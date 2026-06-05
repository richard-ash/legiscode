import { z } from "zod";
import { SectionIdSchema } from "./identifiers";

// DiffChunk is the renderer-facing inline-diff atom in v2's
// reconstruct-then-diff architecture. Each chunk is a contiguous
// slice of one of:
//   • "equal"  — text unchanged between baseline and the bill's
//                reconstructed post-amendment text. The renderer
//                styles this as plain prose.
//   • "insert" — text the bill adds. Rendered underlined-italic.
//   • "delete" — text the bill removes. Rendered struck-italic.
//
// Chunks are emitted by `diffWords(baseline, reconstructedNewText)`
// in document order, so the renderer iterates them sequentially —
// no offset arithmetic, no anchor lookups, no positioning logic.
//
// `section_id` is the **target code section** the chunk amends, not
// the bill's own section number. A multi-section bill produces one
// run of chunks per target section; the renderer filters by
// section_id when overlaying a specific section.
const DiffChunkSchema = z
  .object({
    op: z.enum(["equal", "insert", "delete"]),
    text: z.string(),
    section_id: SectionIdSchema,
  })
  .strict();

export const DiffChunksSchema = z.array(DiffChunkSchema);

export type DiffChunk = z.infer<typeof DiffChunkSchema>;
export type DiffChunks = z.infer<typeof DiffChunksSchema>;
