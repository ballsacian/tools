/**
 * Line diff, unified output.
 *
 * Implemented here rather than shelling out to `git diff --no-index` — which is
 * what the original script did — so the tool has no external process
 * dependency, works identically on every platform, and does not pay a spawn per
 * component.
 *
 * Textual, deliberately, not an AST comparison. The normalized diff is what a
 * human has to read to decide whether a change matters, so producing it is the
 * point; an AST comparison could answer "do these differ" and then be unable to
 * show its work. What made textual comparison viable was better normalization
 * (see `normalize.ts`), not a parser.
 */

export interface DiffResult {
  readonly differs: boolean
  /** Unified diff, empty when identical. */
  readonly diff: string
  readonly added: number
  readonly removed: number
}

type Op = 'equal' | 'add' | 'remove'
interface Edit {
  op: Op
  line: string
}

/** Longest common subsequence over lines, then a backtrack into edits. */
function diffLines(before: string[], after: string[]): Edit[] {
  const n = before.length
  const m = after.length

  // Trim the common prefix and suffix first. Two near-identical components
  // differ in a line or two, so this reduces the DP to almost nothing.
  let start = 0
  while (start < n && start < m && before[start] === after[start]) start++
  let endBefore = n
  let endAfter = m
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--
    endAfter--
  }

  const a = before.slice(start, endBefore)
  const b = after.slice(start, endAfter)

  const rows = a.length + 1
  const cols = b.length + 1
  const table: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]
    const next = table[i + 1]
    if (!row || !next) continue
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const edits: Edit[] = []
  for (let k = 0; k < start; k++)
    edits.push({ op: 'equal', line: before[k] ?? '' })

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push({ op: 'equal', line: a[i] ?? '' })
      i++
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      edits.push({ op: 'remove', line: a[i] ?? '' })
      i++
    } else {
      edits.push({ op: 'add', line: b[j] ?? '' })
      j++
    }
  }
  while (i < a.length) edits.push({ op: 'remove', line: a[i++] ?? '' })
  while (j < b.length) edits.push({ op: 'add', line: b[j++] ?? '' })

  for (let k = endBefore; k < n; k++)
    edits.push({ op: 'equal', line: before[k] ?? '' })

  return edits
}

export interface CompareOptions {
  /** Lines of unchanged context around each change. */
  context?: number
  beforeLabel?: string
  afterLabel?: string
}

export function compare(
  before: string,
  after: string,
  options: CompareOptions = {},
): DiffResult {
  if (before === after)
    return { differs: false, diff: '', added: 0, removed: 0 }

  const context = options.context ?? 3
  const edits = diffLines(before.split('\n'), after.split('\n'))

  const added = edits.filter((e) => e.op === 'add').length
  const removed = edits.filter((e) => e.op === 'remove').length
  if (added === 0 && removed === 0) {
    return { differs: false, diff: '', added: 0, removed: 0 }
  }

  // Keep only changed regions plus their context.
  const keep = new Array<boolean>(edits.length).fill(false)
  edits.forEach((edit, index) => {
    if (edit.op === 'equal') return
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(edits.length - 1, index + context);
      k++
    ) {
      keep[k] = true
    }
  })

  const lines: string[] = []
  if (options.beforeLabel) lines.push(`--- ${options.beforeLabel}`)
  if (options.afterLabel) lines.push(`+++ ${options.afterLabel}`)

  let skipping = false
  edits.forEach((edit, index) => {
    if (!keep[index]) {
      if (!skipping) {
        lines.push('@@')
        skipping = true
      }
      return
    }
    skipping = false
    lines.push(
      `${edit.op === 'add' ? '+' : edit.op === 'remove' ? '-' : ' '}${edit.line}`,
    )
  })

  return { differs: true, diff: lines.join('\n'), added, removed }
}
