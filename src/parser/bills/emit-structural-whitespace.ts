// Translate (x, y) position deltas between consecutive PDF runs into
// the structural whitespace they imply — single spaces inside a
// paragraph, newlines between paragraphs. Without this, runs
// concatenate into a wall of text and indentation-sensitive legal
// prose (nested subsections, numbered lists, paragraph-per-definition
// blocks) loses every structural cue.
//
// The PDF carries no leading whitespace in `.text` — every newline
// and indent is implicit in the run's (page, x, y). Reconstruction
// needs this translator at every run boundary; the alternative
// (concatenate `.text` and hope) produces §901's six-definitions-
// rendered-as-one-blob symptom that motivated the v2 rewrite.

import type { TextRun } from "@/parser/pdf/page-extractor";

// SF Legistar body text uses ~17pt line spacing in single-line wraps
// and ~24-30pt between paragraphs. The 22pt threshold reliably
// separates the two in observed §901 / §31.02 / §1290 fixtures; the
// earlier 16pt heuristic over-promoted same-paragraph line wraps
// into paragraph breaks, splitting six-definition blocks into
// twenty-line walls. Tightening to 22pt resolves both.
//
// Page-boundary transitions get treated as paragraph breaks
// unconditionally: y resets at the top of each page, so the inter-
// page y-delta is negative or zero and the threshold check would
// miss the break. Bills that continue a paragraph across a page are
// rare in SF Legistar's per-definition layout; when they happen,
// diffWords resolves the extra newline against the baseline.
const PARAGRAPH_BREAK_Y_DROP = 22;

/**
 * Whitespace implied by the page/x/y delta from `prev` to `next`,
 * to be inserted between their text contents during reconstruction.
 *
 *   - cross-page  → "\n"  (paragraph break)
 *   - same line   → ""    (or " " when there's a real x-gap)
 *   - line wrap   → " "   (same paragraph, runs split across visual lines)
 *   - new para    → "\n"  (large y-drop between same-page runs)
 *
 * `prev` is always the previous emitted run (deletes don't count —
 * they're skipped, never emitted, so the spatial context for the
 * next emission jumps to the next non-deleted run).
 */
export function emitStructuralWhitespace(prev: TextRun, next: TextRun): string {
  if (prev.page !== next.page) return "\n";

  const sameLine = Math.abs(prev.y - next.y) < 2;
  if (sameLine) {
    // Inter-word space within a single PDF line. Runs are often split
    // at word boundaries with the space dropped; restore it when
    // `prev` doesn't already end in whitespace and the next run sits
    // measurably to the right of `prev`'s right edge.
    const prevEndsWs = /\s$/.test(prev.text);
    const xGap = next.x - (prev.x + prev.width);
    if (!prevEndsWs && xGap > 1) return " ";
    return "";
  }

  const yDrop = prev.y - next.y;
  if (yDrop > PARAGRAPH_BREAK_Y_DROP) return "\n";
  return " ";
}
