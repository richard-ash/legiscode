import { z } from "zod";
import { ModuleIdSchema } from "./identifiers";
import { LegalInstrumentEntrySchema } from "./legal-instrument-entry";
import { SourceLocationSchema } from "./source-location";

export const ResolutionHistoryIdSchema = z
  .string()
  .regex(/^\d{4}-resolutions$/, "resolution history id must match YYYY-resolutions");

// ResolutionHistory is a yearly digest of non-binding resolutions adopted
// by the body. Distinct from OrdinanceHistory because resolutions don't
// amend code text — they are formal positions, requests, or administrative
// directives. Sections never cite resolutions, so resolutions don't appear
// in any Section's references graph; they live as standalone reference
// matter.
export const ResolutionHistorySchema = z
  .object({
    kind: z.literal("resolution_history").default("resolution_history"),
    id: ResolutionHistoryIdSchema,
    year: z.number().int().min(1900).max(2200),
    module_id: ModuleIdSchema,
    items: z.array(LegalInstrumentEntrySchema),
    source_location: SourceLocationSchema,
  })
  .strict()
  .refine((h) => h.items.every((item) => item.instrument_kind === "resolution"), {
    message: "ResolutionHistory.items must all carry instrument_kind 'resolution'",
    path: ["items"],
  })
  .refine((h) => h.id === `${h.year}-resolutions`, {
    message: "ResolutionHistory.id must equal '<year>-resolutions'",
    path: ["id"],
  });

export type ResolutionHistory = z.infer<typeof ResolutionHistorySchema>;
