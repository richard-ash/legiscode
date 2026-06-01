// Public surface of the @/storage module. Consumers must import from here,
// not from individual files inside src/storage/. See docs/ARCHITECTURE.md.
//
// What's intentionally NOT re-exported is internal: implementation details
// of the lock protocol, the 3-step swap state machine, JSON serialization,
// and sentinel composition. Add here when a downstream consumer has a
// legitimate need; default to keeping the surface narrow.

export {
  AtomicWriteError,
  acquireLock,
  computeChecksum,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_MAX_BUILD_AGE_SECONDS,
  type ExitCode,
  ExitCodes,
  ensureCleanNew,
  isSentinelValid,
  type Lock,
  promote,
  recover,
  releaseLock,
  SENTINEL_FILENAME,
} from "./atomic-write";
export { canonicalStringify, fsyncDir, writeJson } from "./canonical-json";
export { type ComposeCorpusMetaInput, composeCorpusMeta, writeCorpusMeta } from "./corpus-meta";
export { type WriteModuleOptions, writeModule } from "./writer";
