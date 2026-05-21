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
  const universe = buildModuleUniverse(modules);
  const perModule = modules.map((m) => validateModule(m, modules, universe));

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

// Per-module anchor universe — parsed sections ∪ raw tocAnchors
// (lowercased). Mirrors what binder.ts:buildAnchorIndex emits so the
// validator never disagrees with the binder about whether a target
// anchor exists. Built once per validateCorpus call and re-keyed by
// module id for the cross-module lookup path.
type ModuleAnchorUniverse = Map<ModuleId, ReadonlySet<string>>;

function buildModuleUniverse(allModules: readonly ParsedModule[]): ModuleAnchorUniverse {
  const out = new Map<ModuleId, ReadonlySet<string>>();
  for (const m of allModules) {
    const set = new Set<string>();
    for (const s of m.sections) set.add(s.id);
    for (const a of m.tocAnchors) set.add(a.toLowerCase());
    out.set(m.module.id, set);
  }
  return out;
}

function validateModule(
  parsed: ParsedModule,
  allModules: readonly ParsedModule[],
  universe: ModuleAnchorUniverse,
): PerModuleValidation {
  return {
    moduleId: parsed.module.id,
    coverage: computeCoverage(parsed),
    citations: computeCitationReport(parsed, allModules, universe),
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
  universe: ModuleAnchorUniverse,
): CitationReport {
  const ownSectionIds = new Set<SectionId>(parsed.sections.map((s) => s.id));
  // Source TOC anchors (every <a name="JD_X"> in the module's bound)
  // include the cases the parser doesn't promote: deletion stubs, Note
  // sub-elements, paragraph subscripts. Citations to those count as
  // resolved because the cited content IS documented in the source —
  // it just isn't a queryable top-level section. Lowercased so the
  // case-mixed source anchors ("906E", "JD_B102A") line up with the
  // post-binder lowercase anchor_id values that flow through the gate.
  const ownTocAnchors = new Set<string>(parsed.tocAnchors.map((a) => a.toLowerCase()));
  // Raw (case-preserving) anchor set kept as belt-and-braces guard
  // against case-sensitivity drift between binder and validator. Phase
  // 6's accuracy fixture verifies this redundancy adds no real hits;
  // remove it then.
  const ownTocAnchorsRaw = new Set<string>(parsed.tocAnchors);
  // Sibling lookup uses the corpus-wide anchor universe so the
  // validator sees the same anchor set the binder did when binding
  // cross-module cites. Mismatched indices = validator/binder
  // disagreement, which was the root cause of 90 false-positive
  // intra-unresolved cites in the production corpus.
  const otherModulesById = new Map<ModuleId, ReadonlySet<string>>();
  for (const m of allModules) {
    if (m.module.id === parsed.module.id) continue;
    const set = universe.get(m.module.id);
    if (set) otherModulesById.set(m.module.id, set);
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
        ownTocAnchorsRaw,
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

// Phase 4 — validator now dry-runs the binder. The legacy hierarchy
// walk + "a"-prefix hack + cross-module slip demotion in
// validate-corpus.ts:207-278 are deleted. Every section-ref must hit
// a real anchor (the build-time binder guarantees this for shipped
// cites); every leftover internal / cross_module target with an
// installed target module is the binder having failed and the build
// refuses to ship it. Cites to modules NOT in this build stay as
// cross_module and report cross-unresolved (install-time concern,
// not gated). vague / structural / internal_appendix pass through;
// the runtime resolver handles them, the build doesn't gate on them.
function classifyCitation(
  _source: SectionFile,
  citation: SectionFile["citations"][number],
  ownSectionIds: ReadonlySet<SectionId>,
  ownTocAnchors: ReadonlySet<string>,
  otherModulesById: ReadonlyMap<ModuleId, ReadonlySet<string>>,
  ownTocAnchorsRaw: ReadonlySet<string>,
): CitationVerdict {
  const target = citation.target;
  switch (target.kind) {
    case "section-ref": {
      const sibling = otherModulesById.get(target.module_id);
      if (sibling) {
        if (sibling.has(target.anchor_id)) return { kind: "resolved" };
        return {
          kind: "intra-unresolved",
          targetId: `${target.module_id}/${target.anchor_id}`,
        };
      }
      // Citing module's own ref. Anchor exists in parsed sections OR
      // in source TOC anchors (deletion stubs / Note sub-elements).
      if (ownSectionIds.has(target.anchor_id as SectionId)) return { kind: "resolved" };
      if (ownTocAnchors.has(target.anchor_id)) return { kind: "resolved" };
      // Defense in depth: ownTocAnchorsRaw kept the case-mixed source
      // form for legacy compat in earlier phases — Phase 2 lowercased
      // the canonical set, but the raw fallback catches a regression
      // path where a binder change drifts from the validator. Drop in
      // Phase 6 if the accuracy fixture confirms no real hit.
      if (ownTocAnchorsRaw.has(target.anchor_id)) return { kind: "resolved" };
      return { kind: "intra-unresolved", targetId: target.anchor_id };
    }
    case "internal":
      // Phase 4 — the binder always rewrites bindable internals to
      // section-ref and reclassifies unbindable ones as vague. An
      // internal target on disk means the binder pass didn't run on
      // this section, which is a regression worth gating.
      return {
        kind: "intra-unresolved",
        targetId: target.section_id,
      };
    case "cross_module": {
      const targetModule = otherModulesById.get(target.module_id);
      if (!targetModule) {
        // Foreign code not in this build (typical ca-* / us-* cite).
        // Install-time concern, reported but not gated.
        return {
          kind: "cross-unresolved",
          targetId: `${target.module_id}/${target.section_id}`,
          reason: `target module "${target.module_id}" not in this build`,
        };
      }
      // Target module IS in build but the binder didn't rewrite the
      // cite. Same regression signature as internal above — gate it.
      return {
        kind: "intra-unresolved",
        targetId: `${target.module_id}/${target.section_id}`,
      };
    }
    case "internal_appendix":
      // Appendix targets render in the appendix viewer (v1.1 surface);
      // not section-id-shaped. Reported as cross-unresolved for
      // bookkeeping, not gated.
      return {
        kind: "cross-unresolved",
        targetId: target.appendix_id,
        reason: "appendix target — appendix viewer (v1.1) covers navigation",
      };
    case "structural":
    case "vague":
      // Out of scope for this gate. Structural references resolve
      // against the corpus tree at runtime. vague is the binder's
      // dump bucket for stale / external / no-anchor cites — they
      // render as citation chrome but don't navigate.
      return { kind: "resolved" };
  }
}
