import { z } from "zod";
import { SectionIdSchema } from "./identifiers";

// AnchorSchema binds a span to a char range in the corpus section's
// baseline text. Populated at build time by emit-diff.ts
// (paragraph-anchored token scan in scripts/sync-bills.ts),
// dereferenced at render time. The alignment risk is paid once
// during the parser run, not on every render. A span only appears in
// text_diff[] when its whole section anchored successfully, so a
// loaded Bill is guaranteed dereferenceable.
//
// baseline_length === 0 marks two distinct shapes:
//   - op:"insert"  — zero baseline consumption, anchor.baseline_offset is the
//                    insertion point inside the baseline.
//   - op:"elision" — wildcard gap (any length of baseline matches), used for
//                    the "* * * *" sentinel that the city writes between
//                    edited paragraphs.
const AnchorSchema = z
  .object({
    baseline_offset: z.number().int().nonnegative(),
    baseline_length: z.number().int().nonnegative(),
  })
  .strict();

// TextDiffSpan is the renderer-facing inline-diff atom. section_id lets a
// multi-section bill route each span to the correct §-anchored region so
// the renderer can show "this paragraph in § 41.2 changes" alongside
// "this paragraph in § 1602 changes" inside one bill, without re-running
// the parser. The section_id refers to the **target code section** the
// span amends, not the bill's own section number.
//
// op = "context" carries spans the city ships verbatim with no change.
// op = "elision" carries the city's "* * * *" sentinel — a wildcard gap
// the aligner matches against any length of baseline. The renderer
// expands the gap (corpus-aligned view) or shows a "[ unchanged text
// omitted ]" separator (stated-source view).
const TextDiffSpanSchema = z
  .object({
    op: z.enum(["insert", "delete", "context", "elision"]),
    text: z.string(),
    section_id: SectionIdSchema,
    anchor: AnchorSchema,
  })
  .strict()
  .refine((s) => s.op !== "elision" || s.anchor.baseline_length === 0, {
    message: "elision spans must have baseline_length 0 (wildcard gap)",
    path: ["anchor", "baseline_length"],
  });

export const TextDiffSchema = z.array(TextDiffSpanSchema);

export type Anchor = z.infer<typeof AnchorSchema>;
export type TextDiffSpan = z.infer<typeof TextDiffSpanSchema>;
export type TextDiff = z.infer<typeof TextDiffSchema>;
