import { z } from "zod";
import { SectionIdSchema } from "./identifiers";

// TextDiffSpan is the renderer-facing inline-diff atom. section_id lets a
// multi-section bill route each span to the correct §-anchored region so
// the renderer can show "this paragraph in § 41.2 changes" alongside
// "this paragraph in § 1602 changes" inside one bill, without re-running
// the parser. The section_id refers to the **target code section** the
// span amends, not the bill's own section number.
//
// op = "context" carries spans the city ships verbatim with no change
// (the "* * * *" elision sentinel surfaces as op: "context" with the
// literal asterisks — the renderer decides how to elide).
const TextDiffSpanSchema = z
  .object({
    op: z.enum(["insert", "delete", "context"]),
    text: z.string(),
    section_id: SectionIdSchema,
  })
  .strict();

export const TextDiffSchema = z.array(TextDiffSpanSchema);

export type TextDiffSpan = z.infer<typeof TextDiffSpanSchema>;
export type TextDiff = z.infer<typeof TextDiffSchema>;
