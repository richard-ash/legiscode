// Citation extraction over MODEL OUTPUT (not corpus text). Reuses the
// existing extractor, but with a synthetic ModuleConfig and no
// jurisdiction modules — the model writes plain prose like
// "see § 10.04.020 in sf-administrative" or "§ 102 of the Building
// Code". The extractor doesn't know which module the model meant when
// it writes a bare cite, so the verifier intersects against tool-call
// fetches in the broader resolution step.
//
// One rule for unqualified cites: the model's instructions require it
// to write `[sf-administrative § 1.01]` for cross-module references.
// This parser pulls those out via a single tagged regex, then layers
// the standard extractor over the remaining prose for bare `§ X.Y`
// references — those resolve against the same-module first heuristic
// inside verify.ts.

import { extractCitations as extractCorpusCitations } from "@/parser/citations";
import type { ModuleConfig } from "@/types";
import { ModuleIdSchema } from "@/types";

export interface ParsedAnswerCitation {
  /** "[module-id § section-id]" → module-id, section-id (qualified). */
  qualified: { module_id: string; section_id: string } | null;
  /** Bare "§ X.Y" → section-id only. The verifier resolves against
   *  the chat's anchored module. */
  bareSectionId: string | null;
  /** "[Bill #260543]" → file_no. Bill citations live in their own surface
   *  because they resolve against the bills index, not the sections
   *  index. Null on section-shaped citations. */
  billFileNo: string | null;
  /** The verbatim string from the answer. */
  display: string;
}

/**
 * Pull every citation candidate out of the model's prose answer. Two
 * shapes:
 *  1. Qualified: `[sf-administrative § 1.01]` — module-id between
 *     brackets, then `§ section-id`. Whitespace-flexible.
 *  2. Bare:     `§ 1.01` — the existing extractor handles these.
 *
 * Returns every match; the resolver decides which are valid.
 */
export function extractAnswerCitations(text: string): ParsedAnswerCitation[] {
  const out: ParsedAnswerCitation[] = [];
  const seen = new Set<string>();
  const qualifiedRanges: { start: number; end: number }[] = [];

  for (const m of text.matchAll(QUALIFIED_RE)) {
    const moduleCandidate = m[1] ?? "";
    const sectionId = (m[2] ?? "").toLowerCase();
    const display = m[0];
    const idx = m.index ?? -1;
    if (!moduleCandidate || !sectionId) continue;
    if (!ModuleIdSchema.safeParse(moduleCandidate).success) continue;
    qualifiedRanges.push({ start: idx, end: idx + display.length });
    const key = `q:${moduleCandidate}:${sectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      qualified: { module_id: moduleCandidate, section_id: sectionId },
      bareSectionId: null,
      billFileNo: null,
      display,
    });
  }

  // [Bill #file_no] form. Bill ids are numeric strings (SF Legistar
  // 6-digit today; the regex permits 3-12 for future jurisdictions).
  // The bracket form keeps bills from competing with section regexes —
  // bills never appear as bare "§" cites in prose.
  for (const m of text.matchAll(BILL_RE)) {
    const fileNo = m[1] ?? "";
    const idx = m.index ?? -1;
    if (!fileNo || idx < 0) continue;
    qualifiedRanges.push({ start: idx, end: idx + m[0].length });
    const key = `bill:${fileNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      qualified: null,
      bareSectionId: null,
      billFileNo: fileNo,
      display: m[0],
    });
  }

  // The standard extractor produces CitationMatches scoped against the
  // synthetic module. We feed each one through as a bare reference and
  // let the resolver pick which module it belongs to. Bare matches that
  // overlap a qualified bracket range are skipped — they're substrings
  // of the bracket form, not independent cites.
  const synthetic = makeSyntheticModule();
  const bare = extractCorpusCitations(text, synthetic);
  for (const match of bare) {
    const target = match.citation.target;
    if (target.kind !== "internal" || target.range) continue;
    if (qualifiedRanges.some((r) => match.start >= r.start && match.end <= r.end)) continue;
    const sectionId = target.section_id;
    const key = `b:${sectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      qualified: null,
      bareSectionId: sectionId,
      billFileNo: null,
      display: match.citation.display_text,
    });
  }
  return out;
}

const QUALIFIED_RE = /\[([a-z][a-z0-9-]*)\s*§\s*([a-z0-9][a-z0-9._-]*)\]/gi;
const BILL_RE = /\[Bill\s+#(\d{3,12})\]/gi;

function makeSyntheticModule(): ModuleConfig {
  return {
    id: "model-output",
    name: "(model output)",
    code_title: "",
    module_version: "0000.00.00",
    max_skip_count: 0,
    citation_patterns: [
      // Match the standard surface forms the corpus extractor knows.
      // Mirrors the manifest defaults; keeping the list short here is
      // fine because the model's output is prose, not legal HTML.
      "§§?\\s*\\d+[a-z]?(?:\\.\\d+[a-z]?)*(?:-\\d+[a-z]?)?",
      "Sections?\\s+\\d+[a-z]?(?:\\.\\d+[a-z]?)*",
      "Sec\\.\\s+\\d+[a-z]?(?:\\.\\d+[a-z]?)*",
    ],
    defined_term_patterns: [],
  };
}
