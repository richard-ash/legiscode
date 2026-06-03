// Public pipeline for the @/parser module. Wraps the raw rbox-walker
// (parse-html.parseExport) with citation/defined-term enrichment, schema
// validation, and graph computation, returning a fully-validated
// ParsedModule per code declared in the jurisdiction manifest.
//
// This file is the parser's public entry point. Everything it pulls
// together — text parsing, citation extraction, defined-term extraction,
// schema validation, definitions/references graphs — is parser-internal
// concern. Consumers see only the ParsedModule[] result.

import type {
  Appendix,
  Citation,
  CorpusEntryKind,
  DisplayRules,
  JurisdictionManifest,
  ModuleConfig,
  ModuleId,
  OrdinanceHistory,
  ParsedModule,
  ResolutionHistory,
  SectionFile,
  SectionId,
  SkippedEntry,
} from "@/types";
import {
  AppendixSchema,
  OrdinanceHistorySchema,
  ResolutionHistorySchema,
  SectionFileSchema,
  SectionIdSchema,
} from "@/types";
import {
  type AnchorIndex,
  type BindContext,
  bindCitation,
  buildAnchorIndex,
  buildCollisionFamilies,
  type CollisionFamilyIndex,
} from "./binder";
import { buildBodySegments, type UnresolvedReferenceReport } from "./build-body-segments";
import { type CitationMatch, extractCitations } from "./citations";
import { type DefinedTermMatch, extractDefinedTerms } from "./defined-terms";
import { buildModuleDefinitions } from "./definitions";
import { ParseAbortError, parseExport as parseExportRaw, type SpanRecord } from "./parse-html";
import { buildGlossaryRecognizer } from "./recognize";

// Known raw-parser strategies. Adding a new jurisdiction adds a token here
// and a case below; unknown tokens fail closed via ParseAbortError so a
// manifest typo (or a future parser_strategy that hasn't shipped yet) can't
// silently route through SF-specific rules.
const KNOWN_STRATEGIES = ["sf-amlegal"] as const;

/**
 * Parse a jurisdiction's source-export bytes per its manifest, returning one
 * fully-validated ParsedModule per code declared in `manifest.modules[]`.
 *
 * The parser dispatches on `manifest.source.format` to pick the right raw
 * parser (today only "amlegal-html"); each result is enriched with
 * citations, defined terms, definitions, and references; entries that fail
 * schema validation are routed to `skipped[]` instead of breaking the build.
 *
 * Returns ParseModule[] in the same order as `manifest.modules[]`. Empty
 * sections[] is allowed at this layer — the storage layer's "refuse to
 * promote an empty module" check is the gate that catches it, because the
 * skip-rate threshold is also a storage decision.
 *
 * @throws ParseAbortError if the underlying raw parser cannot proceed
 *   (corrupt anchor, classifier dead end, etc.)
 */
export function parseExport(buffer: Buffer, manifest: JurisdictionManifest): ParsedModule[] {
  const rawResults = parseRawByStrategy(buffer, manifest);
  const built = rawResults.map((raw) => buildParsedModule(raw.module, raw.result, manifest));
  return runBinderPass(built);
}

// Binder pass: walks every section's citations and rewrites bindable
// targets as section-refs. Runs after every module is built so the
// binder sees a complete anchor index for every sibling. Modules
// without display_rules contribute their anchors (sections still bind
// via bare lookup); modules with display_rules contribute their
// candidate-generation knobs.
//
// Citations that don't bind keep their legacy internal / cross_module
// shape until the build gate refuses to promote them. structural /
// vague / internal_appendix targets pass through unchanged because the
// binder has nothing to bind to.
function runBinderPass(modules: ParsedModule[]): ParsedModule[] {
  if (modules.length === 0) return modules;
  const anchorsByModule = new Map<ModuleId, AnchorIndex>();
  const rulesByModule = new Map<ModuleId, DisplayRules | undefined>();
  const collisionFamiliesByModule = new Map<ModuleId, CollisionFamilyIndex>();
  for (const m of modules) {
    anchorsByModule.set(m.module.id, buildAnchorIndex(m.sections, m.tocAnchors));
    rulesByModule.set(m.module.id, m.module.display_rules);
    collisionFamiliesByModule.set(m.module.id, buildCollisionFamilies(m.sections));
  }

  return modules.map((m) => {
    const ctx: BindContext = {
      citingModuleId: m.module.id,
      anchorsByModule,
      rulesByModule,
      collisionFamiliesByModule,
    };
    const sections = m.sections.map((section): SectionFile => {
      // Skip sections with no citations to avoid pointless reallocation.
      if (section.citations.length === 0) return section;
      // Pass the citing section's hierarchy so hierarchy-scoped
      // disambiguation can run for cites whose target lives in a
      // collision family.
      const rewritten: Citation[] = section.citations.map((c) =>
        bindCitation(c, ctx, section.hierarchy),
      );
      const changed = rewritten.some((c, i) => c !== section.citations[i]);
      if (!changed) return section;
      // Citations[] is re-validated through the schema so a malformed
      // section-ref (e.g. range-bound rewriting that lost its from-to
      // equality) fails closed at the trust boundary.
      const candidate = { ...section, citations: rewritten };
      const validated = SectionFileSchema.safeParse(candidate);
      return validated.success ? validated.data : section;
    });
    return { ...m, sections };
  });
}

// Dispatch on `manifest.parser_strategy` to pick the raw rbox walker. Today
// only `sf-amlegal` is implemented; LA / NYC / future AmLegal jurisdictions
// add cases here without rewriting buildParsedModule. Unknown strategies
// fail closed instead of silently running the wrong classifier.
function parseRawByStrategy(
  buffer: Buffer,
  manifest: JurisdictionManifest,
): ReturnType<typeof parseExportRaw> {
  switch (manifest.parser_strategy) {
    case "sf-amlegal":
      return parseExportRaw(buffer, manifest);
    default:
      throw new ParseAbortError(
        `unknown parser_strategy "${manifest.parser_strategy}". Known strategies: ${KNOWN_STRATEGIES.join(", ")}.`,
      );
  }
}

function buildParsedModule(
  module: ModuleConfig,
  raw: ReturnType<typeof parseExportRaw>[number]["result"],
  manifest: JurisdictionManifest,
): ParsedModule {
  const skipped: SkippedEntry[] = [...raw.skipped];
  const sections: SectionFile[] = [];
  const sectionPaths: Record<SectionId, readonly string[]> = {};
  const appendices: Appendix[] = [];
  const ordinanceHistories: OrdinanceHistory[] = [];
  const resolutionHistories: ResolutionHistory[] = [];
  const corpusEntryKinds = new Set<CorpusEntryKind>(["section"]);

  // Three-pass section build:
  //
  //   Pass 1 — per section: extract citations + defined terms (positions
  //            retained for Pass 2 and Pass 3), build a body-less
  //            SectionFile, schema-validate. Skips on validation failure.
  //   Pass 2 — module-wide: build the canonical Definition[] graph
  //            (id-keyed, scoped, anchored) from every section's
  //            extracted matches plus the manifest's
  //            global_definer_sections list. Persisted as
  //            definitions-v2.json.
  //   Pass 3 — per section: call buildBodySegments using Pass-1
  //            extraction outputs + Pass-2's canonical Definition[]. The
  //            per-occurrence resolver inside buildBodySegments attaches
  //            def_id to each defined_term segment, drops self-suppressed
  //            occurrences, and records unresolved references for the
  //            per-module audit artifact.
  //
  // We cannot inline body-building in Pass 1 because Pass 2's graph
  // requires every section's matches to be known first.
  interface SectionDraft {
    section: SectionFile;
    htmlSpans: readonly SpanRecord[];
    citationMatches: readonly CitationMatch[];
    definedTermMatches: readonly DefinedTermMatch[];
    rawSection: (typeof raw.sections)[number];
  }
  const drafts: SectionDraft[] = [];
  const unresolvedReferences: UnresolvedReferenceReport[] = [];

  // Pass 1
  for (const ps of raw.sections) {
    // Pass the citing section's id so bare `subsection (a)` / `subdivision
    // (b)` refs anchor to it. Without this, those cites classify as null
    // and silently drop from the generated corpus, even though the direct
    // extractor tests pass the option and look green.
    const citationMatches = extractCitations(ps.text, module, {
      currentSectionId: ps.id,
      jurisdictionModules: manifest.modules,
    });
    const definedTermMatches = extractDefinedTerms(ps.text, module);
    const candidate: SectionFile = {
      kind: "section",
      id: ps.id,
      display_label: ps.display_label,
      title: ps.title,
      text: ps.text,
      hierarchy: ps.hierarchy,
      // SectionFile shape stays Citation[] / string[]. Map back,
      // deduping defined terms (the position-aware extractor surfaces
      // every occurrence including same-section duplicates).
      citations: citationMatches.map((c) => c.citation),
      defined_terms: Array.from(new Set(definedTermMatches.map((d) => d.term))),
      editorial_status: ps.editorial_status,
      ...(ps.redirect_to ? { redirect_to: ps.redirect_to } : {}),
      // body[] is replaced by buildBodySegments in Pass 3. We seed a
      // single text segment so the schema's roundtrip invariant
      // (bodyToText(body) === text) passes here — the real tokenized
      // body[] needs the Pass-2 module-wide defined-term dictionary,
      // which doesn't exist yet. Keeping Pass 1's safeParse means
      // shape errors in non-body fields skip early, before the
      // expensive body builder runs.
      body: ps.text.length > 0 ? [{ type: "text", text: ps.text }] : [],
    };
    const validated = SectionFileSchema.safeParse(candidate);
    if (!validated.success) {
      const reason = `validator failed: ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`;
      const idValid = SectionIdSchema.safeParse(ps.id).success;
      if (idValid) {
        skipped.push({ kind: "section", id: ps.id, reason });
      } else {
        skipped.push({
          kind: "parse",
          raw_id: ps.id,
          source_location: { line: Math.max(1, ps.source_location.line) },
          reason,
        });
      }
      continue;
    }
    drafts.push({
      section: validated.data,
      htmlSpans: ps.htmlSpans,
      citationMatches,
      definedTermMatches,
      rawSection: ps,
    });
  }

  // Pass 2: canonical Definition[] graph. Each Definition is
  // addressable (id), anchored (body_anchor char offsets into
  // section.text), scoped (default to definer's hierarchy prefix;
  // module manifest globals override), and provenance-tagged
  // (extracted_by names the source pattern). Persisted as
  // definitions-v2.json.
  const globalDefinerSections = new Set<SectionId>(module.global_definer_sections ?? []);
  const moduleDefinitions = buildModuleDefinitions(
    module,
    drafts.map((d) => ({
      moduleId: module.id,
      section: d.section,
      matches: d.definedTermMatches,
      globalDefinerSections,
    })),
  );

  // Pass 3: build body[] per section, attach via a fresh validated
  // SectionFile (the superRefine on citation_index re-runs against
  // the populated body[]). The per-occurrence resolver inside
  // buildBodySegments attaches def_id to each defined_term and
  // reports unresolved occurrences for the per-module audit artifact.
  //
  // The glossary recognizer is built ONCE here over the module's
  // distinct defined terms and reused for every section — the trie is a
  // module-wide artifact, not a per-section one.
  const glossaryRecognizer = buildGlossaryRecognizer(new Set(moduleDefinitions.map((d) => d.term)));
  for (const draft of drafts) {
    const citationMatchesWithIndex = draft.citationMatches.map((cm, idx) => ({
      ...cm,
      citation_index: idx,
    }));
    const body = buildBodySegments({
      text: draft.section.text,
      htmlSpans: draft.htmlSpans,
      citationMatches: citationMatchesWithIndex,
      moduleDefinitions,
      glossaryRecognizer,
      readerSection: { id: draft.section.id, hierarchy: draft.section.hierarchy },
      onUnresolvedReference: (report) => unresolvedReferences.push(report),
    });
    const withBody = { ...draft.section, body };
    const finalValidated = SectionFileSchema.safeParse(withBody);
    if (!finalValidated.success) {
      const reason = `body-builder produced invalid section: ${finalValidated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`;
      skipped.push({ kind: "section", id: draft.section.id, reason });
      continue;
    }
    sections.push(finalValidated.data);
    sectionPaths[finalValidated.data.id] = draft.rawSection.hierarchy_slugs;
  }

  for (const pa of raw.appendices) {
    const candidate: Appendix = {
      kind: "appendix",
      id: pa.id,
      parent: pa.parent,
      letter: pa.letter,
      title: pa.title,
      body: pa.body,
      figures: [],
      source_location: pa.source_location,
    };
    const validated = AppendixSchema.safeParse(candidate);
    if (!validated.success) {
      skipped.push({
        kind: "parse",
        raw_id: pa.id,
        source_location: { line: Math.max(1, pa.source_location.line) },
        reason: `appendix validator failed: ${validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    appendices.push(validated.data);
    corpusEntryKinds.add("appendix");
  }

  for (const ph of raw.ordinanceHistories) {
    const candidate: OrdinanceHistory = {
      kind: "ordinance_history",
      id: ph.id,
      year: ph.year,
      module_id: ph.module_id,
      items: [],
      source_location: ph.source_location,
    };
    const validated = OrdinanceHistorySchema.safeParse(candidate);
    if (!validated.success) {
      skipped.push({
        kind: "parse",
        raw_id: ph.id,
        source_location: { line: Math.max(1, ph.source_location.line) },
        reason: `ordinance_history validator failed: ${validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    ordinanceHistories.push(validated.data);
    corpusEntryKinds.add("ordinance_history");
  }

  for (const ph of raw.resolutionHistories) {
    const candidate: ResolutionHistory = {
      kind: "resolution_history",
      id: ph.id,
      year: ph.year,
      module_id: ph.module_id,
      items: [],
      source_location: ph.source_location,
    };
    const validated = ResolutionHistorySchema.safeParse(candidate);
    if (!validated.success) {
      skipped.push({
        kind: "parse",
        raw_id: ph.id,
        source_location: { line: Math.max(1, ph.source_location.line) },
        reason: `resolution_history validator failed: ${validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    resolutionHistories.push(validated.data);
    corpusEntryKinds.add("resolution_history");
  }

  return {
    module,
    sections,
    sectionPaths,
    appendices,
    ordinanceHistories,
    resolutionHistories,
    moduleDefinitions,
    unresolvedReferences,
    skipped,
    // Warnings: the parse-html-level InterCodeLink resolver returns
    // these, but isn't yet wired into parseExport's per-module slice.
    // See TODOS.md "Wire InterCodeLink graph through @/corpus".
    warnings: [],
    corpusEntryKinds: Array.from(corpusEntryKinds).sort(),
    tocAnchors: raw.tocAnchors,
  };
}
