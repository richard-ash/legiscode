// Inline-overlay renderer. Walks TextDiffSpan[] in baseline-position
// order against the corpus section's baseline and emits a flat stream
// of RenderBodySegment chunks the section view consumes via
// splitParagraphs + renderInline.
//
// Contract:
//   • spans are in source order from emit-inline-spans, which is also
//     baseline-monotonic (the running cursor only moves forward). A
//     stable sort by offset preserves that source order at shared
//     offsets, which matters because inserts + whitespace contexts
//     share offset 0 in the all-additive subsection prefix case.
//   • gaps between adjacent anchors are filled from the baseline as
//     context — the reader sees the full section text even when the
//     bill body elides portions via the "* * * *" sentinel.
//   • inserts carry their own text (the bill's added prose); deletes
//     render the baseline slice the anchor covers (strikethrough).
//   • zero-length context spans (from emit-inline-spans when a bill
//     PDF whitespace run couldn't anchor) emit their own text as
//     inline glue, so adjacent inserts stay visually separated.
//   • newlines inside any chunk split into paragraph_break markers so
//     splitParagraphs can group the output into <p> blocks downstream.

import type { RenderBodySegment, TextDiff } from "@/types";

export function overlayDiffOnBaseline(spans: TextDiff, baseline: string): RenderBodySegment[] {
  if (spans.length === 0) return paragraphize(baseline);
  // Stable sort by baseline offset only. emit-inline-spans emits in
  // source order (which is also baseline-monotonic), so spans sharing
  // an offset stay in their bill reading order — inserts and the
  // whitespace contexts that glue them together interleave as the
  // lawyer drew them. Don't tiebreak by op kind here: doing so
  // scrambles "(a) Definition" into "(a)Definition " because the
  // whitespace glue gets reordered after the inserts.
  const sorted = [...spans].sort((a, b) => a.anchor.baseline_offset - b.anchor.baseline_offset);
  const out: RenderBodySegment[] = [];
  let cursor = 0;
  for (const span of sorted) {
    const offset = span.anchor.baseline_offset;
    const length = span.anchor.baseline_length;
    if (offset > cursor) {
      pushText(out, baseline.slice(cursor, offset));
      cursor = offset;
    }
    switch (span.op) {
      case "context":
        if (length > 0) {
          pushText(out, baseline.slice(offset, offset + length));
          cursor = offset + length;
        } else if (span.text.length > 0) {
          // Zero-length context = inline glue text (the bill PDF's
          // whitespace or short-context payload that didn't anchor to
          // baseline). Emit the span text directly so it sits between
          // adjacent inserts/contexts rather than disappearing.
          pushText(out, span.text);
        }
        break;
      case "delete":
        if (length > 0) {
          pushDiff(out, baseline.slice(offset, offset + length), "diff_delete");
          cursor = offset + length;
        }
        break;
      case "insert":
        pushDiff(out, span.text, "diff_insert");
        break;
      case "elision":
        // emit-inline-spans skips elision today, so this is unreachable
        // for inline diffs. Wholesale paths never emit elision either.
        // Treat defensively as a sentinel chunk so a future emitter
        // doesn't crash the renderer.
        out.push({ kind: "diff_elision", text: span.text });
        cursor = offset + length;
        break;
    }
  }
  if (cursor < baseline.length) pushText(out, baseline.slice(cursor));
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
