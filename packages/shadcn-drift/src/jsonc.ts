import { readFile } from 'node:fs/promises'
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser'
import { operational } from './errors.js'

/**
 * Read a JSON-with-comments file — `tsconfig.json` and friends.
 *
 * We take the `jsonc-parser` dependency rather than stripping comments with a
 * regex because a naive stripper eats `//` inside string values. A `tsconfig`
 * containing a URL would parse to garbage, and the resulting misresolved alias
 * would surface much later as "every component drifted", which is the single
 * most confusing way this tool can fail.
 */
export async function readJsonc<T>(path: string, what: string): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    throw operational(`could not read ${what}`, [path], cause)
  }
  return parseJsoncText<T>(text, path, what)
}

export function parseJsoncText<T>(text: string, path: string, what: string): T {
  const errors: { error: number; offset: number; length: number }[] = []
  // `allowTrailingComma` matches what TypeScript itself accepts in a tsconfig.
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as T | undefined

  if (errors.length > 0) {
    const [first] = errors
    const line = first ? text.slice(0, first.offset).split('\n').length : 0
    throw operational(`could not parse ${what}`, [
      path,
      first
        ? `${printParseErrorCode(first.error)} at line ${String(line)}`
        : 'unknown parse error',
    ])
  }

  if (value === undefined || value === null || typeof value !== 'object') {
    throw operational(`${what} is not a JSON object`, [path])
  }

  return value
}
