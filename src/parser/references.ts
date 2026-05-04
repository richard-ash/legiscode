// Compute the references graph for a single module's sections.
//
// citations on a ReferencesEntry carries the FULL Citation[] from the
// source SectionFile (every kind: internal, cross_module, external,
// vague, internal_appendix), so consumers can find every outbound edge
// from a section.
//
// cited_by tracks INTERNAL forward edges only — the bidirectional
// invariant only applies inside one module at this stage. External and
// cross_module citations resolve outside this module, so they appear in
// citations but never in any cited_by list inside this module. The
// editorial InterCodeLink graph (round-12 commit on parse-html.ts wiring)
// will populate cross-module cited_by entries when it lands.
//
// Each cited_by entry is an EntryRef (module_id + kind + id) so cross-
// module citers — once wired — can be represented uniformly. Today we
// emit only Section citers (kind: "section") since OrdinanceHistory
// items' affected_sections are tracked separately in the digest entry
// itself, not folded into the references graph.
//
// Broken targets (an internal citation whose section_id doesn't exist
// in this module) are NOT a build error here; they simply don't add a
// cited_by entry. The downstream corpus-level gate catches them.

import type { EntryRef, ModuleId, ReferencesFile, SectionFile, SectionId } from "@/types";

export function computeReferences(
  sections: readonly SectionFile[],
  moduleId: ModuleId,
): ReferencesFile {
  const refs: Record<SectionId, { citations: SectionFile["citations"]; cited_by: EntryRef[] }> = {};

  for (const section of sections) {
    refs[section.id] = {
      citations: section.citations,
      cited_by: [],
    };
  }

  for (const section of sections) {
    for (const citation of section.citations) {
      if (citation.target.kind !== "internal") continue;
      const target = refs[citation.target.section_id];
      if (!target) continue; // broken target; documented as non-fatal
      if (citation.target.section_id === section.id) continue; // self-cite
      const alreadyCited = target.cited_by.some(
        (ref) => ref.module_id === moduleId && ref.kind === "section" && ref.id === section.id,
      );
      if (alreadyCited) continue;
      target.cited_by.push({
        module_id: moduleId,
        kind: "section",
        id: section.id,
      });
    }
  }

  const out: ReferencesFile = {};
  for (const [sectionId, entry] of Object.entries(refs)) {
    out[sectionId] = {
      citations: entry.citations,
      cited_by: entry.cited_by.sort((a, b) => {
        const moduleCompare = a.module_id.localeCompare(b.module_id);
        if (moduleCompare !== 0) return moduleCompare;
        const kindCompare = a.kind.localeCompare(b.kind);
        if (kindCompare !== 0) return kindCompare;
        return a.id.localeCompare(b.id);
      }),
    };
  }
  return out;
}
