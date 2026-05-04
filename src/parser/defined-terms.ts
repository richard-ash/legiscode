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

export function extractDefinedTerms(text: string, module: ModuleConfig): string[] {
  if (!text) return [];

  const terms = new Set<string>();
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
      if (term) terms.add(term);
    }
  }
  return Array.from(terms);
}
