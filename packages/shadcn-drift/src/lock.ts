import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  exitCodeFor,
  hashNormalized,
  listComponentFiles,
  mapLimit,
  type CheckReport,
  type ComponentResult,
  type Verdict,
} from './check.js'
import type { ResolvedConfig } from './config.js'
import { operational } from './errors.js'
import { resolveFormatter, type Formatter } from './formatter.js'
import {
  looksLikeProvenance,
  parseHeader,
  validateHeader,
  type HeaderProblem,
} from './header.js'
import { normalizeLocal, type NormalizeContext } from './normalize.js'
import { readJsonc } from './jsonc.js'

/**
 * The lock file and `--offline` (spec §10).
 *
 * **Be precise about what offline mode proves.** It answers exactly one
 * question — *"has anyone changed this since the lock was written?"* — and it
 * answers it deterministically, without a network, which is what makes it
 * usable from `lint` and a pre-commit hook.
 *
 * It **cannot** detect that *upstream* moved. Nothing network-free can: the
 * lock is a record of one past conversation with the registry, and the registry
 * is unversioned and can change without notice — which is exactly what happened
 * to this package's own ancestor, turning a green check red overnight with
 * nothing in the consuming repo having moved.
 *
 * Selling this as full drift detection would be the one way to make the tool
 * actively harmful, because it is precisely the check people would then stop
 * running. The split the README states, `--help` repeats, and the report itself
 * prints on every offline run:
 *
 *  - `--offline` → every CI run, every commit.
 *  - the default network check → a scheduled job, and before any
 *    `shadcn add -o`.
 */

export const LOCKFILE_VERSION = 1
export const LOCKFILE_NAME = 'shadcn.lock.json'

export interface LockEntry {
  /** The registry URL this file was compared against. `null` for `(ours)`. */
  readonly source: string | null
  /** The header state as written, or `null` when the file carries no header. */
  readonly state: string | null
  /**
   * The verdict the network check reached when the lock was written.
   *
   * Replayed by `--offline` for any file that has not changed since. Recording
   * it is what keeps a lock taken over a drifted tree from reading as clean
   * forever after: the finding is carried in the lock rather than forgotten.
   */
  readonly verdict: Verdict
  /** `sha256-…` of the normalized upstream. `null` when never fetched. */
  readonly upstream: string | null
  /** `sha256-…` of the normalized local file. */
  readonly local: string
  readonly fetchedAt: string
}

export interface LockFile {
  readonly lockfileVersion: number
  /** Recorded so a style change is visible as a reason to refresh. */
  readonly registryStyle: string
  readonly registry: string
  /**
   * Whether the hashes were taken after the formatter pass (§7 step 8).
   *
   * Checked on every offline run. Hashing formatted content and then comparing
   * it against unformatted content makes *every* file mismatch at once, and the
   * resulting wall of findings says nothing about the code — so a mismatch here
   * is an operational failure, not forty findings.
   */
  readonly formatted: boolean
  readonly components: Readonly<Record<string, LockEntry>>
}

export function lockPath(config: ResolvedConfig): string {
  return path.join(config.projectRoot, LOCKFILE_NAME)
}

/** Build a lock from a completed network check. */
export function buildLock(report: CheckReport): LockFile {
  const fetchedAt = new Date().toISOString()
  const components: Record<string, LockEntry> = {}

  for (const result of report.results) {
    if (result.localHash === null) continue
    components[result.file] = {
      source:
        result.style && result.component
          ? `${report.registryBaseUrl}/r/styles/${result.style}/${result.component}.json`
          : null,
      state: result.header?.state ?? null,
      verdict: result.verdict,
      upstream: result.upstreamHash,
      local: result.localHash,
      fetchedAt,
    }
  }

  return {
    lockfileVersion: LOCKFILE_VERSION,
    registryStyle: report.config.registryStyle,
    registry: report.registryBaseUrl,
    formatted: report.formatter !== null,
    components,
  }
}

export async function writeLock(
  config: ResolvedConfig,
  lock: LockFile,
): Promise<string> {
  const file = lockPath(config)
  await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  return file
}

export async function readLock(config: ResolvedConfig): Promise<LockFile> {
  const file = lockPath(config)

  // "There is no lock" and "the lock is corrupt" both exit 3, but they are not
  // the same instruction to the reader, and `readJsonc` cannot tell them apart
  // for us — it reports both as a failure to read.
  try {
    await readFile(file, 'utf8')
  } catch (cause) {
    throw operational(
      `no ${LOCKFILE_NAME} to check against`,
      [
        file,
        'Run `shadcn-drift --update-lock` once, with a network, and commit the result.',
      ],
      cause,
    )
  }

  const raw = await readJsonc<Partial<LockFile>>(file, LOCKFILE_NAME)

  if (raw.lockfileVersion !== LOCKFILE_VERSION) {
    throw operational(
      `${LOCKFILE_NAME} is version ${String(raw.lockfileVersion)}`,
      [
        file,
        `This build understands version ${String(LOCKFILE_VERSION)}.`,
        'Refresh it with `shadcn-drift --update-lock`.',
      ],
    )
  }
  if (!raw.components || typeof raw.components !== 'object') {
    throw operational(`${LOCKFILE_NAME} has no components`, [file])
  }

  return {
    lockfileVersion: raw.lockfileVersion,
    registryStyle: raw.registryStyle ?? '',
    registry: raw.registry ?? '',
    formatted: raw.formatted ?? false,
    components: raw.components,
  }
}

export interface OfflineOptions {
  readonly strict?: boolean
  readonly only?: string
  readonly format?: boolean
  /** Injected by tests; read from `projectRoot` otherwise. */
  readonly lock?: LockFile
}

/**
 * Verify `ui/` against the lock. No network, ever.
 *
 * Produces the same {@link CheckReport} shape as the network path so `--json`
 * consumers and the renderer need no second code path — with `mode: 'offline'`
 * set, which is how both of them know not to present this as a claim about
 * upstream.
 */
export async function checkOffline(
  config: ResolvedConfig,
  options: OfflineOptions = {},
): Promise<CheckReport> {
  const lock = options.lock ?? (await readLock(config))
  const files = await listComponentFiles(config, options.only)

  const resolved =
    options.format === false
      ? null
      : await resolveFormatter(
          config.projectRoot,
          path.join(config.uiDir, files[0] ?? 'button.tsx'),
        )

  // A lock hashed with the formatter, verified without one (or the reverse),
  // mismatches on every single file. That is the tool failing to reach an
  // opinion, not forty findings about the code, so it exits 3.
  if (lock.formatted !== (resolved !== null)) {
    throw operational(
      `${LOCKFILE_NAME} was written ${lock.formatted ? 'with' : 'without'} a formatter, but this run has ${resolved ? 'one' : 'none'}`,
      [
        lockPath(config),
        'Every hash would mismatch, which would read as drift in every file.',
        resolved
          ? 'Re-run with --no-format, or refresh the lock with --update-lock.'
          : "Install the project's Prettier, or refresh the lock with --update-lock.",
      ],
    )
  }

  const format: Formatter = resolved
    ? resolved.format
    : (source) => Promise.resolve(source)
  const ctx: NormalizeContext = {
    aliases: config.aliases,
    registryStyle: config.registryStyle,
  }

  const results = await mapLimit(files, 8, (file) =>
    offlineOne(file, { config, ctx, format, lock }),
  )

  // A locked file that is no longer on disk is as much a change as an edited
  // one; reporting only what is present would let a deletion pass silently.
  //
  // Suppressed under `--only`, where every file the glob excluded would
  // otherwise be reported as deleted — a flag for narrowing the run must not
  // manufacture findings about what it narrowed away.
  const seen = new Set(files)
  const removed: ComponentResult[] = (
    options.only ? [] : Object.keys(lock.components)
  )
    .filter((file) => !seen.has(file))
    .map((file) => ({
      file,
      header: null,
      style: null,
      component: null,
      verdict: 'missing' as const,
      problems: [],
      diff: '',
      added: 0,
      removed: 0,
      companions: [],
      note: 'in the lock, but no longer in ui/',
      localHash: null,
      upstreamHash: lock.components[file]?.upstream ?? null,
    }))

  const all = [...results, ...removed].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  )

  const fetchedAt =
    Object.values(lock.components)[0]?.fetchedAt ?? new Date(0).toISOString()

  return {
    config,
    formatter: resolved?.source ?? null,
    results: all,
    exitCode: exitCodeFor(all, options.strict ?? false),
    registryBaseUrl: lock.registry,
    mode: 'offline',
    lockFetchedAt: fetchedAt,
  }
}

interface OfflineContext {
  config: ResolvedConfig
  ctx: NormalizeContext
  format: Formatter
  lock: LockFile
}

async function offlineOne(
  file: string,
  c: OfflineContext,
): Promise<ComponentResult> {
  const source = await readFile(path.join(c.config.uiDir, file), 'utf8')
  const header = parseHeader(source)
  const localHash = hashNormalized(
    await c.format(normalizeLocal(source, c.ctx)),
  )
  const entry = c.lock.components[file]

  const problems: HeaderProblem[] = header
    ? validateHeader(header)
    : looksLikeProvenance(source)
      ? [
          {
            code: 'unknown-state',
            message:
              'comment mentions shadcn/ui but does not match the header grammar',
          },
        ]
      : []

  const base = {
    file,
    header,
    style: header?.style ?? null,
    component: header?.component ?? null,
    problems,
    diff: '',
    added: 0,
    removed: 0,
    companions: [] as string[],
    localHash,
    upstreamHash: entry?.upstream ?? null,
  }

  if (!entry) {
    return {
      ...base,
      verdict: 'unlocked',
      note: `not in ${LOCKFILE_NAME} — run --update-lock to record it`,
    }
  }

  if (entry.local !== localHash) {
    return {
      ...base,
      verdict: 'changed-since-lock',
      note: `normalized content differs from the lock written ${entry.fetchedAt}. Run without --offline to see the diff and whether upstream also moved.`,
    }
  }

  // Unchanged since the lock, so the lock's verdict still stands — including
  // when it was a finding. A lock taken over a drifted tree must keep reporting
  // that drift rather than blessing it.
  if (!header && looksLikeProvenance(source)) {
    return {
      ...base,
      verdict: 'malformed-header',
      note: 'expected: /** shadcn/ui — <style>/<component> (<state>) — <reason> */',
    }
  }

  return {
    ...base,
    verdict: entry.verdict,
    note:
      entry.verdict === 'clean' || entry.verdict === 'ours'
        ? null
        : `recorded by the lock on ${entry.fetchedAt}; unchanged since`,
  }
}
