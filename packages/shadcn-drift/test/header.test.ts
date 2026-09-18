import { describe, expect, it } from 'vitest'
import {
  formatHeader,
  isTodoReason,
  parseHeader,
  stripHeader,
  validateHeader,
  TODO_REASON,
} from '../src/header.js'

describe('parseHeader', () => {
  it('parses the canonical stock header', () => {
    const h = parseHeader(
      '/** shadcn/ui — new-york-v4/avatar (stock) */\n\nimport x',
    )
    expect(h).toMatchObject({
      state: 'stock',
      style: 'new-york-v4',
      component: 'avatar',
      reason: null,
    })
  })

  it('parses a patched header with a reason', () => {
    const h = parseHeader(
      '/** shadcn/ui — new-york-v4/input (patched) — fill color changed to match token. */',
    )
    expect(h?.state).toBe('patched')
    expect(h?.reason).toBe('fill color changed to match token.')
  })

  it('parses (ours), which names no component', () => {
    const h = parseHeader('/** shadcn/ui — (ours) */')
    expect(h).toMatchObject({ state: 'ours', style: null, component: null })
  })

  it('parses a real multi-line header taken from a production repo', () => {
    // Verbatim, including the backticks and the line wrap. A header that spans
    // lines is still one logical statement.
    const source = [
      '/** shadcn/ui — new-york-v4/chart (patched) — `#/lib/utils.ts` import',
      ' * rewritten to `#/lib/utils`, matching every other file here. */',
      '',
      'import * as React from "react"',
    ].join('\n')
    const h = parseHeader(source)
    expect(h?.state).toBe('patched')
    expect(h?.component).toBe('chart')
    expect(h?.reason).toContain('matching every other file here.')
  })

  it('parses a block header whose terminator is on its own line', () => {
    // The shape every real multi-line header uses, taken from a
    // production repo's input.tsx. A flattener that collapses `\n *` with a greedy `\**` also
    // eats the `*` of the closing `*/`, the grammar stops matching, and the
    // file silently reports as unheaded — which is how this got caught: the
    // checker reported input.tsx as untracked while staring at its header.
    const source = [
      '/**',
      ' * shadcn/ui — new-york-v4/input (patched)',
      ' *',
      ' * - Fill: upstream is `bg-transparent`, replaced with `bg-(--field)`.',
      ' */',
      '',
      "import * as React from 'react'",
    ].join('\n')
    const h = parseHeader(source)
    expect(h?.state).toBe('patched')
    expect(h?.component).toBe('input')
    expect(h?.reason).toContain('bg-(--field)')
  })

  it('strips a terminator-on-own-line header completely', () => {
    const source = [
      '/**',
      ' * shadcn/ui — new-york-v4/input (stock)',
      ' */',
      '',
      'import x',
    ].join('\n')
    expect(stripHeader(source).trimStart()).toBe('import x')
  })

  it('accepts a plain hyphen as well as an em-dash', () => {
    // Nobody should be told their component drifted because they typed `-`.
    const em = parseHeader('/** shadcn/ui — new-york-v4/badge (stock) */')
    const hyphen = parseHeader('/** shadcn/ui - new-york-v4/badge (stock) */')
    const en = parseHeader('/** shadcn/ui – new-york-v4/badge (stock) */')
    expect(hyphen).toMatchObject({ style: em?.style, component: em?.component })
    expect(en).toMatchObject({ style: em?.style, component: em?.component })
  })

  it('returns null for a file with no header', () => {
    expect(parseHeader('import * as React from "react"\n')).toBeNull()
  })

  it('ignores a block comment that does not start the file', () => {
    // Otherwise a stray comment further down could silently reclassify a file.
    const source = 'import x\n\n/** shadcn/ui — new-york-v4/avatar (stock) */\n'
    expect(parseHeader(source)).toBeNull()
  })

  it('returns null for an unrelated leading block comment', () => {
    expect(parseHeader('/** Copyright 2026. */\nimport x')).toBeNull()
  })

  it('keeps an unrecognised state instead of discarding the header', () => {
    // Dropping it would turn a typo into an invisible skip.
    const h = parseHeader('/** shadcn/ui — new-york-v4/avatar (stok) */')
    expect(h?.state).toBe('stok')
  })
})

describe('stripHeader', () => {
  it('removes the header and its trailing newline', () => {
    const source = '/** shadcn/ui — new-york-v4/avatar (stock) */\nimport x\n'
    expect(stripHeader(source)).toBe('import x\n')
  })

  it('leaves a file without a header untouched', () => {
    const source = '/** Copyright 2026. */\nimport x\n'
    expect(stripHeader(source)).toBe(source)
  })
})

describe('formatHeader', () => {
  it('round-trips through parseHeader', () => {
    const original = {
      state: 'patched' as const,
      style: 'new-york-v4',
      component: 'input',
      reason: 'fill color changed.',
    }
    const parsed = parseHeader(formatHeader(original))
    expect(parsed).toMatchObject(original)
  })

  it('round-trips (ours)', () => {
    const parsed = parseHeader(
      formatHeader({
        state: 'ours',
        style: null,
        component: null,
        reason: null,
      }),
    )
    expect(parsed).toMatchObject({
      state: 'ours',
      style: null,
      component: null,
    })
  })
})

describe('validateHeader', () => {
  const parse = (s: string) => {
    const h = parseHeader(s)
    if (!h) throw new Error('expected a header')
    return h
  }

  it('accepts a bare stock header', () => {
    expect(
      validateHeader(parse('/** shadcn/ui — new-york-v4/avatar (stock) */')),
    ).toEqual([])
  })

  it('requires a reason on patched', () => {
    const problems = validateHeader(
      parse('/** shadcn/ui — new-york-v4/input (patched) */'),
    )
    expect(problems.map((p) => p.code)).toContain('missing-reason')
  })

  it('flags a TODO reason left behind by init', () => {
    const problems = validateHeader(
      parse(`/** shadcn/ui — new-york-v4/input (patched) — ${TODO_REASON} */`),
    )
    expect(problems.map((p) => p.code)).toContain('todo-reason')
  })

  it('rejects (ours) that names a component', () => {
    const problems = validateHeader(
      parse('/** shadcn/ui — new-york-v4/x (ours) */'),
    )
    expect(problems.map((p) => p.code)).toContain('unexpected-component')
  })

  it('reports an unknown state and stops there', () => {
    const problems = validateHeader(
      parse('/** shadcn/ui — new-york-v4/avatar (stok) */'),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]?.code).toBe('unknown-state')
  })

  it('does not require a reason on stock', () => {
    expect(
      validateHeader(parse('/** shadcn/ui — new-york-v4/avatar (stock) */')),
    ).toEqual([])
  })
})

describe('isTodoReason', () => {
  it('matches what init writes', () => {
    expect(isTodoReason(TODO_REASON)).toBe(true)
  })

  it('does not match a real reason', () => {
    expect(isTodoReason('fill color changed to match token.')).toBe(false)
    expect(isTodoReason(null)).toBe(false)
  })
})
