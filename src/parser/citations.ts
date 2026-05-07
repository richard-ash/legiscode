// Single-module encapsulation: this file IS the citation extractor. A
// future swap to a richer iterative pipeline edits this file only;
// consumers see the same { extractCitations } surface and migration is
// invisible.
//
// Strategy: scan the section text with each pattern from
// manifest.citation_patterns, then classify each match:
//   - Match starts with "§" + section-id-shaped digits   -> internal
//     (with optional subsection and optional range)
//   - Match starts with "§" but the surrounding text contains a known
//     external code marker ("Code", "Statutes", "U.S.C.", "C.F.R.")    -> external
//   - Anything else: external (raw)
//
// Cross-module and vague targets are explicitly NOT produced today; their
// schema slots exist for the future structured pipeline.
//
// Recall expectation: ~80% on real Chapter 10.04 text. Improvements ship
// automatically on the next scheduled corpus refresh because the
// extractor is encapsulated.

import type { Citation, CitationTarget, ModuleConfig } from "@/types";
import { SectionIdSchema } from "@/types";

const SUBSECTION_PART = /^(?:\([a-z0-9]+\))+$/;

function looksLikeSectionId(value: string): boolean {
  return SectionIdSchema.safeParse(value).success;
}

const EXTERNAL_CONTEXT_REGEX = /\bCode\b|\bStatutes?\b|\bU\.?S\.?C\.?\b|\bC\.?F\.?R\.?\b/i;
const EXTERNAL_LOOKBACK_CHARS = 50;

function hasExternalContext(text: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - EXTERNAL_LOOKBACK_CHARS);
  return EXTERNAL_CONTEXT_REGEX.test(text.slice(start, matchIndex));
}

function classifyMatch(matched: string, fullText: string, matchIndex: number): CitationTarget {
  // Range: §§ X-Y (with optional whitespace)
  const rangeMatch = matched.match(/^§§\s*([a-z0-9._-]+)\s*-\s*([a-z0-9._-]+)$/);
  if (rangeMatch?.[1] && rangeMatch[2]) {
    const from = rangeMatch[1];
    const to = rangeMatch[2];
    if (looksLikeSectionId(from) && looksLikeSectionId(to)) {
      if (hasExternalContext(fullText, matchIndex)) {
        return { kind: "external", raw: matched };
      }
      return { kind: "internal", section_id: from, range: { from, to } };
    }
    return { kind: "external", raw: matched };
  }

  // Single section: § X with optional (a)(2)
  const singleMatch = matched.match(/^§\s*([a-z0-9._-]+)((?:\([a-z0-9]+\))*)$/);
  if (singleMatch?.[1]) {
    const sectionId = singleMatch[1];
    const subsectionPart = singleMatch[2];
    if (!looksLikeSectionId(sectionId)) {
      return { kind: "external", raw: matched };
    }
    if (hasExternalContext(fullText, matchIndex)) {
      return { kind: "external", raw: matched };
    }
    if (subsectionPart && SUBSECTION_PART.test(subsectionPart)) {
      return { kind: "internal", section_id: sectionId, subsection: subsectionPart };
    }
    return { kind: "internal", section_id: sectionId };
  }

  return { kind: "external", raw: matched };
}

export class CitationPatternError extends Error {
  constructor(
    readonly pattern: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CitationPatternError";
  }
}

// Position-bearing extraction result. Per A1 in the feat-parse-html-ast
// design, the canonical extractor returns the position triples needed by
// the pipeline's body-segment builder; callers that only need the bare
// Citation[] shape (e.g. SectionFile.citations) map via `.citation`.
export interface CitationMatch {
  citation: Citation;
  /** Inclusive start index in the input text. */
  start: number;
  /** Exclusive end index in the input text. */
  end: number;
}

export function extractCitations(text: string, module: ModuleConfig): CitationMatch[] {
  if (!text) return [];

  const matches: CitationMatch[] = [];
  const seen = new Set<string>();

  for (const patternStr of module.citation_patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, "g");
    } catch (cause) {
      throw new CitationPatternError(
        patternStr,
        `module.citation_patterns entry "${patternStr}" is not a valid regex: ${(cause as Error).message}`,
        { cause },
      );
    }

    for (const match of text.matchAll(regex)) {
      const display_text = match[0];
      const matchIndex = match.index ?? 0;
      const dedupeKey = `${matchIndex}:${display_text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const target = classifyMatch(display_text, text, matchIndex);
      matches.push({
        citation: { display_text, target },
        start: matchIndex,
        end: matchIndex + display_text.length,
      });
    }
  }

  // Sort by start so the body-segment builder can interleave with
  // defined-term/format spans without re-sorting. Multiple patterns can
  // produce matches at different offsets; the dedup above only catches
  // identical (offset, text) pairs, so two patterns matching at different
  // positions both stand.
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
