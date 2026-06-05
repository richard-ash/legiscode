import { describe, expect, it } from "vitest";
import { anchorContextSpansToBaseline } from "@/parser/bills/anchor-context";
import type { ClassifiedSpan } from "@/parser/bills/classify-spans";

function span(over: Partial<ClassifiedSpan>): ClassifiedSpan {
  return { page: 1, text: "", kind: "context", source_index: 0, ...over };
}

describe("anchorContextSpansToBaseline", () => {
  it("returns an anchor at the substring offset for a single context span", () => {
    const baseline = "The committee shall meet quarterly.";
    const spans = [span({ kind: "context", text: "committee", source_index: 0 })];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    expect(anchors.get(0)).toEqual({ baseline_offset: 4, baseline_length: 9 });
  });

  it("returns no anchor for non-context spans", () => {
    const baseline = "No person shall conduct shadow analysis.";
    const spans = [
      span({ kind: "delete", text: "shadow analysis", source_index: 0 }),
      span({ kind: "insert", text: "environmental review", source_index: 1 }),
      span({ kind: "elision", text: "* * *", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    expect(anchors.size).toBe(0);
  });

  it("skips pure-whitespace context spans (no positioning signal)", () => {
    const baseline = "alpha beta gamma";
    const spans = [
      span({ kind: "context", text: "alpha", source_index: 0 }),
      span({ kind: "context", text: " ", source_index: 1 }),
      span({ kind: "context", text: "beta", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    expect(anchors.has(0)).toBe(true);
    expect(anchors.has(1)).toBe(false);
    expect(anchors.has(2)).toBe(true);
  });

  it("monotone constraint — each anchor starts at or after the previous one's end", () => {
    // "person" appears twice in baseline; the second context span's
    // anchor must be the SECOND occurrence even though the first
    // occurrence would otherwise be the leftmost match.
    const baseline = "No person shall make any person eligible.";
    const spans = [
      span({ kind: "context", text: "No person shall make any", source_index: 0 }),
      span({ kind: "context", text: "person eligible.", source_index: 1 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const a0 = anchors.get(0);
    const a1 = anchors.get(1);
    expect(a0).toBeDefined();
    expect(a1).toBeDefined();
    expect(a1!.baseline_offset).toBeGreaterThanOrEqual(a0!.baseline_offset + a0!.baseline_length);
  });

  it("whitespace-tolerant — \\n and double spaces in baseline match a span with single spaces", () => {
    const baseline = "First paragraph.\n\nSecond  paragraph.";
    const spans = [
      span({ kind: "context", text: "First paragraph. Second paragraph.", source_index: 0 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const a = anchors.get(0);
    expect(a).toBeDefined();
    expect(a!.baseline_offset).toBe(0);
    expect(a!.baseline_length).toBe(baseline.length);
  });

  it("returns no anchor when the context text does not appear at or after the cursor", () => {
    // Anchor for "alpha" lands at 0; "zulu" is not in baseline → no anchor for span 1.
    const baseline = "alpha beta gamma";
    const spans = [
      span({ kind: "context", text: "alpha", source_index: 0 }),
      span({ kind: "context", text: "zulu", source_index: 1 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    expect(anchors.has(0)).toBe(true);
    expect(anchors.has(1)).toBe(false);
  });

  it("escapes regex metacharacters in span text so '.' and '(' match literally", () => {
    const baseline = "Section 31.02 (a) governs notice.";
    const spans = [span({ kind: "context", text: "31.02 (a)", source_index: 0 })];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const a = anchors.get(0);
    expect(a).toBeDefined();
    expect(baseline.slice(a!.baseline_offset, a!.baseline_offset + a!.baseline_length)).toBe(
      "31.02 (a)",
    );
  });

  it("short context with multiple matches picks rightmost before the next distinctive anchor", () => {
    // The §206.10 (bill 260542) shape: an elided bill PDF leaves a
    // short "(c)" subsection-heading context with no neighbors between
    // the prior (a) deletes and the next distinctive context. Baseline
    // has the same "(c)" string repeated in an in-text reference list
    // (...(b), (c), (d)...) AND at the subsection (c) heading. The
    // anchor must be the LATTER (subsection heading), not the former.
    const baseline = "(a) Purpose...(b) items including (c), (d), (e); and (c) Inclusionary Housing.";
    const spans = [
      span({ kind: "context", text: "(a)", source_index: 0 }),
      span({ kind: "context", text: "(c)", source_index: 1 }),
      span({ kind: "context", text: "Inclusionary Housing", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const cAnchor = anchors.get(1);
    const inclAnchor = anchors.get(2);
    expect(cAnchor).toBeDefined();
    expect(inclAnchor).toBeDefined();
    // "(c)" must land at the subsection heading — the LAST "(c)" before
    // the distinctive "Inclusionary Housing" anchor — not the first
    // in-text reference.
    expect(baseline.slice(cAnchor!.baseline_offset, cAnchor!.baseline_offset + cAnchor!.baseline_length)).toBe("(c)");
    expect(cAnchor!.baseline_offset).toBeLessThan(inclAnchor!.baseline_offset);
    expect(inclAnchor!.baseline_offset - cAnchor!.baseline_offset).toBeLessThan(10);
  });

  it("short context falls back to leftmost when no distinctive anchor follows", () => {
    // With no distinctive lookahead bound, the short anchor takes the
    // first match — preserves the prior single-pass behavior for the
    // simple case.
    const baseline = "(a) one (a) two (a) three";
    const spans = [span({ kind: "context", text: "(a)", source_index: 0 })];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    expect(anchors.get(0)).toEqual({ baseline_offset: 0, baseline_length: 3 });
  });

  it("respects monotone cursor — a context span before the cursor is skipped, not back-matched", () => {
    // "shall" appears at offset 10 in baseline. After anchoring "regulate
    // commerce" at offset 30, a subsequent "shall" context can ONLY be
    // matched at offset >= 44 (post-cursor); since baseline has no second
    // "shall", no anchor is returned.
    const baseline = "The Board shall regulate commerce within the City.";
    const spans = [
      span({ kind: "context", text: "regulate commerce within", source_index: 0 }),
      span({ kind: "context", text: "shall", source_index: 1 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    expect(anchors.has(0)).toBe(true);
    expect(anchors.has(1)).toBe(false);
  });
});
