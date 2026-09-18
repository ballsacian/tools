# @ballsacian/tools — working notes

A pnpm monorepo of independently published developer tools. Root is private;
each package in `packages/*` publishes under its own name.

## Toolchain constraints that will bite you

### Two different Node floors, and they are not the same number

|                                 | Node    | Why                                                                                                                            |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Developing** this repo        | **22+** | pnpm 11 imports `node:sqlite`, added in 22.5. On Node 20 it dies with `ERR_UNKNOWN_BUILTIN_MODULE` before installing anything. |
| **Running** a published package | **20+** | What `engines` declares. Consumers type `npx shadcn-drift`; they never invoke pnpm.                                            |

Do not "fix" a Node 20 CI failure by lowering `engines` — that conflates a
contributor constraint with a consumer promise. The `engines-floor` job builds
with the toolchain's Node, then executes the built CLI under Node 20, which
tests the claim that is actually published.

### TypeScript is pinned to 6.x, deliberately

Do not upgrade to TypeScript 7. `typescript-eslint` refuses to load against it:

```
Error: typescript-eslint does not support TS 7.0.
```

That is a hard failure of `pnpm lint:eslint`, not a warning, and the fallback —
dropping `typescript-eslint` — would take every type-aware rule with it. Support
is tracked in [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
for TS ≥7.1. Revisit when that lands; until then `typescript@^6` is load-bearing.

### Relative imports need explicit `.js` extensions

`module`/`moduleResolution` are `NodeNext`, because these packages are run by
Node directly via `npx` rather than fed through a bundler. So a `.ts` source
imports its sibling as `.js`:

```ts
import { ExitCode } from './exit-codes.js' // correct, even though the file is .ts
import { ExitCode } from './exit-codes' // fails to resolve at runtime
```

### Two tsconfigs per package, and they are not interchangeable

| File                  | Who uses it                                       | Covers                                       |
| --------------------- | ------------------------------------------------- | -------------------------------------------- |
| `tsconfig.json`       | ESLint project service, editors, `pnpm typecheck` | `src`, `test`, `vitest.config.ts` — `noEmit` |
| `tsconfig.build.json` | root solution file, `tsc -b`                      | `src` only — emits `dist/`                   |

The split exists because ESLint's project service resolves the _nearest_
`tsconfig.json`, and a file outside its `include` is a parse error
(`was not found by the project service`), not a skipped file. Meanwhile the
build must not emit test code into `dist/`, since `dist/` is the published
tarball. One config cannot do both.

Adding a package? It needs both files, a `typecheck` script, and a reference
from the root `tsconfig.json` pointing at its **`tsconfig.build.json`**.

### `types` is set explicitly

`"types": ["node"]` rather than relying on automatic `node_modules/@types/*`
discovery. Pins which ambient globals are in scope instead of absorbing whatever
a transitive dependency installs.

## Line endings

This machine has `core.autocrlf=true` globally. `.gitattributes` sets
`* text=auto eol=lf` to override it, so working tree, committed bytes, and CI on
Linux all agree.

This matters more here than in a normal repo: `shadcn-drift` compares file
content against a registry, and a line-ending mismatch is exactly the false
positive it exists to rule out.

**Test fixtures are exempt from everything.** `packages/*/test/fixtures/` is
`-text` in `.gitattributes` and listed in `.prettierignore`. They are recorded
registry payloads compared byte-for-byte; formatting or normalizing them would
rewrite the thing under test.

## Tests never hit the network

`vitest.config.ts` excludes `*.live.test.ts` unless `DRIFT_LIVE=1`. Registry
payloads belong in `test/fixtures/` as recordings. CI must not be able to go red
because `ui.shadcn.com` had a bad day.

## Exit codes are a contract

`packages/shadcn-drift/src/exit-codes.ts`. The important split is that
`OPERATIONAL` (3) — could not form a verdict — is distinct from the finding
codes `DRIFT` (1) and `AUTHENTICITY` (2). Never collapse a network failure into
a finding, and never let one exit 0.

## CI

`.github/workflows/ci.yml` runs on **Windows and Linux**. Not ceremony: these
tools resolve paths out of `tsconfig`/`package.json` and load the consumer's own
Prettier by absolute path. Twice during development a Windows absolute path
(`E:\…`) had to become a `file://` URL before Node's ESM loader would accept it
— and in `formatter.ts` that failure mode is silent, degrading to an unformatted
comparison that reports every component as drifted. Linux-only CI would have
shipped it.

Default branch is `master`, not `main` — workflow triggers and
`.changeset/config.json` `baseBranch` both depend on it.

## CI security model

This repository is public, so CI executes code from strangers. The design goal
is that **no workflow which can run untrusted code can ever reach a secret.**

| Control                                     | Where          | Why                                                                                                                                                                                                                |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pull_request`, never `pull_request_target` | `ci.yml`       | A fork's PR runs with no secrets and a read-only token. `pull_request_target` would run the same untrusted code _with_ secrets — the single worst change anyone could make here.                                   |
| `permissions:` declared explicitly          | both workflows | The repository default is now `read`, but a declared block means a future default change cannot silently widen a job. `release.yml` starts from `permissions: {}`.                                                 |
| Actions pinned to commit SHAs               | both workflows | A tag is mutable. Repointing `@v1` runs new code inside the job holding `NPM_TOKEN`. **`sha_pinning_required` is enabled on the repository**, so GitHub rejects a workflow that reintroduces a tag.                |
| `persist-credentials: false`                | every checkout | Keeps a usable git credential out of `.git/config`, where a PR-authored build script could find it.                                                                                                                |
| `timeout-minutes`                           | every job      | A fork PR gets no secrets, so the residual risk is runner abuse. This bounds it.                                                                                                                                   |
| `--frozen-lockfile`                         | every install  | A PR cannot resolve anything the committed lockfile does not already pin. Dependency lifecycle scripts do not run at all: pnpm 10+ blocks them unless named in `pnpm.onlyBuiltDependencies`, and nothing is named. |
| `environment: npm-publish`                  | `release.yml`  | `NPM_TOKEN` lives in the environment, not in repository secrets, so no other workflow can read it. The environment requires a human reviewer and is restricted to `master`.                                        |

**Do not move the version bump into CI.** The stock changesets setup has the
workflow open a "version packages" PR, which needs `contents: write`,
`pull-requests: write`, and the repository setting allowing Actions to create
pull requests — all granted to the one job that also holds `NPM_TOKEN`.
Versioning locally removes every one of those. The publish job can read the
repo, mint an OIDC token, and publish; it cannot write to the repository at all.

## Publishing

`publishConfig.provenance` is `true`. npm requires provenance to be generated
from a **public** repository, on a cloud-hosted CI runner, with `id-token: write`
— all of which `.github/workflows/release.yml` satisfies. The repo is public for
this reason.

Provenance therefore cannot be produced by a local `npm publish` — it needs CI
with OIDC. But the _version bump_ is deliberately local, for the reasons above.
The release flow is:

```bash
pnpm changeset          # describe the change (usually in the PR that makes it)
pnpm version-packages   # bump versions + CHANGELOG, refresh the lockfile
git commit -am "chore: version packages"
pnpm tag-release        # create the git tags
git push --follow-tags  # CI publishes what is now committed
```

The publish job then waits for a reviewer on the `npm-publish` environment. It
is a no-op when nothing needs releasing: changesets compares each package
against the registry and exits cleanly if the versions match.
