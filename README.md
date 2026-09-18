# @ballsacian/tools

A pnpm monorepo holding small, independently published developer tools.

The repo is the container; the packages are the product. Each one publishes
under its own name with its own version — there is deliberately no package
called `tools`, because a grab-bag forces consumers to take everything and makes
semver meaningless.

## Packages

| Package                                   | Version    | What it does                                                                                                                            |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`shadcn-drift`](./packages/shadcn-drift) | unreleased | Detects drift between vendored shadcn/ui components and their registry sources, and verifies that what claims to be shadcn actually is. |

## Development

Requires **Node 22+** and pnpm — pnpm 11 itself needs 22.5+. The published
packages run on Node 20+; that wider floor is verified separately in CI by
executing the built CLI under Node 20.

```bash
pnpm install
pnpm build          # tsc -b across the workspace
pnpm test           # vitest, no network
pnpm lint           # prettier --check, eslint, tsc
pnpm format         # prettier --write
```

### Releasing

[Changesets](https://github.com/changesets/changesets). Describe the change,
version locally, and let CI publish:

```bash
pnpm changeset          # describe the change, in the PR that makes it
pnpm version-packages   # bump versions + CHANGELOG, refresh the lockfile
pnpm tag-release        # create the git tags
git push --follow-tags
```

The version bump is deliberately **not** done in CI. Doing it there would
require granting `contents: write` and pull-request creation to the one job that
also holds the npm token; doing it here means that job can only read, mint an
OIDC token for provenance, and publish. Publishing then waits on a human
reviewer. See [CLAUDE.md](./CLAUDE.md) § CI security model.

## Conventions

Working in here? See [CLAUDE.md](./CLAUDE.md) — it records the toolchain
constraints that are not obvious from the config files, including why this repo
is pinned to TypeScript 6 and why relative imports need `.js` extensions.

Design notes for in-progress work live in `notes/`, which is gitignored.
