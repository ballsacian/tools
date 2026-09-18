# shadcn-drift

> **Status: pre-release.** `check` and `config` work. `init` (autodiscovery) and
> `--offline` (the lock file) are not implemented yet and exit `3` rather than
> pretending to pass.

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

## Planned surface

```
npx shadcn-drift                 # check for drift (default)
npx shadcn-drift init            # autodiscover components, write provenance headers
npx shadcn-drift --offline       # verify against shadcn.lock.json — no network, CI-safe
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
to differ and must say why. `npx shadcn-drift init` writes these for you by
identifying each file against the registry.

## License

MIT
