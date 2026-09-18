// @ts-check

/**
 * Single Prettier config for the whole monorepo. Keep it the only one — Prettier
 * resolves the *nearest* config and does not merge, so a second config in a
 * package would replace this file outright rather than extend it.
 *
 * @type {import('prettier').Config}
 */
const config = {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  // `lf`, not the `auto` used in other repos on this machine: `.gitattributes`
  // pins the working tree to LF, so there is no CRLF for `auto` to preserve and
  // an explicit `lf` makes a stray CRLF a formatting error instead of silently
  // accepted noise.
  endOfLine: 'lf',
}

export default config
