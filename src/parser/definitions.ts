// Compute the definitions index for a single module's sections.
//
// Output shape: Record<term, Array<{ defined_in_section: SectionId }>>.
// Same term across multiple sections produces array length > 1 — that's
// the real-world case for terms redefined in multiple subsections; the
// schema captures it without flattening.
//
// Per-(term, section) duplicates are collapsed: a section that quotes
// "Director of Transportation" twice still only contributes one entry.
// Cross-section ordering is sorted by section_id for determinism.

import type {
  Definition,
  DefinitionsFile,
  ModuleConfig,
  ModuleId,
  SectionFile,
  SectionId,
} from "@/types";
import { buildDefinitionId, canonicalizeTerm } from "./definition-id";
import type { DefinedTermMatch } from "./defined-terms";

export function computeDefinitions(sections: readonly SectionFile[]): DefinitionsFile {
  const buckets = new Map<string, Set<string>>();

  for (const section of sections) {
    for (const term of section.defined_terms) {
      let sections = buckets.get(term);
      if (!sections) {
        sections = new Set();
        buckets.set(term, sections);
      }
      sections.add(section.id);
    }
  }

  const out: DefinitionsFile = {};
  for (const [term, sectionSet] of buckets) {
    out[term] = Array.from(sectionSet)
      .sort()
      .map((id) => ({ defined_in_section: id }));
  }
  return out;
}

// ─── Canonical Definition[] extraction (L2a) ───────────────────────────────
//
// Per the definitions-foundation plan §4 build-time pipeline:
//   PARSE        → DefinedTermMatch[] per section (defined-terms.ts)
//   SCOPE-ASSIGN → per-section conversion to Definition[] with default
//                  hierarchy_prefix scope, overridden to module scope when
//                  the manifest declares the section in global_definer_sections
//   (RESOLVE happens later in Pass 3 of build-body-segments)
//
// This function owns the SCOPE-ASSIGN step. The PARSE step is the per-
// section extractDefinedTerms call already in pipeline.ts; RESOLVE lives
// in build-body-segments.ts after the per-module Definition[] is built.

// Maximum characters of a definitional clause to include in the
// Definition.excerpt field. Long enough for legal phrasing ("X means a
// [N-word description]…"); short enough to keep popover payloads bounded.
// Excerpts longer than this get truncated with an ellipsis suffix.
const MAX_EXCERPT_LENGTH = 500;

// Extract the paragraph-bounded excerpt containing the defining clause.
// Sentence boundaries in this corpus are unreliable ("Sec. 1.01" looks
// like a sentence end), so paragraph boundaries (\n) are the primary
// excerpt anchor. Cap at MAX_EXCERPT_LENGTH so a 4000-char paragraph
// doesn't ship a 4000-char popover excerpt.
function extractExcerpt(text: string, definingStart: number, triggerEnd: number): string {
  const prevNewline = text.lastIndexOf("\n", Math.max(0, definingStart - 1));
  const paragraphStart = prevNewline === -1 ? 0 : prevNewline + 1;
  const nextNewline = text.indexOf("\n", triggerEnd);
  const paragraphEnd = nextNewline === -1 ? text.length : nextNewline;
  let excerpt = text.slice(paragraphStart, paragraphEnd).trim();
  if (excerpt.length > MAX_EXCERPT_LENGTH) {
    excerpt = `${excerpt.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
  }
  return excerpt;
}

// Shift the raw match span inward past leading/trailing whitespace so
// body_anchor lines up with the scanner's \b<canonical-term>\b hit in
// build-body-segments. Without this, self-suppression of the defining
// occurrence fails: scanner emits {start: A, end: A+8} for "Approval",
// but body_anchor would be {start: A-1, end: A+9} when the raw capture
// was "\nApproval\n". Internal whitespace stays in the span — the
// renderer can re-canonicalize a slice if it needs a clean comparison.
function trimAnchor(rawTerm: string, start: number, end: number): { start: number; end: number } {
  const leading = rawTerm.length - rawTerm.trimStart().length;
  const trailing = rawTerm.length - rawTerm.trimEnd().length;
  return { start: start + leading, end: end - trailing };
}

export interface SectionDefinitionContext {
  moduleId: ModuleId;
  section: SectionFile;
  matches: readonly DefinedTermMatch[];
  /**
   * Section ids the manifest declared as module-wide definers. Definitions
   * extracted from a section in this set get scope:{kind:"module"} and
   * extracted_by:"manifest:declared-global" regardless of the originating
   * pattern. See §9 L5 of the plan: manifest-declared globals are the
   * only source of module scope.
   */
  globalDefinerSections: ReadonlySet<SectionId>;
}

// Build canonical Definition[] for a single section. Same-term duplicates
// within a section collapse to the first match (deterministic by start
// position because extractDefinedTerms sorts ascending). Dedup runs on
// the canonicalized term so raw captures that differ only in whitespace
// ("\nApproval\n" vs "Approval ") collapse to one Definition.
export function buildSectionDefinitions(ctx: SectionDefinitionContext): Definition[] {
  const { moduleId, section, matches, globalDefinerSections } = ctx;
  const isGlobalDefiner = globalDefinerSections.has(section.id);
  const seenTerms = new Set<string>();
  const out: Definition[] = [];
  for (const match of matches) {
    const term = canonicalizeTerm(match.term);
    if (seenTerms.has(term)) continue;
    seenTerms.add(term);
    const id = buildDefinitionId(moduleId, section.id, match.term);
    const { start, end } = trimAnchor(match.term, match.start, match.end);
    const excerpt = extractExcerpt(section.text, match.start, match.full_match_end);
    const definition: Definition = {
      id,
      term,
      defined_in: section.id,
      body_anchor: { start, end },
      excerpt,
      scope: isGlobalDefiner
        ? { kind: "module" }
        : { kind: "hierarchy", prefix: [...section.hierarchy] },
      extracted_by: isGlobalDefiner
        ? "manifest:declared-global"
        : `amlegal:pattern:${match.pattern_kind}`,
    };
    out.push(definition);
  }
  return out;
}

// Build the per-module Definition[] across every section's extracted
// matches. Output is sorted by definition id for deterministic on-disk
// ordering, matching the contract pattern of other parser outputs
// (computeDefinitions sorts entries; this mirrors that).
export function buildModuleDefinitions(
  module: ModuleConfig,
  contexts: readonly SectionDefinitionContext[],
): Definition[] {
  const out: Definition[] = [];
  for (const ctx of contexts) {
    out.push(...buildSectionDefinitions(ctx));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  // Defensive: module-wide id uniqueness — extractor bugs would surface
  // here as collisions. The schema's ModuleDefinitionsSchema also catches
  // this at write time, but failing fast in the parser lets the build
  // skip the rest of the persistence pipeline with a clearer signal.
  const seen = new Set<string>();
  for (const def of out) {
    if (seen.has(def.id)) {
      throw new Error(
        `module ${module.id}: duplicate Definition.id ${def.id} from canonicalized term "${def.term}"`,
      );
    }
    seen.add(def.id);
  }
  return out;
}
