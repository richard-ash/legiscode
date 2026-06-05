// Inline-overlay renderer. Walks DiffChunk[] in document order and
// emits a flat stream of RenderBodySegment chunks the section view
// consumes via splitParagraphs + renderInline.
//
// v2 contract — chunks come from `diffWords(baseline, reconstructedNewText)`
// already sequenced in document order:
//
//   • "equal"  → renderer emits plain text (lc-text). Newlines inside
//                the chunk break into paragraph_break markers so
//                splitParagraphs can group output into <p> blocks.
//   • "insert" → diff_insert (underlined). Same newline handling.
//   • "delete" → diff_delete (struck). Same newline handling.
//
// No offset math, no anchor lookups, no positioning logic. The diff
// algorithm already aligned the chunks; the renderer just walks them.

import type { DiffChunks, RenderBodySegment } from "@/types";

export function overlayDiffOnBaseline(chunks: DiffChunks, baseline: string): RenderBodySegment[] {
  if (chunks.length === 0) return paragraphize(baseline);
  const out: RenderBodySegment[] = [];
  for (const chunk of chunks) {
    switch (chunk.op) {
      case "equal":
        pushText(out, chunk.text);
        break;
      case "insert":
        pushDiff(out, chunk.text, "diff_insert");
        break;
      case "delete":
        pushDiff(out, chunk.text, "diff_delete");
        break;
    }
  }
  return out;
}

function pushText(out: RenderBodySegment[], text: string): void {
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: "paragraph_break" });
    const piece = parts[i];
    if (piece && piece.length > 0) out.push({ kind: "text", text: piece });
  }
}

function pushDiff(
  out: RenderBodySegment[],
  text: string,
  kind: "diff_insert" | "diff_delete",
): void {
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: "paragraph_break" });
    const piece = parts[i];
    if (piece && piece.length > 0) out.push({ kind, text: piece });
  }
}

function paragraphize(text: string): RenderBodySegment[] {
  if (text.length === 0) return [];
  const out: RenderBodySegment[] = [];
  pushText(out, text);
  return out;
}
