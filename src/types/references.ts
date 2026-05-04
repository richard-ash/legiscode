import { z } from "zod";
import { CitationSchema } from "./citation";
import { EntryRefSchema } from "./entry-ref";
import { SectionIdSchema } from "./identifiers";

// ReferencesEntry holds the bidirectional graph for one Section.
//
// citations carries the FULL Citation[] from the source SectionFile (every
// kind: internal, cross_module, external, vague, internal_appendix), so
// consumers can find every outbound edge from a section.
//
// cited_by is a list of EntryRefs — fully namespaced (module_id + kind + id)
// so cross-module forward edges from the editorial InterCodeLink graph can
// be represented uniformly with intra-module edges. Today only Section
// citers (kind: "section") are emitted; future rounds may add
// OrdinanceHistory or Appendix citers when those parser paths populate
// them.
const ReferencesEntrySchema = z
  .object({
    citations: z.array(CitationSchema),
    cited_by: z.array(EntryRefSchema),
  })
  .strict();

// Round 12 keeps the file Section-keyed for now: each entry answers the
// question "for this Section, what are its outbound citations and inbound
// citers?" Cross-kind reverse-lookup ("who cites Appendix M?") is a future
// enhancement that would require either widening the keys or splitting into
// kind-specific reference files.
export const ReferencesFileSchema = z.record(SectionIdSchema, ReferencesEntrySchema);

export type ReferencesEntry = z.infer<typeof ReferencesEntrySchema>;
export type ReferencesFile = z.infer<typeof ReferencesFileSchema>;
