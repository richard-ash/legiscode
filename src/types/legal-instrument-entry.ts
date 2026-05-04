import { z } from "zod";
import { SectionIdSchema } from "./identifiers";

// Date kinds carried by legal instruments. Legal digests typically publish
// multiple dates per ordinance/resolution: when adopted by the body, when
// approved by the executive, when it became effective, when it became
// operative (sometimes a deferred date), when filed with the registrar, or
// when it appeared on a ballot. raw_text is preserved verbatim; iso_value
// is parsed when the source string is unambiguous.
//
// "other" exists as a default catch-all so the parser can record dates whose
// label it doesn't recognize without losing them. New observed labels get
// promoted to first-class enum values as the parser learns them.
export const LegalDateKindSchema = z.enum([
  "adopted",
  "approved",
  "effective",
  "operative",
  "filed",
  "election",
  "passed",
  "amended",
  "other",
]);

export const LegalDateSchema = z
  .object({
    kind: LegalDateKindSchema,
    iso_value: z.string().nullable(),
    raw_text: z.string().min(1),
  })
  .strict();

const AffectedSectionRefSchema = z
  .object({
    raw_text: z.string().min(1),
    resolved_id: SectionIdSchema.nullable(),
  })
  .strict();

// LegalInstrumentEntry is the inner item shape inside an OrdinanceHistory
// or ResolutionHistory file. Both kinds share the schema; the discriminator
// `instrument_kind` lets a generic UI render either while still being
// type-honest.
//
// affected_sections has both raw_text (as printed in the digest) and
// resolved_id (after the parser cross-checks against this module's section
// index). resolved_id stays null when the heuristic can't bind it; raw_text
// is always preserved so the operator can audit unresolved entries.
//
// raw_text on the entry itself is the unstructured fallback — whatever text
// the parser collected from the digest rbox. Always present even when the
// structured fields parse cleanly, so the original source is never lost.
export const LegalInstrumentEntrySchema = z
  .object({
    instrument_kind: z.enum(["ordinance", "resolution"]),
    instrument_number: z.string().min(1),
    file_number: z.string().nullable(),
    dates: z.array(LegalDateSchema),
    subject: z.string(),
    body: z.string(),
    raw_text: z.string(),
    affected_sections: z.array(AffectedSectionRefSchema).default([]),
  })
  .strict();

export type LegalDateKind = z.infer<typeof LegalDateKindSchema>;
export type LegalDate = z.infer<typeof LegalDateSchema>;
export type LegalInstrumentEntry = z.infer<typeof LegalInstrumentEntrySchema>;
