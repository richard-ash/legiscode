import { describe, expect, it } from "vitest";
import type { AnchorMap } from "@/parser/bills/anchor-context";
import { anchorContextSpansToBaseline } from "@/parser/bills/anchor-context";
import type { ClassifiedSpan } from "@/parser/bills/classify-spans";
import { emitInlineSpans } from "@/parser/bills/emit-inline-spans";
import type { Anchor, SectionId } from "@/types";

function span(over: Partial<ClassifiedSpan>): ClassifiedSpan {
  return { page: 1, text: "", kind: "context", source_index: 0, ...over };
}

const SID = "test-section" as SectionId;

describe("emitInlineSpans", () => {
  it("emits a single context span with the anchor's offset and length", () => {
    const baseline = "The committee meets quarterly.";
    const spans = [span({ kind: "context", text: baseline, source_index: 0 })];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      op: "context",
      text: baseline,
      section_id: SID,
      anchor: { baseline_offset: 0, baseline_length: baseline.length },
    });
  });

  it("positions a delete span at the preceding context's end with span-text length", () => {
    const baseline = "The Advisory committee shall meet.";
    const spans = [
      span({ kind: "context", text: "The ", source_index: 0 }),
      span({ kind: "delete", text: "Advisory ", source_index: 1 }),
      span({ kind: "context", text: "committee shall meet.", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    const del = out.find((s) => s.op === "delete");
    expect(del).toBeDefined();
    expect(del!.anchor.baseline_offset).toBe(4);
    expect(del!.anchor.baseline_length).toBe("Advisory ".length);
    expect(
      baseline.slice(
        del!.anchor.baseline_offset,
        del!.anchor.baseline_offset + del!.anchor.baseline_length,
      ),
    ).toBe("Advisory ");
  });

  it("positions an insert span at the preceding context's end with baseline_length 0", () => {
    // baseline has "committee" at offset 4; the bill inserts "Advisory "
    // before "committee".
    const baseline = "The committee shall meet.";
    const spans = [
      span({ kind: "context", text: "The ", source_index: 0 }),
      span({ kind: "insert", text: "Advisory ", source_index: 1 }),
      span({ kind: "context", text: "committee shall meet.", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    const ins = out.find((s) => s.op === "insert");
    expect(ins).toBeDefined();
    expect(ins!.anchor.baseline_offset).toBe(4);
    expect(ins!.anchor.baseline_length).toBe(0);
    expect(ins!.text).toBe("Advisory ");
  });

  it("delete + insert in source order both land between their surrounding contexts", () => {
    const baseline = "The Advisory Committee shall provide input.";
    const spans = [
      span({ kind: "context", text: "The Advisory ", source_index: 0 }),
      span({ kind: "delete", text: "Committee ", source_index: 1 }),
      span({ kind: "insert", text: "Council ", source_index: 2 }),
      span({ kind: "context", text: "shall provide input.", source_index: 3 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    const del = out.find((s) => s.op === "delete");
    const ins = out.find((s) => s.op === "insert");
    expect(del?.anchor.baseline_offset).toBe(13);
    expect(del?.anchor.baseline_length).toBe("Committee ".length);
    expect(ins?.anchor.baseline_offset).toBe(13 + "Committee ".length);
    expect(ins?.anchor.baseline_length).toBe(0);
  });

  it("elision spans are skipped (no entry in the output)", () => {
    const baseline = "alpha beta gamma";
    const spans = [
      span({ kind: "context", text: "alpha", source_index: 0 }),
      span({ kind: "elision", text: "* * *", source_index: 1 }),
      span({ kind: "context", text: "gamma", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    expect(out.every((s) => s.op !== "elision")).toBe(true);
  });

  it("drops non-whitespace context spans that fail to anchor (avoids duplication with baseline gap-fill)", () => {
    // The renderer fills gaps between anchors from baseline text. If a
    // failed-anchor context carried real prose, emitting it inline
    // would duplicate it once from the inline glue and once from the
    // gap-fill. Drop the non-whitespace failed-anchor context entirely.
    const baseline = "alpha beta gamma";
    const spans = [
      span({ kind: "context", text: "alpha", source_index: 0 }),
      span({ kind: "context", text: "zulu", source_index: 1 }), // not in baseline
      span({ kind: "context", text: "gamma", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.text)).toEqual(["alpha", "gamma"]);
  });

  it("emits pure-whitespace context between adjacent inserts as zero-length inline glue", () => {
    // The bill PDF's visual " " between two underlined words is a
    // whitespace context run that won't anchor. Emit it at the cursor
    // with length 0 so the renderer keeps adjacent inserts separated
    // visually.
    const baseline = "alpha";
    const spans = [
      span({ kind: "insert", text: "(a)", source_index: 0 }),
      span({ kind: "context", text: " ", source_index: 1 }),
      span({ kind: "insert", text: "Definition", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    expect(out.map((s) => ({ op: s.op, text: s.text }))).toEqual([
      { op: "insert", text: "(a)" },
      { op: "context", text: " " },
      { op: "insert", text: "Definition" },
    ]);
    expect(out[1]!.anchor.baseline_length).toBe(0);
  });

  it("skips leading whitespace when positioning a delete (the gap is context, not deletion)", () => {
    // Context "shall" anchors at (0, 5). Baseline has "shall corporation"
    // — there's a space between "shall" and "corporation". The delete
    // should land at offset 6 (on "c"), not offset 5 (on the space).
    const baseline = "shall corporation or association";
    const spans = [
      span({ kind: "context", text: "shall", source_index: 0 }),
      span({ kind: "delete", text: "corporation", source_index: 1 }),
      span({ kind: "context", text: "or association", source_index: 2 }),
    ];
    const anchors = anchorContextSpansToBaseline(spans, baseline);
    const out = emitInlineSpans(spans, anchors, baseline, SID);
    const del = out.find((s) => s.op === "delete");
    expect(del?.anchor.baseline_offset).toBe(6);
    expect(
      baseline.slice(
        del!.anchor.baseline_offset,
        del!.anchor.baseline_offset + del!.anchor.baseline_length,
      ),
    ).toBe("corporation");
  });

  it("renders fully from baseline when given empty inputs", () => {
    const anchors: AnchorMap = new Map<number, Anchor>();
    const out = emitInlineSpans([], anchors, "anything", SID);
    expect(out).toEqual([]);
  });
});
