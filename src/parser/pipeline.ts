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
  CorpusEntryKind,
  JurisdictionManifest,
  ModuleConfig,
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
import { extractCitations } from "./citations";
import { extractDefinedTerms } from "./defined-terms";
import { computeDefinitions } from "./definitions";
import { ParseAbortError, parseExport as parseExportRaw } from "./parse-html";
import { computeReferences } from "./references";

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
  return rawResults.map((raw) => buildParsedModule(raw.module, raw.result));
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
): ParsedModule {
  const skipped: SkippedEntry[] = [...raw.skipped];
  const sections: SectionFile[] = [];
  const sectionPaths: Record<SectionId, readonly string[]> = {};
  const appendices: Appendix[] = [];
  const ordinanceHistories: OrdinanceHistory[] = [];
  const resolutionHistories: ResolutionHistory[] = [];
  const corpusEntryKinds = new Set<CorpusEntryKind>(["section"]);

  for (const ps of raw.sections) {
    const candidate: SectionFile = {
      kind: "section",
      id: ps.id,
      title: ps.title,
      text: ps.text,
      hierarchy: ps.hierarchy,
      citations: extractCitations(ps.text, module),
      defined_terms: extractDefinedTerms(ps.text, module),
      editorial_status: ps.editorial_status,
      ...(ps.redirect_to ? { redirect_to: ps.redirect_to } : {}),
      // body[] is replaced by the parser walker in a follow-up commit;
      // we seed a single text segment so the schema's roundtrip
      // invariant (bodyToText(body) === text) passes at this stage —
      // the candidate validator runs the same superRefine the disk
      // boundary does, and an empty body would fail it for any
      // section with non-empty text.
      body: ps.text.length > 0 ? [{ type: "text", text: ps.text }] : [],
    };
    const validated = SectionFileSchema.safeParse(candidate);
    if (!validated.success) {
      const reason = `validator failed: ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`;
      // If the section's own id failed SectionIdSchema, recording a
      // kind:"section" SkippedEntry would just re-fail the same validator
      // downstream. Fall back to kind:"parse" with the raw id verbatim.
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
    sections.push(validated.data);
    sectionPaths[validated.data.id] = ps.hierarchy_slugs;
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
    definitions: computeDefinitions(sections),
    references: computeReferences(sections, module.id),
    skipped,
    // Warnings: the parse-html-level InterCodeLink resolver returns these,
    // but it isn't yet wired into parseExport's per-module slice. Empty for
    // now; surfacing happens when the InterCodeLink graph lands in the
    // pipeline (deferred from round 12).
    warnings: [],
    corpusEntryKinds: Array.from(corpusEntryKinds).sort(),
    tocAnchors: raw.tocAnchors,
  };
}
