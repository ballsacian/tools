import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from './config.js'
import { DriftError } from './errors.js'
import { ExitCode } from './exit-codes.js'
import { resolveFormatter, type Formatter } from './formatter.js'
import {
  isKnownState,
  looksLikeProvenance,
  parseHeader,
  validateHeader,
  type HeaderProblem,
  type ProvenanceHeader,
} from './header.js'
import {
  normalizeLocal,
  normalizeUpstream,
  type NormalizeContext,
} from './normalize.js'
import { compare } from './compare.js'
import {
  companionFiles,
  primaryFile,
  Registry,
  UnknownComponentError,
} from './registry.js'

export type Verdict =
  /** Declared state matches reality. */
  | 'clean'
  /** `(stock)` but differs — undeclared change. */
  | 'drift'
  /** `(patched)`/`(forked)` but identical — the tag is stale. */
  | 'stale-tag'
  /** The header names a component the registry has never served. */
  | 'unknown-component'
  /** No header; filename matches a registry component and the source does too. */
  | 'untracked-match'
  /** No header; filename matches a registry component but the source differs. */
  | 'untracked-drift'
  /** No header and no registry component by that name — ours. */
  | 'ours'
  /** A leading comment claims provenance but does not parse. */
  | 'malformed-header'
  /** `--offline`: the file's normalized hash differs from the lock's. */
  | 'changed-since-lock'
  /** `--offline`: the file is in `ui/` but the lock has never seen it. */
  | 'unlocked'
  /** `--offline`: the lock names a file that is no longer in `ui/`. */
  | 'missing'

export interface ComponentResult {
  readonly file: string
  readonly header: ProvenanceHeader | null
  readonly style: string | null
  readonly component: string | null
  readonly verdict: Verdict
  readonly problems: readonly HeaderProblem[]
  readonly diff: string
  readonly added: number
  readonly removed: number
  /** Extra files in the registry payload we did not compare (spec §14 Q2). */
  readonly companions: readonly string[]
  readonly note: string | null
  /**
   * `sha256-…` of the *normalized* local file (spec §7), so that formatting
   * churn does not change it. `null` only when the file could not be read.
   */
  readonly localHash: string | null
  /** The same, for the upstream side. `null` when upstream was never fetched. */
  readonly upstreamHash: string | null
}

export interface CheckReport {
  readonly config: ResolvedConfig
  readonly formatter: string | null
  readonly results: readonly ComponentResult[]
  readonly exitCode: ExitCode
  /** Where upstream was read from. Recorded in the lock file. */
  readonly registryBaseUrl: string
  /**
   * How the verdicts were reached.
   *
   * `offline` compares against `shadcn.lock.json` and cannot see upstream at
   * all — it answers "has anyone changed this since the lock was written?" and
   * nothing more. Carried on the report so the renderer and `--json` consumers
   * cannot present the two as the same claim.
   */
  readonly mode: 'network' | 'offline'
  /** `offline` only: when the lock was written. */
  readonly lockFetchedAt: string | null
}

export interface CheckOptions {
  readonly strict?: boolean
  readonly only?: string
  readonly format?: boolean
  readonly registry?: Registry
}

/** Minimal glob: `*` and `?` only. Enough for `--only` and `drift.ignore`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export async function listComponentFiles(
  config: ResolvedConfig,
  only?: string,
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(config.uiDir, { withFileTypes: true })
  } catch (cause) {
    throw new DriftError('could not read the ui directory', {
      exitCode: ExitCode.OPERATIONAL,
      detail: [config.uiDir, `resolved via ${config.uiDirSource}`],
      cause,
    })
  }

  const ignore = (config.overrides.ignore ?? []).map(globToRegExp)
  const onlyRe = only ? globToRegExp(only) : null

  return entries
    .filter((e) => e.isFile() && /\.(tsx|ts)$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => !ignore.some((re) => re.test(name)))
    .filter((name) => !onlyRe || onlyRe.test(name))
    .sort()
}

/**
 * Content hash of an already-normalized file.
 *
 * Hashing *after* normalization is what makes the lock file survive formatting
 * churn (spec §10): a Prettier run, a CRLF checkout or an added
 * `eslint-disable` all vanish before the hash is taken, so none of them
 * invalidate a lock.
 */
export function hashNormalized(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

/** Run `tasks` with bounded concurrency — polite to the registry, still fast. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        const item = items[index]
        if (item === undefined) continue
        results[index] = await fn(item)
      }
    },
  )
  await Promise.all(workers)
  return results
}

export async function check(
  config: ResolvedConfig,
  options: CheckOptions = {},
): Promise<CheckReport> {
  const files = await listComponentFiles(config, options.only)
  const registry =
    options.registry ??
    new Registry({
      ...(config.overrides.registryAllowlist
        ? { allowlist: config.overrides.registryAllowlist }
        : {}),
    })

  const resolved =
    options.format === false
      ? null
      : await resolveFormatter(
          config.projectRoot,
          path.join(config.uiDir, files[0] ?? 'button.tsx'),
        )
  const format: Formatter = resolved
    ? resolved.format
    : (source) => Promise.resolve(source)

  const ctx: NormalizeContext = {
    aliases: config.aliases,
    registryStyle: config.registryStyle,
  }

  // One request settles "does this component exist" for the whole directory,
  // and is what lets an unheaded file be identified by filename at all.
  let index: string[] = []
  try {
    index = await registry.fetchIndex()
  } catch {
    // Non-fatal: without it we simply probe per component and let a 404 answer.
    index = []
  }

  const results = await mapLimit(files, 8, (file) =>
    checkOne(file, {
      config,
      ctx,
      registry,
      format,
      index,
      strict: options.strict ?? false,
    }),
  )

  return {
    config,
    formatter: resolved?.source ?? null,
    results,
    exitCode: exitCodeFor(results, options.strict ?? false),
    registryBaseUrl: registry.baseUrl,
    mode: 'network',
    lockFetchedAt: null,
  }
}

interface CheckOneContext {
  config: ResolvedConfig
  ctx: NormalizeContext
  registry: Registry
  format: Formatter
  index: string[]
  strict: boolean
}

async function checkOne(
  file: string,
  c: CheckOneContext,
): Promise<ComponentResult> {
  const source = await readFile(path.join(c.config.uiDir, file), 'utf8')
  const header = parseHeader(source)
  const base = path.basename(file, path.extname(file))

  const empty = {
    file,
    header,
    problems: [] as HeaderProblem[],
    diff: '',
    added: 0,
    removed: 0,
    companions: [] as string[],
    localHash: null as string | null,
    upstreamHash: null as string | null,
  }

  // Only for the paths that never reach a comparison. The comparison already
  // normalizes and formats the local side, so those reuse its result rather
  // than paying a second Prettier invocation per file.
  const localHash = async () =>
    hashNormalized(await c.format(normalizeLocal(source, c.ctx)))

  if (header) {
    const problems = validateHeader(header)

    if (isKnownState(header.state) && header.state === 'ours') {
      // Still hashed. `(ours)` means "no registry component corresponds", not
      // "do not watch this file" — `--offline` must still notice it changing.
      return {
        ...empty,
        problems,
        style: null,
        component: null,
        verdict: 'ours',
        note: null,
        localHash: await localHash(),
      }
    }

    const style = header.style ?? c.config.registryStyle
    const component = header.component ?? base
    const comparison = await compareAgainstRegistry(
      file,
      source,
      style,
      component,
      c,
    )
    if ('error' in comparison) {
      return {
        ...empty,
        problems,
        style,
        component,
        verdict: 'unknown-component',
        note: comparison.error,
        localHash: await localHash(),
      }
    }

    const declaredStock = header.state === 'stock'
    const verdict: Verdict = comparison.differs
      ? declaredStock
        ? 'drift'
        : 'clean'
      : declaredStock
        ? 'clean'
        : 'stale-tag'

    return {
      ...empty,
      problems,
      style,
      component,
      verdict,
      diff: comparison.diff,
      added: comparison.added,
      removed: comparison.removed,
      companions: comparison.companions,
      note: null,
      localHash: hashNormalized(comparison.normalizedLocal),
      upstreamHash: hashNormalized(comparison.normalizedUpstream),
    }
  }

  // A comment that claims provenance but will not parse must be reported as
  // such. Falling through to the untracked path would discard the file's
  // declared intent and report a deliberate patch as undeclared drift — the
  // tool contradicting a header it is looking straight at.
  if (looksLikeProvenance(source)) {
    return {
      ...empty,
      style: null,
      component: null,
      verdict: 'malformed-header',
      problems: [
        {
          code: 'unknown-state',
          message:
            'comment mentions shadcn/ui but does not match the header grammar',
        },
      ],
      note: 'expected: /** shadcn/ui — <style>/<component> (<state>) — <reason> */',
      localHash: await localHash(),
    }
  }

  // Tier 0: no header. Identify by filename — the shadcn CLI names files after
  // components, so this resolves the overwhelming majority.
  if (c.index.length > 0 && !c.index.includes(base)) {
    return {
      ...empty,
      style: null,
      component: null,
      verdict: 'ours',
      note: null,
      localHash: await localHash(),
    }
  }

  const comparison = await compareAgainstRegistry(
    file,
    source,
    c.config.registryStyle,
    base,
    c,
  )
  if ('error' in comparison) {
    return {
      ...empty,
      style: null,
      component: null,
      verdict: 'ours',
      note: null,
      localHash: await localHash(),
    }
  }

  return {
    ...empty,
    style: c.config.registryStyle,
    component: base,
    verdict: comparison.differs ? 'untracked-drift' : 'untracked-match',
    diff: comparison.diff,
    added: comparison.added,
    removed: comparison.removed,
    companions: comparison.companions,
    note: 'inferred from the filename; no provenance header',
    localHash: hashNormalized(comparison.normalizedLocal),
    upstreamHash: hashNormalized(comparison.normalizedUpstream),
  }
}

export type Comparison =
  | {
      differs: boolean
      diff: string
      added: number
      removed: number
      companions: string[]
      /** Both sides after §7, which is what the lock file hashes. */
      normalizedUpstream: string
      normalizedLocal: string
    }
  | { error: string }

export interface CompareRequest {
  readonly registry: Registry
  readonly format: Formatter
  readonly ctx: NormalizeContext
  /** Registry style, e.g. `new-york-v4`. */
  readonly style: string
  /** Registry component name, e.g. `button`. */
  readonly component: string
  /** The local file's source, exactly as it sits on disk. */
  readonly source: string
  /** What the local side is called in the diff header. */
  readonly label: string
}

/**
 * Normalize both sides and diff them.
 *
 * Shared with `init` deliberately. The normalization order is load-bearing
 * (spec §7.1: with step 5 but not step 7, 0 of 8 stock components reconcile),
 * so a second copy of this sequence for autodiscovery would be a second place
 * for that ordering to rot — and `init` would then propose `(patched)` for
 * files `check` calls `(stock)`, which is the tool disagreeing with itself.
 */
export async function compareWithRegistry(
  request: CompareRequest,
): Promise<Comparison> {
  const { registry, format, ctx, style, component, source, label } = request
  let upstreamRaw: string
  let companions: string[]
  try {
    const payload = await registry.fetchComponent(style, component)
    upstreamRaw = primaryFile(payload, component).content ?? ''
    companions = companionFiles(payload, component)
  } catch (error) {
    if (error instanceof UnknownComponentError) return { error: error.message }
    throw error
  }

  const upstream = await format(normalizeUpstream(upstreamRaw, ctx))
  const local = await format(normalizeLocal(source, ctx))
  const result = compare(upstream, local, {
    beforeLabel: `registry ${style}/${component}`,
    afterLabel: label,
  })
  return {
    ...result,
    companions,
    normalizedUpstream: upstream,
    normalizedLocal: local,
  }
}

async function compareAgainstRegistry(
  file: string,
  source: string,
  style: string,
  component: string,
  c: CheckOneContext,
): Promise<Comparison> {
  return compareWithRegistry({
    registry: c.registry,
    format: c.format,
    ctx: c.ctx,
    style,
    component,
    source,
    label: file,
  })
}

/**
 * Aggregate verdicts into one exit code.
 *
 * Authenticity outranks drift: "this is not the component it claims to be" is a
 * worse thing to learn than "this component changed".
 */
export function exitCodeFor(
  results: readonly ComponentResult[],
  strict: boolean,
): ExitCode {
  const authenticity = results.some(
    (r) =>
      r.verdict === 'unknown-component' ||
      (strict &&
        (r.verdict === 'untracked-drift' || r.verdict === 'untracked-match')) ||
      (strict && r.verdict === 'ours' && r.header === null) ||
      // Offline. A file the lock has never seen is the same claim as an
      // untagged one: nobody has examined it.
      (strict && r.verdict === 'unlocked'),
  )
  if (authenticity) return ExitCode.AUTHENTICITY

  const drift = results.some(
    (r) =>
      r.verdict === 'drift' ||
      r.verdict === 'malformed-header' ||
      r.verdict === 'stale-tag' ||
      r.verdict === 'untracked-drift' ||
      r.verdict === 'changed-since-lock' ||
      r.verdict === 'unlocked' ||
      r.verdict === 'missing' ||
      r.problems.some((p) => p.code !== 'todo-reason') ||
      (strict && r.problems.length > 0),
  )
  return drift ? ExitCode.DRIFT : ExitCode.OK
}
