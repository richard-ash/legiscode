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

import type {
  BodySegment,
  DefinitionId,
  ModuleId,
  ParsedModule,
  SectionFile,
  SectionId,
  SkippedEntry,
} from "@/types";

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
  /**
   * Vague reclass observability. Buckets vague targets by why the
   * binder couldn't bind them:
   *   - vague_external: target had no source_target field — author
   *     wrote a fundamentally underspecified cite ("the previous
   *     section", "as set forth above"). Acceptable; outside the gate.
   *   - vague_collision_unresolvable: target had a source_target whose
   *     section_id lives in a collision family every one of whose
   *     members shares the citing section's hierarchy. Honest-vague;
   *     acceptable.
   *   - vague_no_anchor: target had a source_target whose section_id
   *     hit no anchor at all (no exact match, no collision family).
   *     This is a binder bug indicator — the build gate requires zero
   *     entries.
   */
  newly_vague_by_reason: NewlyVagueByReason;
}

export interface NewlyVagueByReason {
  vague_external: number;
  vague_collision_unresolvable: number;
  vague_no_anchor: number;
}

/**
 * Per-module section-id uniqueness report. Each entry names a section.id
 * that two or more SectionFiles in the same module emit, with the count
 * of colliding entries. Non-empty arrays are gate failures: the storage
 * writer's `<sectionId>.json` filename layout assumes uniqueness, so a
 * collision silently drops every entry but the last-write winner.
 *
 * Sorted by id ascending so the operator-visible failure message is
 * deterministic and snapshot tests don't churn on iteration order.
 */
export interface DuplicateSectionId {
  id: SectionId;
  count: number;
}

/**
 * One defined_term occurrence whose def_id points at a Definition the
 * module never emitted. Build-time gate output: shipping any of these
 * would land a section whose tooltip cannot resolve at runtime, which
 * the loader used to handle with a silent skip. Per
 * project_legal_corpus_zero_skip, completeness gates are non-negotiable
 * — the loader now trusts the gate and the build refuses to ship a
 * module with unresolvable refs.
 *
 * Sorted (sectionId, defId) ascending so the BuildError message is
 * deterministic across runs.
 */
export interface UnresolvableDefinitionRef {
  sectionId: SectionId;
  defId: DefinitionId;
}

export interface PerModuleValidation {
  moduleId: ModuleId;
  coverage: TocCoverageReport;
  citations: CitationReport;
  /**
   * section.id values that appear on more than one SectionFile in this
   * module. Empty array when uniqueness holds (the happy path). Lifted
   * into a `duplicate_section_ids` BuildError by the orchestrator; the
   * orchestrator short-circuits writeModule for any module with a
   * non-empty entry so silently-collapsed bundles never land on disk.
   */
  duplicateSectionIds: readonly DuplicateSectionId[];
  /**
   * defined_term occurrences whose def_id is not present in this
   * module's `moduleDefinitions[]`. Empty array on the happy path.
   * Lifted into an `unresolvable_def_id` BuildError by the
   * orchestrator so the build refuses to ship a module the runtime
   * loader would have to silent-skip.
   */
  unresolvableDefIds: readonly UnresolvableDefinitionRef[];
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
  const collisionFamilies = buildCollisionFamiliesByModule(modules);
  const perModule = modules.map((m) => validateModule(m, modules, universe, collisionFamilies));

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
    newly_vague_by_reason: {
      vague_external: perModule.reduce(
        (sum, m) => sum + m.citations.newly_vague_by_reason.vague_external,
        0,
      ),
      vague_collision_unresolvable: perModule.reduce(
        (sum, m) => sum + m.citations.newly_vague_by_reason.vague_collision_unresolvable,
        0,
      ),
      vague_no_anchor: perModule.reduce(
        (sum, m) => sum + m.citations.newly_vague_by_reason.vague_no_anchor,
        0,
      ),
    },
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

// Per-module collision-family index used for vague-bucket attribution.
// Mirrors binder.buildCollisionFamilies; kept local to avoid pulling the
// binder module into validate-corpus's dependency graph. Values carry
// each member's hierarchy so the validator can re-derive the binder's
// disambiguation verdict without recomputing it against every cite.
interface FamilyMember {
  readonly id: SectionId;
  readonly hierarchy: readonly string[];
}
type CollisionFamiliesByModule = Map<ModuleId, ReadonlyMap<string, readonly FamilyMember[]>>;

function stripOrdinalSuffix(id: string): string {
  return id.replace(/-\d+[a-z]?$/i, "");
}

// Mirrors binder.ts's APPENDIX_PREFIX_RE / stripAppendixPrefix. Kept
// in sync so the cite-resolution preview's family lookup matches what
// the runtime binder sees.
const APPENDIX_PREFIX_RE = /^(?:article|chapter)[\da-z]+appendix[a-z]+\.(.+)$/i;
function stripAppendixPrefix(id: string): string | null {
  const m = id.match(APPENDIX_PREFIX_RE);
  return m?.[1] ?? null;
}

function buildCollisionFamiliesByModule(
  modules: readonly ParsedModule[],
): CollisionFamiliesByModule {
  const out: CollisionFamiliesByModule = new Map();
  for (const m of modules) {
    const grouped = new Map<string, FamilyMember[]>();
    function push(key: string, member: FamilyMember): void {
      let arr = grouped.get(key);
      if (!arr) {
        arr = [];
        grouped.set(key, arr);
      }
      arr.push(member);
    }
    for (const s of m.sections) {
      const member: FamilyMember = { id: s.id, hierarchy: s.hierarchy };
      push(stripOrdinalSuffix(s.id), member);
      const leaf = stripAppendixPrefix(s.id);
      if (leaf) push(stripOrdinalSuffix(leaf), member);
    }
    const families = new Map<string, readonly FamilyMember[]>();
    for (const [key, members] of grouped) {
      // Mirror binder.ts: keep singletons for appendix-leaf aliases so a
      // bare cite in a module with one appendix can still resolve.
      if (members.length > 1 || members.some((m) => stripAppendixPrefix(m.id) !== null)) {
        families.set(key, members);
      }
    }
    out.set(m.module.id, families);
  }
  return out;
}

function validateModule(
  parsed: ParsedModule,
  allModules: readonly ParsedModule[],
  universe: ModuleAnchorUniverse,
  collisionFamilies: CollisionFamiliesByModule,
): PerModuleValidation {
  return {
    moduleId: parsed.module.id,
    coverage: computeCoverage(parsed),
    citations: computeCitationReport(parsed, allModules, universe, collisionFamilies),
    duplicateSectionIds: computeDuplicateSectionIds(parsed),
    unresolvableDefIds: computeUnresolvableDefIds(parsed),
  };
}

// Walk every section body in the module and collect each defined_term
// occurrence whose def_id has no matching Definition in
// `moduleDefinitions[]`. The loader's runtime tooltip lookup
// (joinDefinitionsForSection in electron/corpus-loader.ts) used to
// silent-skip these; the gate moves the check to build time so the
// loader can trust every def_id resolves.
//
// Recurses into format.children — defined_term spans nest inside
// bold/italic/list wrappers. De-dupes by (sectionId, defId) so a
// section that references the same missing def_id twice surfaces once.
function computeUnresolvableDefIds(parsed: ParsedModule): readonly UnresolvableDefinitionRef[] {
  const known = new Set<DefinitionId>(parsed.moduleDefinitions.map((d) => d.id));
  const seen = new Set<string>();
  const out: UnresolvableDefinitionRef[] = [];
  for (const section of parsed.sections) {
    walkDefIds(section.body, (defId) => {
      if (known.has(defId)) return;
      const key = `${section.id} ${defId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ sectionId: section.id, defId });
    });
  }
  out.sort((a, b) => {
    if (a.sectionId !== b.sectionId) return a.sectionId < b.sectionId ? -1 : 1;
    return a.defId < b.defId ? -1 : a.defId > b.defId ? 1 : 0;
  });
  return out;
}

function walkDefIds(segments: readonly BodySegment[], visit: (defId: DefinitionId) => void): void {
  for (const seg of segments) {
    if (seg.kind === "defined_term") {
      visit(seg.def_id);
    } else if (seg.kind === "format") {
      walkDefIds(seg.children, visit);
    }
  }
}

// Tally each section.id across the module's emitted SectionFiles. Entries
// with count > 1 are the regression: the writer's filename layout
// (`<sectionId>.json` per hierarchy directory) makes id uniqueness a
// load-bearing invariant the parser must guarantee. Returned sorted by id
// so the BuildError message is deterministic.
function computeDuplicateSectionIds(parsed: ParsedModule): readonly DuplicateSectionId[] {
  const counts = new Map<SectionId, number>();
  for (const s of parsed.sections) {
    counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  }
  const dups: DuplicateSectionId[] = [];
  for (const [id, count] of counts) {
    if (count > 1) dups.push({ id, count });
  }
  dups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return dups;
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
  collisionFamilies: CollisionFamiliesByModule,
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
  const newly_vague_by_reason: NewlyVagueByReason = {
    vague_external: 0,
    vague_collision_unresolvable: 0,
    vague_no_anchor: 0,
  };

  for (const section of parsed.sections) {
    for (const citation of section.citations) {
      total += 1;
      // Vague bucketing runs BEFORE classifyCitation so the
      // bookkeeping isn't entangled with the resolution verdict.
      if (citation.target.kind === "vague") {
        bucketVague(
          citation.target,
          section,
          collisionFamilies,
          universe,
          parsed.module.id,
          newly_vague_by_reason,
        );
      }
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

  return { total, resolved, unresolvedIntra, unresolvedCross, newly_vague_by_reason };
}

// Attribute a vague target to one of three buckets. The validator
// dry-runs the binder's disambiguation logic against the per-module
// collision-family index so its verdict agrees with the runtime
// resolver's (validator/binder agreement property).
function bucketVague(
  target: {
    kind: "vague";
    raw: string;
    source_target?: { kind: string; section_id?: string; module_id?: string };
  },
  section: SectionFile,
  collisionFamilies: CollisionFamiliesByModule,
  universe: ModuleAnchorUniverse,
  citingModuleId: ModuleId,
  bucket: NewlyVagueByReason,
): void {
  if (!target.source_target) {
    bucket.vague_external += 1;
    return;
  }
  const source = target.source_target;
  if (typeof source.section_id !== "string") {
    // Defensive: source_target shape must carry a section_id for
    // internal/cross_module; without one we can't bucket — treat as
    // external.
    bucket.vague_external += 1;
    return;
  }
  // Determine which module's families/anchors to consult.
  const targetModuleId =
    source.kind === "cross_module" && typeof source.module_id === "string"
      ? source.module_id
      : citingModuleId;
  const families = collisionFamilies.get(targetModuleId);
  const anchors = universe.get(targetModuleId);
  const stripped = stripOrdinalSuffix(source.section_id);
  const family = families?.get(stripped);
  if (family) {
    // The family exists; the binder must have come up ambiguous on
    // hierarchy disambiguation. Honest-vague: every family member
    // shares the citing section's hierarchy, or the ancestor walk hit
    // ambiguity at every depth.
    bucket.vague_collision_unresolvable += 1;
    return;
  }
  // No collision family — but the cite still came up vague. That
  // means the source_target's section_id matched no anchor at all,
  // which is the binder-bug indicator the build gate forbids.
  // If the anchor IS present, the binder shouldn't have reclassified;
  // count it under no_anchor anyway so the gate surfaces the
  // disagreement.
  if (anchors?.has(source.section_id) || anchors?.has(source.section_id.toLowerCase())) {
    bucket.vague_no_anchor += 1;
    return;
  }
  bucket.vague_no_anchor += 1;
}

type CitationVerdict =
  | { kind: "resolved" }
  | { kind: "intra-unresolved"; targetId: string }
  | { kind: "cross-unresolved"; targetId: string; reason: string };

// Dry-runs the binder. Every section-ref must hit a real anchor (the
// build-time binder guarantees this for shipped cites); every leftover
// internal / cross_module target with an installed target module is
// the binder having failed and the build refuses to ship it. Cites to
// modules NOT in this build stay as cross_module and report
// cross-unresolved (install-time concern, not gated). vague /
// structural / internal_appendix pass through; the runtime resolver
// handles them, the build doesn't gate on them.
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
      // Defense in depth: ownTocAnchorsRaw keeps the case-mixed source
      // form to catch a regression path where a binder change drifts
      // from the validator.
      if (ownTocAnchorsRaw.has(target.anchor_id)) return { kind: "resolved" };
      return { kind: "intra-unresolved", targetId: target.anchor_id };
    }
    case "internal":
      // The binder always rewrites bindable internals to section-ref
      // and reclassifies unbindable ones as vague. An internal target
      // on disk means the binder pass didn't run on this section,
      // which is a regression worth gating.
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
