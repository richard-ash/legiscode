import { describe, expect, it } from "vitest";
import type { SectionId, TextDiffSpan } from "@/types";
import { overlayDiffOnBaseline } from "@/ui/diff/overlay";

const SID = "test" as SectionId;

function makeSpan(
  op: TextDiffSpan["op"],
  text: string,
  offset: number,
  length: number,
): TextDiffSpan {
  return {
    op,
    text,
    section_id: SID,
    anchor: { baseline_offset: offset, baseline_length: length },
  };
}

describe("overlayDiffOnBaseline", () => {
  it("returns the baseline as one text segment when no spans are given", () => {
    expect(overlayDiffOnBaseline([], "Hello world.")).toEqual([
      { kind: "text", text: "Hello world." },
    ]);
  });

  it("returns nothing when both spans and baseline are empty", () => {
    expect(overlayDiffOnBaseline([], "")).toEqual([]);
  });

  it("emits a single context segment for a verbatim reprint", () => {
    const baseline = "The committee meets quarterly.";
    const spans = [makeSpan("context", baseline, 0, baseline.length)];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([{ kind: "text", text: baseline }]);
  });

  it("interleaves context + insert + context with the insert highlighted", () => {
    const baseline = "The committee shall meet.";
    const spans = [
      makeSpan("context", "The ", 0, 4),
      makeSpan("insert", "Advisory ", 4, 0),
      makeSpan("context", "committee shall meet.", 4, 21),
    ];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([
      { kind: "text", text: "The " },
      { kind: "diff_insert", text: "Advisory " },
      { kind: "text", text: "committee shall meet." },
    ]);
  });

  it("renders a delete span by slicing the baseline at its anchor range", () => {
    const baseline = "The Advisory committee shall meet.";
    const spans = [
      makeSpan("context", "The ", 0, 4),
      makeSpan("delete", "Advisory ", 4, 9),
      makeSpan("context", "committee shall meet.", 13, 21),
    ];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([
      { kind: "text", text: "The " },
      { kind: "diff_delete", text: "Advisory " },
      { kind: "text", text: "committee shall meet." },
    ]);
  });

  it("fills the gap between non-adjacent anchors with baseline as text", () => {
    // Two context spans separated by an un-anchored baseline region;
    // the renderer fills the gap from baseline.
    const baseline = "alpha beta gamma";
    const spans = [makeSpan("context", "alpha", 0, 5), makeSpan("context", "gamma", 11, 5)];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([
      { kind: "text", text: "alpha" },
      { kind: "text", text: " beta " },
      { kind: "text", text: "gamma" },
    ]);
  });

  it("splits text segments at \\n into paragraph_break markers", () => {
    const baseline = "First.\nSecond.";
    expect(overlayDiffOnBaseline([], baseline)).toEqual([
      { kind: "text", text: "First." },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second." },
    ]);
  });

  it("splits diff_delete chunks at newlines too", () => {
    const baseline = "DEL1\nDEL2";
    const spans = [makeSpan("delete", "DEL1\nDEL2", 0, 9)];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([
      { kind: "diff_delete", text: "DEL1" },
      { kind: "paragraph_break" },
      { kind: "diff_delete", text: "DEL2" },
    ]);
  });

  it("emits a wholesale rewrite as full-baseline delete then trailing zero-length insert", () => {
    // synthesizeWholesale's classic output shape: delete the entire
    // baseline, then insert the bill's new body at the end. The two
    // spans are at different offsets (0 vs baseline.length) so they
    // sort by offset alone.
    const baseline = "old text";
    const spans = [
      makeSpan("insert", "new content", baseline.length, 0),
      makeSpan("delete", baseline, 0, baseline.length),
    ];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([
      { kind: "diff_delete", text: "old text" },
      { kind: "diff_insert", text: "new content" },
    ]);
  });

  it("preserves source order at shared baseline offsets (whitespace glue interleaved with inserts)", () => {
    // emit-inline-spans positions adjacent inserts and inline glue at
    // the same offset; the overlay must keep them in source order so
    // "(a) Definition" renders that way instead of "(a)Definition ".
    const baseline = "anything";
    const spans = [
      makeSpan("insert", "(a)", 0, 0),
      makeSpan("context", " ", 0, 0),
      makeSpan("insert", "Definition", 0, 0),
    ];
    expect(overlayDiffOnBaseline(spans, baseline)).toEqual([
      { kind: "diff_insert", text: "(a)" },
      { kind: "text", text: " " },
      { kind: "diff_insert", text: "Definition" },
      { kind: "text", text: "anything" },
    ]);
  });
});
