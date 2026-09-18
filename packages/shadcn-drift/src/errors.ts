import { ExitCode } from './exit-codes.js'

/**
 * An error that already knows how it should terminate the process.
 *
 * Every throw site picks the code deliberately, so the CLI never has to guess
 * whether a failure was a finding about the user's code or a failure of the
 * tool to reach an opinion. Anything that escapes as a plain `Error` is a bug
 * and becomes {@link ExitCode.OPERATIONAL} at the top level.
 */
export class DriftError extends Error {
  readonly exitCode: ExitCode
  /** Extra lines printed under the message — what was searched, what to try. */
  readonly detail: string[]

  constructor(
    message: string,
    options: {
      exitCode?: ExitCode
      detail?: string[]
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'DriftError'
    this.exitCode = options.exitCode ?? ExitCode.OPERATIONAL
    this.detail = options.detail ?? []
  }
}

/**
 * The tool could not form a verdict. Reserved for "we cannot tell" — never for
 * "we looked and found a problem", which is what the finding codes are for.
 */
export function operational(
  message: string,
  detail?: string[],
  cause?: unknown,
): DriftError {
  return new DriftError(message, {
    exitCode: ExitCode.OPERATIONAL,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  })
}
