---
'shadcn-drift': patch
---

Stop treating colocated tests and stories in `ui/` as components.

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
