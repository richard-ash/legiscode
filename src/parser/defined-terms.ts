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

// Position-bearing match. Per A1 in the feat-parse-html-ast design, this
// extractor mirrors extractCitations' shape (CitationMatch) for symmetry.
//
// Important: positions point at the *defining* site (`<term>` inside
// `"<term>" means …`), NOT at usage sites elsewhere in the section. The
// body-segment builder's defined-term highlighting is OCCURRENCE-based —
// it scans `text` against the module-wide dictionary in Pass 3 of the
// pipeline. So the positions surfaced here aren't currently consumed by
// any production caller; the pipeline only reads `.term` (line 124-135 of
// pipeline.ts) to populate `SectionFile.defined_terms`.
//
// They're kept for two reasons: (a) symmetry with extractCitations keeps
// the parser-internal extractor contracts consistent, and (b) a future
// consumer that wants to highlight the DEFINING sentence (separate from
// usage occurrences) can use them without re-extracting. If a real
// consumer materializes that needs robust positions across pathological
// patterns, switch the regex to use the `d` flag and read `match.indices`
// — the current `match[0].indexOf(term)` heuristic finds the first
// occurrence in the full match, not necessarily the captured one. Current
// manifest patterns (`"([^"]+)"\\s+means`) can't trigger that ambiguity
// because the term is wrapped in unique quote chars.
export interface DefinedTermMatch {
  term: string;
  /** Inclusive start of the captured term in the input text. */
  start: number;
  /** Exclusive end of the captured term in the input text. */
  end: number;
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
      matches.push({ term, start, end: start + term.length });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
