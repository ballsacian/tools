---
'shadcn-drift': minor
---

First release.

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
