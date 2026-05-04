import { z } from "zod";
import { AppendixIdSchema } from "./appendix";
import { ModuleIdSchema, SectionIdSchema } from "./identifiers";

const SubsectionSchema = z.string().min(1);

const RangeSchema = z
  .object({
    from: SectionIdSchema,
    to: SectionIdSchema,
  })
  .strict();

const InternalTargetSchema = z
  .object({
    kind: z.literal("internal"),
    section_id: SectionIdSchema,
    subsection: SubsectionSchema.optional(),
    range: RangeSchema.optional(),
  })
  .strict()
  .refine((target) => !target.range || target.range.from === target.section_id, {
    message: "section_id must equal range.from when range is set",
    path: ["section_id"],
  });

const CrossModuleTargetSchema = z
  .object({
    kind: z.literal("cross_module"),
    module_id: ModuleIdSchema,
    section_id: SectionIdSchema,
    subsection: SubsectionSchema.optional(),
    range: RangeSchema.optional(),
  })
  .strict()
  .refine((target) => !target.range || target.range.from === target.section_id, {
    message: "section_id must equal range.from when range is set",
    path: ["section_id"],
  });

const ExternalParsedSchema = z
  .object({
    jurisdiction: z.string().min(1),
    code: z.string().min(1),
    section: z.string().min(1),
    subsection: SubsectionSchema.optional(),
  })
  .strict();

const ExternalTargetSchema = z
  .object({
    kind: z.literal("external"),
    raw: z.string().min(1),
    parsed: ExternalParsedSchema.optional(),
  })
  .strict();

const VagueTargetSchema = z
  .object({
    kind: z.literal("vague"),
    raw: z.string().min(1),
  })
  .strict();

// "see Appendix M" and similar text-regex extractions resolve to an Appendix
// in the same module. Cross-module appendix citations are rare enough in
// real data that they stay vague until/unless they show up; this kind covers
// the common case.
const InternalAppendixTargetSchema = z
  .object({
    kind: z.literal("internal_appendix"),
    appendix_id: AppendixIdSchema,
  })
  .strict();

export const CitationTargetSchema = z.discriminatedUnion("kind", [
  InternalTargetSchema,
  CrossModuleTargetSchema,
  ExternalTargetSchema,
  VagueTargetSchema,
  InternalAppendixTargetSchema,
]);

export const CitationSchema = z
  .object({
    display_text: z.string().min(1),
    target: CitationTargetSchema,
  })
  .strict();

export type CitationTarget = z.infer<typeof CitationTargetSchema>;
export type Citation = z.infer<typeof CitationSchema>;
