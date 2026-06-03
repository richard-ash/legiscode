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

// Vague reclass observability. When the binder reclassifies an
// `internal` or `cross_module` cite as vague (no anchor matched, or
// hierarchy-disambiguation came up ambiguous), preserve the original
// target so the validator can attribute the reclass to its cause:
// external-author-ambiguity (no source_target → vague_external),
// collision-family-unresolvable (source_target present, family members
// all share citing hierarchy → vague_collision_unresolvable), or
// binder-bug-indicator (source_target present, no anchor reachable →
// vague_no_anchor). The source_target field is optional so cites
// authored as vague-from-inception ("the previous section", inline
// editor notes) carry no provenance.
//
// SectionRef is NOT a valid source_target — vague reclass happens
// BEFORE bind, so the source can only be one of the pre-binder
// shapes (internal / cross_module).
const VagueSourceTargetSchema: z.ZodType<
  | {
      kind: "internal";
      section_id: string;
      subsection?: string;
      range?: { from: string; to: string };
    }
  | {
      kind: "cross_module";
      module_id: string;
      section_id: string;
      subsection?: string;
      range?: { from: string; to: string };
    }
> = z.lazy(() => z.union([InternalTargetSchema, CrossModuleTargetSchema]));

const VagueTargetSchema = z
  .object({
    kind: z.literal("vague"),
    raw: z.string().min(1),
    source_target: VagueSourceTargetSchema.optional(),
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

// SectionRef carries the anchor-bound citation target produced by
// the build-time binder. anchor_id is the lowercase, JD_-stripped
// section anchor (equals the target section's id); module_id names
// the module that owns it (same as the citing section for intra-
// module cites, a sibling module for cross-module). The runtime
// resolver is one titleMap lookup.
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
