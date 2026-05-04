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

import type { DefinitionsFile, SectionFile } from "@/types";

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
