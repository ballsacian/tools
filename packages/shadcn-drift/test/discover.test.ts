import { describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../src/check.js'
import { resolveConfig } from '../src/config.js'
import {
  applyProposal,
  bestFingerprint,
  exportedSymbols,
  insertHeader,
  planInit,
  proposedHeader,
  retag,
  similarity,
  writableStates,
  type InitProposal,
} from '../src/discover.js'
import { ExitCode } from '../src/exit-codes.js'
import { parseHeader, TODO_REASON } from '../src/header.js'
import { fixtureRegistry } from './helpers/fixture-registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const headerless = path.join(here, 'fixtures/projects/headerless-app')

/**
 * `init` writes to disk, so every test that exercises writing gets its own copy
 * of the fixture. Mutating the committed one would leave the suite's result
 * dependent on whether a previous run finished.
 *
 * The copy lives inside `test/fixtures/` rather than the OS temp directory, and
 * that is load-bearing: `resolveFormatter` walks up from the project root
 * looking for the project's *own* Prettier. A copy in `%TEMP%` finds none, so
 * the whole suite would silently exercise the unformatted path — where quote
 * style alone makes every stock component look `(patched)`. Everything under
 * `test/fixtures/` is already excluded from ESLint, Prettier and typecheck, and
 * `.tmp/` is gitignored.
 */
async function withCopy<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const scratch = path.join(here, 'fixtures/.tmp')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(path.join(scratch, 'init-'))
  const root = path.join(dir, 'app')
  await cp(headerless, root, { recursive: true })
  try {
    return await fn(root)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const planFor = async (root: string) =>
  planInit(await resolveConfig(path.join(root, 'components.json')), {
    registry: fixtureRegistry(),
  })

const byFile = (proposals: readonly InitProposal[], file: string) =>
  proposals.find((p) => p.file === file)

describe('exportedSymbols', () => {
  it('reads every shape a registry component actually uses', () => {
    const symbols = exportedSymbols(`
      export function Badge() {}
      export const badgeVariants = cva('')
      export class Thing {}
      export type BadgeProps = { x: number }
      export interface Other { y: string }
      export { Avatar, AvatarImage as Image, type AvatarProps }
    `)
    expect([...symbols].sort()).toEqual([
      'Avatar',
      'AvatarProps',
      'Badge',
      'BadgeProps',
      'Image',
      'Other',
      'Thing',
      'badgeVariants',
    ])
  })

  it('takes the exported name from an `as` rename, not the local one', () => {
    // What another file can import is the right-hand side. Recording the local
    // name would make the fingerprint describe a module nobody can see.
    expect(exportedSymbols('export { Root as Accordion }')).toEqual(
      new Set(['Accordion']),
    )
  })
})

describe('bestFingerprint', () => {
  const candidates = [
    {
      name: 'avatar',
      symbols: new Set(['Avatar', 'AvatarImage', 'AvatarFallback']),
    },
    { name: 'badge', symbols: new Set(['Badge', 'badgeVariants']) },
  ]

  it('matches a renamed file on its exports', () => {
    const match = bestFingerprint(
      new Set(['Badge', 'badgeVariants']),
      candidates,
    )
    expect(match?.name).toBe('badge')
  })

  it('refuses a single shared symbol', () => {
    // A lone `Root` or `cn` is shared by half the registry. Writing a header
    // off one symbol names the wrong component confidently, which is worse
    // than naming none: a wrong (stock) tag reports permanent drift, and a
    // wrong (patched) tag suppresses a real one.
    expect(
      bestFingerprint(new Set(['Badge', 'Unrelated']), candidates),
    ).toBeNull()
  })

  it('refuses a tie rather than picking one', () => {
    const tied = [
      { name: 'a', symbols: new Set(['One', 'Two']) },
      { name: 'b', symbols: new Set(['One', 'Two']) },
    ]
    expect(bestFingerprint(new Set(['One', 'Two']), tied)).toBeNull()
  })

  it('scores identical sets at 1 and disjoint sets at 0', () => {
    expect(similarity(new Set(['A', 'B']), new Set(['A', 'B']))).toBe(1)
    expect(similarity(new Set(['A']), new Set(['B']))).toBe(0)
  })
})

describe('insertHeader', () => {
  it('puts the header first, because only a leading comment counts', () => {
    const out = insertHeader('import x from "y"\n', '/** h */')
    expect(out.startsWith('/** h */\n\n')).toBe(true)
  })

  it('goes above a "use client" directive', () => {
    // Comments are trivia and do not break a directive prologue, so the
    // directive still applies — and the header has to lead or `parseHeader`
    // will not see it.
    const out = insertHeader('"use client"\n\nimport x from "y"\n', '/** h */')
    expect(out.split('\n')[0]).toBe('/** h */')
    expect(out).toContain('"use client"')
  })

  it('keeps a byte-order mark first', () => {
    // Dropping it would be `init` changing content while claiming only to add
    // a comment, and the file would read as modified on the next run.
    const out = insertHeader('﻿import x from "y"\n', '/** h */')
    expect(out.startsWith('﻿/** h */')).toBe(true)
  })

  it('matches the file’s existing line endings', () => {
    const out = insertHeader('import x from "y"\r\n', '/** h */')
    expect(out.startsWith('/** h */\r\n\r\n')).toBe(true)
  })
})

describe('planInit — the acceptance case from the spec', () => {
  it('reconstructs every header, including (ours) for non-registry files', async () => {
    const plan = await planFor(headerless)

    // Identical to upstream after normalization.
    for (const file of [
      'avatar.tsx',
      'badge.tsx',
      'button.tsx',
      'card.tsx',
      'label.tsx',
      'separator.tsx',
      'tabs.tsx',
    ]) {
      const proposal = byFile(plan.proposals, file)
      expect(proposal, file).toBeDefined()
      expect(proposal?.state, file).toBe('stock')
      expect(proposal?.matchedBy, file).toBe('filename')
    }

    // Not in any registry — the tag that distinguishes "we wrote this" from
    // "nobody has looked at this yet".
    const ours = byFile(plan.proposals, 'create-select.tsx')
    expect(ours?.state).toBe('ours')
    expect(ours?.component).toBeNull()
    expect(proposedHeader(ours!)).toBe('/** shadcn/ui — (ours) */')
  })

  it('tags chart.tsx (stock) despite its vendored eslint-disable block', async () => {
    // The eslint directives are stripped by the normalizer, so what is left is
    // identical to upstream. Without that step this file would be proposed
    // (patched) for lint configuration that upstream will never have.
    const plan = await planFor(headerless)
    expect(byFile(plan.proposals, 'chart.tsx')?.state).toBe('stock')
  })

  it('identifies a renamed file by its exported symbols', async () => {
    // status-pill.tsx is badge.tsx under another name. The shadcn CLI names
    // files after components, so the filename resolves the overwhelming
    // majority — this is the fallback for the rest.
    const plan = await planFor(headerless)
    const renamed = byFile(plan.proposals, 'status-pill.tsx')
    expect(renamed?.component).toBe('badge')
    expect(renamed?.matchedBy).toBe('exports')
    expect(renamed?.state).toBe('stock')
    expect(plan.fingerprinted).toBe(true)
  })

  it('leaves a file that already has a header completely alone', async () => {
    // switch.tsx is tagged (patched) in the fixture even though it is identical
    // to upstream. init must not "correct" that: re-running after
    // `shadcn add -o` is the intended recovery path, and it is only safe if a
    // second run cannot revise a human's reason into a TODO.
    const plan = await planFor(headerless)
    const untouched = byFile(plan.proposals, 'switch.tsx')
    expect(untouched?.skipped).toBe('has-header')
    expect(untouched?.existing?.state).toBe('patched')
  })
})

describe('planInit — writing', () => {
  it('writes headers that check then reads back as clean', async () => {
    // The round trip is the real acceptance test: strip the headers, let init
    // reconstruct them, and the resulting repo must pass its own checker.
    await withCopy(async (root) => {
      const plan = await planFor(root)
      for (const proposal of plan.proposals) {
        if (proposal.skipped) continue
        await applyProposal(proposal)
      }

      const config = await resolveConfig(path.join(root, 'components.json'))
      const report = await check(config, { registry: fixtureRegistry() })

      const stock = report.results.filter((r) => r.header?.state === 'stock')
      expect(stock).toHaveLength(9)
      expect(stock.every((r) => r.verdict === 'clean')).toBe(true)

      const ours = report.results.find((r) => r.file === 'create-select.tsx')
      expect(ours?.verdict).toBe('ours')
      expect(ours?.header?.state).toBe('ours')
    })
  })

  it('reaches a clean --strict run, which is the point of (ours)', async () => {
    // Before init, every unheaded file fails --strict (exit 2). After it, the
    // only finding left is switch.tsx's deliberately stale (patched) tag.
    await withCopy(async (root) => {
      const config = await resolveConfig(path.join(root, 'components.json'))
      const before = await check(config, {
        registry: fixtureRegistry(),
        strict: true,
      })
      expect(before.exitCode).toBe(ExitCode.AUTHENTICITY)

      const plan = await planInit(config, { registry: fixtureRegistry() })
      for (const proposal of plan.proposals) {
        if (proposal.skipped) continue
        await applyProposal(proposal)
      }

      const after = await check(config, {
        registry: fixtureRegistry(),
        strict: true,
      })
      expect(
        after.results.filter(
          (r) =>
            r.verdict === 'untracked-drift' || r.verdict === 'untracked-match',
        ),
      ).toHaveLength(0)
      expect(after.results.filter((r) => r.header === null)).toHaveLength(0)
      // Not clean, but for one honest reason rather than nine untagged files.
      expect(after.exitCode).toBe(ExitCode.DRIFT)
    })
  })

  it('is idempotent — a second run proposes nothing', async () => {
    // Re-running after `shadcn add -o` is the documented recovery path, so a
    // repeat run has to be a no-op rather than a second header.
    await withCopy(async (root) => {
      const first = await planFor(root)
      for (const proposal of first.proposals) {
        if (proposal.skipped) continue
        await applyProposal(proposal)
      }

      const second = await planFor(root)
      expect(second.proposals.filter((p) => p.skipped === null)).toHaveLength(0)
      expect(second.proposals.every((p) => p.skipped === 'has-header')).toBe(
        true,
      )

      const source = await readFile(
        path.join(root, 'src/components/ui/button.tsx'),
        'utf8',
      )
      expect(source.match(/shadcn\/ui/g)).toHaveLength(1)
      // And what was written is what this package's own parser reads back —
      // `init` emitting a header `check` cannot parse would be the tool
      // failing its own grammar.
      expect(parseHeader(source)).toMatchObject({
        state: 'stock',
        style: 'new-york-v4',
        component: 'button',
        reason: null,
      })
    })
  })

  it('never proposes (forked) on its own — spec §14 Q3', async () => {
    // There is no defensible similarity cutoff, and the two mistakes are not
    // symmetric: proposing patched for a fork costs a diff a human downgrades,
    // while proposing forked for a patch stops the file being compared at all.
    await withCopy(async (root) => {
      const file = path.join(root, 'src/components/ui/button.tsx')
      const source = await readFile(file, 'utf8')
      await writeFile(
        file,
        source.replace(
          /export \{[^}]*\}/,
          'export { Button }\nconst extra = 1\n',
        ),
        'utf8',
      )

      const plan = await planFor(root)
      const button = byFile(plan.proposals, 'button.tsx')
      expect(button?.state).toBe('patched')
      expect(button?.reason).toBe(TODO_REASON)
      expect(plan.proposals.some((p) => p.state === 'forked')).toBe(false)
    })
  })
})

describe('retag', () => {
  const matched = (): InitProposal => ({
    file: 'button.tsx',
    absolutePath: '/x/button.tsx',
    skipped: null,
    existing: null,
    state: 'patched',
    style: 'new-york-v4',
    component: 'button',
    reason: TODO_REASON,
    matchedBy: 'filename',
    diff: '',
    added: 0,
    removed: 0,
    note: '',
  })

  it('drops the component reference when downgrading to (ours)', () => {
    // Naming one would contradict the claim the tag makes.
    const out = retag(matched(), 'ours')
    expect(out.style).toBeNull()
    expect(out.component).toBeNull()
    expect(proposedHeader(out)).toBe('/** shadcn/ui — (ours) */')
  })

  it('keeps a human’s reason instead of the TODO', () => {
    const out = retag(matched(), 'forked', 'rewritten for the design system.')
    expect(proposedHeader(out)).toBe(
      '/** shadcn/ui — new-york-v4/button (forked) — rewritten for the design system. */',
    )
  })

  it('drops the reason for (stock), which must diff empty', () => {
    expect(retag(matched(), 'stock').reason).toBeNull()
  })

  it('offers only (ours) for a file the registry could not identify', () => {
    const unmatched: InitProposal = {
      ...matched(),
      state: 'ours',
      style: null,
      component: null,
    }
    expect(writableStates(unmatched)).toEqual(['ours'])
    // And refuses the retag outright, rather than writing a header with no
    // component reference under a state that requires one.
    expect(retag(unmatched, 'stock').state).toBe('ours')
  })
})
