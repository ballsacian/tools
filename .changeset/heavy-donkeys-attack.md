---
'shadcn-drift': minor
---

Add `init` autodiscovery, cover `--strict`, and ship the lock file with `--offline`.

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
