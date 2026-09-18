/**
 * The provenance header — the tool's on-disk API.
 *
 * ```tsx
 * /** shadcn/ui — new-york-v4/avatar (stock) *\/
 * /** shadcn/ui — new-york-v4/input (patched) — fill changed to match token. *\/
 * /** shadcn/ui — (ours) — wraps Combobox with a create-new affordance. *\/
 * ```
 *
 * Grammar: a leading block comment, the literal marker `shadcn/ui`, a dash,
 * an optional `<style>/<component>` reference, a parenthesised state, and an
 * optional dash-separated reason.
 *
 * `(ours)` carries no component reference, because the whole claim it makes is
 * that the file does not correspond to a registry component. The `shadcn/ui`
 * marker still leads, so one scan finds every classified file regardless of
 * verdict — which is what `--strict` needs in order to tell "we wrote this" from
 * "nobody has looked at this yet".
 */

/** Tags a file may carry. See the spec §5. */
export const HEADER_STATES = ['stock', 'patched', 'forked', 'ours'] as const
export type HeaderState = (typeof HEADER_STATES)[number]

export interface ProvenanceHeader {
  /**
   * The tag exactly as written — deliberately *not* narrowed to
   * {@link HeaderState}.
   *
   * A typo'd tag like `(stok)` has to survive parsing so that
   * {@link validateHeader} can report it. Narrowing here would force
   * {@link parseHeader} to either cast (a lie, since the value is arbitrary
   * text from a file) or return `null`, and returning `null` would demote the
   * file to "no header" — turning a one-character typo into a silently skipped
   * component, which is the exact failure mode `--strict` exists to prevent.
   *
   * Use {@link isKnownState} to narrow.
   */
  readonly state: HeaderState | (string & Record<never, never>)
  /** Registry style, e.g. `new-york-v4`. `null` for `(ours)`. */
  readonly style: string | null
  /** Registry component, e.g. `avatar`. `null` for `(ours)`. */
  readonly component: string | null
  /** Free text after the second dash, trimmed. `null` when absent. */
  readonly reason: string | null
  /** The comment exactly as it appeared, for error messages. */
  readonly raw: string
}

export type HeaderProblemCode =
  | 'unknown-state'
  | 'missing-component'
  | 'unexpected-component'
  | 'missing-reason'
  | 'todo-reason'

export interface HeaderProblem {
  readonly code: HeaderProblemCode
  readonly message: string
}

/**
 * Any dash a human might type. The canonical form uses an em-dash, but nobody
 * should have a header rejected — and then be told their component drifted —
 * because they typed a hyphen.
 */
const DASH = '[\\u2014\\u2013-]'

const HEADER_RE = new RegExp(
  '^/\\*\\*?' + // block comment open
    '\\s*shadcn/ui\\s*' + // marker
    DASH +
    '\\s*' +
    '(?:([a-z0-9][a-z0-9.-]*)/([a-z0-9][a-z0-9.-]*)\\s*)?' + // style/component
    // `(state)` plus an optional qualifier inside the same parens. People
    // write `(patched, \`SelectTrigger\` only)` — a real select.tsx does —
    // and rejecting that would demote a perfectly clear header to "no
    // header", which is strictly worse than reading the leading word as the
    // state and folding the rest into the reason.
    '\\(\\s*([a-zA-Z-]+)\\b([^)]*)\\)' + // (state[, qualifier])
    // Everything from the state to the terminator is the reason. A leading dash
    // is stripped afterwards rather than required: the canonical one-liner uses
    // `— reason`, but a multi-line header puts its explanation on the following
    // lines with no separator at all, which is how a real sonner.tsx
    // was written. Demanding the dash rejected a perfectly good header.
    '([\\s\\S]*?)' + // reason
    '\\s*\\*/$',
)

/**
 * Pull the leading block comment off a source file.
 *
 * Only a comment that *starts* the file counts. A block comment further down is
 * ordinary documentation, and treating it as provenance would let a stray
 * comment silently reclassify a component.
 */
export function extractLeadingBlockComment(
  source: string,
): { comment: string; rest: string } | null {
  const leading = source.match(/^\s*/)?.[0].length ?? 0
  if (!source.startsWith('/*', leading)) return null
  const end = source.indexOf('*/', leading)
  if (end === -1) return null
  return {
    comment: source.slice(leading, end + 2),
    rest: source.slice(end + 2).replace(/^[ \t]*\r?\n/, ''),
  }
}

/** Parse a file's provenance header. `null` means the file carries none. */
export function parseHeader(source: string): ProvenanceHeader | null {
  const leading = extractLeadingBlockComment(source)
  if (!leading) return null

  // Collapse the comment to one line first: a multi-line header is still a
  // single logical statement.
  //
  // The negative lookahead is load-bearing. A naive `\**` here also eats the
  // `*` of the closing `*/` when the terminator sits on its own line — which is
  // how every real multi-line header is written:
  //
  //     /**
  //      * shadcn/ui — new-york-v4/input (patched)
  //      */        ← this line
  //
  // The comment then flattens to `… /`, the grammar fails to match, and the
  // file silently reports as having no header at all. Caught by running against
  // a production repo, where `input.tsx` and `select.tsx` are written this way.
  // Exactly one line break per match, and only horizontal whitespace around
  // it. `\s*` would swallow the *next* newline too, leaving that line's leading
  // `*` stranded mid-sentence and breaking the grammar just as thoroughly.
  const flat = leading.comment
    .replace(/[ \t]*\r?\n[ \t]*(?:\*(?!\/))?[ \t]*/g, ' ')
    .trim()
  const match = HEADER_RE.exec(flat)
  if (!match) return null

  const [, style, component, rawState, qualifier, reason] = match
  if (rawState === undefined) return null

  // An in-parens qualifier is part of the explanation, so it satisfies the
  // "patched must say why" rule rather than being discarded.
  const parts = [
    qualifier?.replace(/^[\s,;:—–-]+/, '').trim(),
    reason?.replace(/^[\s—–-]+/, '').trim(),
  ].filter((part): part is string => Boolean(part))

  return {
    state: rawState.toLowerCase(),
    style: style ?? null,
    component: component ?? null,
    reason: parts.length > 0 ? parts.join(' — ') : null,
    raw: leading.comment,
  }
}

/**
 * Does the leading comment *claim* to be provenance, whether or not it parses?
 *
 * The dangerous failure is a header that is almost right silently degrading to
 * "this file has no header", because the file then gets treated as untracked
 * and its declared intent is lost. Callers use this to report a malformed
 * header as a malformed header.
 */
export function looksLikeProvenance(source: string): boolean {
  const leading = extractLeadingBlockComment(source)
  return leading ? /\bshadcn\/ui\b/.test(leading.comment) : false
}

/** Remove the provenance header, leaving the rest of the file untouched. */
export function stripHeader(source: string): string {
  if (!parseHeader(source)) return source
  return extractLeadingBlockComment(source)?.rest ?? source
}

/** Render a header in canonical form. */
export function formatHeader(
  header: Pick<ProvenanceHeader, 'state' | 'style' | 'component' | 'reason'>,
): string {
  const ref =
    header.style && header.component
      ? `${header.style}/${header.component} `
      : ''
  const reason = header.reason ? ` — ${header.reason}` : ''
  return `/** shadcn/ui — ${ref}(${header.state})${reason} */`
}

/** What `init` writes when it can see *that* a file changed but not *why*. */
export const TODO_REASON = 'TODO: describe the change'

export function isTodoReason(reason: string | null): boolean {
  return reason !== null && /^todo\b/i.test(reason)
}

export function isKnownState(state: string): state is HeaderState {
  return (HEADER_STATES as readonly string[]).includes(state)
}

/**
 * Check a parsed header against the rules in §5. Returns every problem found,
 * rather than the first, so a single run tells you everything to fix.
 *
 * `todo-reason` is reported here but is only *fatal* under `--strict` — `init`
 * writes it deliberately, and failing immediately would make the tool's own
 * onboarding step leave the repo in a failing state.
 */
export function validateHeader(header: ProvenanceHeader): HeaderProblem[] {
  const problems: HeaderProblem[] = []

  if (!isKnownState(header.state)) {
    problems.push({
      code: 'unknown-state',
      message: `unknown state "(${header.state})" — expected one of ${HEADER_STATES.join(', ')}`,
    })
    return problems
  }

  if (header.state === 'ours') {
    if (header.style ?? header.component) {
      problems.push({
        code: 'unexpected-component',
        message:
          '(ours) must not name a registry component — that is the claim it contradicts',
      })
    }
    return problems
  }

  if (!header.style || !header.component) {
    problems.push({
      code: 'missing-component',
      message: `(${header.state}) must name its source as <style>/<component>`,
    })
  }

  if (header.state !== 'stock') {
    if (!header.reason) {
      problems.push({
        code: 'missing-reason',
        message: `(${header.state}) must say what changed and why`,
      })
    } else if (isTodoReason(header.reason)) {
      problems.push({
        code: 'todo-reason',
        message: `(${header.state}) still carries a TODO reason`,
      })
    }
  }

  return problems
}
