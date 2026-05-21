import { z } from "zod";
import { SourceLocationSchema } from "./source-location";

// AppendixId is a slug derived from the structured parent + letter fields:
// "article-10-appendix-a", "chapter-10-appendix-b", "article-600-appendix-a".
// The slug shape lives on disk and in URLs; the structured fields drive
// citation resolution.
export const AppendixIdSchema = z
  .string()
  .regex(
    /^(article|chapter)-[a-z0-9]+(?:-[a-z0-9]+)*-appendix-[a-z]+$/,
    "appendix id must match (article|chapter)-N(-...)-appendix-LETTER",
  );

const FigureSchema = z
  .object({
    caption: z.string(),
    image_url: z.string().nullable(),
    source_location: SourceLocationSchema,
  })
  .strict();

const AppendixParentSchema = z
  .object({
    kind: z.enum(["article", "chapter"]),
    number: z.union([z.number().int(), z.string().min(1)]),
  })
  .strict();

// Appendix is reference matter attached to an article or chapter — typically
// fee schedules, forms, technical tables, or maps. AmLegal publishes them
// using Section-flavored markup but with non-section IDs, which the round-11
// parser surfaced as schema-rejected skips. Round 12 models them as a
// first-class CorpusEntry kind so they are no longer dropped.
//
// Structured fields (parent + letter) are canonical; the slug `id` is
// derived for filesystem and URL ergonomics. Citation resolution should read
// parent + letter, not parse the slug.
export const AppendixSchema = z
  .object({
    kind: z.literal("appendix").default("appendix"),
    id: AppendixIdSchema,
    parent: AppendixParentSchema,
    letter: z.string().regex(/^[a-z]+$/, "appendix letter must be lowercase ascii"),
    title: z.string(),
    body: z.string(),
    figures: z.array(FigureSchema).default([]),
    source_location: SourceLocationSchema,
  })
  .strict();

export type Appendix = z.infer<typeof AppendixSchema>;
export type AppendixId = z.infer<typeof AppendixIdSchema>;
