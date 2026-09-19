import { describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, hashNormalized } from '../src/check.js'
import { resolveConfig, type ResolvedConfig } from '../src/config.js'
import { DriftError } from '../src/errors.js'
import { ExitCode } from '../src/exit-codes.js'
import {
  buildLock,
  checkOffline,
  lockPath,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  readLock,
  writeLock,
  type LockFile,
} from '../src/lock.js'
import { fixtureRegistry } from './helpers/fixture-registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const appProject = path.join(here, 'fixtures/projects/subpath-imports-app')

/**
 * Offline mode writes and reads a lock file at the project root, so each test
 * gets its own copy. It lives under `test/fixtures/` rather than the OS temp
 * directory so the project's own Prettier still resolves — a lock hashed with
 * a formatter and verified without one mismatches on every file, which is the
 * exact failure `checkOffline` refuses to run into.
 */
async function withCopy<T>(
  fn: (config: ResolvedConfig) => Promise<T>,
): Promise<T> {
  const scratch = path.join(here, 'fixtures/.tmp')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'lock-'))
  const root = path.join(dir, 'app')
  await cp(appProject, root, { recursive: true })
  try {
    return await fn(await resolveConfig(path.join(root, 'components.json')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function lockFor(config: ResolvedConfig): Promise<LockFile> {
  const report = await check(config, { registry: fixtureRegistry() })
  return buildLock(report)
}

const uiFile = (config: ResolvedConfig, name: string) =>
  path.join(config.uiDir, name)

describe('hashNormalized', () => {
  it('is stable and content-addressed', () => {
    expect(hashNormalized('a')).toBe(hashNormalized('a'))
    expect(hashNormalized('a')).not.toBe(hashNormalized('b'))
    expect(hashNormalized('a')).toMatch(/^sha256-[0-9a-f]{64}$/)
  })
})

describe('buildLock', () => {
  it('hashes the normalized content, so formatting churn cannot invalidate it', async () => {
    // The point of §10's "hashes are of the normalized content": a CRLF
    // checkout, a Prettier pass, or a per-file eslint-disable must not make a
    // committed lock stale. Those all vanish in §7 before the hash is taken.
    await withCopy(async (config) => {
      const before = await lockFor(config)

      const file = uiFile(config, 'button.tsx')
      const source = await readFile(file, 'utf8')
      // The exemption goes *below* the provenance header, which is how a real
      // vendored file is written — the header has to lead or nothing reads it
      // as provenance at all.
      const [header, ...rest] = source.split('\n')
      const churned = [
        header,
        '/* eslint-disable no-shadow -- vendored */',
        ...rest,
      ]
        .join('\n')
        .replace(/\n/g, '\r\n')
      await writeFile(file, churned, 'utf8')

      const after = await lockFor(config)
      expect(after.components['button.tsx']?.local).toBe(
        before.components['button.tsx']?.local,
      )
    })
  })

  it('records the source URL, the declared state, and the verdict', async () => {
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      expect(lock.components['button.tsx']).toMatchObject({
        source: 'https://ui.shadcn.com/r/styles/new-york-v4/button.json',
        state: 'stock',
        verdict: 'clean',
      })
      expect(lock.components['button.tsx']?.upstream).toMatch(/^sha256-/)
      expect(lock.lockfileVersion).toBe(LOCKFILE_VERSION)
    })
  })

  it('still hashes an (ours) file, which is not the same as ignoring it', async () => {
    // `(ours)` means "no registry component corresponds", not "stop watching".
    // A local component silently changing is exactly what a lock is for.
    await withCopy(async (config) => {
      await writeFile(
        uiFile(config, 'thing.tsx'),
        '/** shadcn/ui — (ours) */\n\nexport function Thing() {\n  return null\n}\n',
        'utf8',
      )
      const lock = await lockFor(config)
      expect(lock.components['thing.tsx']?.local).toMatch(/^sha256-/)
      expect(lock.components['thing.tsx']?.source).toBeNull()
      expect(lock.components['thing.tsx']?.upstream).toBeNull()
    })
  })
})

describe('checkOffline', () => {
  it('passes an untouched tree with no network at all', async () => {
    // Asserted, not assumed: `fetch` is replaced with something that throws for
    // the duration of the offline run. This mode's entire value is being safe
    // in `lint` and a pre-commit hook, which is only true if it genuinely
    // cannot reach out — a stray probe would make it fail on a plane.
    await withCopy(async (config) => {
      const lock = await lockFor(config)

      const realFetch = globalThis.fetch
      globalThis.fetch = () => {
        throw new Error('offline mode must not touch the network')
      }
      try {
        const report = await checkOffline(config, { lock })
        expect(report.mode).toBe('offline')
        expect(report.exitCode).toBe(ExitCode.DRIFT) // chart.tsx's stale tag
        expect(
          report.results.filter((r) => r.verdict === 'changed-since-lock'),
        ).toHaveLength(0)
      } finally {
        globalThis.fetch = realFetch
      }
    })
  })

  it('catches a file edited since the lock', async () => {
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      const file = uiFile(config, 'button.tsx')
      const source = await readFile(file, 'utf8')
      await writeFile(
        file,
        source.replace('rounded-md', 'rounded-full'),
        'utf8',
      )

      const report = await checkOffline(config, { lock })
      const button = report.results.find((r) => r.file === 'button.tsx')
      expect(button?.verdict).toBe('changed-since-lock')
      expect(report.exitCode).toBe(ExitCode.DRIFT)
    })
  })

  it('catches a file added since the lock', async () => {
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      await writeFile(
        uiFile(config, 'new-thing.tsx'),
        'export function NewThing() {\n  return null\n}\n',
        'utf8',
      )

      const report = await checkOffline(config, { lock })
      expect(
        report.results.find((r) => r.file === 'new-thing.tsx')?.verdict,
      ).toBe('unlocked')
      expect(report.exitCode).toBe(ExitCode.DRIFT)
    })
  })

  it('escalates an unlocked file to authenticity under --strict', async () => {
    // Same claim as an untagged file: nobody has examined it. Under --strict
    // that is a statement about what the file *is*, not about whether it
    // changed, so it takes the authenticity code.
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      await writeFile(
        uiFile(config, 'new-thing.tsx'),
        '/** shadcn/ui — (ours) */\n\nexport function NewThing() {\n  return null\n}\n',
        'utf8',
      )

      expect((await checkOffline(config, { lock })).exitCode).toBe(
        ExitCode.DRIFT,
      )
      expect(
        (await checkOffline(config, { lock, strict: true })).exitCode,
      ).toBe(ExitCode.AUTHENTICITY)
    })
  })

  it('catches a file deleted since the lock', async () => {
    // Reporting only what is present would let a deletion pass silently, and a
    // deleted component is as much a change as an edited one.
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      await rm(uiFile(config, 'badge.tsx'))

      const report = await checkOffline(config, { lock })
      expect(report.results.find((r) => r.file === 'badge.tsx')?.verdict).toBe(
        'missing',
      )
      expect(report.exitCode).toBe(ExitCode.DRIFT)
    })
  })

  it('does not report every other file as deleted under --only', async () => {
    // A flag for narrowing the run must not manufacture findings about what it
    // narrowed away.
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      const report = await checkOffline(config, { lock, only: 'button.tsx' })
      expect(report.results.map((r) => r.file)).toEqual(['button.tsx'])
    })
  })

  it('keeps reporting a finding the lock recorded', async () => {
    // chart.tsx is tagged (patched) but identical to upstream — a stale tag.
    // A lock taken over that tree must go on reporting it rather than blessing
    // it, or `--update-lock` would become a way to silence findings.
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      expect(lock.components['chart.tsx']?.verdict).toBe('stale-tag')

      const report = await checkOffline(config, { lock })
      expect(report.results.find((r) => r.file === 'chart.tsx')?.verdict).toBe(
        'stale-tag',
      )
      expect(report.exitCode).toBe(ExitCode.DRIFT)
    })
  })

  it('refuses to run when the lock was hashed with a different formatter setting', async () => {
    // Every hash would mismatch at once, and forty findings that say nothing
    // about the code is worse than an error. That is exit 3 — the tool could
    // not form an opinion — not exit 1.
    await withCopy(async (config) => {
      const lock = await lockFor(config)
      expect(lock.formatted).toBe(true)

      const error = await checkOffline(config, { lock, format: false }).catch(
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(DriftError)
      expect((error as DriftError).exitCode).toBe(ExitCode.OPERATIONAL)
    })
  })
})

describe('readLock', () => {
  it('says there is no lock, rather than failing to parse one', async () => {
    await withCopy(async (config) => {
      const error = await readLock(config).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriftError)
      expect((error as DriftError).exitCode).toBe(ExitCode.OPERATIONAL)
      expect((error as DriftError).message).toContain(
        `no ${LOCKFILE_NAME} to check against`,
      )
    })
  })

  it('refuses a lock from a future version instead of misreading it', async () => {
    await withCopy(async (config) => {
      await writeFile(
        lockPath(config),
        JSON.stringify({ lockfileVersion: 99, components: {} }),
        'utf8',
      )
      const error = await readLock(config).catch((e: unknown) => e)
      expect((error as DriftError).exitCode).toBe(ExitCode.OPERATIONAL)
      expect((error as DriftError).message).toContain('version 99')
    })
  })

  it('round-trips through disk', async () => {
    await withCopy(async (config) => {
      const written = await lockFor(config)
      await writeLock(config, written)
      const read = await readLock(config)
      expect(read.components['button.tsx']).toEqual(
        written.components['button.tsx'],
      )
      expect(read.formatted).toBe(true)
    })
  })
})
