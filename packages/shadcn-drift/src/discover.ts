import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compareWithRegistry, listComponentFiles, mapLimit } from './check.js'
import type { ResolvedConfig } from './config.js'
import { resolveFormatter, type Formatter } from './formatter.js'
import {
  formatHeader,
  looksLikeProvenance,
  parseHeader,
  TODO_REASON,
  type HeaderState,
  type ProvenanceHeader,
} from './header.js'
import type { NormalizeContext } from './normalize.js'
import { primaryFile, Registry } from './registry.js'

/**
 * Autodiscovery — the mode that makes the tool adoptable (spec §6).
 *
 * Without it, `shadcn-drift` only pays off on a repo that already writes
 * provenance headers, which at the time this was written meant exactly one repo
 * in the world. `init` identifies each unheaded file in `ui/` against the
 * registry and writes the header for you.
 *
 * The rule that makes it safe to re-run: **it only ever adds headers.** It never
 * rewrites or removes one. `shadcn add -o` destroys headers by overwriting the
 * file, so re-running `init` afterwards is the intended recovery path — and
 * that is only true if a second run cannot quietly revise a human's `(patched)`
 * reason into `TODO`.
 */

/** Why a file was left alone. */
export type SkipReason =
  /** Already carries a parseable header. Not ours to revise. */
  | 'has-header'
  /**
   * The leading comment claims shadcn/ui provenance but does not parse.
   *
   * Prepending a second header here would leave the file with two competing
   * provenance claims, and `parseHeader` only reads the first — so the broken
   * one would go on being invisible while the file *looked* fixed. It is
   * reported for a human instead.
   */
  | 'malformed-header'

/** How the file was matched to a registry component. */
export type MatchMethod = 'filename' | 'exports'

export interface InitProposal {
  /** File name within `ui/`. */
  readonly file: string
  readonly absolutePath: string
  /** Set when the file was left alone; `null` when a header is proposed. */
  readonly skipped: SkipReason | null
  /** The header already on the file, when there is one. */
  readonly existing: ProvenanceHeader | null
  /** The state `init` proposes writing. */
  readonly state: HeaderState
  /** `null` for `(ours)`. */
  readonly style: string | null
  readonly component: string | null
  readonly reason: string | null
  readonly matchedBy: MatchMethod | null
  readonly diff: string
  readonly added: number
  readonly removed: number
  /** Human-readable explanation of how this proposal was reached. */
  readonly note: string
}

export interface InitPlan {
  readonly config: ResolvedConfig
  readonly formatter: string | null
  readonly proposals: readonly InitProposal[]
  /** True when the export-fingerprint pass ran (it costs a fetch per entry). */
  readonly fingerprinted: boolean
}

export interface InitOptions {
  readonly only?: string
  readonly format?: boolean
  readonly registry?: Registry
}

/**
 * Names a module exports, as written.
 *
 * Deliberately a scan rather than a parse: the package has near-zero runtime
 * dependencies by design (it runs under `npx`, so install time is felt on every
 * invocation), and adding a TypeScript parser to recover a list of identifiers
 * would be the largest dependency in the tool by an order of magnitude. A false
 * positive here costs a wrong suggestion on a prompt the user is already
 * reading; it cannot silently rewrite anything.
 */
export function exportedSymbols(source: string): Set<string> {
  const names = new Set<string>()

  for (const match of source.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) names.add(match[1])
  }
  for (const match of source.matchAll(
    /\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) names.add(match[1])
  }
  for (const match of source.matchAll(
    /\bexport\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) names.add(match[1])
  }
  // `export { Avatar, AvatarImage as Image, type Props }` — the *exported*
  // name is what another file sees, so `as` takes the right-hand side.
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const cleaned = part.replace(/\btype\s+/g, '').trim()
      if (!cleaned) continue
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(cleaned)
      const name = alias?.[1] ?? cleaned
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }

  return names
}

/**
 * How alike two export sets are, as a Jaccard ratio.
 *
 * `export { Avatar, AvatarImage, AvatarFallback }` is close to unique across the
 * registry, which is what makes this a usable fallback at all.
 */
export function similarity(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const name of a) if (b.has(name)) shared++
  return shared / (a.size + b.size - shared)
}

/** Shared symbols between two export sets. */
function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0
  for (const name of a) if (b.has(name)) shared++
  return shared
}

interface Fingerprint {
  readonly name: string
  readonly symbols: Set<string>
}

/**
 * Match a renamed file against the registry by what it exports.
 *
 * Two guards, both against the same failure — confidently writing a header that
 * names the wrong component, which is worse than writing none. A wrong
 * `(stock)` tag reports permanent drift; a wrong `(patched)` tag suppresses a
 * real one.
 *
 *  - at least two shared symbols, so a lone `cn` or `Root` cannot carry a match
 *  - a clear winner: a tie at the top is reported as no match, not a coin flip
 */
export function bestFingerprint(
  symbols: ReadonlySet<string>,
  candidates: readonly Fingerprint[],
  threshold = 0.5,
): Fingerprint | null {
  let best: Fingerprint | null = null
  let bestScore = 0
  let tied = false

  for (const candidate of candidates) {
    if (sharedCount(symbols, candidate.symbols) < 2) continue
    const score = similarity(symbols, candidate.symbols)
    if (score < threshold) continue
    if (score > bestScore) {
      best = candidate
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }

  return tied ? null : best
}

/** Everything `init` needs about one candidate file, gathered once. */
interface Candidate {
  file: string
  absolutePath: string
  source: string
  base: string
}

export async function planInit(
  config: ResolvedConfig,
  options: InitOptions = {},
): Promise<InitPlan> {
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

  const candidates: Candidate[] = []
  const skipped: InitProposal[] = []

  for (const file of files) {
    const absolutePath = path.join(config.uiDir, file)
    const source = await readFile(absolutePath, 'utf8')
    const existing = parseHeader(source)

    if (existing) {
      skipped.push(
        leftAlone(file, absolutePath, 'has-header', existing, {
          state: 'ours',
          note: `already tagged (${existing.state}) — init never rewrites a header`,
        }),
      )
      continue
    }
    if (looksLikeProvenance(source)) {
      skipped.push(
        leftAlone(file, absolutePath, 'malformed-header', null, {
          state: 'ours',
          note: 'leading comment claims shadcn/ui provenance but does not parse — fix it by hand, adding a second header would hide it',
        }),
      )
      continue
    }

    candidates.push({
      file,
      absolutePath,
      source,
      base: path.basename(file, path.extname(file)),
    })
  }

  let index: string[] = []
  try {
    index = await registry.fetchIndex()
  } catch {
    // Non-fatal. Without the index we cannot rule a name out cheaply, so every
    // candidate is probed and a 404 answers instead.
    index = []
  }

  // The fingerprint pass costs one fetch per registry entry, so it runs only
  // when some file actually needs it — a repo whose files the CLI named is the
  // overwhelming majority, and it should pay nothing for the rename case.
  const needsFingerprint = candidates.filter(
    (candidate) => index.length > 0 && !index.includes(candidate.base),
  )
  const fingerprints =
    needsFingerprint.length > 0
      ? await loadFingerprints(registry, config.registryStyle, index)
      : []

  const proposals = await mapLimit(candidates, 8, async (candidate) => {
    const byFilename = index.length === 0 || index.includes(candidate.base)
    let component: string | null = byFilename ? candidate.base : null
    let matchedBy: MatchMethod | null = byFilename ? 'filename' : null

    if (!component && fingerprints.length > 0) {
      const match = bestFingerprint(
        exportedSymbols(candidate.source),
        fingerprints,
      )
      if (match) {
        component = match.name
        matchedBy = 'exports'
      }
    }

    if (!component) {
      return ours(
        candidate,
        index.length > 0
          ? 'no registry component by this name, and its exports match none either'
          : 'no registry component by this name',
      )
    }

    const comparison = await compareWithRegistry({
      registry,
      format,
      ctx,
      style: config.registryStyle,
      component,
      source: candidate.source,
      label: candidate.file,
    })

    // A filename guess that 404s is not a finding here the way it is in
    // `check` — nothing claimed provenance, so the honest answer is `(ours)`.
    if ('error' in comparison) {
      return ours(
        candidate,
        'the registry has never served a component by this name',
      )
    }

    const matchNote =
      matchedBy === 'exports'
        ? `matched by its exported symbols, not its filename — verify this is really ${component}`
        : 'matched by filename'

    if (!comparison.differs) {
      return {
        file: candidate.file,
        absolutePath: candidate.absolutePath,
        skipped: null,
        existing: null,
        state: 'stock' as const,
        style: config.registryStyle,
        component,
        reason: null,
        matchedBy,
        diff: '',
        added: 0,
        removed: 0,
        note: `identical to the registry after normalization · ${matchNote}`,
      }
    }

    return {
      file: candidate.file,
      absolutePath: candidate.absolutePath,
      skipped: null,
      // Always `patched`, never `forked` — see `PATCHED_NOT_FORKED` below.
      state: 'patched' as const,
      existing: null,
      style: config.registryStyle,
      component,
      reason: TODO_REASON,
      matchedBy,
      diff: comparison.diff,
      added: comparison.added,
      removed: comparison.removed,
      note: `differs from the registry (+${String(comparison.added)}/-${String(comparison.removed)}) · ${matchNote}`,
    }
  })

  const all = [...skipped, ...proposals].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  )

  return {
    config,
    formatter: resolved?.source ?? null,
    proposals: all,
    fingerprinted: fingerprints.length > 0,
  }
}

/**
 * Why `init` never proposes `(forked)` on its own (spec §14 Q3, resolved).
 *
 * A similarity cutoff would have to be invented, not derived — there is no
 * number at which "heavily patched" becomes "rewritten", because the difference
 * is about intent rather than line count. The two mistakes are not symmetric:
 *
 *  - Proposing `patched` for something genuinely forked costs a diff the human
 *    reads once and downgrades.
 *  - Proposing `forked` for something merely patched turns upstream from a
 *    contract into ancestry, and the file stops being compared at all. The tool
 *    goes quiet about a component forever, which is the failure it exists to
 *    prevent.
 *
 * So the floor is `patched` and `forked` is a human's word. The interactive
 * prompt offers it; `--yes` never picks it.
 */
export const PATCHED_NOT_FORKED = true

function ours(candidate: Candidate, why: string): InitProposal {
  return {
    file: candidate.file,
    absolutePath: candidate.absolutePath,
    skipped: null,
    existing: null,
    state: 'ours',
    style: null,
    component: null,
    reason: null,
    matchedBy: null,
    diff: '',
    added: 0,
    removed: 0,
    note: why,
  }
}

function leftAlone(
  file: string,
  absolutePath: string,
  skipped: SkipReason,
  existing: ProvenanceHeader | null,
  rest: { state: HeaderState; note: string },
): InitProposal {
  return {
    file,
    absolutePath,
    skipped,
    existing,
    state: rest.state,
    style: null,
    component: null,
    reason: null,
    matchedBy: null,
    diff: '',
    added: 0,
    removed: 0,
    note: rest.note,
  }
}

async function loadFingerprints(
  registry: Registry,
  style: string,
  names: readonly string[],
): Promise<Fingerprint[]> {
  const loaded = await mapLimit(names, 8, async (name) => {
    try {
      const payload = await registry.fetchComponent(style, name)
      const content = primaryFile(payload, name).content ?? ''
      return { name, symbols: exportedSymbols(content) }
    } catch {
      // A component the registry lists but will not serve in this style is not
      // a failure of `init` — it just cannot be a fingerprint candidate.
      return null
    }
  })
  return loaded.filter((entry): entry is Fingerprint => entry !== null)
}

/**
 * Put the header at the very top of the file.
 *
 * It must lead, because `parseHeader` only honours a block comment that *starts*
 * the file — treating a comment further down as provenance would let a stray
 * comment reclassify a component. That includes going above a `'use client'`
 * directive: comments are trivia and do not break a directive prologue, so the
 * directive still applies.
 */
export function insertHeader(source: string, header: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  // A byte-order mark has to stay the first thing in the file, so the header
  // goes after it rather than before it. Dropping it instead would be `init`
  // changing content while claiming only to add a comment, and the file would
  // then read as modified on the next run.
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const body = bom ? source.slice(1) : source
  return `${bom}${header}${eol}${eol}${body}`
}

export interface WriteResult {
  readonly file: string
  readonly header: string
}

/** Write one proposal's header to disk. */
export async function applyProposal(
  proposal: InitProposal,
): Promise<WriteResult> {
  const header = formatHeader({
    state: proposal.state,
    style: proposal.style,
    component: proposal.component,
    reason: proposal.reason,
  })
  const source = await readFile(proposal.absolutePath, 'utf8')
  await writeFile(proposal.absolutePath, insertHeader(source, header), 'utf8')
  return { file: proposal.file, header }
}

/** Render a proposal's header without writing it — used by `--dry-run`. */
export function proposedHeader(proposal: InitProposal): string {
  return formatHeader({
    state: proposal.state,
    style: proposal.style,
    component: proposal.component,
    reason: proposal.reason,
  })
}

/**
 * Apply a human's override to a proposal, preserving everything else.
 *
 * `(ours)` is always available — it is the one tag that needs no registry
 * component, since asserting that none corresponds is the whole claim it
 * makes. The other three need one, so a file the registry could not identify
 * cannot be retagged into them and is returned unchanged; the prompt uses
 * {@link writableStates} so that choice is never offered in the first place.
 */
export function retag(
  proposal: InitProposal,
  state: HeaderState,
  reason?: string | null,
): InitProposal {
  if (state === 'ours') {
    return {
      ...proposal,
      state,
      style: null,
      component: null,
      reason: reason ?? null,
    }
  }
  if (!proposal.component || !proposal.style) return proposal
  return {
    ...proposal,
    state,
    reason:
      state === 'stock' ? null : (reason ?? proposal.reason ?? TODO_REASON),
  }
}

/** The states this proposal could legally be written as. */
export function writableStates(proposal: InitProposal): HeaderState[] {
  return proposal.component && proposal.style
    ? ['stock', 'patched', 'forked', 'ours']
    : ['ours']
}
