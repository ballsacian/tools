/**
 * Exit codes are part of the CLI's contract — CI scripts branch on them.
 *
 * The split that matters is {@link OPERATIONAL} versus the two finding codes: a
 * network failure or a missing `components.json` means the tool could not reach
 * an opinion, and that must never be reported as "clean". The script this
 * package was extracted from folded 404s and fetch failures into a single error
 * bucket, which made "this component does not exist upstream" — a real finding —
 * indistinguishable from "ui.shadcn.com was briefly down".
 */
export const ExitCode = {
  /** Everything checked matches its declared state. */
  OK: 0,
  /**
   * A `(stock)` file differs from upstream, or a `(patched)`/`(forked)` file is
   * now identical to it and the tag is stale.
   */
  DRIFT: 1,
  /**
   * A claimed component does not exist upstream, the registry origin is not
   * trusted, or — under `--strict` — a file in `ui/` carries no header at all.
   */
  AUTHENTICITY: 2,
  /**
   * The tool could not form a verdict: no `components.json`, unparseable
   * config, or the registry was unreachable. Not a finding about the code.
   */
  OPERATIONAL: 3,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]
