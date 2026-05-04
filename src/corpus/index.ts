// Public surface of the @/corpus module. Consumers (today: the CLI; later:
// any in-process or programmatic caller) depend ONLY on the symbols
// re-exported here. Reaching past this barrel into build-corpus.ts or
// errors.ts is a code smell.
//
// @/corpus owns the corpus-build orchestrator: it composes @/parser,
// @/storage, and @/types into the buildCorpus(opts) → BuildResult
// contract. Errors are data, not exceptions; the discriminated-union
// `BuildError` lists every failure mode the orchestrator can produce.
//
// ExitCodes are re-exported from @/storage where AtomicWriteError owns
// the canonical enum. @/corpus uses the same type so callers don't have
// to reach into @/storage just to map `BuildResult.exitCode`.

export { buildCorpus } from "./build-corpus";
export { errorsToExitCode } from "./errors";
export type {
  BuildCorpusOptions,
  BuildError,
  BuildResult,
  CitationReport,
  CorpusBuildMeta,
  SkipsReport,
  TocCoverageReport,
  UnresolvedCitation,
} from "./types";
export { type ExitCode, ExitCodes } from "@/storage";
