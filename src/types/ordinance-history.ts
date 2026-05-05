import { z } from "zod";
import { ModuleIdSchema } from "./identifiers";
import { LegalInstrumentEntrySchema } from "./legal-instrument-entry";
import { SourceLocationSchema } from "./source-location";

// OrdinanceHistoryId is a year-suffixed slug: "2023-ordinances".
// The parser emits one OrdinanceHistory entry per year per module that
// AmLegal publishes a digest for; year boundaries come straight from the
// digest's image-headed rbox structure.
export const OrdinanceHistoryIdSchema = z
  .string()
  .regex(/^\d{4}-ordinances$/, "ordinance history id must match YYYY-ordinances");

// OrdinanceHistory is a yearly digest of binding code amendments. Each
// item is a LegalInstrumentEntry constrained to instrument_kind: "ordinance"
// (the discriminator inside the entry shape). Sections cite ordinances via
// their `affected_sections` arrays as the canonical record of what changed
// when.
//
// Resolutions live in a separate ResolutionHistory kind because they are
// non-binding and follow different citation patterns. Splitting at the
// outer file makes UI/search faceting honest from day one.
export const OrdinanceHistorySchema = z
  .object({
    kind: z.literal("ordinance_history").default("ordinance_history"),
    id: OrdinanceHistoryIdSchema,
    year: z.number().int().min(1900).max(2200),
    module_id: ModuleIdSchema,
    items: z.array(LegalInstrumentEntrySchema),
    source_location: SourceLocationSchema,
  })
  .strict()
  .refine((h) => h.items.every((item) => item.instrument_kind === "ordinance"), {
    message: "OrdinanceHistory.items must all carry instrument_kind 'ordinance'",
    path: ["items"],
  })
  .refine((h) => h.id === `${h.year}-ordinances`, {
    message: "OrdinanceHistory.id must equal '<year>-ordinances'",
    path: ["id"],
  });

export type OrdinanceHistory = z.infer<typeof OrdinanceHistorySchema>;
