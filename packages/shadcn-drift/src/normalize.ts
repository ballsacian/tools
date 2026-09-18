import { stripHeader } from './header.js'

/**
 * Reduce both sides of a comparison to a form where what remains is real.
 *
 * Every step here exists to delete a difference that is *not* drift. The
 * ordering matters and is documented per step; see spec §7, whose validation
 * table was measured against the live registry.
 */

export interface NormalizeContext {
  /** `components.json` aliases, verbatim. */
  readonly aliases: Readonly<Record<string, string>>
  /** e.g. `new-york-v4` — appears in upstream's own import paths. */
  readonly registryStyle: string
}

/** Extensions that carry no meaning across the alias boundary. */
const CODE_EXTENSIONS = /\.(tsx|ts|jsx|js|mjs|cjs)$/

/**
 * Apply `fn` to every module specifier, leaving the rest of the file alone.
 *
 * Rewriting via import specifiers rather than raw text substitution is what
 * keeps a className like `"@/lib/utils"` in a docstring from being silently
 * rewritten — and keeps a rule aimed at imports from corrupting source.
 */
export function mapImportSpecifiers(
  source: string,
  fn: (specifier: string) => string,
): string {
  return source.replace(
    /(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\2/g,
    (whole, lead: string, quote: string, specifier: string) => {
      const mapped = fn(specifier)
      return mapped === specifier ? whole : `${lead}${quote}${mapped}${quote}`
    },
  )
}

/** Step 0 — line endings. A CRLF checkout is not drift. */
export function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, '\n')
}

/**
 * Step 1 — the `'use client'` directive, dropped from *both* sides.
 *
 * Whether a file has one depends on the `rsc` setting and on which CLI version
 * added it, so its presence is version noise rather than a property of the
 * component.
 */
export function stripUseClient(source: string): string {
  return source.replace(/^['"]use client['"];?[ \t]*\r?\n\s*/m, '')
}

/**
 * Step 3 — our own `eslint-disable` blocks, dropped from the local side.
 *
 * Lint configuration that happens to live in the file. Upstream will never have
 * one, and without this a per-file lint exemption inside a `(stock)` component
 * registers as drift — the circularity that otherwise forces you to ignore the
 * whole directory, which also exempts the components you wrote.
 *
 * Runs *after* {@link stripHeader} so the provenance comment is still first.
 */
export function stripEslintDirectives(source: string): string {
  return source.replace(/^\/\*\s*eslint-disable[\s\S]*?\*\/[ \t]*\r?\n/gm, '')
}

interface AliasRule {
  readonly match: RegExp
  readonly replace: string
}

/**
 * Steps 4 and 5 — rewrite upstream's import specifiers into this project's.
 *
 * Derived from `components.json` aliases rather than hardcoded, with one
 * exception that cannot be: `new-york-v4` emits a bare `import { cn } from "cn"`
 * (and lists `"cn"` in the payload's `dependencies`) rather than
 * `@/lib/utils`. That is a package-shaped placeholder the CLI rewrites on
 * `add`, so alias-derived rules cannot catch it. Every shadcn component imports
 * `cn`, so omitting this rule fails every component in the directory — measured,
 * not theorised.
 */
export function buildAliasRules(ctx: NormalizeContext): AliasRule[] {
  const a = ctx.aliases
  const ui = a['ui'] ?? '@/components/ui'
  const utils = a['utils'] ?? '@/lib/utils'
  const lib = a['lib'] ?? '@/lib'
  const hooks = a['hooks'] ?? '@/hooks'
  const components = a['components'] ?? '@/components'
  const style = ctx.registryStyle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Most specific first: `@/lib/utils` must win over `@/lib/*`, and the
  // style-scoped registry path over the generic components path.
  return [
    { match: new RegExp(`^@/registry/${style}/ui/(.+)$`), replace: `${ui}/$1` },
    {
      match: new RegExp(`^@/registry/${style}/hooks/(.+)$`),
      replace: `${hooks}/$1`,
    },
    { match: new RegExp(`^@/registry/${style}/lib/utils$`), replace: utils },
    {
      match: new RegExp(`^@/registry/${style}/lib/(.+)$`),
      replace: `${lib}/$1`,
    },
    { match: /^@\/components\/ui\/(.+)$/, replace: `${ui}/$1` },
    { match: /^@\/lib\/utils$/, replace: utils },
    { match: /^@\/lib\/(.+)$/, replace: `${lib}/$1` },
    { match: /^@\/hooks\/(.+)$/, replace: `${hooks}/$1` },
    { match: /^@\/components\/(.+)$/, replace: `${components}/$1` },
    // The bare placeholder. See the note above.
    { match: /^cn$/, replace: utils },
  ]
}

export function rewriteUpstreamSpecifiers(
  source: string,
  ctx: NormalizeContext,
): string {
  const rules = buildAliasRules(ctx)
  return mapImportSpecifiers(source, (specifier) => {
    for (const rule of rules) {
      if (rule.match.test(specifier))
        return specifier.replace(rule.match, rule.replace)
    }
    return specifier
  })
}

/**
 * Step 6 — extension equivalence, applied to *both* sides.
 *
 * A project on Node subpath imports writes `#/lib/utils.ts` because `#/` is an `imports`
 * field and needs the extension; upstream writes `@/lib/utils`. No
 * `components.json` field describes that difference, so the alternative was a
 * per-project rewrite escape hatch. Stripping extensions from both sides is
 * generic, needs no configuration, and is correct everywhere — and it
 * reclassifies that repo's `chart.tsx`, currently `(patched)` for this reason
 * alone, back to `(stock)`.
 *
 * Only relative and alias-shaped specifiers are touched; a real package is left
 * exactly as written.
 */
export function stripImportExtensions(
  source: string,
  ctx: NormalizeContext,
): string {
  const prefixes = aliasPrefixes(ctx)
  return mapImportSpecifiers(source, (specifier) => {
    const isLocal =
      specifier.startsWith('.') || prefixes.some((p) => specifier.startsWith(p))
    return isLocal ? specifier.replace(CODE_EXTENSIONS, '') : specifier
  })
}

function aliasPrefixes(ctx: NormalizeContext): string[] {
  const found = new Set<string>(['@/', '#/', '~/'])
  for (const alias of Object.values(ctx.aliases)) {
    const match = /^([^a-zA-Z0-9]*[a-zA-Z0-9]*\/)/.exec(alias)
    if (match?.[1]) found.add(match[1])
  }
  return [...found]
}

/**
 * Step 7 — hoist, sort, and single-block the imports on both sides.
 *
 * The registry orders its imports differently from how the CLI leaves them on
 * disk, and the CLI's output carries a blank line between third-party and
 * aliased imports that the payload does not. Prettier preserves both — blank
 * lines between imports are meaningful to it — so neither normalizes away on
 * its own. With step 6 applied but not this one, all eight components measured
 * still reported drift.
 *
 * Only the *leading* import block is considered. Imports are top-level by
 * language rule, and scanning the whole file risks matching the word `import`
 * inside a string or template literal.
 */
export function canonicalizeImports(source: string): string {
  const lines = source.split('\n')
  const imports: string[] = []
  let index = 0
  let buffer: string[] = []

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (buffer.length > 0) {
      buffer.push(line)
      if (isStatementEnd(trimmed)) {
        imports.push(buffer.join('\n'))
        buffer = []
      }
      index++
      continue
    }

    if (trimmed === '') {
      index++
      continue
    }

    if (/^import\b/.test(trimmed)) {
      if (isStatementEnd(trimmed) && !/^import\s*$/.test(trimmed)) {
        imports.push(line)
      } else {
        buffer.push(line)
      }
      index++
      continue
    }

    break
  }

  if (buffer.length > 0) return source // unterminated; leave the file alone
  if (imports.length === 0) return source

  const body = lines
    .slice(index)
    .join('\n')
    .replace(/^\s*\n+/, '')
  const sorted = [...imports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `${sorted.join('\n')}\n\n${body}`
}

/** A specifier-terminated import: ends with a quoted module, optional `;`. */
function isStatementEnd(trimmed: string): boolean {
  return /(['"])[^'"]*\1\s*;?$/.test(trimmed)
}

/** Everything except formatting, for the upstream side. */
export function normalizeUpstream(
  source: string,
  ctx: NormalizeContext,
): string {
  let out = normalizeLineEndings(source)
  out = stripUseClient(out)
  out = rewriteUpstreamSpecifiers(out, ctx)
  out = stripImportExtensions(out, ctx)
  out = canonicalizeImports(out)
  return out
}

/** Everything except formatting, for the local side. */
export function normalizeLocal(source: string, ctx: NormalizeContext): string {
  let out = normalizeLineEndings(source)
  out = stripHeader(out)
  out = stripEslintDirectives(out)
  out = stripUseClient(out)
  out = stripImportExtensions(out, ctx)
  out = canonicalizeImports(out)
  return out
}
