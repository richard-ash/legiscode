// Layer 3 typography classifier. Walks the per-page text runs from
// `extractTextRuns` and decides each run's amendment role by correlating
// its baseline against the page's graphics-op decoration (thin
// `~0.6pt` rectangles for SF Legistar's underline / strikethrough).
//
// Why this lives at the parser level and not in the renderer: the
// underline-vs-strikethrough distinction is the ONLY signal we have for
// SF Legistar redlines. Both kinds use the same italic Times font and
// the same fill color (`#000000`). The visual decoration is therefore
// load-bearing for `insert` vs `delete` classification; losing it in
// the structural pass would force every diff into manual_review.
//
// ## Pipeline
//
//   text-runs  ──┐
//   graphics-op ─┼──► classifySpans ──► ClassifiedSpan[] (in source order)
//   font-metadata┘                        │
//                                          ▼
//                                       emit-diff.ts consumes this
//                                       per affected_section and aligns
//                                       against corpus baseline text.
//
// ## SF Legistar redline convention (from each bill's NOTE block)
//
//   plain Arial                              → context
//   single-underline italics Times New Roman → insert
//   strikethrough  italics Times New Roman   → delete
//   double-underlined Arial                  → board insert (future)
//   strikethrough  Arial                     → board delete  (future)
//   `* * * *`                                → elision sentinel
//
// Class-A bill mode handles the first three + elision. Board-amendment
// support waits on `feat/board-amendments` (out of scope this PR).
//
// ## Decoration geometry
//
// PDF user-space puts origin at bottom-left and y grows upward, so for
// a text run with baseline y `b` and glyph height `h`:
//
//        ┌───────────────────────┐  top  = b + h
//        │   ALL CAPS WORD       │
//        ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  baseline = b
//                                                     <-- underline:    y ≈ b - 1
//                                                     <-- strikethrough: y ≈ b + h/2
//
// We bucket lines into the under-baseline band (y < b) → insert, and
// the through-baseline band (b ≤ y ≤ b + h * 0.8) → delete. Anything
// above-glyph (y > b + h) is treated as decoration on a different run.

import type { FontMetadata, GraphicsOp, TextRun } from "@/parser/pdf/page-extractor";
import { isItalicFont, isTimesFont } from "./italic";
import { normalize } from "./normalize";

export type ClassifiedKind = "context" | "insert" | "delete" | "elision" | "ambiguous";

/** A single classified text run, ready for emit-diff. */
export type ClassifiedSpan = {
  /** 1-indexed page number, matching TextRun.page. */
  page: number;
  /** Verbatim text from the source TextRun. */
  text: string;
  /** Amendment role. */
  kind: ClassifiedKind;
  /** Source-order index into the input TextRun[]. Stable across runs. */
  source_index: number;
};

export type ClassifySpansOptions = {
  /**
   * Horizontal overlap fraction required to claim decoration (line's
   * intersected width / run's width). Default 0.5 = at least half the
   * run must be covered by the decoration line.
   */
  horizontal_overlap_threshold?: number;
  /**
   * Maximum vertical distance below baseline for a line to count as
   * "underline" (in PDF points). Default 4. SF Legistar underline
   * sits about 1.5–2 pt below baseline.
   */
  underline_max_depth?: number;
};

const DEFAULT_OPTIONS: Required<ClassifySpansOptions> = {
  horizontal_overlap_threshold: 0.5,
  underline_max_depth: 4,
};

// SF Legistar's PDF generator splits the "* * * *" elision sentinel into
// four separate text runs (one per asterisk) — we never see the full
// string in a single TextRun. Match each component individually; the
// downstream aligner (emit-diff.ts) coalesces consecutive elision spans
// into one wildcard gap.
const ELISION_COMPONENT_RE = /^\*+$/;

/**
 * Classify each TextRun by font + graphics-op decoration.
 *
 * The output is one ClassifiedSpan per input TextRun, in input order.
 * No filtering — keeping length parity lets emit-diff drive directly
 * off `source_index` without re-walking the original array.
 */
export function classifySpans(
  runs: readonly TextRun[],
  graphicsOps: readonly GraphicsOp[],
  fontMeta: ReadonlyMap<string, FontMetadata>,
  options: ClassifySpansOptions = {},
): ClassifiedSpan[] {
  const opts: Required<ClassifySpansOptions> = { ...DEFAULT_OPTIONS, ...options };

  // Bucket graphics ops by page; classify-spans only ever correlates
  // within a single page.
  const opsByPage = new Map<number, GraphicsOp[]>();
  for (const op of graphicsOps) {
    // Skip giant ops (full-page clips, page-bound rectangles). A
    // strike/underline line is < 5 pt tall; anything taller is page
    // chrome and would smear classification.
    if (op.bbox.h > 5) continue;
    const list = opsByPage.get(op.page);
    if (list === undefined) {
      opsByPage.set(op.page, [op]);
    } else {
      list.push(op);
    }
  }

  const out: ClassifiedSpan[] = [];
  for (let idx = 0; idx < runs.length; idx++) {
    const run = runs[idx];
    if (run === undefined) continue;

    // Elision sentinel test runs FIRST — the city sometimes typesets
    // the asterisks in italic Times to match surrounding amendment
    // prose, which would otherwise mis-classify as insert/delete.
    const normalized = normalize(run.text);
    if (ELISION_COMPONENT_RE.test(normalized)) {
      out.push({ page: run.page, text: run.text, kind: "elision", source_index: idx });
      continue;
    }

    const meta = fontMeta.get(run.font_name);
    const isAmendmentClass = isItalicFont(meta) && isTimesFont(meta);

    if (!isAmendmentClass) {
      out.push({ page: run.page, text: run.text, kind: "context", source_index: idx });
      continue;
    }

    // Amendment-class run: needs decoration to decide insert vs delete.
    const pageOps = opsByPage.get(run.page) ?? [];
    const decoration = classifyDecoration(run, pageOps, opts);
    out.push({ page: run.page, text: run.text, kind: decoration, source_index: idx });
  }

  return out;
}

function classifyDecoration(
  run: TextRun,
  pageOps: readonly GraphicsOp[],
  opts: Required<ClassifySpansOptions>,
): "insert" | "delete" | "ambiguous" {
  // Skip runs with no horizontal extent (e.g. zero-width control glyphs).
  if (run.width <= 0) return "ambiguous";

  // Bounds of the run's footprint.
  const runLeft = run.x;
  const runRight = run.x + run.width;
  const baseline = run.y;
  const glyphTop = run.y + Math.max(run.height, 4);
  // Strikethrough sits between baseline and ~80% of glyph height.
  const strikeMin = baseline + 0.1;
  const strikeMax = baseline + Math.max(run.height, 4) * 0.8;
  // Underline sits between baseline and a few points below it.
  const underlineMax = baseline - 0.5;
  const underlineMin = baseline - opts.underline_max_depth;

  let underlineHit = false;
  let strikeHit = false;

  for (const op of pageOps) {
    const opLeft = op.bbox.x;
    const opRight = op.bbox.x + op.bbox.w;
    // Horizontal overlap test.
    const intersect = Math.min(runRight, opRight) - Math.max(runLeft, opLeft);
    if (intersect <= 0) continue;
    if (intersect / run.width < opts.horizontal_overlap_threshold) continue;

    // Vertical band test. Use the line's center y for the bucket pick.
    const opCenterY = op.bbox.y + op.bbox.h / 2;

    if (opCenterY >= underlineMin && opCenterY <= underlineMax) {
      underlineHit = true;
    } else if (opCenterY >= strikeMin && opCenterY <= strikeMax) {
      strikeHit = true;
    } else if (opCenterY > glyphTop) {
      // Above-glyph decoration — belongs to a different run, ignore.
    }
  }

  if (underlineHit && strikeHit) return "ambiguous";
  if (underlineHit) return "insert";
  if (strikeHit) return "delete";
  // No decoration on an italic-Times run is unexpected: SF Legistar
  // shouldn't emit such runs. Treat as ambiguous so emit-diff cascades
  // the whole section to manual_review.
  return "ambiguous";
}
