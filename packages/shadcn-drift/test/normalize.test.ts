import { describe, expect, it } from 'vitest'
import {
  canonicalizeImports,
  mapImportSpecifiers,
  normalizeLineEndings,
  normalizeLocal,
  normalizeUpstream,
  rewriteUpstreamSpecifiers,
  stripEslintDirectives,
  stripImportExtensions,
  stripUseClient,
  type NormalizeContext,
} from '../src/normalize.js'

/** A project on Node subpath imports: `#/` aliases with explicit extensions. */
const ctx: NormalizeContext = {
  registryStyle: 'new-york-v4',
  aliases: {
    components: '#/components',
    utils: '#/lib/utils',
    ui: '#/components/ui',
    lib: '#/lib',
    hooks: '#/hooks',
  },
}

describe('mapImportSpecifiers', () => {
  it('rewrites specifiers but leaves other strings alone', () => {
    const source = [
      "import { cn } from '@/lib/utils'",
      "const label = '@/lib/utils'", // not an import — must not change
    ].join('\n')
    const out = mapImportSpecifiers(source, (s) =>
      s === '@/lib/utils' ? '#/lib/utils' : s,
    )
    expect(out).toContain("import { cn } from '#/lib/utils'")
    expect(out).toContain("const label = '@/lib/utils'")
  })
})

describe('normalizeLineEndings', () => {
  it('treats a CRLF checkout as identical to LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\n')).toBe('a\nb\n')
  })
})

describe('stripUseClient', () => {
  it('removes the directive', () => {
    expect(stripUseClient("'use client'\n\nimport x")).toBe('import x')
  })
})

describe('stripEslintDirectives', () => {
  it('removes a vendored eslint-disable block', () => {
    // Without this, exempting a (stock) file from a lint rule registers as
    // drift — the circularity that otherwise forces ignoring the whole dir.
    const source =
      '/* eslint-disable no-shadow -- vendored:\n   upstream code */\nimport x\n'
    expect(stripEslintDirectives(source)).toBe('import x\n')
  })
})

describe('rewriteUpstreamSpecifiers', () => {
  it('rewrites the bare "cn" placeholder to the utils alias', () => {
    // new-york-v4 emits `from "cn"`, not `@/lib/utils`. Alias-derived rules
    // cannot catch it because it is not alias-shaped. Every component imports
    // cn, so missing this fails the entire directory.
    const out = rewriteUpstreamSpecifiers(`import { cn } from "cn"`, ctx)
    expect(out).toBe(`import { cn } from "#/lib/utils"`)
  })

  it('rewrites @/lib/utils to the utils alias', () => {
    expect(
      rewriteUpstreamSpecifiers(`import { cn } from "@/lib/utils"`, ctx),
    ).toContain('#/lib/utils')
  })

  it('prefers the utils alias over the generic lib rule', () => {
    const out = rewriteUpstreamSpecifiers(
      `import a from "@/lib/utils"\nimport b from "@/lib/x"`,
      ctx,
    )
    expect(out).toContain('"#/lib/utils"')
    expect(out).toContain('"#/lib/x"')
  })

  it('rewrites the style-scoped registry path', () => {
    const out = rewriteUpstreamSpecifiers(
      `import { Button } from "@/registry/new-york-v4/ui/button"`,
      ctx,
    )
    expect(out).toContain('"#/components/ui/button"')
  })

  it('leaves real packages untouched', () => {
    const source = `import { Slot } from "radix-ui"\nimport * as React from "react"`
    expect(rewriteUpstreamSpecifiers(source, ctx)).toBe(source)
  })
})

describe('stripImportExtensions', () => {
  it('drops extensions from aliased specifiers on both sides', () => {
    // #/ needs the extension (Node imports field); @/ does not. Neither says
    // anything about whether the component matches.
    expect(
      stripImportExtensions(`import { cn } from '#/lib/utils.ts'`, ctx),
    ).toBe(`import { cn } from '#/lib/utils'`)
  })

  it('drops extensions from relative specifiers', () => {
    expect(stripImportExtensions(`import x from './y.tsx'`, ctx)).toBe(
      `import x from './y'`,
    )
  })

  it('leaves a package name that merely ends in .js alone', () => {
    const source = `import x from 'some.js'`
    expect(stripImportExtensions(source, ctx)).toBe(source)
  })
})

describe('canonicalizeImports', () => {
  it('erases ordering and blank-line grouping differences', () => {
    // The registry orders imports differently than the CLI leaves them, and the
    // CLI inserts a blank line the payload lacks. Prettier preserves both.
    const upstream = [
      `import * as React from 'react'`,
      `import { cn } from '#/lib/utils'`,
      `import { Slot } from 'radix-ui'`,
      ``,
      `export const x = 1`,
    ].join('\n')
    const local = [
      `import * as React from 'react'`,
      `import { Slot } from 'radix-ui'`,
      ``,
      `import { cn } from '#/lib/utils'`,
      ``,
      `export const x = 1`,
    ].join('\n')
    expect(canonicalizeImports(upstream)).toBe(canonicalizeImports(local))
  })

  it('handles multi-line import statements', () => {
    const source = [
      `import {`,
      `  a,`,
      `  b,`,
      `} from './x'`,
      `import y from './y'`,
      ``,
      `const z = 1`,
    ].join('\n')
    const out = canonicalizeImports(source)
    expect(out).toContain('a,')
    expect(out).toContain('const z = 1')
  })

  it('leaves a file with no imports alone', () => {
    expect(canonicalizeImports('const x = 1\n')).toBe('const x = 1\n')
  })

  it('does not scan past the leading import block', () => {
    // Guards against matching the word `import` inside a string further down.
    const source = [
      `import a from './a'`,
      ``,
      `const doc = "import b from './b'"`,
    ].join('\n')
    expect(canonicalizeImports(source)).toContain(
      `const doc = "import b from './b'"`,
    )
  })
})

describe('full pipelines', () => {
  it('reconciles a registry component with its vendored copy', () => {
    // Condensed from the real thing: upstream's bare `cn`, its import order,
    // versus the local file's header, extension, and blank-line grouping.
    const upstream = [
      `import * as React from "react"`,
      `import { cn } from "cn"`,
      `import { Slot } from "radix-ui"`,
      ``,
      `export const Button = () => null`,
    ].join('\n')

    const local = [
      `/** shadcn/ui — new-york-v4/button (stock) */`,
      ``,
      `import * as React from "react"`,
      `import { Slot } from "radix-ui"`,
      ``,
      `import { cn } from "#/lib/utils.ts"`,
      ``,
      `export const Button = () => null`,
    ].join('\n')

    expect(normalizeUpstream(upstream, ctx)).toBe(normalizeLocal(local, ctx))
  })

  it('still sees a real change after all the noise is removed', () => {
    const upstream = [
      `import { cn } from "cn"`,
      ``,
      `export const A = 'upstream'`,
    ].join('\n')
    const local = [
      `/** shadcn/ui — new-york-v4/a (stock) */`,
      `import { cn } from "#/lib/utils.ts"`,
      ``,
      `export const A = 'ours'`,
    ].join('\n')
    expect(normalizeUpstream(upstream, ctx)).not.toBe(
      normalizeLocal(local, ctx),
    )
  })
})
