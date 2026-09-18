#!/usr/bin/env node
import { parseArgs } from 'node:util'
import path from 'node:path'
import {
  findComponentsJson,
  resolveConfig,
  type ResolvedConfig,
} from './config.js'
import { check } from './check.js'
import { DriftError } from './errors.js'
import { ExitCode } from './exit-codes.js'
import { renderReport } from './report.js'

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
    // Phase 5. Must not exit 0 — a CI script would read that as "clean".
    console.error('shadcn-drift: "init" is not implemented yet.')
    console.error(
      'Autodiscovery is specified but not built yet — see the README.',
    )
    return ExitCode.OPERATIONAL
  }

  if (command !== 'check') {
    throw new DriftError(`unknown command "${command}"`, {
      detail: ['Expected one of: check, config, init.'],
    })
  }

  if (values.offline || values['update-lock']) {
    // Phase 7.
    console.error('shadcn-drift: the lock file is not implemented yet.')
    console.error(
      'Offline mode is specified but not built yet — see the README.',
    )
    return ExitCode.OPERATIONAL
  }

  const configs = await resolveAll(cwd, values.ui)
  let worst: ExitCode = ExitCode.OK
  for (const config of configs) {
    const report = await check(config, {
      strict: values.strict,
      format: !values['no-format'],
      ...(values.only === undefined ? {} : { only: values.only }),
    })
    if (values.json) {
      console.log(JSON.stringify({ version: 1, report }, null, 2))
    } else {
      console.log(renderReport(report, { strict: values.strict }))
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
