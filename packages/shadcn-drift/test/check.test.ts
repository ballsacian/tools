import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, exitCodeFor, type ComponentResult } from '../src/check.js'
import { resolveConfig } from '../src/config.js'
import { ExitCode } from '../src/exit-codes.js'
import { Registry, type FetchLike } from '../src/registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const registryDir = path.join(here, 'fixtures/registry')
const appProject = path.join(here, 'fixtures/projects/subpath-imports-app')

/**
 * A registry backed by recorded payloads.
 *
 * The suite must never touch the network: CI going red because ui.shadcn.com
 * had a bad day would train everyone to ignore it.
 */
const fixtureFetch: FetchLike = async (url) => {
  const ok = (body: string) => ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  })

  if (url.endsWith('/r/index.json')) {
    return ok(await readFile(path.join(registryDir, 'index.json'), 'utf8'))
  }

  const match = /\/r\/styles\/([^/]+)\/([^/]+)\.json$/.exec(url)
  if (match) {
    const file = path.join(
      registryDir,
      `${match[1] ?? ''}__${match[2] ?? ''}.json`,
    )
    try {
      return ok(await readFile(file, 'utf8'))
    } catch {
      // Exactly what the real registry does: a 404 status with an HTML body.
      return {
        ok: false,
        status: 404,
        text: () => readFile(path.join(registryDir, '404.html'), 'utf8'),
      }
    }
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const fixtureRegistry = () => new Registry({ fetchImpl: fixtureFetch })

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
