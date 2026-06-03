// Pure reconstruction helpers for the diff view. Four functions, four
// consumers:
//
//   reconstructStatedSource(spans)
//     Renderer (stated-source mode). Produces the BEFORE / AFTER pair
//     as the bill's PDF stated it — ignores anchors entirely and walks
//     the span list in source order. Useful when the user wants to see
//     exactly what the city wrote, even if the bill's stated_before
//     drifts from the current corpus.
//
//   reconstructCorpusAligned(spans, baseline)
//     Side-by-side renderer (corpus-aligned mode). Reconstructs BEFORE
//     / AFTER using each span's build-time anchor to project it onto
//     the baseline char range. Insert spans land at their anchor
//     offset with zero baseline consumption; delete spans cover their
//     anchor range; context spans pass the baseline range through.
//
//   reconstructInline(spans, baseline)
//     Section-overlay renderer (variant B). Returns a SINGLE stream
//     interleaving context + delete (struck) + insert (highlighted) in
//     baseline order. The reader sees the section's current text with
//     the proposed changes overlaid in place — GitHub-inline style.
//     Anchors drive layout; out-of-bounds anchors fall back to the
//     baseline as one context chunk (defensive — emit-diff's gate
//     should prevent this).
//
//   applyToBaseline(spans, baseline)
//     AI agent's `get_pending_amendments` tool consumer. Returns the
//     baseline mutated by every span: deletes carve out their anchor
//     range, inserts splice into their anchor offset. The result is
//     the "what the law would say if this bill passed today" text.
//
// All three are total functions over a well-formed TextDiffSpan[]
// (anchor present, op enum honored). Bad inputs return the input
// baseline unchanged rather than throwing — the renderer can fall
// back to the manual_review path without crashing.

import type { RenderBodySegment, TextDiff, TextDiffSpan } from "@/types";

export type SideBySide = {
  before: SegmentedText;
  after: SegmentedText;
};

/**
 * A segmented text stream — a list of {kind, text} chunks the renderer
 * iterates over to apply per-kind styling (insert highlight, delete
 * strikethrough, context plain, elision separator).
 *
 * Used by the side-by-side stated-source and corpus-aligned renderers.
 * The inline overlay renderer uses RenderBodySegment[] instead so it
 * can share splitParagraphs and renderSegment with the normal body
 * path.
 */
export type SegmentedText = SegmentedChunk[];

export type SegmentedChunk = {
  kind: "context" | "insert" | "delete" | "elision";
  text: string;
};

/**
 * Walk spans in source order, splitting into BEFORE (what was) and
 * AFTER (what will be). Insert spans appear only in AFTER; delete
 * spans only in BEFORE; context spans appear in both; elision spans
 * become " * * * * " separators in both panes.
 */
export function reconstructStatedSource(spans: TextDiff): SideBySide {
  const before: SegmentedText = [];
  const after: SegmentedText = [];
  for (const span of spans) {
    switch (span.op) {
      case "context":
        before.push({ kind: "context", text: span.text });
        after.push({ kind: "context", text: span.text });
        break;
      case "delete":
        before.push({ kind: "delete", text: span.text });
        break;
      case "insert":
        after.push({ kind: "insert", text: span.text });
        break;
      case "elision":
        before.push({ kind: "elision", text: span.text });
        after.push({ kind: "elision", text: span.text });
        break;
    }
  }
  return { before, after };
}

/**
 * Use each span's anchor to drive the reconstruction off the baseline
 * char range. Falls back to stated-source semantics when an anchor
 * points outside the baseline (defensive — emit-diff's gate should
 * prevent this).
 */
export function reconstructCorpusAligned(spans: TextDiff, baseline: string): SideBySide {
  if (spans.length === 0) {
    return {
      before: [{ kind: "context", text: baseline }],
      after: [{ kind: "context", text: baseline }],
    };
  }
  // Defensive: any out-of-bounds anchor means upstream alignment drifted;
  // fall back to stated-source rendering rather than slicing garbage out
  // of the baseline. emit-diff's per-section gate should prevent this,
  // but a stale corpus reload mid-render could violate the contract.
  if (!anchorsAreInBounds(spans, baseline)) {
    return reconstructStatedSource(spans);
  }
  const before: SegmentedText = [];
  const after: SegmentedText = [];
  // Sort by baseline_offset; the renderer walks the BASELINE in order,
  // interleaving spans at their bound positions.
  const sorted = [...spans].sort((a, b) => {
    if (a.anchor.baseline_offset !== b.anchor.baseline_offset) {
      return a.anchor.baseline_offset - b.anchor.baseline_offset;
    }
    // Ties: inserts come AFTER deletes/contexts at the same offset
    // (visually the replacement appears after the strikethrough).
    return opSortKey(a.op) - opSortKey(b.op);
  });

  let cursor = 0;
  for (const span of sorted) {
    const offset = span.anchor.baseline_offset;
    const length = span.anchor.baseline_length;
    // Emit any baseline gap before this span as shared context.
    if (offset > cursor) {
      const gap = baseline.slice(cursor, offset);
      if (gap.length > 0) {
        before.push({ kind: "context", text: gap });
        after.push({ kind: "context", text: gap });
      }
      cursor = offset;
    }
    switch (span.op) {
      case "context":
        // Baseline slice goes to both sides; cursor advances by anchor length.
        if (length > 0) {
          const slice = baseline.slice(offset, offset + length);
          before.push({ kind: "context", text: slice });
          after.push({ kind: "context", text: slice });
          cursor = offset + length;
        }
        break;
      case "delete":
        // Baseline slice appears struck through on BEFORE only.
        if (length > 0) {
          const slice = baseline.slice(offset, offset + length);
          before.push({ kind: "delete", text: slice });
          cursor = offset + length;
        }
        break;
      case "insert":
        // Insert spans don't consume baseline; the span's own text
        // appears on AFTER. Cursor stays.
        after.push({ kind: "insert", text: span.text });
        break;
      case "elision":
        before.push({ kind: "elision", text: span.text });
        after.push({ kind: "elision", text: span.text });
        // Wildcard gap: emit-diff guarantees baseline_length === 0,
        // but defensively advance cursor by `length` anyway.
        cursor = offset + length;
        break;
    }
  }
  // Tail: emit any baseline past the last anchor.
  if (cursor < baseline.length) {
    const tail = baseline.slice(cursor);
    before.push({ kind: "context", text: tail });
    after.push({ kind: "context", text: tail });
  }
  return { before, after };
}

/**
 * Walk spans against the baseline and emit a RenderBodySegment[] stream
 * where deletes appear in-place (struck-through at render time) and
 * inserts appear at their anchor positions (highlighted at render
 * time). Used by the section-view overlay (variant B): the reader sees
 * the section's current body with the bill's proposed changes overlaid
 * inline, GitHub-style.
 *
 * Output is BodySegment-shaped — context chunks become text segments,
 * newlines split into paragraph_break markers, and insert / delete /
 * elision chunks become their RenderBodySegment variants. The overlay
 * renderer can therefore reuse splitParagraphs + renderSegment with the
 * normal body path; no parallel paragraph splitter or renderer needed.
 *
 * Empty spans → baseline as one paragraph-split text run (clean body,
 * no overlay-induced visual diff). Out-of-bounds anchors → same.
 */
export function reconstructInline(spans: TextDiff, baseline: string): RenderBodySegment[] {
  if (spans.length === 0 || !anchorsAreInBounds(spans, baseline)) {
    return paragraphizeText(baseline);
  }
  const out: RenderBodySegment[] = [];
  // Same sort as reconstructCorpusAligned: ascending by baseline_offset,
  // ties broken so an insert at the same offset as a delete renders
  // AFTER the strikethrough (the visual "replacement" pattern readers
  // expect from inline diffs).
  const sorted = [...spans].sort((a, b) => {
    if (a.anchor.baseline_offset !== b.anchor.baseline_offset) {
      return a.anchor.baseline_offset - b.anchor.baseline_offset;
    }
    return opSortKey(a.op) - opSortKey(b.op);
  });
  let cursor = 0;
  for (const span of sorted) {
    const offset = span.anchor.baseline_offset;
    const length = span.anchor.baseline_length;
    if (offset > cursor) {
      const gap = baseline.slice(cursor, offset);
      if (gap.length > 0) pushText(out, gap);
      cursor = offset;
    }
    switch (span.op) {
      case "context":
        if (length > 0) {
          pushText(out, baseline.slice(offset, offset + length));
          cursor = offset + length;
        }
        break;
      case "delete":
        if (length > 0) {
          pushDiffRuns(out, baseline.slice(offset, offset + length), "diff_delete");
          cursor = offset + length;
        }
        break;
      case "insert":
        pushDiffRuns(out, span.text, "diff_insert");
        break;
      case "elision":
        out.push({ kind: "diff_elision", text: span.text });
        cursor = offset + length;
        break;
    }
  }
  if (cursor < baseline.length) {
    pushText(out, baseline.slice(cursor));
  }
  return out;
}

/**
 * Append `text` to a RenderBodySegment stream, splitting at `\n` into
 * `{kind:"text"}` runs separated by `{kind:"paragraph_break"}` markers.
 * Empty runs are dropped so two adjacent paragraph_breaks (which
 * splitParagraphs would render as an empty paragraph anyway) don't
 * surface. The first run is fused onto the trailing text segment when
 * possible to keep the stream compact.
 */
function pushText(out: RenderBodySegment[], text: string): void {
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: "paragraph_break" });
    const piece = parts[i];
    if (piece && piece.length > 0) out.push({ kind: "text", text: piece });
  }
}

/**
 * Append `text` to a RenderBodySegment stream as one or more diff runs
 * (diff_insert / diff_delete). Splits at `\n` so a delete chunk that
 * spans two paragraphs renders as one struck run per paragraph rather
 * than carrying the newline into the rendered span.
 */
function pushDiffRuns(
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

function paragraphizeText(text: string): RenderBodySegment[] {
  if (text.length === 0) return [];
  const out: RenderBodySegment[] = [];
  pushText(out, text);
  return out;
}

/**
 * Mutate the baseline according to the diff and return the result —
 * deletes excised, inserts spliced in at their anchor offsets. This is
 * what the AI agent uses to answer "what would §X say if 260217
 * passed?". Pure function: baseline in, after-text out.
 *
 * Strategy: walk sorted spans forward, accumulating `out` from the
 * baseline. A cursor advances past consumed baseline ranges; inserts
 * splice their text in at the current cursor without consuming, so
 * positions stay consistent without per-edit reshifts.
 */
export function applyToBaseline(spans: TextDiff, baseline: string): string {
  if (spans.length === 0) return baseline;
  // Same defensive guard as reconstructCorpusAligned: a bad anchor
  // means upstream alignment drifted and slicing would produce
  // truncated garbage. Return the baseline unchanged.
  if (!anchorsAreInBounds(spans, baseline)) return baseline;
  // Sort same as the renderer: by baseline_offset ascending, with
  // ties resolved so inserts come AFTER deletes / contexts at the
  // same offset (the visual "replacement" pattern).
  const sorted = [...spans].sort((a, b) => {
    if (a.anchor.baseline_offset !== b.anchor.baseline_offset) {
      return a.anchor.baseline_offset - b.anchor.baseline_offset;
    }
    return opSortKey(a.op) - opSortKey(b.op);
  });

  let out = "";
  let cursor = 0;
  for (const span of sorted) {
    const offset = span.anchor.baseline_offset;
    const length = span.anchor.baseline_length;
    if (offset > cursor) {
      out += baseline.slice(cursor, offset);
      cursor = offset;
    }
    switch (span.op) {
      case "context":
        // Pass the baseline slice through unchanged.
        out += baseline.slice(offset, offset + length);
        cursor = Math.max(cursor, offset + length);
        break;
      case "delete":
        // Skip the baseline slice entirely; cursor advances past it.
        cursor = Math.max(cursor, offset + length);
        break;
      case "insert":
        // Splice the span's text in at the current position; no
        // baseline consumption.
        out += span.text;
        break;
      case "elision":
        // Wildcard gap: emit-diff guarantees baseline_length === 0,
        // so this is a no-op on the baseline. The agent treats
        // elision as "the baseline content here is unchanged".
        cursor = Math.max(cursor, offset + length);
        break;
    }
  }
  // Tail: append any baseline past the last anchor.
  if (cursor < baseline.length) {
    out += baseline.slice(cursor);
  }
  return out;
}

function anchorsAreInBounds(spans: TextDiff, baseline: string): boolean {
  for (const span of spans) {
    const start = span.anchor.baseline_offset;
    const end = start + span.anchor.baseline_length;
    if (start < 0 || end > baseline.length) return false;
  }
  return true;
}

function opSortKey(op: TextDiffSpan["op"]): number {
  // Higher = renders later at the same offset.
  switch (op) {
    case "context":
      return 0;
    case "delete":
      return 1;
    case "elision":
      return 2;
    case "insert":
      return 3;
  }
}
