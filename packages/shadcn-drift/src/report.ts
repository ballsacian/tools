import path from 'node:path'
import type { CheckReport, ComponentResult, Verdict } from './check.js'
import type { InitPlan, InitProposal } from './discover.js'
import { proposedHeader } from './discover.js'
import { ExitCode } from './exit-codes.js'

const LABEL: Record<Verdict, string> = {
  clean: 'matches its declared state',
  drift: 'tagged (stock) but differs from the registry',
  'stale-tag':
    'declared a delta but is identical to the registry — retag it (stock)',
  'unknown-component': 'claims a component the registry has never served',
  'untracked-match': 'matches the registry, but carries no provenance header',
  'untracked-drift':
    'differs from the registry and carries no provenance header',
  ours: 'not a registry component',
  'malformed-header':
    'has a comment claiming shadcn/ui provenance that does not parse',
  'changed-since-lock': 'changed since the lock was written',
  unlocked: 'is not in the lock file',
  missing: 'is in the lock file but no longer on disk',
}

/** Verdicts that mean "look at this". */
function isFinding(result: ComponentResult, strict: boolean): boolean {
  if (result.verdict === 'clean') return result.problems.length > 0
  if (result.verdict === 'ours') return strict && result.header === null
  if (result.verdict === 'untracked-match') return strict
  return true
}

/**
 * What an offline run is allowed to claim.
 *
 * Printed on every offline report, not tucked into `--help`. The whole risk of
 * this mode is someone reading a green `--offline` as "we are up to date with
 * upstream" and dropping the network check that actually answers that — which
 * would leave the repo worse off than before the lock existed.
 */
const OFFLINE_CAVEAT =
  'offline: compared against the lock only. This says nothing about whether upstream moved — run without --offline for that.'

export function renderReport(
  report: CheckReport,
  options: { strict?: boolean } = {},
): string {
  const strict = options.strict ?? false
  const lines: string[] = []
  const rel = path.relative(process.cwd(), report.config.componentsJsonPath)

  lines.push('')
  lines.push(
    `${rel || report.config.componentsJsonPath}  —  ${report.config.registryStyle}`,
  )
  lines.push(
    `${String(report.results.length)} file(s) in ${path.relative(report.config.projectRoot, report.config.uiDir)}` +
      (report.formatter
        ? `  ·  ${report.formatter}`
        : '  ·  no formatter (comparing unformatted)'),
  )
  if (report.mode === 'offline') {
    lines.push(`lock written ${report.lockFetchedAt ?? 'at an unknown time'}`)
    lines.push(OFFLINE_CAVEAT)
  }
  lines.push('')

  const counts = new Map<Verdict, number>()
  for (const result of report.results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1)
  }
  for (const [verdict, count] of counts) {
    lines.push(`  ${String(count).padStart(3)}  ${LABEL[verdict]}`)
  }

  const findings = report.results.filter((r) => isFinding(r, strict))
  for (const result of findings) {
    lines.push('')
    lines.push(`─── ${result.file} — ${LABEL[result.verdict]}`)
    if (result.note) lines.push(`    ${result.note}`)
    for (const problem of result.problems) {
      if (problem.code === 'todo-reason' && !strict) continue
      lines.push(`    header: ${problem.message}`)
    }
    if (result.companions.length > 0) {
      lines.push(
        `    not compared (companion files in the payload): ${result.companions.join(', ')}`,
      )
    }
    if (result.diff) {
      lines.push('')
      for (const line of result.diff.split('\n')) lines.push(`    ${line}`)
    }
  }

  lines.push('')
  if (report.exitCode === ExitCode.OK) {
    lines.push(
      report.mode === 'offline'
        ? 'OK — nothing has changed since the lock was written.'
        : 'OK — every header matches reality.',
    )
  } else if (report.exitCode === ExitCode.AUTHENTICITY) {
    lines.push('FAIL — a component is not what it claims to be.')
  } else {
    lines.push(
      'FAIL — undeclared drift. Either revert the file, or retag its header (patched) and say why.',
    )
  }

  return lines.join('\n')
}

/** One proposal, as the interactive prompt and `--dry-run` both show it. */
export function renderProposal(proposal: InitProposal): string {
  const lines: string[] = []
  lines.push(`─── ${proposal.file}`)
  lines.push(`    ${proposal.note}`)
  if (proposal.skipped) {
    lines.push('    left alone — init only ever adds headers')
    return lines.join('\n')
  }
  if (proposal.diff) {
    lines.push('')
    for (const line of proposal.diff.split('\n')) lines.push(`    ${line}`)
    lines.push('')
  }
  lines.push(`    ${proposedHeader(proposal)}`)
  return lines.join('\n')
}

export function renderInitPlan(
  plan: InitPlan,
  options: { dryRun?: boolean } = {},
): string {
  const lines: string[] = []
  const rel = path.relative(process.cwd(), plan.config.componentsJsonPath)

  lines.push('')
  lines.push(
    `${rel || plan.config.componentsJsonPath}  —  ${plan.config.registryStyle}`,
  )
  lines.push(
    `${String(plan.proposals.length)} file(s) in ${path.relative(plan.config.projectRoot, plan.config.uiDir)}` +
      (plan.formatter
        ? `  ·  ${plan.formatter}`
        : '  ·  no formatter (comparing unformatted)'),
  )
  if (plan.fingerprinted) {
    lines.push(
      '  some files did not match a registry name, so exported symbols were compared too',
    )
  }
  lines.push('')

  const writable = plan.proposals.filter((p) => p.skipped === null)
  const counts = new Map<string, number>()
  for (const proposal of writable) {
    counts.set(proposal.state, (counts.get(proposal.state) ?? 0) + 1)
  }
  for (const [state, count] of counts) {
    lines.push(`  ${String(count).padStart(3)}  would be tagged (${state})`)
  }
  const untouched = plan.proposals.filter((p) => p.skipped !== null)
  if (untouched.length > 0) {
    lines.push(
      `  ${String(untouched.length).padStart(3)}  already carry a header — left alone`,
    )
  }

  for (const proposal of plan.proposals) {
    if (proposal.skipped === 'has-header') continue
    lines.push('')
    lines.push(renderProposal(proposal))
  }

  lines.push('')
  if (options.dryRun) {
    lines.push('--dry-run: nothing was written.')
  }
  return lines.join('\n')
}
