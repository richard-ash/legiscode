import { z } from "zod";
import { TextDiffSchema } from "./text-diff";

// Conditional invariant: when parse_status is "ok", text_diff must be
// non-empty. The other parse_status values explicitly mean "no usable diff
// was produced", so the file's purpose is the parse_status itself, and
// text_diff is allowed to be empty.
export const OrdinanceFileSchema = z
  .object({
    number: z.string().min(1),
    title: z.string(),
    status: z.string().min(1),
    text_diff: TextDiffSchema,
    parse_status: z.enum(["ok", "manual_review", "structural_change"]),
  })
  .strict()
  .refine((ordinance) => ordinance.parse_status !== "ok" || ordinance.text_diff.length > 0, {
    message: "text_diff must be non-empty when parse_status is 'ok'",
    path: ["text_diff"],
  });

export type OrdinanceFile = z.infer<typeof OrdinanceFileSchema>;
