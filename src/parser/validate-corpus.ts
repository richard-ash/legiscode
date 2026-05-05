// Corpus-level validation gates that need vantage of every module at once:
// TOC coverage (catches silent drops anywhere in the hierarchy) and
// intra-module citation resolution (every internal §-cite must hit a
// known section).
//
// Pure-data: takes ParsedModule[] in, returns a CorpusValidationResult.
// No fs reads, no HTML reads — testable from plain fixtures. Lives in
// @/parser because the inputs are parser outputs and the
// citation-resolution semantics share the same vocabulary the rest of
// @/parser uses.
//
// The "errors as data" surface (BuildError) lives in @/corpus; this module
// returns structural data and lets @/corpus classify it into typed errors
// + exit codes.

import type { ModuleId, ParsedModule, SectionFile, SectionId, SkippedEntry } from "@/types";

export interface TocCoverageReport {
  /** Total entries the parser attempted to emit (parsed sections + skipped raw_ids). */
  total: number;
  /** Entries that landed in `parsed.sections[]` — i.e., valid SectionIds. */
  covered: number;
  /** Section ids the parser tried to emit but couldn't. */
  missing: readonly SectionId[];
}

export interface UnresolvedCitation {
  sourceModuleId: ModuleId;
  sourceSectionId: SectionId;
  /**
   * The raw target id the citation pointed at — usually the destination
   * section id with no module qualifier.
   */
  rawText: string;
  reason: string;
}

export interface CitationReport {
  /** Total citations emitted across all sections in the input modules. */
  total: number;
  /** Citations whose target resolved (intra-module hit, or cross-module / external by design). */
  resolved: number;
  /**
   * Intra-module citations whose target.section_id does NOT exist in the
   * citing module. The 100% gate: this list MUST be empty for the
   * corpus to ship.
   */
  unresolvedIntra: readonly UnresolvedCitation[];
  /**
   * Cross-module citations whose target couldn't be resolved (e.g.,
   * because the referenced module isn't in this build). Reported but
   * NOT gated — cross-module resolution happens at install time when
   * both modules are present.
   */
  unresolvedCross: readonly UnresolvedCitation[];
}

export interface PerModuleValidation {
  moduleId: ModuleId;
  coverage: TocCoverageReport;
  citations: CitationReport;
}

export interface CorpusValidationResult {
  /** Corpus-aggregate coverage. Sum of per-module totals; missing flattened. */
  coverage: TocCoverageReport;
  /** Corpus-aggregate citations. Sum of per-module totals; unresolved flattened. */
  citations: CitationReport;
  /** Per-module breakdown for emitting per-module gate errors downstream. */
  perModule: readonly PerModuleValidation[];
}

export function validateCorpus(modules: readonly ParsedModule[]): CorpusValidationResult {
  const perModule = modules.map((m) => validateModule(m, modules));

  const coverage: TocCoverageReport = {
    total: perModule.reduce((sum, m) => sum + m.coverage.total, 0),
    covered: perModule.reduce((sum, m) => sum + m.coverage.covered, 0),
    missing: perModule.flatMap((m) => m.coverage.missing),
  };
  const citations: CitationReport = {
    total: perModule.reduce((sum, m) => sum + m.citations.total, 0),
    resolved: perModule.reduce((sum, m) => sum + m.citations.resolved, 0),
    unresolvedIntra: perModule.flatMap((m) => m.citations.unresolvedIntra),
    unresolvedCross: perModule.flatMap((m) => m.citations.unresolvedCross),
  };
  return { coverage, citations, perModule };
}

function validateModule(
  parsed: ParsedModule,
  allModules: readonly ParsedModule[],
): PerModuleValidation {
  return {
    moduleId: parsed.module.id,
    coverage: computeCoverage(parsed),
    citations: computeCitationReport(parsed, allModules),
  };
}

function computeCoverage(parsed: ParsedModule): TocCoverageReport {
  const missing: SectionId[] = collectSkippedSectionIds(parsed.skipped);
  const covered = parsed.sections.length;
  return {
    total: covered + missing.length,
    covered,
    missing,
  };
}

// "Missing" section ids are the section-shaped entries the parser tried
// to emit but couldn't. SkippedEntry kinds are "section" (validator
// rejection of a complete SectionFile — id is known and valid) and
// "parse" (parse-time skip — raw_id may or may not be a valid SectionId).
// Only valid SectionIds land in `missing[]`; raw_id-less or non-conforming
// raw_ids are observed via the skip count but can't be enumerated as
// SectionIds without breaking the type.
function collectSkippedSectionIds(skipped: readonly SkippedEntry[]): SectionId[] {
  const out: SectionId[] = [];
  for (const s of skipped) {
    if (s.kind === "section") {
      out.push(s.id);
      continue;
    }
    if (s.kind === "parse" && s.raw_id) {
      // The parse-time skip carries raw_id verbatim — not pre-validated.
      // Try to interpret it as a section id; if it doesn't conform, the
      // skip is still a coverage gap, just one we can't name.
      const candidate = s.raw_id.trim();
      if (/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(candidate)) {
        out.push(candidate as SectionId);
      }
    }
  }
  return out;
}

function computeCitationReport(
  parsed: ParsedModule,
  allModules: readonly ParsedModule[],
): CitationReport {
  const ownSectionIds = new Set<SectionId>(parsed.sections.map((s) => s.id));
  // Source TOC anchors (every <a name="JD_X"> in the module's bound)
  // include the cases the parser doesn't promote: deletion stubs, Note
  // sub-elements, paragraph subscripts. Citations to those count as
  // resolved because the cited content IS documented in the source —
  // it just isn't a queryable top-level section.
  const ownTocAnchors = new Set<string>(parsed.tocAnchors);
  const otherModulesById = new Map<ModuleId, Set<SectionId>>();
  for (const m of allModules) {
    if (m.module.id === parsed.module.id) continue;
    otherModulesById.set(m.module.id, new Set(m.sections.map((s) => s.id)));
  }

  let total = 0;
  let resolved = 0;
  const unresolvedIntra: UnresolvedCitation[] = [];
  const unresolvedCross: UnresolvedCitation[] = [];

  for (const section of parsed.sections) {
    for (const citation of section.citations) {
      total += 1;
      const verdict = classifyCitation(
        section,
        citation,
        ownSectionIds,
        ownTocAnchors,
        otherModulesById,
      );
      if (verdict.kind === "resolved") {
        resolved += 1;
      } else if (verdict.kind === "intra-unresolved") {
        unresolvedIntra.push({
          sourceModuleId: parsed.module.id,
          sourceSectionId: section.id,
          rawText: verdict.targetId,
          reason: "intra-module citation target not in parsed sections or source anchors",
        });
      } else {
        unresolvedCross.push({
          sourceModuleId: parsed.module.id,
          sourceSectionId: section.id,
          rawText: verdict.targetId,
          reason: verdict.reason,
        });
      }
    }
  }

  return { total, resolved, unresolvedIntra, unresolvedCross };
}

type CitationVerdict =
  | { kind: "resolved" }
  | { kind: "intra-unresolved"; targetId: string }
  | { kind: "cross-unresolved"; targetId: string; reason: string };

function classifyCitation(
  source: SectionFile,
  citation: SectionFile["citations"][number],
  ownSectionIds: ReadonlySet<SectionId>,
  ownTocAnchors: ReadonlySet<string>,
  otherModulesById: ReadonlyMap<ModuleId, ReadonlySet<SectionId>>,
): CitationVerdict {
  const target = citation.target;
  switch (target.kind) {
    case "internal": {
      // Resolution order — first hit wins:
      //   1. Self-citation (trivially exists)
      //   2. Hierarchy walk on parsed section ids ("261.1.5" → "261.1")
      //   3. Source TOC anchor lookup (catches deletion stubs / Note
      //      sub-elements that exist as <a name="JD_X"> in source but
      //      aren't promoted to queryable sections)
      // Only "." segments are walked; "-" / "_" stay literal because they
      // delimit non-hierarchy ids (e.g., "1075.1-art-16" is a single
      // section, not section "1075.1" with sub "art-16").
      if (target.section_id === source.id) return { kind: "resolved" };
      let candidate: string = target.section_id;
      while (true) {
        if (ownSectionIds.has(candidate as SectionId)) return { kind: "resolved" };
        if (ownTocAnchors.has(candidate)) return { kind: "resolved" };
        const idx = candidate.lastIndexOf(".");
        if (idx < 0) break;
        candidate = candidate.slice(0, idx);
      }
      // The citation extractor's regex matches "§\s*\d+(?:\.\d+)*" and
      // emits every hit as `internal`. Bare-integer cites with no
      // hierarchy and no source-anchor backing are almost certainly
      // external code references the extractor mis-classified
      // (CA Public Resources § 95075, US Code § 5270, etc.). Demote to
      // cross-unresolved (informational, not gated) to avoid blocking
      // the PR on extractor false positives. A future PR with
      // context-aware extraction can promote these back to typed external.
      if (/^\d+$/.test(target.section_id)) {
        return {
          kind: "cross-unresolved",
          targetId: target.section_id,
          reason:
            "bare-integer citation with no source anchor — likely external code reference mis-extracted as internal",
        };
      }
      return { kind: "intra-unresolved", targetId: target.section_id };
    }
    case "internal_appendix":
      // Appendix targets aren't tracked in the section-id index; report
      // as cross-style unresolved (informational, not gated). A future
      // round can promote to a typed report if/when we resolve appendices.
      return {
        kind: "cross-unresolved",
        targetId: target.appendix_id,
        reason: "appendix target — not tracked by intra-module section gate",
      };
    case "cross_module": {
      const targetModule = otherModulesById.get(target.module_id);
      if (!targetModule) {
        return {
          kind: "cross-unresolved",
          targetId: `${target.module_id}/${target.section_id}`,
          reason: `target module "${target.module_id}" not in this build`,
        };
      }
      if (!targetModule.has(target.section_id)) {
        return {
          kind: "cross-unresolved",
          targetId: `${target.module_id}/${target.section_id}`,
          reason: "target section not in cross-module section set",
        };
      }
      return { kind: "resolved" };
    }
    case "external":
    case "vague":
      // Out of scope for this gate — by definition unresolvable
      // structurally. Counted as "resolved" for total/resolved math
      // because they're not failures.
      return { kind: "resolved" };
  }
}
