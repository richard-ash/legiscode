// Position context spans in the corpus baseline by whitespace-tolerant
// substring search. This is the positioning primitive the new diff
// pipeline relies on: the bill PDF IS already a redline (per the SF
// drafting convention encoded in classify-spans), so the diff doesn't
// need to be computed — context spans just need to be located in the
// baseline so the renderer can lay out the deletes and inserts around
// them.
//
// Why monotone: a context span like "or" or "and" appears many times
// in a typical baseline. Each anchor must start at or after the
// previous anchor's end so source-order context spans map to
// source-order positions in the baseline.
//
// Why whitespace-tolerant: pdfjs splits TextRuns at glyph-positioning
// boundaries; a baseline phrase that appears in the bill as a single
// run may render with an extra space or a newline in the corpus. We
// normalize span whitespace to `\s+` in the regex so the match is
// robust to these cosmetic differences.
//
// Why lookahead for short contexts: a short context like "(c)" can
// match the baseline at many positions (subsection-heading "(c)",
// in-text references "...(b), (c), (d)...", etc.). Leftmost-at-cursor
// is wrong when the lawyer elided unchanged subsections from the bill
// PDF: the first "(c)" baseline-after-cursor lands inside an unrelated
// in-text reference list, and all inserts attached to that anchor
// dump into the wrong place. Lookahead to the next DISTINCTIVE context
// (long enough to be unambiguous) gives an upper bound; the short
// context anchors at its rightmost match before that bound.

import type { Anchor } from "@/types";
import type { ClassifiedSpan } from "./classify-spans";

export type AnchorMap = ReadonlyMap<number, Anchor>;

/**
 * Minimum length (chars, after trim) for a context span to anchor.
 * Single-character spans like "F" or "." match the first occurrence of
 * that glyph after the cursor; in real bills that occurrence is almost
 * never the right one (e.g. the "F" in "Ffireworks" classified as
 * context anchors to the "F" in "Francisco" 50 chars later, dragging
 * every subsequent delete past the end of the actual edit zone). Short
 * stopwords ("or", "to", "of") have the same problem at higher
 * cardinality. Three characters is the smallest threshold that filters
 * the glyph-level false matches without dropping useful anchors.
 */
const MIN_ANCHOR_LENGTH = 3;

/**
 * A context span is "distinctive" when its trimmed text is at least
 * this long. Distinctive anchors use leftmost-at-cursor directly; short
 * anchors look ahead to the next distinctive anchor and pick their
 * rightmost match before that bound. Eight chars is short enough that
 * most subsection-heading runs and short phrases qualify, but long
 * enough that a distinctive anchor's leftmost match is reliably the
 * intended one.
 */
const DISTINCTIVE_ANCHOR_LENGTH = 8;

/**
 * Build a map from each context span's `source_index` to the baseline
 * char range it occupies. Spans that fail to match (no occurrence at or
 * after the monotone cursor) are absent from the map; consumers handle
 * the missing-anchor case (typically: degrade to a wholesale rewrite or
 * leave the surrounding edit unpositioned).
 *
 * Non-context spans (insert / delete / elision / ambiguous) are skipped
 * entirely — only context spans serve as anchors. Pure-whitespace
 * context spans are also skipped because they carry no positioning
 * signal.
 */
export function anchorContextSpansToBaseline(
  spans: readonly ClassifiedSpan[],
  baseline: string,
): AnchorMap {
  const anchorable: ClassifiedSpan[] = [];
  for (const s of spans) {
    if (s.kind !== "context") continue;
    if (s.text.trim().length < MIN_ANCHOR_LENGTH) continue;
    anchorable.push(s);
  }

  const anchors = new Map<number, Anchor>();
  let cursor = 0;
  for (let i = 0; i < anchorable.length; i++) {
    const span = anchorable[i];
    if (span === undefined) continue;
    const matches = findMatches(span.text, baseline, cursor);
    const leftmost = matches[0];
    if (leftmost === undefined) continue;

    const isDistinctive = span.text.trim().length >= DISTINCTIVE_ANCHOR_LENGTH;
    // Look ahead to the next distinctive anchor; if one exists, this
    // short context anchors at its rightmost match before that bound
    // (subsection-heading case). Without a distinctive successor we
    // can't disambiguate, so fall back to leftmost — the conservative
    // monotone choice.
    let chosen = leftmost;
    if (!isDistinctive && matches.length > 1) {
      const bound = nextDistinctiveAnchor(anchorable, i + 1, baseline, cursor);
      if (bound !== null) {
        const inWindow = matches.filter((m) => m.offset + m.length <= bound);
        const rightmost = inWindow[inWindow.length - 1];
        if (rightmost !== undefined) chosen = rightmost;
      }
    }

    anchors.set(span.source_index, {
      baseline_offset: chosen.offset,
      baseline_length: chosen.length,
    });
    cursor = chosen.offset + chosen.length;
  }
  return anchors;
}

/**
 * Find every baseline position at or after `cursor` where `text` matches
 * under the whitespace-tolerant rule. Returns matches in left-to-right
 * order. Uses sticky scanning to avoid re-running the regex per call.
 */
function findMatches(
  text: string,
  baseline: string,
  cursor: number,
): Array<{ offset: number; length: number }> {
  const pattern = escapeRegex(text).replace(/\s+/g, "\\s+");
  const re = new RegExp(pattern, "g");
  re.lastIndex = cursor;
  const out: Array<{ offset: number; length: number }> = [];
  while (true) {
    const m = re.exec(baseline);
    if (m === null) break;
    out.push({ offset: m.index, length: m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/**
 * Leftmost baseline position at or after `cursor` of any anchorable
 * span at or after index `from` whose trimmed text is at least
 * DISTINCTIVE_ANCHOR_LENGTH. Returns `null` when no upcoming distinctive
 * span has a baseline match — the caller treats that as "no upper
 * bound" and falls back to leftmost.
 *
 * Computed against the cursor (not against any tentative anchor of the
 * current span) so the result doesn't depend on which candidate we
 * eventually pick. The cursor is monotone, so this bound is a valid
 * upper limit for any match the current short span could choose.
 */
function nextDistinctiveAnchor(
  anchorable: readonly ClassifiedSpan[],
  from: number,
  baseline: string,
  cursor: number,
): number | null {
  for (let j = from; j < anchorable.length; j++) {
    const next = anchorable[j];
    if (next === undefined) continue;
    if (next.text.trim().length < DISTINCTIVE_ANCHOR_LENGTH) continue;
    const first = findMatches(next.text, baseline, cursor)[0];
    if (first === undefined) continue;
    return first.offset;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
