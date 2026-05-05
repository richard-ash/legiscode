import { z } from "zod";
import { CitationSchema } from "./citation";
import { SectionIdSchema } from "./identifiers";

// editorial_status captures AmLegal's per-section publication state.
// "active" is the default (an enacted, in-force section). "reserved" means
// a section number is reserved for future use but currently has no body.
// "repealed" and "redesignated" mark tombstones — the section number still
// exists in the corpus but its substance moved elsewhere or was deleted.
// Combined with redirect_to, this lets the UI render the right "what
// happened to §X?" affordances rather than silently dropping the section.
export const SectionEditorialStatusSchema = z
  .enum(["active", "reserved", "repealed", "redesignated"])
  .default("active");

// `kind` discriminates Section files from sibling CorpusEntry kinds
// (Appendix, OrdinanceHistory, ResolutionHistory). Default makes the
// reader lenient when the field is omitted: missing-with-default parses
// fine, present-with-wrong-value fails strict validation.
//
// redirect_to is set on redesignated/repealed sections that point at a
// successor section. editorial_status discriminates the variants so the
// renderer can show "[Reserved.]", "[Repealed.]", or a redirect affordance.
export const SectionFileSchema = z
  .object({
    kind: z.literal("section").default("section"),
    id: SectionIdSchema,
    title: z.string(),
    text: z.string(),
    citations: z.array(CitationSchema),
    defined_terms: z.array(z.string()),
    hierarchy: z.array(z.string()),
    editorial_status: SectionEditorialStatusSchema,
    redirect_to: SectionIdSchema.optional(),
  })
  .strict()
  .refine((s) => s.redirect_to === undefined || s.editorial_status === "redesignated", {
    message: "redirect_to is only valid when editorial_status is 'redesignated'",
    path: ["redirect_to"],
  });

export type SectionEditorialStatus = z.infer<typeof SectionEditorialStatusSchema>;
export type SectionFile = z.infer<typeof SectionFileSchema>;
