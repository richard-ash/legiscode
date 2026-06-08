import { z } from "zod";
import { SectionIdSchema } from "./identifiers";
import { BodySegmentSchema } from "./section";

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

// NewBody is the structured BodySegment[] for the post-amendment text
// of a single section the bill amends. It is the structured counterpart
// to `diff_chunks`: where diff_chunks carries the equal/insert/delete
// stream for the Changes view, new_bodies carries the parsed
// reconstructed text for the Proposed view.
//
// One entry per (target_section) with a renderable outcome (anchored or
// added_section). Sections whose outcome is no_changes, no_baseline,
// structural, unresolved, etc. do NOT appear here — the renderer falls
// back to baseline / banner copy for those.
//
// `body` is a flat BodySegment[]; the same renderer pipeline that walks
// corpus section bodies (renderInline + splitParagraphs) consumes this
// without special-casing. The roundtrip invariant `bodyToText(body)`
// re-flattens to the reconstructed newText byte-for-byte — this is the
// alignment hook structured diff overlay uses to project diff_chunks
// onto new_body coordinates.
const NewBodySchema = z
  .object({
    section_id: SectionIdSchema,
    body: z.array(BodySegmentSchema),
  })
  .strict();

export const NewBodiesSchema = z.array(NewBodySchema);

export type NewBody = z.infer<typeof NewBodySchema>;
export type NewBodies = z.infer<typeof NewBodiesSchema>;
