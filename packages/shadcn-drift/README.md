# shadcn-drift

Check that the shadcn/ui components vendored into your repo still match the
registry they came from — and that what claims to be shadcn actually is.

```bash
npx shadcn-drift
```

No config, no install, no setup. It finds your `components.json`, resolves your
`ui/` directory from your aliases, refetches each component from the registry,
normalizes away the differences the shadcn CLI always introduces, and shows you
what actually diverged.

## Why

`shadcn add` vendors source code into your repo. That is the whole point — you
own it and can change it. But it means:

- **Upgrades silently overwrite your changes.** `shadcn add -o button` replaces
  the file. Whatever you patched is gone, and nothing tells you.
- **The registry is unversioned.** Components change upstream with no release,
  no changelog, and no way to pin.
- **Anything can claim to be shadcn.** A file in `ui/` that an agent generated,
  or that came from a third-party registry, looks exactly like one the CLI
  wrote.

`shadcn-drift` makes all three visible.

## Surface

```
npx shadcn-drift                 # check for drift (default)
npx shadcn-drift config          # show what it resolved, and how
npx shadcn-drift init            # autodiscover components, write provenance headers
npx shadcn-drift --strict        # every file in ui/ must carry a header
npx shadcn-drift --offline       # verify against shadcn.lock.json — no network
npx shadcn-drift --update-lock   # refresh the lock file from the registry
```

### Exit codes

| Code | Meaning                                                                        |
| ---: | ------------------------------------------------------------------------------ |
|  `0` | clean                                                                          |
|  `1` | drift — a component changed and nothing declared it                            |
|  `2` | authenticity — claimed component doesn't exist upstream, or untrusted registry |
|  `3` | operational — couldn't reach a verdict (no `components.json`, network failure) |

`3` is deliberately not `1`. A CI script must be able to tell "your code has a
problem" from "the tool couldn't tell".

## Provenance headers

Optional, and the tool is useful without them — but adopting them is what makes
an intentional change stay intentional:

```tsx
/** shadcn/ui — new-york-v4/avatar (stock) */
/** shadcn/ui — new-york-v4/input (patched) — fill color changed to match token. */
```

`(stock)` must match upstream exactly. `(patched)` and `(forked)` are expected
to differ and must say why. `(ours)` says no registry component corresponds —
it names none, because that is the claim it makes.

## `init` — adopting the headers

```bash
npx shadcn-drift init            # per-file prompt showing the diff
npx shadcn-drift init --dry-run  # print the proposals, write nothing
npx shadcn-drift init --yes      # accept every inference
```

For each file in `ui/` with no header, `init` works out which registry
component it is — **by filename first**, since the shadcn CLI names files after
components, then by matching **exported symbol names** for a file that was
renamed — and classifies it by running the same comparison `check` does:
identical is `(stock)`, different is `(patched)` with a `TODO` reason for you to
finish, and nothing matching is `(ours)`.

Two rules worth knowing:

- **It only ever adds headers.** It never rewrites or removes one. `shadcn
add -o` destroys headers by overwriting the file, so re-running `init`
  afterwards is both safe and the intended recovery path.
- **It never proposes `(forked)` on its own.** There is no defensible
  similarity cutoff, and the mistakes are not symmetric: proposing `(patched)`
  for a fork costs you a diff you downgrade once, while proposing `(forked)`
  for a patch turns upstream from a contract into ancestry and the file stops
  being compared at all. The prompt offers it; `--yes` never picks it.

## `--strict`

Every file in `ui/` must carry a header — `(ours)` included. An untagged file,
which is the shape an agent or a copy-paste produces, exits `2`. This inverts
the usual default, where untagged means trusted-and-skipped.

A `(patched)` reason of `TODO` — what `init` writes when it cannot know why —
also fails under `--strict`. That is deliberate: `init` gets you most of the way
and then makes you finish the sentence.

## The lock file and `--offline`

```bash
npx shadcn-drift --update-lock   # writes shadcn.lock.json. Commit it.
npx shadcn-drift --offline       # verify against it. No network.
```

Hashes are of the **normalized** content, so a Prettier run, a CRLF checkout or
an added `eslint-disable` does not invalidate a committed lock.

**Be precise about what offline mode proves.** It answers exactly one question:

> _Has anyone changed this since the lock was written?_

Deterministic, network-free, fast — which is what makes it usable from `lint`
and a pre-commit hook. It **cannot** detect that _upstream_ moved. Nothing
network-free can: the registry is unversioned, and the lock is a record of one
past conversation with it.

So the two modes are not interchangeable:

|                   | When to run it                                  | What it answers        |
| ----------------- | ----------------------------------------------- | ---------------------- |
| `--offline`       | every CI run, every commit                      | did _we_ change it?    |
| default (network) | a scheduled job, and before any `shadcn add -o` | did _upstream_ change? |

Treating a green `--offline` as "we are up to date" and dropping the network
check would leave you worse off than before the lock existed, so the report
says so on every offline run.

`--update-lock` exits with the result of the check that produced the lock:
refreshing a lock over a drifted tree records the drift, it does not bless it.

## License

MIT
