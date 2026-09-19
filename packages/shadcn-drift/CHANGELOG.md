# shadcn-drift

## 0.2.1

### Patch Changes

- Stop treating colocated tests and stories in `ui/` as components.
  
  `ui/` is not exclusively the shadcn CLI's directory. A `tags-input.test.tsx`
  sitting next to `tags-input.tsx` is an ordinary way to lay a component out, and
  `*.test.*`, `*.spec.*`, `*.stories.*` and `*.d.ts` were being classified as
  `(ours)` — so `--strict` demanded a provenance header on a test file, and `init`
  offered to write one.
  
  The second is the worse half: `init` writing into a test is the tool editing a
  file it had no business classifying in the first place.
  
  This is not left to `drift.ignore`. Zero configuration is the premise, and
  "configure it to stop asking about your tests" is a setup step every repo that
  colocates them would have to discover by being told something wrong first.
  
  The rule is deliberately narrow — extensions, not a guess at intent. An
  `index.ts` someone added to `ui/` is still checked, because whether a barrel
  deserves a header is the author's call and not a filename heuristic's.

## 0.2.0

### Minor Changes

- Add `init` autodiscovery, cover `--strict`, and ship the lock file with `--offline`.
  
  `npx shadcn-drift init` identifies each unheaded file in `ui/` against the
  registry — by filename first, falling back to matching exported symbol names for
  a renamed file — and writes the provenance header for you. It **only ever adds**
  headers, never rewrites or removes one, which is what makes re-running it after
  `shadcn add -o` both safe and the intended recovery path. Interactive by
  default; `--yes` accepts every inference and `--dry-run` writes nothing.
  
  It never proposes `(forked)` on its own. There is no defensible similarity
  cutoff, and the mistakes are not symmetric: proposing `(patched)` for a fork
  costs a diff you downgrade once, while proposing `(forked)` for a patch turns
  upstream from a contract into ancestry and the file stops being compared at all.
  
  `--strict` now has test coverage, and — more to the point — an authoring story:
  `init` writing `(ours)` is what lets a repo with locally-authored components in
  `ui/` reach a clean strict run at all.
  
  `--update-lock` writes `shadcn.lock.json`, hashed over the **normalized**
  content so formatting churn cannot invalidate a committed lock. `--offline` then
  verifies against it with no network, which is what makes it usable from `lint`
  and a pre-commit hook.
  
  Offline mode answers exactly one question — _has anyone changed this since the
  lock was written?_ — and cannot detect that upstream moved; nothing network-free
  can. Keep running the default network check on a schedule and before any
  `shadcn add -o`.

## 0.1.0

### Minor Changes

- [`89a5afe`](https://github.com/ballsacian/tools/commit/89a5afe1e9f9724aa06f8125ea3ec0b937a90efb) Thanks [@jlaramie](https://github.com/jlaramie)! - First release.
  
  `npx shadcn-drift` checks the shadcn/ui components vendored into your repo
  against the registry they came from, with no configuration: it finds your
  `components.json`, resolves your `ui/` directory through your aliases, refetches
  each component, normalizes away the differences the shadcn CLI always
  introduces, and shows you what actually diverged.
  
  - **`check`** — the default. Reports drift, stale tags, components that do not
    exist upstream, and (with `--strict`) files carrying no provenance header at
    all.
  - **`config`** — shows how the tool resolved your project, including _how_ it
    decided, since misresolution is the confusing failure mode.
  - Exit codes distinguish drift (1) from authenticity (2) from "could not form a
    verdict" (3), so CI can tell a finding from a flaky network.
  
  Verified against a real 43-component repository: 23/23 `(stock)` components
  clean, patched components correctly excluded, and one stale `(patched)` tag
  found.
  
  `init` (autodiscovery) and `--offline` (the lock file) are specified but not
  implemented yet; both exit 3 rather than pretending to pass.
