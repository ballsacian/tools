import path from 'node:path'
import type { CheckReport, ComponentResult, Verdict } from './check.js'
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
}

/** Verdicts that mean "look at this". */
function isFinding(result: ComponentResult, strict: boolean): boolean {
  if (result.verdict === 'clean') return result.problems.length > 0
  if (result.verdict === 'ours') return strict && result.header === null
  if (result.verdict === 'untracked-match') return strict
  return true
}

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
    lines.push('OK — every header matches reality.')
  } else if (report.exitCode === ExitCode.AUTHENTICITY) {
    lines.push('FAIL — a component is not what it claims to be.')
  } else {
    lines.push(
      'FAIL — undeclared drift. Either revert the file, or retag its header (patched) and say why.',
    )
  }

  return lines.join('\n')
}
