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
  check,
  compareWithRegistry,
  exitCodeFor,
  hashNormalized,
  listComponentFiles,
  type CheckOptions,
  type CheckReport,
  type Comparison,
  type ComponentResult,
  type Verdict,
} from './check.js'
export {
  applyProposal,
  bestFingerprint,
  exportedSymbols,
  insertHeader,
  planInit,
  proposedHeader,
  retag,
  similarity,
  writableStates,
  type InitOptions,
  type InitPlan,
  type InitProposal,
  type MatchMethod,
  type SkipReason,
} from './discover.js'
export {
  buildLock,
  checkOffline,
  lockPath,
  readLock,
  writeLock,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  type LockEntry,
  type LockFile,
  type OfflineOptions,
} from './lock.js'
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
