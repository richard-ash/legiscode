import { z } from "zod";
import { DefinedTermSchema, SectionIdSchema } from "./identifiers";

export const DefinitionEntrySchema = z
  .object({
    defined_in_section: SectionIdSchema,
  })
  .strict();

// Keys are TERMS (DefinedTermSchema), not SectionIdSchema. Every term in
// the map is defined in at least one section, so the value array is
// .min(1); the same term defined across multiple sections produces an
// array length > 1.
export const DefinitionsFileSchema = z.record(
  DefinedTermSchema,
  z.array(DefinitionEntrySchema).min(1),
);

export type DefinitionEntry = z.infer<typeof DefinitionEntrySchema>;
export type DefinitionsFile = z.infer<typeof DefinitionsFileSchema>;
