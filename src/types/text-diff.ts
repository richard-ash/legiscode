import { z } from "zod";

const TextDiffSpanSchema = z
  .object({
    op: z.enum(["insert", "delete", "context"]),
    text: z.string(),
  })
  .strict();

export const TextDiffSchema = z.array(TextDiffSpanSchema);

export type TextDiffSpan = z.infer<typeof TextDiffSpanSchema>;
export type TextDiff = z.infer<typeof TextDiffSchema>;
