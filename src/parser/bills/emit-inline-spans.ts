// Walk classified spans in source order, emitting positioned
// TextDiffSpan[] for the renderer. Context spans land at their anchor
// positions; delete spans land at the running cursor (the end of the
// preceding context anchor, after skipping whitespace); insert spans
// land at the running cursor with zero baseline consumption.
//
// This is the new diff-emission core: it replaces the old
// diffAgainstBaseline path that re-derived the diff via `diffWords`.
// The classification already labels every word's kind; this function
// just records where each label belongs in baseline coordinates so the
// renderer can lay the overlay out.

import type { SectionId, TextDiffSpan } from "@/types";
import type { AnchorMap } from "./anchor-context";
import type { ClassifiedSpan } from "./classify-spans";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Bare subsection labels like "(a)", "(b)", "(1)", "(i)" mark paragraph
// boundaries inside the bill body. The PDF visually separates them with
// real line breaks, but the per-run TextDiff stream collapses to inline.
// When an insert span carries only a label, prepend a newline so the
// renderer splits the overlay at that point.
const SUBSECTION_LABEL_RE = /^\([A-Za-z0-9]+\)$/;

/**
 * Emit TextDiffSpan[] for the renderer from classified spans + a
 * context-anchor map. The anchor map comes from
 * `anchorContextSpansToBaseline`; spans with no anchor (failed match)
 * are skipped, so a surrounding delete or insert positions at the
 * preceding successful anchor's end.
 *
 * Caller invariants:
 *   • spans are in source order
 *   • `anchors` is keyed by source_index over the same input
 *   • ambiguous-kind spans were rejected upstream (the inline path's
 *     classification_low_confidence gate); this function does not
 *     handle them
 */
export function emitInlineSpans(
  spans: readonly ClassifiedSpan[],
  anchors: AnchorMap,
  baseline: string,
  sectionId: SectionId,
): TextDiffSpan[] {
  const out: TextDiffSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.kind === "context") {
      const a = anchors.get(span.source_index);
      if (a !== undefined) {
        out.push({
          op: "context",
          text: span.text,
          section_id: sectionId,
          anchor: { baseline_offset: a.baseline_offset, baseline_length: a.baseline_length },
        });
        cursor = a.baseline_offset + a.baseline_length;
        continue;
      }
      // No anchor: drop content context (its words are either already
      // in the baseline gap-fill or weren't meaningful prose), but
      // emit pure-whitespace runs as zero-length glue so adjacent
      // inserts render with the bill's spacing in between ("(a)
      // Definition" instead of "(a)Definition"). Non-whitespace
      // unanchored text would duplicate against the renderer's gap-
      // fill from baseline, so it stays dropped.
      if (out.length > 0 && /^\s+$/.test(span.text)) {
        out.push({
          op: "context",
          text: span.text,
          section_id: sectionId,
          anchor: { baseline_offset: cursor, baseline_length: 0 },
        });
      }
    } else if (span.kind === "delete") {
      // Position deletes by substring-searching the baseline starting
      // at the running cursor, just like contexts. This is necessary
      // because some surrounding context spans may have failed to
      // anchor (the bill's text drifted, the context was too short to
      // anchor safely, etc.), leaving the cursor short of where the
      // struck baseline word actually lives. Without the search the
      // renderer would slice the wrong byte range out of baseline and
      // strike unrelated words.
      const pattern = escapeRegex(span.text).replace(/\s+/g, "\\s+");
      const re = new RegExp(pattern);
      const match = re.exec(baseline.slice(cursor));
      if (match !== null) {
        const offset = cursor + match.index;
        const length = match[0].length;
        out.push({
          op: "delete",
          text: span.text,
          section_id: sectionId,
          anchor: { baseline_offset: offset, baseline_length: length },
        });
        cursor = offset + length;
      } else {
        // No baseline match: emit a span carrying the bill's struck
        // text verbatim with length 0 so the renderer can show it
        // struck without slicing the wrong baseline region.
        out.push({
          op: "delete",
          text: span.text,
          section_id: sectionId,
          anchor: { baseline_offset: cursor, baseline_length: 0 },
        });
      }
    } else if (span.kind === "insert") {
      // Skip leading whitespace at the cursor so the insert lands on
      // the next non-whitespace boundary (the inter-anchor whitespace
      // belongs to the gap, not the new content).
      while (cursor < baseline.length && /\s/.test(baseline[cursor]!)) cursor++;
      const text =
        out.length > 0 && SUBSECTION_LABEL_RE.test(span.text) ? `\n${span.text}` : span.text;
      out.push({
        op: "insert",
        text,
        section_id: sectionId,
        anchor: { baseline_offset: cursor, baseline_length: 0 },
      });
    }
    // elision spans are intentionally skipped — the bill's "* * * *"
    // sentinel marks "unchanged baseline omitted here." Skipping it lets
    // the renderer's gap-fill emit the actual baseline content from the
    // preceding context anchor's end to the next anchor's start, so the
    // reader sees the full section text with edits overlaid in place.
  }
  return out;
}
