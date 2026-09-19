import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, exitCodeFor, type ComponentResult } from '../src/check.js'
import { resolveConfig } from '../src/config.js'
import { ExitCode } from '../src/exit-codes.js'
import { fixtureRegistry } from './helpers/fixture-registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const appProject = path.join(here, 'fixtures/projects/subpath-imports-app')

const byFile = (results: readonly ComponentResult[], file: string) =>
  results.find((r) => r.file === file)

describe('check — against a real vendored ui/ directory', () => {
  it('finds every (stock) component clean', async () => {
    // The headline regression. Measured during spec work: with the normalizer
    // as originally shipped, 0 of 8 passed; the bare-`cn` rewrite alone left it
    // at 0 of 8; adding import canonicalization took it to 8 of 8. If this
    // drops below 8, one of those two steps has regressed.
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config, { registry: fixtureRegistry() })

    const stock = report.results.filter((r) => r.header?.state === 'stock')
    expect(stock).toHaveLength(8)
    expect(stock.filter((r) => r.verdict === 'clean')).toHaveLength(8)
  })

  it('reports chart.tsx as a stale tag, exactly as the spec predicted', async () => {
    // chart.tsx is tagged (patched) *solely* because of the `.ts` extension on
    // its utils import. Extension equivalence normalizes that away, so it is
    // now identical to upstream and the tag is stale.
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config, { registry: fixtureRegistry() })
    expect(byFile(report.results, 'chart.tsx')?.verdict).toBe('stale-tag')
  })

  it('exits 1 — a stale tag is a finding, not a pass', async () => {
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config, { registry: fixtureRegistry() })
    expect(report.exitCode).toBe(ExitCode.DRIFT)
  })

  it('uses the project’s own prettier, not ours', async () => {
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config, { registry: fixtureRegistry() })
    expect(report.formatter).toContain('prettier from the project')
  })
})

describe('check — options', () => {
  it('honours --only', async () => {
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config, {
      registry: fixtureRegistry(),
      only: 'button.tsx',
    })
    expect(report.results.map((r) => r.file)).toEqual(['button.tsx'])
  })

  it('still reconciles without a formatter, since normalization does the work', async () => {
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config, {
      registry: fixtureRegistry(),
      format: false,
      only: 'button.tsx',
    })
    // Quote style alone differs without Prettier, so this is expected to
    // differ — the point is that it runs and reports rather than crashing.
    expect(report.formatter).toBeNull()
    expect(report.results).toHaveLength(1)
  })
})

describe('exitCodeFor', () => {
  const result = (over: Partial<ComponentResult>): ComponentResult => ({
    file: 'x.tsx',
    header: null,
    style: null,
    component: null,
    verdict: 'clean',
    problems: [],
    diff: '',
    added: 0,
    removed: 0,
    companions: [],
    note: null,
    localHash: null,
    upstreamHash: null,
    ...over,
  })

  it('returns 0 when everything is clean', () => {
    expect(exitCodeFor([result({})], false)).toBe(ExitCode.OK)
  })

  it('returns 1 for drift', () => {
    expect(exitCodeFor([result({ verdict: 'drift' })], false)).toBe(
      ExitCode.DRIFT,
    )
  })

  it('returns 2 for a component that does not exist upstream', () => {
    expect(exitCodeFor([result({ verdict: 'unknown-component' })], false)).toBe(
      ExitCode.AUTHENTICITY,
    )
  })

  it('lets authenticity outrank drift when both are present', () => {
    // "This is not the component it claims to be" is worse news than
    // "this component changed".
    const results = [
      result({ verdict: 'drift' }),
      result({ verdict: 'unknown-component' }),
    ]
    expect(exitCodeFor(results, false)).toBe(ExitCode.AUTHENTICITY)
  })

  it('ignores untagged files by default but fails them under --strict', () => {
    // Untagged is the shape an agent or a copy-paste produces. The original
    // script treated it as trusted-and-skipped; --strict inverts that.
    const results = [result({ verdict: 'ours', header: null })]
    expect(exitCodeFor(results, false)).toBe(ExitCode.OK)
    expect(exitCodeFor(results, true)).toBe(ExitCode.AUTHENTICITY)
  })

  it('does not fail on a TODO reason unless --strict', () => {
    // init writes TODO deliberately; failing immediately would leave the tool's
    // own onboarding step in a failing state.
    const results = [
      result({
        problems: [
          { code: 'todo-reason', message: 'still carries a TODO reason' },
        ],
      }),
    ]
    expect(exitCodeFor(results, false)).toBe(ExitCode.OK)
    expect(exitCodeFor(results, true)).toBe(ExitCode.DRIFT)
  })
})

describe('--strict (spec §9.3)', () => {
  const result = (over: Partial<ComponentResult>): ComponentResult => ({
    file: 'x.tsx',
    header: null,
    style: null,
    component: null,
    verdict: 'clean',
    problems: [],
    diff: '',
    added: 0,
    removed: 0,
    companions: [],
    note: null,
    localHash: null,
    upstreamHash: null,
    ...over,
  })

  it('fails an untagged file that happens to match upstream', () => {
    // The inversion --strict exists for. A file identical to the registry is
    // still unexamined: nobody has said whether it is meant to stay that way,
    // and the next `shadcn add -o` will not be reviewable. Authenticity, not
    // drift — the question is what the file *is*, not whether it changed.
    const results = [result({ verdict: 'untracked-match' })]
    expect(exitCodeFor(results, false)).toBe(ExitCode.OK)
    expect(exitCodeFor(results, true)).toBe(ExitCode.AUTHENTICITY)
  })

  it('escalates an untagged file that differs from drift to authenticity', () => {
    const results = [result({ verdict: 'untracked-drift' })]
    expect(exitCodeFor(results, false)).toBe(ExitCode.DRIFT)
    expect(exitCodeFor(results, true)).toBe(ExitCode.AUTHENTICITY)
  })

  it('passes a file that declares (ours), which is the whole point of the tag', () => {
    // "We wrote this" and "nobody has looked at this yet" are the two states
    // --strict has to tell apart, and a declared (ours) is the first one. If
    // this failed there would be no way for a repo to reach a clean strict run,
    // and the flag would be unusable rather than strict.
    const declared = result({
      verdict: 'ours',
      header: {
        state: 'ours',
        style: null,
        component: null,
        reason: null,
        raw: '/** shadcn/ui — (ours) */',
      },
    })
    expect(exitCodeFor([declared], true)).toBe(ExitCode.OK)
  })

  it('fails the same file when the tag is absent', () => {
    expect(exitCodeFor([result({ verdict: 'ours', header: null })], true)).toBe(
      ExitCode.AUTHENTICITY,
    )
  })

  it('treats a malformed header as drift, not as an untagged file', () => {
    // It claims provenance — it is just written wrong. Escalating it to
    // authenticity would say "this is not what it claims to be", which is a
    // different and more alarming finding than "your header has a typo".
    const results = [result({ verdict: 'malformed-header' })]
    expect(exitCodeFor(results, false)).toBe(ExitCode.DRIFT)
    expect(exitCodeFor(results, true)).toBe(ExitCode.DRIFT)
  })

  it('fails a header problem other than TODO even without --strict', () => {
    // A (patched) tag with no reason is broken in both modes; only the reason
    // `init` writes for you is given until --strict.
    const results = [
      result({
        problems: [{ code: 'missing-reason', message: 'must say why' }],
      }),
    ]
    expect(exitCodeFor(results, false)).toBe(ExitCode.DRIFT)
  })

  it('lets an unknown component outrank an untagged one', () => {
    const results = [
      result({ verdict: 'untracked-match' }),
      result({ verdict: 'unknown-component' }),
    ]
    expect(exitCodeFor(results, true)).toBe(ExitCode.AUTHENTICITY)
  })
})

describe('--strict — end to end', () => {
  it('fails a directory of untagged files and names every one', async () => {
    const config = await resolveConfig(
      path.join(here, 'fixtures/projects/headerless-app/components.json'),
    )
    const report = await check(config, {
      registry: fixtureRegistry(),
      strict: true,
    })

    expect(report.exitCode).toBe(ExitCode.AUTHENTICITY)
    const untagged = report.results.filter((r) => r.header === null)
    expect(untagged.length).toBeGreaterThan(0)
    // Everything without a header is reported, whether or not it matches.
    expect(untagged.every((r) => r.verdict !== 'clean')).toBe(true)
  })

  it('passes the same directory without --strict, because tier 0 is not a gate', async () => {
    // Untagged-and-identical is the shape of a repo that has never heard of
    // this tool. Failing it by default would make `npx shadcn-drift` useless as
    // a first look, which is goal 1.
    const config = await resolveConfig(
      path.join(here, 'fixtures/projects/headerless-app/components.json'),
    )
    const report = await check(config, { registry: fixtureRegistry() })
    expect(
      report.results.filter((r) => r.verdict === 'untracked-drift'),
    ).toHaveLength(0)
    expect(report.exitCode).toBe(ExitCode.DRIFT) // switch.tsx's stale (patched)
  })
})
