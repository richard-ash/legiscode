// Build-time contract surface for @/corpus. The orchestrator's public types
// live here so consumers can pin the shape of `BuildResult` and the
// discriminated union of `BuildError` without pulling in build-corpus.ts.
//
// Errors are data, not exceptions: every failure mode the orchestrator
// can produce is one variant of `BuildError`. New failure modes add a
// variant; `errorsToExitCode` then becomes a TS exhaustiveness error
// until the new kind has a mapping.
//
// Phase-4 fields (`coverage`, `citations`, the toc/citation BuildError
// kinds) are part of the contract today; the pipeline populates them as
// empty placeholders until `validateCorpus` lands in @/parser.

import type { ZodIssue } from "zod";
import type {
  CitationReport,
  DuplicateSectionId,
  TocCoverageReport,
  UnresolvedCitation,
} from "@/parser";
import type { ExitCode } from "@/storage";
import type { ModuleId, ParseWarning, SectionId } from "@/types";

export type { CitationReport, DuplicateSectionId, TocCoverageReport, UnresolvedCitation };

export interface BuildCorpusOptions {
  /**
   * Absolute path to a `JurisdictionManifest` JSON file. @/corpus reads
   * + validates it; consumers don't need to pre-parse.
   */
  manifestPath: string;
  /**
   * Already-resolved absolute path of the source export
   * (e.g., AmLegal HTML). The CLI is responsible for resolving
   * `manifest.source.path` relative to the repo root and running the
   * realpath + sandbox check; @/corpus trusts the value.
   *
   * Decoupling source-path resolution from @/corpus keeps the security
   * boundary in the CLI (where argv lives) and lets future programmatic
   * callers — which won't have a "repo root" — supply absolute paths
   * directly.
   */
  sourcePath: string;
  /**
   * Already-validated absolute path of the base output directory. Per
   * D6, @/corpus purges this directory at the start of every build —
   * `outputDir` is ephemeral build state, not authoritative storage.
   */
  outputDir: string;
  /** ISO 8601 datetime injected for determinism. */
  snapshotAt: string;
  /** Override every module's `max_skip_count` for this run. */
  maxSkips?: number;
  /**
   * Build only these module ids. Undefined or empty builds every module
   * declared in `manifest.modules[]`.
   */
  only?: readonly string[];
}

export interface SkipsReport {
  total: number;
  byModule: Readonly<Record<ModuleId, number>>;
}

/**
 * Discriminated union of every failure mode `buildCorpus` can produce.
 * Caller pattern-matches on `kind`; `errorsToExitCode` maps each kind to
 * an exit code via an exhaustive switch.
 *
 * `manifest_invalid` carries an optional `reason` for read/parse failures
 * (file not found, malformed JSON) where Zod issues don't apply. When
 * `issues` is non-empty the manifest parsed but failed schema validation.
 *
 * The three `atomic_write_*` variants preserve @/storage's tri-state exit
 * code semantics: lock contention (LOCK_HELD=6) is retryable, recovery
 * refusal (RECOVERY_REFUSED=7) needs operator inspection, generic write
 * failures (WRITE=5) are I/O issues. Collapsing all three into one variant
 * would lose the signal automation depends on.
 */
export type BuildError =
  | { kind: "manifest_invalid"; path: string; issues: readonly ZodIssue[]; reason?: string }
  | { kind: "source_unreadable"; path: string; errno: string }
  | { kind: "parse_aborted"; moduleId: ModuleId | null; reason: string }
  | { kind: "skip_gate_exceeded"; moduleId: ModuleId; count: number; max: number }
  | { kind: "toc_coverage_failed"; moduleId: ModuleId; missing: readonly SectionId[] }
  | { kind: "citation_resolution_failed"; unresolved: readonly UnresolvedCitation[] }
  | {
      kind: "duplicate_section_ids";
      moduleId: ModuleId;
      duplicates: readonly DuplicateSectionId[];
    }
  | { kind: "atomic_write_failed"; moduleId: ModuleId; errno: string }
  | { kind: "atomic_write_lock_held"; moduleId: ModuleId; reason: string }
  | { kind: "atomic_write_recovery_refused"; moduleId: ModuleId; reason: string }
  | { kind: "corpus_meta_write_failed"; errno: string };

/**
 * Shape returned to the CLI. `exitCode` is what the process should exit
 * with; the rest of the fields are observability for the caller.
 *
 * `warnings` is reserved for `ParseWarning[]` once the InterCodeLink
 * graph wires through; today it's always empty (deferred per plan).
 */
export interface BuildResult {
  exitCode: ExitCode;
  modulesBuilt: ModuleId[];
  coverage: TocCoverageReport;
  citations: CitationReport;
  skips: SkipsReport;
  errors: BuildError[];
  warnings: ParseWarning[];
  durationMs: number;
  sourceSha256: string;
  snapshotAt: string;
}

/**
 * Corpus-level build artifact written to `<outputDir>/corpus-meta.json`.
 * Per-module corpus-meta sentinels are written by @/storage; this file
 * is the corpus-wide complement, recording cross-module gate results
 * and source provenance.
 *
 * snake_case fields match the on-disk JSON convention used by per-module
 * corpus-meta.json so consumers can read both with the same idiom.
 */
export interface CorpusBuildMeta {
  valid: boolean;
  source_sha256: string;
  snapshot_at: string;
  duration_ms: number;
  modules_built: readonly ModuleId[];
  skips: SkipsReport;
  coverage: TocCoverageReport;
  citations: CitationReport;
  errors: readonly BuildError[];
}

export const EMPTY_COVERAGE: TocCoverageReport = { total: 0, covered: 0, missing: [] };
export const EMPTY_CITATIONS: CitationReport = {
  total: 0,
  resolved: 0,
  unresolvedIntra: [],
  unresolvedCross: [],
  newly_vague_by_reason: {
    vague_external: 0,
    vague_collision_unresolvable: 0,
    vague_no_anchor: 0,
  },
};
