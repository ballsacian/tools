#!/usr/bin/env node
import { parseArgs } from 'node:util'
import path from 'node:path'
import {
  findComponentsJson,
  resolveConfig,
  type ResolvedConfig,
} from './config.js'
import { check } from './check.js'
import {
  applyProposal,
  planInit,
  retag,
  writableStates,
  type InitPlan,
  type InitProposal,
} from './discover.js'
import { DriftError } from './errors.js'
import { ExitCode } from './exit-codes.js'
import { isTodoReason } from './header.js'
import { buildLock, checkOffline, writeLock } from './lock.js'
import { renderInitPlan, renderProposal, renderReport } from './report.js'

const USAGE = `
shadcn-drift — check vendored shadcn/ui components against the registry

Usage
  npx shadcn-drift [options]          check for drift (default; hits the network)
  npx shadcn-drift config [options]   show the resolved configuration and exit
  npx shadcn-drift init [options]     autodiscover components and write headers
  npx shadcn-drift --offline          verify against shadcn.lock.json, no network
  npx shadcn-drift --update-lock      refresh shadcn.lock.json from the registry

Options
  --cwd <dir>      where to start looking for components.json
  --ui <dir>       override the resolved ui/ directory
  --strict         require a provenance header on every file in ui/
  --only <glob>    check a subset
  --json           machine-readable output
  --no-format      skip the formatter normalization pass
  --yes            init: accept every inference without prompting
  --dry-run        init: print what would be written, change nothing
  -h, --help       show this
  -v, --version    show version

Exit codes
  0  clean       1  drift       2  authenticity       3  operational

The lock file
  --update-lock writes shadcn.lock.json from a network check, and exits with
  that check's result: refreshing a lock over a drifted tree records the drift,
  it does not bless it.

  --offline then answers one question — "has anyone changed this since the lock
  was written?" — with no network, which is what makes it safe for lint and
  pre-commit. It cannot tell you that *upstream* moved; nothing network-free
  can. Keep running the default check on a schedule, and before shadcn add -o.
`.trim()

async function readVersion(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const url = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(await readFile(url, 'utf8')) as { version: string }
  return pkg.version
}

/**
 * Resolve every project reachable from `cwd`. A monorepo legitimately has more
 * than one `components.json`, and silently picking one of them would report a
 * clean result for a repo that was never fully checked.
 */
async function resolveAll(
  cwd: string,
  uiOverride?: string,
): Promise<ResolvedConfig[]> {
  const found = await findComponentsJson(cwd)
  if (found.length === 0) {
    throw new DriftError('no components.json found', {
      exitCode: ExitCode.OPERATIONAL,
      detail: [
        `searched upward from ${cwd}, then downward 4 levels`,
        'Run this from a project that uses shadcn/ui, or pass --cwd.',
      ],
    })
  }

  const configs: ResolvedConfig[] = []
  for (const file of found) {
    const config = await resolveConfig(file)
    configs.push(
      uiOverride
        ? { ...config, uiDir: path.resolve(uiOverride), uiDirSource: '--ui' }
        : config,
    )
  }
  return configs
}

function printConfig(configs: ResolvedConfig[]): void {
  for (const [index, config] of configs.entries()) {
    if (index > 0) console.log('')
    console.log(
      path.relative(process.cwd(), config.componentsJsonPath) ||
        config.componentsJsonPath,
    )
    console.log(`  style declared   ${config.declaredStyle}`)
    console.log(`  registry style   ${config.registryStyle}`)
    console.log(
      `  tailwind         v${String(config.tailwindVersion)}  (${config.tailwindVersionSource})`,
    )
    console.log(
      `  ui directory     ${path.relative(config.projectRoot, config.uiDir)}`,
    )
    console.log(`                   via ${config.uiDirSource}`)
    console.log(
      `  tsx / rsc        ${String(config.tsx)} / ${String(config.rsc)}`,
    )
    const aliases = Object.entries(config.aliases)
    if (aliases.length > 0) {
      console.log(
        `  aliases          ${aliases.map(([k, v]) => `${k}=${v}`).join(', ')}`,
      )
    }
  }
}

interface InitRunOptions {
  yes: boolean
  dryRun: boolean
  json: boolean
  format: boolean
  only?: string
}

/**
 * Drive `init`: propose a header per unheaded file, then write the accepted ones.
 *
 * Interactive by default. `--yes` and `--dry-run` are the two non-interactive
 * paths, and one of them is *required* when stdin is not a TTY — a prompt that
 * silently reads EOF and then writes 43 files nobody looked at is exactly the
 * outcome the per-file prompt exists to prevent.
 */
async function runInit(
  configs: ResolvedConfig[],
  options: InitRunOptions,
): Promise<number> {
  const interactive = !options.yes && !options.dryRun
  if (interactive && !process.stdin.isTTY) {
    throw new DriftError('init needs a terminal, or a flag saying what to do', {
      exitCode: ExitCode.OPERATIONAL,
      detail: [
        'stdin is not a TTY, so the per-file prompt cannot run.',
        'Pass --yes to accept every inference, or --dry-run to only print them.',
      ],
    })
  }

  let written = 0
  let todos = 0
  let malformed = 0

  for (const config of configs) {
    const plan = await planInit(config, {
      format: options.format,
      ...(options.only === undefined ? {} : { only: options.only }),
    })

    malformed += plan.proposals.filter(
      (p) => p.skipped === 'malformed-header',
    ).length

    if (options.json) {
      console.log(JSON.stringify({ version: 1, plan }, null, 2))
      continue
    }

    if (!interactive) {
      console.log(renderInitPlan(plan, { dryRun: options.dryRun }))
      if (options.dryRun) continue
      for (const proposal of plan.proposals) {
        if (proposal.skipped) continue
        await applyProposal(proposal)
        written++
        if (isTodoReason(proposal.reason)) todos++
      }
      continue
    }

    for (const proposal of await promptAll(plan)) {
      await applyProposal(proposal)
      written++
      if (isTodoReason(proposal.reason)) todos++
    }
  }

  if (options.json) return ExitCode.OK

  if (!options.dryRun) {
    console.log('')
    console.log(`Wrote ${String(written)} header(s).`)
  }
  if (todos > 0) {
    console.log(
      `${String(todos)} carry a TODO reason. Finish those sentences — ` +
        '`shadcn-drift --strict` fails until you do, deliberately.',
    )
  }
  if (malformed > 0) {
    console.log(
      `${String(malformed)} file(s) have a provenance comment that does not parse ` +
        'and were left untouched. Fix those by hand.',
    )
  }
  return ExitCode.OK
}

/** The interactive per-file prompt. Returns the proposals to write. */
async function promptAll(plan: InitPlan): Promise<InitProposal[]> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const accepted: InitProposal[] = []

  try {
    console.log(renderInitPlan(plan).split('\n─── ')[0] ?? '')
    for (const proposal of plan.proposals) {
      if (proposal.skipped === 'has-header') continue
      console.log('')
      console.log(renderProposal(proposal))
      if (proposal.skipped) continue

      const states = writableStates(proposal)
      const choices = states.map((state, i) => `${String(i + 1)}=${state}`)
      const answer = (
        await rl.question(
          `    [enter]=accept  ${choices.join('  ')}  s=skip  q=quit  › `,
        )
      )
        .trim()
        .toLowerCase()

      if (answer === 'q') break
      if (answer === 's') continue

      let chosen = proposal
      if (answer !== '') {
        const picked = states[Number(answer) - 1]
        if (!picked) {
          console.log('    not a choice — skipped')
          continue
        }
        const reason =
          picked === 'patched' || picked === 'forked'
            ? (await rl.question('    reason (blank = TODO): ')).trim()
            : ''
        chosen = retag(proposal, picked, reason === '' ? null : reason)
      }
      accepted.push(chosen)
    }
  } finally {
    rl.close()
  }

  return accepted
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      ui: { type: 'string' },
      only: { type: 'string' },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'no-format': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      'update-lock': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })

  if (values.help) {
    console.log(USAGE)
    return ExitCode.OK
  }

  if (values.version) {
    console.log(await readVersion())
    return ExitCode.OK
  }

  const command = positionals[0] ?? 'check'
  const cwd = path.resolve(values.cwd ?? process.cwd())

  if (command === 'config') {
    const configs = await resolveAll(cwd, values.ui)
    if (values.json) {
      console.log(JSON.stringify({ version: 1, projects: configs }, null, 2))
    } else {
      printConfig(configs)
    }
    return ExitCode.OK
  }

  if (command === 'init') {
    const configs = await resolveAll(cwd, values.ui)
    return runInit(configs, {
      yes: values.yes,
      dryRun: values['dry-run'],
      json: values.json,
      format: !values['no-format'],
      ...(values.only === undefined ? {} : { only: values.only }),
    })
  }

  if (command !== 'check') {
    throw new DriftError(`unknown command "${command}"`, {
      detail: ['Expected one of: check, config, init.'],
    })
  }

  if (values.offline && values['update-lock']) {
    throw new DriftError('--offline and --update-lock are opposites', {
      detail: [
        '--update-lock refreshes the lock from the registry, which needs a network.',
        '--offline is the mode that promises not to use one.',
      ],
    })
  }

  const configs = await resolveAll(cwd, values.ui)
  let worst: ExitCode = ExitCode.OK
  for (const config of configs) {
    const report = values.offline
      ? await checkOffline(config, {
          strict: values.strict,
          format: !values['no-format'],
          ...(values.only === undefined ? {} : { only: values.only }),
        })
      : await check(config, {
          strict: values.strict,
          format: !values['no-format'],
          ...(values.only === undefined ? {} : { only: values.only }),
        })

    if (values.json) {
      console.log(JSON.stringify({ version: 1, report }, null, 2))
    } else {
      console.log(renderReport(report, { strict: values.strict }))
    }

    if (values['update-lock']) {
      const file = await writeLock(config, buildLock(report))
      if (!values.json) {
        console.log('')
        console.log(`Wrote ${path.relative(process.cwd(), file) || file}.`)
        console.log(
          `Commit it. \`--offline\` then answers "has anyone changed this since?" with no network — and only that.`,
        )
      }
    }

    // Authenticity (2) outranks drift (1); neither is outranked by OK.
    if (report.exitCode > worst) worst = report.exitCode
  }
  return worst
}

function report(error: unknown): number {
  if (error instanceof DriftError) {
    console.error(`shadcn-drift: ${error.message}`)
    for (const line of error.detail) console.error(`  ${line}`)
    return error.exitCode
  }
  console.error('shadcn-drift: unexpected failure')
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
  return ExitCode.OPERATIONAL
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.exitCode = report(error)
  })
