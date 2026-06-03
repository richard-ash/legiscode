// Internal orchestration for `buildCorpus`. Sequential pipeline that
// reads + parses a jurisdiction's source, runs corpus-level gates,
// and writes the per-module bundles + a corpus-level `corpus-meta.json`.
//
// Errors are data: every failure mode lands in `BuildResult.errors` as a
// typed `BuildError`. The orchestrator never throws to its caller (with
// the exception of unknown errors that escape the typed catch arms —
// those propagate up because they're bugs, not errors-as-data).
//
// Pipeline steps:
//   1. read + validate manifest
//   2. read source bytes; compute SHA-256
//   3. parse → ParsedModule[]
//   4. validateCorpus (TOC coverage + intra-module citation resolution)
//   5. purge outputDir, then per-module: skip-gate check + writeModule
//   6. write corpus-level corpus-meta.json
//   7. errorsToExitCode → BuildResult

import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CitationPatternError,
  type CorpusValidationResult,
  DefinedTermPatternError,
  ParseAbortError,
  type ParsedModule,
  parseExport,
  validateCorpus,
} from "@/parser";
import { AtomicWriteError, ExitCodes, writeJson, writeModule } from "@/storage";
import type { JurisdictionManifest, ModuleId } from "@/types";
import { CorpusReadError, readJurisdictionManifest } from "@/types/validate";
import { errorsToExitCode } from "./errors";
import {
  type BuildCorpusOptions,
  type BuildError,
  type BuildResult,
  type CorpusBuildMeta,
  EMPTY_CITATIONS,
  EMPTY_COVERAGE,
} from "./types";

const CORPUS_META_FILENAME = "corpus-meta.json";

export async function buildCorpus(opts: BuildCorpusOptions): Promise<BuildResult> {
  const startedAt = Date.now();
  const errors: BuildError[] = [];
  const modulesBuilt: ModuleId[] = [];
  const skipsByModule: Record<ModuleId, number> = {};
  let totalSkips = 0;
  let sourceSha256 = "";
  let validation: CorpusValidationResult = {
    coverage: EMPTY_COVERAGE,
    citations: EMPTY_CITATIONS,
    perModule: [],
  };

  // Step 1 — read + validate manifest
  const manifestResult = await readManifest(opts.manifestPath);
  if (manifestResult.kind === "err") {
    errors.push(manifestResult.error);
    return finalize();
  }
  const manifest = manifestResult.value;

  // Step 2 — read source bytes, compute SHA-256
  const sourceResult = await readSource(opts.sourcePath);
  if (sourceResult.kind === "err") {
    errors.push(sourceResult.error);
    return finalize();
  }
  sourceSha256 = createHash("sha256").update(sourceResult.value).digest("hex");

  // Step 3 — parse
  let parsed: ParsedModule[];
  try {
    parsed = parseExport(sourceResult.value, manifest);
  } catch (err) {
    if (err instanceof ParseAbortError) {
      errors.push({ kind: "parse_aborted", moduleId: null, reason: err.message });
      return finalize();
    }
    if (err instanceof CitationPatternError || err instanceof DefinedTermPatternError) {
      // The manifest passed schema validation but a citation_patterns or
      // defined_term_patterns string is not a valid RegExp. Surface as a
      // typed manifest_invalid BuildError instead of letting the throw
      // escape the orchestrator contract.
      errors.push({
        kind: "manifest_invalid",
        path: opts.manifestPath,
        issues: [],
        reason: err.message,
      });
      return finalize();
    }
    throw err;
  }

  // Step 4 — corpus-level validation: TOC coverage, intra-module citation
  // resolution, and section.id uniqueness gates. Pure-data; no HTML access.
  // Per-module failures become typed BuildErrors; corpus-level totals
  // populate BuildResult.
  const filtered = filterTargets(parsed, opts.only);
  validation = validateCorpus(filtered);
  const modulesWithDuplicates = new Set<ModuleId>();
  for (const m of validation.perModule) {
    if (m.coverage.missing.length > 0) {
      errors.push({
        kind: "toc_coverage_failed",
        moduleId: m.moduleId,
        missing: m.coverage.missing,
      });
    }
    if (m.duplicateSectionIds.length > 0) {
      // Per D7: short-circuit writeModule for any module whose section.ids
      // are not unique. The writer's `<sectionId>.json` filename layout
      // collapses duplicates to a last-write winner, silently dropping
      // every other colliding entry. A bundle on disk would already be
      // bad data; we'd rather fail loudly than ship it.
      errors.push({
        kind: "duplicate_section_ids",
        moduleId: m.moduleId,
        duplicates: m.duplicateSectionIds,
      });
      modulesWithDuplicates.add(m.moduleId);
    }
    if (m.unresolvableDefIds.length > 0) {
      // Loader-trust gate: every defined_term def_id must point at a
      // Definition the module emitted. The runtime tooltip lookup in
      // electron/corpus-loader.ts used to silent-skip missing refs;
      // project_legal_corpus_zero_skip forbids that — completeness
      // gates are non-negotiable. Module bundles still write (the
      // sections themselves are valid); the BuildError flips
      // corpus-meta.valid=false so consumers can refuse to install.
      errors.push({
        kind: "unresolvable_def_id",
        moduleId: m.moduleId,
        refs: m.unresolvableDefIds,
      });
    }
  }
  if (validation.citations.unresolvedIntra.length > 0) {
    errors.push({
      kind: "citation_resolution_failed",
      unresolved: validation.citations.unresolvedIntra,
    });
  }
  // NB: TOC coverage and citation gate failures still write per-module
  // bundles (atomicity preserved per writeModule's own contract). Only
  // duplicate_section_ids short-circuits the write — see modulesWithDuplicates
  // skip below — because shipping a silently-collapsed bundle is worse than
  // shipping no bundle at all. The corpus-level corpus-meta.json records
  // `valid: false` with the typed errors so consumers can inspect; file
  // presence alone is no longer the validity signal.

  // Step 5 — purge outputDir (D6) then write each requested module.
  // When --only is set we purge ONLY the targeted module subdirectories so
  // unselected modules in an existing corpus survive across iteration runs.
  // A whole-outputDir purge would otherwise delete every module the
  // operator did not include in --only.
  await mkdir(opts.outputDir, { recursive: true });
  if (opts.only && opts.only.length > 0) {
    for (const ps of filtered) {
      await rm(join(opts.outputDir, ps.module.id), { recursive: true, force: true });
    }
  } else {
    await rm(opts.outputDir, { recursive: true, force: true });
    await mkdir(opts.outputDir, { recursive: true });
  }

  for (const ps of filtered) {
    // Short-circuit per D7: a module with duplicate section.ids would
    // produce a silently-collapsed bundle (multiple sections writing to
    // the same `<sectionId>.json` path). Skip the writeModule call
    // entirely so no per-module directory exists; corpus-meta still
    // records `valid: false` with the duplicate_section_ids error.
    if (modulesWithDuplicates.has(ps.module.id)) {
      skipsByModule[ps.module.id] = ps.skipped.length;
      totalSkips += ps.skipped.length;
      continue;
    }

    const maxSkips = opts.maxSkips ?? ps.module.max_skip_count;

    // Pre-check the skip gate so we can surface skip_gate_exceeded as its
    // own typed BuildError instead of pattern-matching @/storage's PARSE
    // exception. @/storage's defensive enforceSkipGate stays as a safety
    // net (it'll never fire because we pre-check).
    //
    // On any per-module failure we record + CONTINUE rather than break:
    // modules are independent, and the operator wants the full picture
    // for diagnosis. Per-module bundles still write to disk; corpus-level
    // corpus-meta records `valid: false` with the specific failure.
    if (ps.skipped.length > maxSkips) {
      errors.push({
        kind: "skip_gate_exceeded",
        moduleId: ps.module.id,
        count: ps.skipped.length,
        max: maxSkips,
      });
      // skip count is also tracked here so corpus-level totals see this
      // module's skips even though the bundle didn't promote
      skipsByModule[ps.module.id] = ps.skipped.length;
      totalSkips += ps.skipped.length;
      continue;
    }

    try {
      await writeModule(ps, {
        jurisdiction: manifest.jurisdiction,
        outputDir: join(opts.outputDir, ps.module.id),
        snapshotAt: opts.snapshotAt,
        maxSkips,
        sourceSha256,
      });
      modulesBuilt.push(ps.module.id);
      skipsByModule[ps.module.id] = ps.skipped.length;
      totalSkips += ps.skipped.length;
    } catch (err) {
      if (err instanceof AtomicWriteError) {
        errors.push(classifyWriteError(err, ps.module.id));
        continue;
      }
      if (err instanceof ParseAbortError) {
        errors.push({ kind: "parse_aborted", moduleId: ps.module.id, reason: err.message });
        continue;
      }
      throw err;
    }
  }

  // Step 6 — write corpus-level corpus-meta.json (full builds only).
  // In --only mode `modules_built` reflects just the rebuilt subset, so
  // overwriting corpus-meta would falsely claim the corpus contains only
  // those modules. Leave any prior full-build sentinel intact; --only is
  // an iteration mode, not a canonical-corpus producer.
  if (!opts.only || opts.only.length === 0) {
    const corpusMeta: CorpusBuildMeta = {
      valid: errors.length === 0,
      source_sha256: sourceSha256,
      snapshot_at: opts.snapshotAt,
      duration_ms: Date.now() - startedAt,
      modules_built: modulesBuilt,
      skips: { total: totalSkips, byModule: skipsByModule },
      coverage: validation.coverage,
      citations: validation.citations,
      errors,
    };
    try {
      await writeJson(join(opts.outputDir, CORPUS_META_FILENAME), corpusMeta);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
      errors.push({ kind: "corpus_meta_write_failed", errno });
    }
  }

  // Step 7 — classify errors → exit code, return
  return finalize();

  function finalize(): BuildResult {
    return {
      exitCode: errorsToExitCode(errors),
      modulesBuilt,
      coverage: validation.coverage,
      citations: validation.citations,
      skips: { total: totalSkips, byModule: skipsByModule },
      errors,
      warnings: [],
      durationMs: Date.now() - startedAt,
      sourceSha256,
      snapshotAt: opts.snapshotAt,
    };
  }
}

type StepResult<T> = { kind: "ok"; value: T } | { kind: "err"; error: BuildError };

async function readManifest(path: string): Promise<StepResult<JurisdictionManifest>> {
  try {
    const value = await readJurisdictionManifest(path);
    return { kind: "ok", value };
  } catch (err) {
    if (err instanceof CorpusReadError) {
      // CorpusReadError stages: "read" (fs error), "parse" (JSON syntax),
      // "validate" (Zod failure). Only "validate" carries Zod issues; the
      // other stages get a `reason` so the CLI can surface the detail.
      return {
        kind: "err",
        error: {
          kind: "manifest_invalid",
          path,
          issues: [],
          reason: err.message,
        },
      };
    }
    return {
      kind: "err",
      error: {
        kind: "manifest_invalid",
        path,
        issues: [],
        reason: (err as Error).message,
      },
    };
  }
}

async function readSource(path: string): Promise<StepResult<Buffer>> {
  try {
    return { kind: "ok", value: await readFile(path) };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    return { kind: "err", error: { kind: "source_unreadable", path, errno } };
  }
}

function filterTargets(
  modules: readonly ParsedModule[],
  only: readonly string[] | undefined,
): readonly ParsedModule[] {
  if (!only || only.length === 0) return modules;
  const allowed = new Set(only);
  return modules.filter((m) => allowed.has(m.module.id));
}

function classifyWriteError(err: AtomicWriteError, moduleId: ModuleId): BuildError {
  // Preserve @/storage's tri-state exit-code semantics by mapping each
  // AtomicWriteError exitCode to its own typed BuildError variant. Without
  // this dispatch, lock contention (retryable) and recovery refusal
  // (operator-inspect) would both collapse into a generic write failure
  // and `errorsToExitCode` would emit WRITE=5 for all three, breaking the
  // documented CLI exit-code contract that automation depends on.
  switch (err.exitCode) {
    case ExitCodes.PARSE:
      // Storage's PARSE-coded errors are corpus-shape failures (zero
      // sections, drift) the parser couldn't catch. Treat as parse_aborted
      // for the moduleId we know about.
      return { kind: "parse_aborted", moduleId, reason: err.message };
    case ExitCodes.LOCK_HELD:
      return { kind: "atomic_write_lock_held", moduleId, reason: err.message };
    case ExitCodes.RECOVERY_REFUSED:
      return { kind: "atomic_write_recovery_refused", moduleId, reason: err.message };
    default:
      return { kind: "atomic_write_failed", moduleId, errno: err.message };
  }
}
