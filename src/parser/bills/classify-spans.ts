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
//
// ## Per-glyph classification
//
// One text run can carry several decoration regions when the lawyer
// compressed multiple edits into the same glyph footprint:
//
//   `(3)(2)` — side-by-side delete + insert, struck on the left half,
//              underlined on the right half. Two regions.
//   `(52)`   — overlapped-paren renumber, struck on `(`, `5`, `)` with
//              the new `2` underlined in the middle. Three regions in
//              a strike→underline→strike pattern.
//
// Each glyph picks its kind from the decoration ops whose x range covers
// the glyph's center, and adjacent same-kind glyphs merge into a single
// emitted sub-span. A glyph covered by both strike and underline ops
// (same x range, different Y band) is ambiguous; a glyph covered by
// neither is also ambiguous (amendment-class runs are expected to carry
// some decoration). The downstream `emit-diff` gate treats any
// ambiguous span as `classification_low_confidence` for its section.

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
   * Maximum vertical distance below baseline for a line to count as
   * "underline" (in PDF points). Default 4. SF Legistar underline
   * sits about 1.5–2 pt below baseline.
   */
  underline_max_depth?: number;
};

const DEFAULT_OPTIONS: Required<ClassifySpansOptions> = {
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
 * Normally emits ONE ClassifiedSpan per input TextRun in input order.
 * When a single italic-Times TextRun carries multiple decoration regions
 * — `(3)(2)` (strike→underline), `(52)` (strike→underline→strike), or
 * any other alternating run — the decoration-boundary walker emits one
 * sub-span per kind region. Every emitted span's `source_index` still
 * points back to its source TextRun, and the spans for that source
 * remain consecutive in the output, so emit-diff continues to drive
 * partition lookups off the run-offset map without re-walking the
 * original array.
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

    // T3 tightening: zero-width control glyphs (soft hyphens, joiner
    // chars, certain ligature shims) come through pdfjs with width === 0
    // and no useful decoration overlap. Treating them as `ambiguous`
    // cascades the whole section to classification_low_confidence even
    // when every other amendment span anchors cleanly. They carry no
    // diff content, so classify as context — the downstream
    // `filterToAmendmentSpans` drops them via the normalize() emptiness
    // check.
    if (run.width <= 0) {
      out.push({ page: run.page, text: run.text, kind: "context", source_index: idx });
      continue;
    }

    // Runs whose entire payload normalizes to "" carry no diff content
    // regardless of font/decoration. The dominant case is a single ASCII
    // space between an underlined word and a struck word: SF Legistar
    // typesets the space in the same italic-Times font as the surrounding
    // amendment glyphs, but the underline / strikethrough graphics ops
    // are drawn under the GLYPHS, not the inter-glyph space — so a
    // standalone space run with width > 0 has no decoration overlap and
    // would otherwise fall through to `ambiguous`. Routing to context
    // matches what `filterToAmendmentSpans` already does for empty
    // payloads.
    if (normalized.length === 0) {
      out.push({ page: run.page, text: run.text, kind: "context", source_index: idx });
      continue;
    }

    // Amendment-class run: walk the decoration ops left-to-right and
    // emit one sub-span per kind region.
    const pageOps = opsByPage.get(run.page) ?? [];
    const subSpans = classifyByDecorationBoundaries(run, pageOps, opts);
    for (const sub of subSpans) {
      out.push({ page: run.page, text: sub.text, kind: sub.kind, source_index: idx });
    }
  }

  return out;
}

/**
 * Walk a single TextRun's decoration ops glyph-by-glyph and emit one
 * sub-span per kind region. The dominant case is a single uniform
 * region (the whole run is underlined or struck), in which case this
 * returns one sub-span. Multiple regions surface when the lawyer
 * compressed several edits into a single text-show op:
 *
 *   `(3)(2)`  →  delete `(3)` + insert `(2)`           (strike, underline)
 *   `(52)`    →  delete `(5` + insert `2` + delete `)` (strike, underline, strike)
 *
 * Glyph centers are estimated assuming uniform per-character width
 * (`run.width / run.text.length`). That estimate is accurate for the
 * monospaced redline glyph pairs SF Legistar uses for numbering edits
 * (parens, digits) and good-enough for general italic-Times runs whose
 * decoration ops align with whole-glyph boundaries (the lawyer never
 * underlines half a glyph). A glyph covered by both a strike op and an
 * underline op is genuinely ambiguous; so is a glyph covered by
 * neither — amendment-class runs are expected to carry some decoration.
 */
function classifyByDecorationBoundaries(
  run: TextRun,
  pageOps: readonly GraphicsOp[],
  opts: Required<ClassifySpansOptions>,
): Array<{ text: string; kind: "insert" | "delete" | "ambiguous" }> {
  if (run.text.length === 0) return [{ text: run.text, kind: "ambiguous" }];

  const runLeft = run.x;
  const runRight = run.x + run.width;
  const baseline = run.y;
  const glyphTop = baseline + Math.max(run.height, 4);
  const strikeMin = baseline + 0.1;
  const strikeMax = baseline + Math.max(run.height, 4) * 0.8;
  const underlineMax = baseline - 0.5;
  const underlineMin = baseline - opts.underline_max_depth;

  // Collect each decoration op's x footprint inside the run, tagged by
  // kind. Above-glyph ops belong to a different run and are ignored.
  type Region = { left: number; right: number; kind: "insert" | "delete" };
  const regions: Region[] = [];
  for (const op of pageOps) {
    const overlapLeft = Math.max(runLeft, op.bbox.x);
    const overlapRight = Math.min(runRight, op.bbox.x + op.bbox.w);
    if (overlapRight <= overlapLeft) continue;
    const opCenterY = op.bbox.y + op.bbox.h / 2;
    if (opCenterY > glyphTop) continue;
    let kind: "insert" | "delete" | null = null;
    if (opCenterY >= underlineMin && opCenterY <= underlineMax) kind = "insert";
    else if (opCenterY >= strikeMin && opCenterY <= strikeMax) kind = "delete";
    if (kind === null) continue;
    regions.push({ left: overlapLeft, right: overlapRight, kind });
  }

  // Assign each glyph a kind based on which decoration regions cover
  // its center, then merge adjacent same-kind glyphs into sub-spans.
  //
  // Glyphs whose center falls inside one or more regions classify from
  // the union of those regions' kinds (both kinds present → genuinely
  // ambiguous, since the lawyer drew strike and underline at the same
  // x). Glyphs whose center falls in a GAP between regions inherit the
  // kind of the nearest single-kind neighbor — Legistar regularly draws
  // its decoration ops a point or two shy of full glyph coverage and we
  // shouldn't cascade a section to manual_review over a 3pt rendering
  // quirk. When the two neighbors carry different single kinds, the
  // gap splits at its midpoint (the boundary between an old-text strike
  // and a new-text underline lands cleanly on one glyph or the other).
  const charWidth = run.width / run.text.length;
  type Kind = "insert" | "delete" | "ambiguous";
  const glyphKind: Kind[] = [];
  for (let i = 0; i < run.text.length; i++) {
    const center = runLeft + (i + 0.5) * charWidth;
    let hasInsert = false;
    let hasDelete = false;
    for (const r of regions) {
      if (center < r.left || center > r.right) continue;
      if (r.kind === "insert") hasInsert = true;
      else hasDelete = true;
    }
    if (hasInsert && hasDelete) {
      glyphKind.push("ambiguous");
      continue;
    }
    if (hasInsert) {
      glyphKind.push("insert");
      continue;
    }
    if (hasDelete) {
      glyphKind.push("delete");
      continue;
    }
    // Gap glyph: no region's range contains its center. Inherit from
    // the nearest single-kind neighbor on either side.
    glyphKind.push(inheritGapKind(center, regions));
  }

  const out: Array<{ text: string; kind: Kind }> = [];
  let curText = run.text[0] ?? "";
  let curKind = glyphKind[0] ?? "ambiguous";
  for (let i = 1; i < run.text.length; i++) {
    const k = glyphKind[i] ?? "ambiguous";
    if (k === curKind) {
      curText += run.text[i];
    } else {
      out.push({ text: curText, kind: curKind });
      curText = run.text[i] ?? "";
      curKind = k;
    }
  }
  out.push({ text: curText, kind: curKind });
  return out;
}

/**
 * Decide a gap glyph's kind from the nearest decoration regions on
 * either side. The gap is the stretch between two decoration regions
 * (or between the start/end of the run and the first/last region).
 *
 * Rules:
 *   • Only one neighbor (run boundary): inherit that neighbor's kind.
 *   • Both neighbors carry the same single kind: that kind.
 *   • Different single kinds: split at the midpoint of the gap so the
 *     boundary glyph picks the closer kind.
 *   • Either neighbor is itself ambiguous (overlapping strike+underline
 *     at that position): the gap glyph stays ambiguous — we can't
 *     safely propagate.
 *   • No regions at all: ambiguous.
 *
 * "Nearest" is measured to the region's edge: for the left neighbor,
 * the region whose `right` is largest but still ≤ center; for the
 * right neighbor, the region whose `left` is smallest but still ≥
 * center. When multiple regions share an edge position (e.g., strike
 * and underline both ending at the same x), their union of kinds is
 * what counts for the side test.
 */
function inheritGapKind(
  center: number,
  regions: ReadonlyArray<{ left: number; right: number; kind: "insert" | "delete" }>,
): "insert" | "delete" | "ambiguous" {
  if (regions.length === 0) return "ambiguous";

  let leftEdge = Number.NEGATIVE_INFINITY;
  let leftHasInsert = false;
  let leftHasDelete = false;
  let rightEdge = Number.POSITIVE_INFINITY;
  let rightHasInsert = false;
  let rightHasDelete = false;
  for (const r of regions) {
    if (r.right <= center) {
      if (r.right > leftEdge) {
        leftEdge = r.right;
        leftHasInsert = false;
        leftHasDelete = false;
      }
      if (r.right === leftEdge) {
        if (r.kind === "insert") leftHasInsert = true;
        else leftHasDelete = true;
      }
    }
    if (r.left >= center) {
      if (r.left < rightEdge) {
        rightEdge = r.left;
        rightHasInsert = false;
        rightHasDelete = false;
      }
      if (r.left === rightEdge) {
        if (r.kind === "insert") rightHasInsert = true;
        else rightHasDelete = true;
      }
    }
  }
  const leftKind = sideKind(leftHasInsert, leftHasDelete);
  const rightKind = sideKind(rightHasInsert, rightHasDelete);

  if (leftKind === null && rightKind === null) return "ambiguous";
  if (rightKind === null) return leftKind ?? "ambiguous";
  if (leftKind === null) return rightKind;
  if (leftKind === "ambiguous" || rightKind === "ambiguous") return "ambiguous";
  if (leftKind === rightKind) return leftKind;
  // Different single kinds: midpoint of the gap between the two
  // closest-edge regions decides which side the glyph falls on.
  const midpoint = (leftEdge + rightEdge) / 2;
  return center < midpoint ? leftKind : rightKind;
}

function sideKind(
  hasInsert: boolean,
  hasDelete: boolean,
): "insert" | "delete" | "ambiguous" | null {
  if (!hasInsert && !hasDelete) return null;
  if (hasInsert && hasDelete) return "ambiguous";
  return hasInsert ? "insert" : "delete";
}
