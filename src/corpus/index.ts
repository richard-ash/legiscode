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

export { type ExitCode, ExitCodes } from "@/storage";
export { buildCorpus } from "./build-corpus";
export type {
  CatalogIndex,
  CatalogModule,
  JurisdictionCatalog,
  JurisdictionEntry,
} from "./catalog";
export { CatalogIndexSchema, CatalogModuleSchema, JurisdictionCatalogSchema } from "./catalog";
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

// `CorpusRef` and its helpers (`parse`, `serialize`, `equals`, `hash`,
// `corpusRefFromWire`, `corpusRefToWire`) live at `@/corpus/refs` and are
// imported directly by every consumer (persistence, corpus-nav, workbench,
// UI, the IPC boundary). This is a deliberate carve-out from the
// deep-module barrel discipline: re-exporting four bare verb names
// through this barrel would force per-call-site aliasing. The grep gates
// in `test/baseline.test.ts` pin `refs.ts` as the one sanctioned home for
// the brand+zod machinery, and `@/corpus/wire` as the zod-free home for
// the shape declarations.
