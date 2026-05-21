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

const VagueTargetSchema = z
  .object({
    kind: z.literal("vague"),
    raw: z.string().min(1),
  })
  .strict();

// Article / Chapter / Division / Title citations route to a structural node
// in the corpus tree, not a section page. Level mirrors the prefix word;
// number is the cited identifier as written (e.g. "5", "2.4", "II").
const StructuralLevelSchema = z.enum(["article", "chapter", "division", "title"]);

const StructuralTargetSchema = z
  .object({
    kind: z.literal("structural"),
    level: StructuralLevelSchema,
    number: z.string().min(1),
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

// SectionRef carries the anchor-bound citation target produced by the
// build-time binder. anchor_id is the lowercase, JD_-stripped section
// anchor; module names the module that owns it (same module the citing
// section lives in for intra-module cites, a sibling module for cross-
// module). Phase 5 collapses this with the legacy internal / cross_module
// variants — after the rename, every section-ref's anchor_id equals the
// target section's id, and the resolver is one titleMap lookup.
const SectionRefTargetSchema = z
  .object({
    kind: z.literal("section-ref"),
    anchor_id: SectionIdSchema,
    module_id: ModuleIdSchema,
    subsection: SubsectionSchema.optional(),
    range: RangeSchema.optional(),
  })
  .strict()
  .refine((target) => !target.range || target.range.from === target.anchor_id, {
    message: "anchor_id must equal range.from when range is set",
    path: ["anchor_id"],
  });

export const CitationTargetSchema = z.discriminatedUnion("kind", [
  InternalTargetSchema,
  CrossModuleTargetSchema,
  StructuralTargetSchema,
  VagueTargetSchema,
  InternalAppendixTargetSchema,
  SectionRefTargetSchema,
]);

export type StructuralLevel = z.infer<typeof StructuralLevelSchema>;

export const CitationSchema = z
  .object({
    display_text: z.string().min(1),
    target: CitationTargetSchema,
  })
  .strict();

export type CitationTarget = z.infer<typeof CitationTargetSchema>;
export type Citation = z.infer<typeof CitationSchema>;
