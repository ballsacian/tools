import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  companionFiles,
  primaryFile,
  Registry,
  UnknownComponentError,
  type FetchLike,
} from '../src/registry.js'
import { compare } from '../src/compare.js'
import { ExitCode } from '../src/exit-codes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const registryDir = path.join(here, 'fixtures/registry')

const fetchFrom = (file: string, status = 200): FetchLike => {
  return () =>
    Promise.resolve({
      ok: status < 400,
      status,
      text: () => readFile(path.join(registryDir, file), 'utf8'),
    })
}

describe('Registry — trust', () => {
  it('accepts the official registry', () => {
    expect(() => new Registry()).not.toThrow()
  })

  it('refuses an origin nobody opted into', () => {
    // A registry serves executable source straight into your repo, so an
    // unexpected origin is the actual "fake shadcn" vector.
    expect(
      () => new Registry({ baseUrl: 'https://registry.evil.example' }),
    ).toThrow(/untrusted registry origin/)
  })

  it('reports an untrusted origin as an authenticity failure, not an error', () => {
    try {
      new Registry({ baseUrl: 'https://registry.evil.example' })
      expect.unreachable()
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(
        ExitCode.AUTHENTICITY,
      )
    }
  })

  it('allows an origin named in drift.registryAllowlist', () => {
    expect(
      () =>
        new Registry({
          baseUrl: 'https://registry.acme.dev',
          allowlist: ['registry.acme.dev'],
        }),
    ).not.toThrow()
  })

  it('checks trust before any request is made', () => {
    let called = false
    expect(() => {
      new Registry({
        baseUrl: 'https://registry.evil.example',
        fetchImpl: () => {
          called = true
          throw new Error('should never run')
        },
      })
    }).toThrow()
    expect(called).toBe(false)
  })
})

describe('Registry — fetching', () => {
  it('builds the style-scoped URL', () => {
    // Verified live 2026-09-18: the flat `/r/<name>.json` form 404s and the
    // style segment is load-bearing.
    expect(new Registry().componentUrl('new-york-v4', 'button')).toBe(
      'https://ui.shadcn.com/r/styles/new-york-v4/button.json',
    )
  })

  it('reads a recorded payload', async () => {
    const registry = new Registry({
      fetchImpl: fetchFrom('new-york-v4__button.json'),
    })
    const payload = await registry.fetchComponent('new-york-v4', 'button')
    expect(payload.name).toBe('button')
  })

  it('treats a 404 as a finding, not a parse error', async () => {
    // The real registry answers 404 with ~35 KB of HTML. Parsing before
    // checking the status turns a clean finding into "unexpected token <".
    const registry = new Registry({ fetchImpl: fetchFrom('404.html', 404) })
    await expect(
      registry.fetchComponent('new-york-v4', 'frobnicator'),
    ).rejects.toBeInstanceOf(UnknownComponentError)
  })

  it('classifies an unknown component as authenticity', async () => {
    const registry = new Registry({ fetchImpl: fetchFrom('404.html', 404) })
    const error = await registry
      .fetchComponent('new-york-v4', 'frobnicator')
      .catch((e: unknown) => e)
    expect((error as { exitCode: number }).exitCode).toBe(ExitCode.AUTHENTICITY)
  })

  it('reads every component name from the index in one request', async () => {
    let requests = 0
    const registry = new Registry({
      fetchImpl: (url) => {
        requests++
        return fetchFrom('index.json')(url)
      },
    })
    const names = await registry.fetchIndex()
    expect(names).toContain('button')
    expect(names.length).toBeGreaterThan(50)
    await registry.fetchIndex()
    expect(requests).toBe(1) // cached
  })
})

describe('primaryFile', () => {
  it('finds the component in the v4 payload shape', async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(registryDir, 'new-york-v4__button.json'),
        'utf8',
      ),
    ) as Parameters<typeof primaryFile>[0]
    // v4 nests at registry/new-york-v4/ui/button.tsx; new-york uses ui/button.tsx.
    expect(primaryFile(payload, 'button').content).toContain('buttonVariants')
  })

  it('finds it in the legacy bare shape too', () => {
    const payload = {
      name: 'button',
      files: [{ path: 'ui/button.tsx', content: 'x' }],
    }
    expect(primaryFile(payload, 'button').content).toBe('x')
  })

  it('reports a payload with no usable source', () => {
    expect(() => primaryFile({ name: 'x', files: [] }, 'x')).toThrow(
      /no source/,
    )
  })
})

describe('companionFiles', () => {
  it('lists payload files that are not the component itself', () => {
    // `sidebar` ships `use-mobile`. The original script silently ignored these,
    // so a drifted companion was invisible.
    const payload = {
      name: 'sidebar',
      files: [
        { path: 'ui/sidebar.tsx', content: 'a' },
        { path: 'hooks/use-mobile.ts', content: 'b' },
      ],
    }
    expect(companionFiles(payload, 'sidebar')).toEqual(['hooks/use-mobile.ts'])
  })
})

describe('compare', () => {
  it('reports identical input as clean', () => {
    expect(compare('a\nb\n', 'a\nb\n').differs).toBe(false)
  })

  it('counts additions and removals', () => {
    const result = compare('a\nb\nc\n', 'a\nB\nc\n')
    expect(result.differs).toBe(true)
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
  })

  it('marks changed lines with + and -', () => {
    const result = compare('keep\nold\n', 'keep\nnew\n')
    expect(result.diff).toContain('-old')
    expect(result.diff).toContain('+new')
    expect(result.diff).toContain(' keep')
  })

  it('elides unchanged regions far from any change', () => {
    const before = [...Array(40).keys()].map(String).join('\n')
    const after = before.replace('\n20\n', '\nXX\n')
    const result = compare(before, after)
    expect(result.diff).toContain('@@')
    expect(result.diff).not.toContain(' 1\n')
  })

  it('handles insertion at the end', () => {
    const result = compare('a\n', 'a\nb\n')
    expect(result.added).toBe(1)
    expect(result.removed).toBe(0)
  })
})
