import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../src/check.js'
import { resolveConfig } from '../src/config.js'
import { normalizeUpstream, type NormalizeContext } from '../src/normalize.js'
import {
  companionFiles,
  primaryFile,
  Registry,
  UnknownComponentError,
  type RegistryPayload,
} from '../src/registry.js'

/**
 * The only test that touches the network, and it is opt-in.
 *
 * ```bash
 * DRIFT_LIVE=1 pnpm test
 * ```
 *
 * `vitest.config.ts` excludes `*.live.test.ts` unless `DRIFT_LIVE` is set, so
 * CI cannot go red because ui.shadcn.com had a bad day. That exclusion is what
 * makes the rest of the suite trustworthy — and it is also what creates the gap
 * this file closes.
 *
 * **Every other test in this package is a recording.** The fixtures under
 * `test/fixtures/registry/` were captured on 2026-09-18, and nothing in a green
 * `pnpm test` can tell you when they stopped describing reality. That is not a
 * hypothetical: the script this package was extracted from went from correct to
 * reporting 23 false positives without a line of it changing, because the
 * registry changed underneath it. A recording that has silently gone stale
 * reproduces exactly that failure, one level up — the suite would keep passing
 * while the tool got the real answer wrong.
 *
 * So these tests are not about component content. They pin the **assumptions**
 * the normalizer and the fetcher are built on, each one separately, so that
 * when upstream moves the failure names which assumption died rather than
 * saying only that something differs.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const registryDir = path.join(here, 'fixtures/registry')
const appProject = path.join(here, 'fixtures/projects/subpath-imports-app')

const STYLE = 'new-york-v4'

/** Which components have a recorded payload, derived rather than listed. */
async function recordedComponents(): Promise<string[]> {
  const entries = await readdir(registryDir)
  return entries
    .filter((name) => name.startsWith(`${STYLE}__`) && name.endsWith('.json'))
    .map((name) => name.slice(`${STYLE}__`.length, -'.json'.length))
    .sort()
}

async function recordedPayload(name: string): Promise<RegistryPayload> {
  const file = path.join(registryDir, `${STYLE}__${name}.json`)
  return JSON.parse(await readFile(file, 'utf8')) as RegistryPayload
}

const live = () => new Registry()

describe('live registry — URL shape (spec §14 Q1)', () => {
  it('still serves the style-scoped form', async () => {
    const payload = await live().fetchComponent(STYLE, 'button')
    expect(payload.name).toBe('button')
    expect(primaryFile(payload, 'button').content).toContain('function Button')
  })

  it('still 404s the flat form, so the style segment stays load-bearing', async () => {
    // If this ever starts returning 200, the header grammar's
    // `<style>/<component>` reference has a cheaper alternative and §5 is worth
    // revisiting. Until then, dropping the style segment silently compares
    // against different components: new-york and new-york-v4 are Tailwind v3
    // and v4 and are not naming variants of each other.
    const response = await fetch('https://ui.shadcn.com/r/button.json')
    expect(response.status).toBe(404)
  })

  it('answers a missing component with a 404 status and an HTML body', async () => {
    // `res.ok` before `res.json()` is load-bearing: this registry serves ~35 KB
    // of HTML on a 404, so parsing before checking turns a clean finding —
    // "this component does not exist upstream" — into a JSON syntax error that
    // reads like a bug in this tool.
    const response = await fetch(
      `https://ui.shadcn.com/r/styles/${STYLE}/frobnicator.json`,
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toMatch(/^\s*\{/)

    await expect(
      live().fetchComponent(STYLE, 'frobnicator'),
    ).rejects.toBeInstanceOf(UnknownComponentError)
  })

  it('still settles every component name in one index request', async () => {
    const index = await live().fetchIndex()
    expect(index.length).toBeGreaterThan(50)
    for (const name of await recordedComponents()) {
      expect(index, `${name} left the registry index`).toContain(name)
    }
  })
})

describe('live registry — the normalizer’s premises (spec §7)', () => {
  it('still emits the bare `cn` placeholder, which step 5 exists for', async () => {
    // Measured 2026-09-18: new-york-v4 no longer emits `@/lib/utils` at all. It
    // emits `import { cn } from "cn"`, a package-shaped placeholder the CLI
    // rewrites on `add`, which alias-derived rewriting cannot catch. Every
    // shadcn component imports `cn`, so if this premise changes shape again,
    // step 5 fails every component in the directory at once — exactly the
    // blast radius that broke ui-drift.mjs.
    const payload = await live().fetchComponent(STYLE, 'button')
    const source = primaryFile(payload, 'button').content ?? ''
    expect(source).toMatch(/from\s+["']cn["']/)
    expect(payload.dependencies ?? []).toContain('cn')
  })

  it('still orders its imports differently from the CLI, which step 7 exists for', async () => {
    // The registry's own ordering is not the CLI's, and Prettier preserves
    // both, so neither normalizes away on its own. If upstream ever started
    // shipping imports in the CLI's order this test would fail — which is the
    // signal to re-measure §7.1 rather than to assume step 7 is now free.
    const payload = await live().fetchComponent(STYLE, 'button')
    const source = primaryFile(payload, 'button').content ?? ''
    const canonicalized = normalizeUpstream(source, {
      aliases: { utils: '#/lib/utils', ui: '#/components/ui' },
      registryStyle: STYLE,
    } satisfies NormalizeContext)
    expect(canonicalized).not.toBe(source)
  })

  it('still nests v4 payload files under registry/<style>/', async () => {
    // The two payload shapes §14 Q1 recorded: new-york-v4 puts its file at
    // `registry/new-york-v4/ui/button.tsx` while new-york uses `ui/button.tsx`.
    // `primaryFile` matches on the filename precisely so both keep working.
    const payload = await live().fetchComponent(STYLE, 'button')
    expect(primaryFile(payload, 'button').path).toMatch(/button\.tsx$/)
  })
})

describe('live registry — are the recordings still true?', () => {
  it('serves the same component source the fixtures recorded', async () => {
    // The headline reason this file exists. Compared after normalization rather
    // than byte-for-byte, because payload metadata (`meta.links`, docs URLs)
    // churns without the component changing, and a test that fails on that
    // teaches people to re-record without reading the diff.
    //
    // A failure here means one fixture is stale, and names it. Re-record that
    // payload, then re-run the offline suite: if a (stock) component stops
    // reconciling, upstream genuinely moved and the tool is about to report it.
    const ctx: NormalizeContext = {
      aliases: { utils: '#/lib/utils', ui: '#/components/ui' },
      registryStyle: STYLE,
    }
    const registry = live()
    const names = await recordedComponents()
    const stale: string[] = []

    // Guards against the way this test could rot into passing vacuously: an
    // empty fixture directory, or `primaryFile` falling back to '' on both
    // sides and comparing nothing to nothing.
    expect(names.length).toBeGreaterThan(0)

    for (const name of names) {
      const recorded = await recordedPayload(name)
      const fresh = await registry.fetchComponent(STYLE, name)
      const before = normalizeUpstream(
        primaryFile(recorded, name).content ?? '',
        ctx,
      )
      const after = normalizeUpstream(
        primaryFile(fresh, name).content ?? '',
        ctx,
      )
      expect(before.length, `${name} recorded no source`).toBeGreaterThan(100)
      expect(after.length, `${name} served no source`).toBeGreaterThan(100)
      if (before !== after) stale.push(name)
    }

    expect(stale, 'recorded fixtures no longer match upstream').toEqual([])
  })

  it('has not grown companion files the fixtures do not know about', async () => {
    // Companions are reported but not compared (§14 Q2, deferred). A component
    // that newly ships one is a change to what the tool is not checking, which
    // is worth hearing about even while the answer stays "report, don't
    // compare".
    const registry = live()
    for (const name of await recordedComponents()) {
      const recorded = companionFiles(await recordedPayload(name), name)
      const fresh = companionFiles(
        await registry.fetchComponent(STYLE, name),
        name,
      )
      expect(fresh.sort(), `${name} companions changed`).toEqual(
        recorded.sort(),
      )
    }
  })
})

describe('live registry — the §7.1 measurement, against reality', () => {
  it('reconciles all eight (stock) components with no residual diff', async () => {
    // The number that justifies textual comparison over an AST: as shipped in
    // ui-drift.mjs, 0 of 8; with step 5 alone, still 0 of 8; with step 7 as
    // well, 8 of 8 and zero residual diff. The offline suite asserts this
    // against recordings. This asserts it against the registry itself, which is
    // the only version of the claim that cannot quietly go stale.
    const config = await resolveConfig(path.join(appProject, 'components.json'))
    const report = await check(config)

    const stock = report.results.filter((r) => r.header?.state === 'stock')
    expect(stock).toHaveLength(8)
    expect(
      stock.filter((r) => r.verdict !== 'clean').map((r) => r.file),
      'a (stock) component stopped reconciling against the live registry',
    ).toEqual([])
  })
})
