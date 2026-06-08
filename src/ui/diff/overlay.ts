// Structured overlay renderer for **Changes mode only**. Walks the
// baseline BodySegment[] and projects the section's diff_chunks onto
// it to produce a RenderBodySegment[] with inline insert/delete marks.
//
// Proposed mode does NOT route through here. The section view renders
// Proposed directly from the bill's parsed `new_body` (which the
// parser already produced at build time) — no projection, no walker.
// This split came from PR #47: when delete chunks emitted nothing in
// Proposed, atomic-segment wrappers (citations, defined-terms) whose
// chars had been deleted were silently resurrected with their baseline
// text. Walking new_body for Proposed sidesteps the inference entirely.
//
// Algorithm — walk baseline body in DFS order; maintain a cursor
// through diff_chunks; consume baseline chars from equal+delete chunks
// (the baseline-source chunk types). Insert chunks contribute zero
// baseline chars and emit at their natural position in the stream.
//
//   • equal chunks  → emit as plain text (sits inside the surrounding
//                     citation / defined_term / format wrapper).
//   • delete chunks → emit as diff_delete (struck inline).
//   • insert chunks → emit as diff_insert (highlighted inline).
//
// Atomic segments (citation, defined_term, subsection_label): when
// every consumed char came from an equal chunk, emit the segment
// intact so the popover / tooltip still wires. When any char came
// from a delete chunk OR any insert landed inside the atomic span,
// emit the consumed children directly — losing the segment chrome is
// the honest read of "the bill changed text inside this annotation."

import { bodyToText } from "@/types";
import type { BodySegment, DiffChunks, RenderBodySegment } from "@/types";

export type OverlayMode = "changes";

/**
 * Construct a minimal BodySegment[] from a raw baseline string (no
 * citations / defined-terms / format extraction). Used by callers
 * that have only text on hand, not a parsed corpus body (e.g. the
 * bill-view's DiffView, which loads baseline via an async loader
 * that returns a string). Section-view callers should always pass
 * the corpus `section.body` directly — that route keeps the full
 * citation / defined-term / list chrome across diff modes, which
 * baseline-text-only callers necessarily lose.
 */
export function bodyFromText(text: string): readonly BodySegment[] {
  if (text.length === 0) return [];
  const out: BodySegment[] = [];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: "paragraph_break" });
    const piece = parts[i];
    if (piece && piece.length > 0) out.push({ kind: "text", text: piece });
  }
  return out;
}

/**
 * Render the Changes-mode overlay by projecting `diffChunks` onto
 * `baselineBody`. Returns a flat RenderBodySegment[] with inline
 * insert/delete marks. The baseline body is the same `BodySegment[]`
 * the Original view renders, so the two modes share structural DOM
 * and only diff marks differ.
 *
 * Proposed mode renders from `Bill.new_bodies[i].body` directly at
 * the section-view layer; it does not route through this function.
 */
export function overlayStructured(
  diffChunks: DiffChunks,
  baselineBody: readonly BodySegment[],
  mode: OverlayMode,
): RenderBodySegment[] {
  // baseline.text is the canonical slice source. With
  // diffWordsWithSpace, equal/delete chunk text is already
  // byte-identical to baseline at the corresponding span — slicing
  // from baseline is a no-op alignment check, not a correction. We
  // keep it explicit so the walker stays decoupled from chunk-text
  // bytes: any future diff-emitter change that breaks byte alignment
  // (e.g. reverting to whitespace-insensitive diffWords) surfaces as
  // visibly mangled text instead of silently wrong-looking-correct
  // output that's actually off by a few chars.
  // The mode argument exists for forward-compat with future overlay
  // modes; today only "changes" routes here.
  void mode;
  const baseline = bodyToText(baselineBody);
  const stream = new DiffStream(diffChunks, baseline);
  const out: RenderBodySegment[] = [];
  walk(baselineBody, out, stream);
  // After walking the full baseline, any remaining chunks are
  // trailing inserts (the bill appended text past the end of the
  // baseline) OR a trailing wholesale-delete that consumed every
  // baseline char already. Flush both kinds so nothing is lost.
  stream.flushTail(out);
  return collapseStructuralWhitespace(out);
}

/**
 * Collapse runs of paragraph_break and drop leading/trailing breaks.
 * The structured walker can emit adjacent paragraph_breaks when the
 * baseline body already carries one at a position where a whitespace-
 * only insert chunk also emits one (PDF reconstruction artifacts —
 * the bill's reconstructed newText injects extra blank lines around
 * section-like prose). Without this pass, those positions render as
 * double or triple paragraph gaps that don't appear in the resting
 * Original view, breaking spacing parity across modes.
 */
function collapseStructuralWhitespace(segs: readonly RenderBodySegment[]): RenderBodySegment[] {
  const out: RenderBodySegment[] = [];
  let prevWasBreak = true; // suppress a leading paragraph_break
  for (const seg of segs) {
    if (seg.kind === "paragraph_break") {
      if (!prevWasBreak) {
        out.push(seg);
        prevWasBreak = true;
      }
      continue;
    }
    out.push(seg);
    prevWasBreak = false;
  }
  // Drop trailing paragraph_break.
  while (out.length > 0 && out[out.length - 1]?.kind === "paragraph_break") {
    out.pop();
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────

/**
 * Tally returned from a `consume()` call. The walker uses it to decide
 * whether an atomic baseline segment (citation, defined_term,
 * subsection_label) survives the amendment with its wrapper intact.
 *
 * The rule the walker enforces: the wrapper survives only when EVERY
 * consumed baseline char came from an equal chunk AND no inserts
 * landed inside the consumed span. Either a delete or an inserted
 * phrase inside the wrapped region means the bill rewrote text inside
 * that annotation; the wrapper drops and the consumed children
 * (including the diff marks) render directly.
 */
type ConsumeReport = { hadDelete: boolean; hadInsert: boolean };

class DiffStream {
  private readonly chunks: DiffChunks;
  private readonly baseline: string;
  private idx = 0;
  private posInChunk = 0;
  private basePos = 0;

  constructor(chunks: DiffChunks, baseline: string) {
    this.chunks = chunks;
    this.baseline = baseline;
  }

  /**
   * Drain insert chunks at the current cursor position into `out`.
   * Inserts contribute 0 baseline chars; they live "between" equal /
   * delete spans in baseline coordinates. Every consume() begins with
   * an insert drain so an inserted phrase at a baseline position
   * surfaces in reading order. Returns the number of insert chunks
   * drained so the caller can update its op-mix tally.
   */
  private flushInserts(out: RenderBodySegment[]): number {
    let count = 0;
    while (this.idx < this.chunks.length) {
      const c = this.chunks[this.idx];
      if (!c || c.op !== "insert") return count;
      pushDiff(out, c.text, "diff_insert");
      this.idx++;
      this.posInChunk = 0;
      count++;
    }
    return count;
  }

  /**
   * Consume exactly `n` chars from the equal+delete stream (the
   * baseline-source chunks). Equal chunks emit text sliced from
   * baseline at the current basePos; with the diffWordsWithSpace
   * emitter, chunk.text === baseline.slice(basePos, basePos+n) by
   * construction, but slicing from baseline keeps the walker
   * decoupled from chunk bytes (any future drift surfaces visibly,
   * not as silently-wrong-looking output). Delete chunks emit
   * diff_delete inline. Inserts are drained at the start AND end so
   * they surface in source order.
   *
   * Returns a ConsumeReport so the walker can detect whether the
   * span the caller asked about crossed a deleted or inserted chunk
   * — the load-bearing signal for atomic-segment wrapper survival.
   */
  consume(n: number, out: RenderBodySegment[]): ConsumeReport {
    const report: ConsumeReport = { hadDelete: false, hadInsert: false };
    if (this.flushInserts(out) > 0) report.hadInsert = true;
    let remaining = n;
    while (remaining > 0) {
      const c = this.chunks[this.idx];
      if (!c) return report;
      // Inserts can interleave between equal/delete chunks; drain
      // them eagerly so the next chunk is guaranteed to be a
      // baseline-source op.
      if (c.op === "insert") {
        if (this.flushInserts(out) > 0) report.hadInsert = true;
        continue;
      }
      const remInChunk = c.text.length - this.posInChunk;
      const take = Math.min(remaining, remInChunk);
      // Slice from BASELINE (canonical), not from chunk.text. The
      // chunk's char count drives offset arithmetic; the byte content
      // comes from baseline.
      const slice = this.baseline.slice(this.basePos, this.basePos + take);
      if (c.op === "delete") {
        pushDiff(out, slice, "diff_delete");
        report.hadDelete = true;
      } else {
        // op === "equal"
        pushText(out, slice);
      }
      this.posInChunk += take;
      this.basePos += take;
      remaining -= take;
      if (this.posInChunk >= c.text.length) {
        this.idx++;
        this.posInChunk = 0;
      }
    }
    if (this.flushInserts(out) > 0) report.hadInsert = true;
    return report;
  }

  /**
   * Drain everything left in the stream after baseline body has been
   * fully walked. Handles two cases the inline drains don't cover:
   *   • a trailing insert past the baseline's end
   *   • a trailing delete whose chars hung off the end of the
   *     baseline body (defensive — diffWords output is roundtrip-
   *     bound so this should be empty)
   */
  flushTail(out: RenderBodySegment[]): void {
    while (this.idx < this.chunks.length) {
      const c = this.chunks[this.idx];
      if (!c) return;
      if (c.op === "insert") {
        pushDiff(out, c.text, "diff_insert");
      } else if (c.op === "delete") {
        const slice = this.baseline.slice(this.basePos);
        pushDiff(out, slice, "diff_delete");
        this.basePos += c.text.length - this.posInChunk;
      } else {
        // op === "equal": should have been drained by walk; defensive
        const slice = this.baseline.slice(this.basePos);
        pushText(out, slice);
        this.basePos += c.text.length - this.posInChunk;
      }
      this.idx++;
      this.posInChunk = 0;
    }
  }
}

function walk(
  segments: readonly BodySegment[],
  out: RenderBodySegment[],
  stream: DiffStream,
): void {
  for (const seg of segments) {
    switch (seg.kind) {
      case "text":
        stream.consume(seg.text.length, out);
        break;
      case "citation": {
        // Atomic segment. The wrapper survives only when EVERY
        // consumed baseline char came from an equal chunk AND no
        // insert landed inside the consumed span. Either a delete
        // or an inserted phrase inside the citation means the bill
        // rewrote text within the annotation — drop the wrapper and
        // emit the consumed children directly with their diff marks.
        //
        // The prior heuristic checked `consumed.every(s.kind ===
        // "text")` and broke in Proposed mode because delete chunks
        // emitted nothing, leaving consumed-but-deleted spans
        // indistinguishable from purely-equal ones. ConsumeReport
        // observes chunk ops directly, so the inference is honest.
        const consumed: RenderBodySegment[] = [];
        const report = stream.consume(seg.raw.length, consumed);
        if (consumed.length === 0) break;
        if (!report.hadDelete && !report.hadInsert) {
          out.push(seg);
        } else {
          for (const c of consumed) out.push(c);
        }
        break;
      }
      case "defined_term": {
        const consumed: RenderBodySegment[] = [];
        const report = stream.consume(seg.raw.length, consumed);
        if (consumed.length === 0) break;
        if (!report.hadDelete && !report.hadInsert) {
          out.push(seg);
        } else {
          for (const c of consumed) out.push(c);
        }
        break;
      }
      case "subsection_label": {
        const consumed: RenderBodySegment[] = [];
        const report = stream.consume(seg.label.length, consumed);
        if (consumed.length === 0) break;
        if (!report.hadDelete && !report.hadInsert) {
          out.push(seg);
        } else {
          for (const c of consumed) out.push(c);
        }
        break;
      }
      case "paragraph_break": {
        // bodyToText emits "\n" for a paragraph_break; consume that
        // single char from the diff stream and emit the structural
        // marker. Consumed text is discarded — the marker takes its
        // place visually.
        stream.consume(1, []);
        out.push({ kind: "paragraph_break" });
        break;
      }
      case "format": {
        const inner: RenderBodySegment[] = [];
        walk(seg.children, inner, stream);
        out.push({
          kind: "format",
          style: seg.style,
          // RenderBodySegment is structurally compatible with
          // BodySegment at the format-children slot — the renderer's
          // switch handles diff_* children alongside the standard
          // kinds.
          children: inner as unknown as BodySegment[],
        });
        break;
      }
    }
  }
}

function pushText(out: RenderBodySegment[], text: string): void {
  if (text.length === 0) return;
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
  if (text.length === 0) return;
  // Whitespace-only diff chunks are structural reformatting, not
  // substantive changes — emit at most a paragraph_break (when the
  // chunk crossed a line) and never a green/struck span. A reader
  // doesn't benefit from a highlight on three spaces, and the chunk
  // alignment otherwise leaks PDF reconstruction artifacts into the
  // overlay as visual noise.
  if (/^\s+$/.test(text)) {
    if (text.includes("\n")) out.push({ kind: "paragraph_break" });
    return;
  }
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: "paragraph_break" });
    const piece = parts[i];
    if (piece && piece.length > 0) out.push({ kind, text: piece });
  }
}
