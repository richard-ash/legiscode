// Single-module encapsulation: this is the defined-term extractor. A
// future swap to a richer pipeline edits this file only.
//
// Each pattern in manifest.defined_term_patterns must use capture group 1
// for the term itself (e.g. `"([^"]+)"\s+means` captures the quoted term).
// Terms are deduplicated within a section; multi-section detection lives
// in computeDefinitions.

import type { ModuleConfig } from "@/types";

export class DefinedTermPatternError extends Error {
  constructor(
    readonly pattern: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DefinedTermPatternError";
  }
}

// Position-bearing match. Mirrors extractCitations' CitationMatch
// shape for symmetry.
//
// Positions point at the *defining* site (`<term>` inside `"<term>"
// means …`), NOT at usage sites elsewhere in the section. The body-segment
// builder's defined-term highlighting is OCCURRENCE-based — it scans
// `text` against the module-wide dictionary in Pass 3 of the pipeline.
// The defining-site positions surfaced here are also used to populate
// Definition.body_anchor (the canonical defining range that the
// renderer uses for popover excerpts).
//
// If a real consumer materializes that needs robust positions across
// pathological patterns, switch the regex to use the `d` flag and read
// `match.indices` — the current `match[0].indexOf(term)` heuristic finds
// the first occurrence in the full match, not necessarily the captured
// one. Current manifest patterns (`"([^"]+)"\\s+means`) can't trigger
// that ambiguity because the term is wrapped in unique quote chars.
export interface DefinedTermMatch {
  term: string;
  /** Inclusive start of the captured term in the input text. */
  start: number;
  /** Exclusive end of the captured term in the input text. */
  end: number;
  /**
   * Provenance tag for `Definition.extracted_by` — canonical name of the
   * pattern that produced this match. Recognized patterns map to documented
   * names (quoted-means, shall-mean, is-defined-as, curly-quoted-means);
   * unknown manifest patterns map to "custom" so the audit groups them
   * separately.
   */
  pattern_kind: string;
  /**
   * Exclusive end of the full match including the trigger phrase
   * ("means", "shall mean", etc.). Used to bound the excerpt region
   * that becomes Definition.body_anchor — the excerpt covers the
   * defining clause, not just the term.
   */
  full_match_end: number;
}

// Pattern-kind classifier. Canonical regex strings → documented names.
//
// The keys are the exact strings operators write in manifest
// `defined_term_patterns` arrays. When a manifest adds a new
// well-documented pattern, register it here so audit-grouping stays
// consistent across modules.
const KNOWN_PATTERN_KINDS: Record<string, string> = {
  // Straight ASCII quotes + "means" — the default pattern shipped
  // across every SF module today.
  '"([^"]+)"\\s+means': "quoted-means",
  // "X" shall mean — common AmLegal definitional verb.
  '"([^"]+)"\\s+shall\\s+mean': "shall-mean",
  // "X" is defined as — defined-by-attribution form.
  '"([^"]+)"\\s+is\\s+defined\\s+as': "is-defined-as",
  // "X" are defined as — plural form.
  '"([^"]+)"\\s+are\\s+defined\\s+as': "are-defined-as",
  // Curly-quote variants — AmLegal HTML occasionally emits these for
  // the same definitional phrasing.
  "[“”]([^“”]+)[“”]\\s+means": "curly-quoted-means",
  "[“”]([^“”]+)[“”]\\s+shall\\s+mean": "curly-quoted-shall-mean",
};

function classifyPattern(patternStr: string): string {
  return KNOWN_PATTERN_KINDS[patternStr] ?? "custom";
}

export function extractDefinedTerms(text: string, module: ModuleConfig): DefinedTermMatch[] {
  if (!text) return [];

  const matches: DefinedTermMatch[] = [];
  for (const patternStr of module.defined_term_patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, "g");
    } catch (cause) {
      throw new DefinedTermPatternError(
        patternStr,
        `module.defined_term_patterns entry "${patternStr}" is not a valid regex: ${(cause as Error).message}`,
        { cause },
      );
    }
    const patternKind = classifyPattern(patternStr);
    for (const match of text.matchAll(regex)) {
      const term = match[1];
      if (!term) continue;
      // The capture group's position inside the full match. We can recover
      // it because `match.index` is the start of the full match and the
      // capture text appears at a known offset in match[0].
      const fullStart = match.index ?? 0;
      const captureOffset = match[0].indexOf(term);
      // Defensive: if `term` doesn't substring-match into match[0] (only
      // possible with regex transforms zod doesn't apply), fall back to
      // the full-match start so the position is at least monotonic.
      const start = captureOffset >= 0 ? fullStart + captureOffset : fullStart;
      matches.push({
        term,
        start,
        end: start + term.length,
        pattern_kind: patternKind,
        full_match_end: fullStart + match[0].length,
      });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
