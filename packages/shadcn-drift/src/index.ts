/**
 * Programmatic entry point for shadcn-drift.
 *
 * The CLI in `cli.ts` is a thin shell over this; anything the CLI can do should
 * be reachable from here without spawning a process.
 */
export { ExitCode } from './exit-codes.js'
export { DriftError } from './errors.js'
export {
  findComponentsJson,
  registryStyleFor,
  resolveConfig,
  type ComponentsJson,
  type DriftOverrides,
  type ResolvedConfig,
} from './config.js'
export {
  extractLeadingBlockComment,
  formatHeader,
  isKnownState,
  isTodoReason,
  parseHeader,
  stripHeader,
  validateHeader,
  HEADER_STATES,
  TODO_REASON,
  type HeaderProblem,
  type HeaderProblemCode,
  type HeaderState,
  type ProvenanceHeader,
} from './header.js'
