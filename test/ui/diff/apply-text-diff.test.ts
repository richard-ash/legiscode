import { describe, expect, it } from "vitest";
import type { TextDiff, TextDiffSpan } from "@/types";
import {
  applyToBaseline,
  reconstructCorpusAligned,
  reconstructInline,
  reconstructStatedSource,
} from "@/ui/diff/apply-text-diff";

function span(over: Partial<TextDiffSpan>): TextDiffSpan {
  return {
    op: "context",
    text: "x",
    section_id: "1.1",
    anchor: { baseline_offset: 0, baseline_length: 0 },
    ...over,
  } as TextDiffSpan;
}

describe("reconstructStatedSource", () => {
  it("walks spans in source order, ignoring anchors", () => {
    const spans: TextDiff = [
      span({ op: "context", text: "The " }),
      span({ op: "delete", text: "old" }),
      span({ op: "insert", text: "new" }),
      span({ op: "context", text: " law." }),
    ];
    const { before, after } = reconstructStatedSource(spans);
    expect(before.map((c) => c.text).join("")).toBe("The old law.");
    expect(after.map((c) => c.text).join("")).toBe("The new law.");
  });

  it("emits elision sentinels on both panes", () => {
    const spans: TextDiff = [
      span({ op: "context", text: "Part 1." }),
      span({ op: "elision", text: "*" }),
      span({ op: "context", text: "Part 2." }),
    ];
    const { before, after } = reconstructStatedSource(spans);
    expect(before.map((c) => c.kind)).toEqual(["context", "elision", "context"]);
    expect(after.map((c) => c.kind)).toEqual(["context", "elision", "context"]);
  });

  it("excludes inserts from before and deletes from after", () => {
    const spans: TextDiff = [
      span({ op: "delete", text: "old" }),
      span({ op: "insert", text: "new" }),
    ];
    const { before, after } = reconstructStatedSource(spans);
    expect(before.map((c) => c.kind)).toEqual(["delete"]);
    expect(after.map((c) => c.kind)).toEqual(["insert"]);
  });

  it("returns empty pairs for empty input", () => {
    const { before, after } = reconstructStatedSource([]);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
  });
});

describe("reconstructCorpusAligned", () => {
  const baseline = "The Advisory Committee shall provide input.";
  //              0123456789012345678901234567890123456789012
  // tokens:      |  4         |             |        |
  //              The(0,3) Advisory(4,8) Committee(13,9) shall(23,5) provide(29,7) input(37,5).

  it("returns the baseline as a single context chunk on both sides when spans is empty", () => {
    const result = reconstructCorpusAligned([], baseline);
    expect(result.before).toEqual([{ kind: "context", text: baseline }]);
    expect(result.after).toEqual([{ kind: "context", text: baseline }]);
  });

  it("emits delete + insert at their anchor positions", () => {
    const spans: TextDiff = [
      span({
        op: "delete",
        text: "Committee",
        anchor: { baseline_offset: 13, baseline_length: 9 },
      }),
      span({
        op: "insert",
        text: "Council",
        anchor: { baseline_offset: 13, baseline_length: 0 },
      }),
    ];
    const { before, after } = reconstructCorpusAligned(spans, baseline);
    // BEFORE has the leading 13 chars as context, then "Committee" as delete,
    // then the trailing baseline as context.
    const beforeText = before.map((c) => c.text).join("");
    expect(beforeText).toBe(baseline);
    // AFTER: leading context, "Council" as insert, then trailing context
    // (the delete slice is excluded so AFTER reads as the law would).
    const afterText = after.map((c) => c.text).join("");
    expect(afterText).toBe("The Advisory Council shall provide input.");
    // Insert chunk is present
    const insertChunks = after.filter((c) => c.kind === "insert");
    expect(insertChunks).toEqual([{ kind: "insert", text: "Council" }]);
  });

  it("emits trailing baseline as context after the last anchor", () => {
    const spans: TextDiff = [
      span({
        op: "context",
        text: "The Advisory",
        anchor: { baseline_offset: 0, baseline_length: 12 },
      }),
    ];
    const { before, after } = reconstructCorpusAligned(spans, baseline);
    expect(before.map((c) => c.text).join("")).toBe(baseline);
    expect(after.map((c) => c.text).join("")).toBe(baseline);
  });

  it("sorts overlapping inserts after deletes at the same offset", () => {
    const spans: TextDiff = [
      span({
        op: "insert",
        text: "new",
        anchor: { baseline_offset: 13, baseline_length: 0 },
      }),
      span({
        op: "delete",
        text: "Committee",
        anchor: { baseline_offset: 13, baseline_length: 9 },
      }),
    ];
    const { after } = reconstructCorpusAligned(spans, baseline);
    // Delete consumes "Committee" (off the AFTER side), insert "new"
    // splices in at offset 13.
    expect(after.map((c) => c.text).join("")).toBe("The Advisory new shall provide input.");
  });
});

describe("reconstructInline", () => {
  const baseline = "The Advisory Committee shall provide input.";

  it("returns the baseline as a single text segment when spans is empty", () => {
    expect(reconstructInline([], baseline)).toEqual([{ kind: "text", text: baseline }]);
  });

  it("returns an empty stream when baseline AND spans are empty", () => {
    expect(reconstructInline([], "")).toEqual([]);
  });

  it("interleaves text, diff_delete, and diff_insert in baseline order", () => {
    const spans: TextDiff = [
      span({
        op: "delete",
        text: "Committee",
        anchor: { baseline_offset: 13, baseline_length: 9 },
      }),
      span({
        op: "insert",
        text: "Council",
        anchor: { baseline_offset: 13, baseline_length: 0 },
      }),
    ];
    const out = reconstructInline(spans, baseline);
    expect(out).toEqual([
      { kind: "text", text: "The Advisory " },
      { kind: "diff_delete", text: "Committee" },
      { kind: "diff_insert", text: "Council" },
      { kind: "text", text: " shall provide input." },
    ]);
  });

  it("renders a wholesale-delete span as a single diff_delete covering the baseline", () => {
    const spans: TextDiff = [
      span({
        op: "delete",
        text: baseline,
        anchor: { baseline_offset: 0, baseline_length: baseline.length },
      }),
    ];
    expect(reconstructInline(spans, baseline)).toEqual([{ kind: "diff_delete", text: baseline }]);
  });

  it("renders a wholesale-add span as a single diff_insert when baseline is empty", () => {
    const added = "Newly added section text.";
    const spans: TextDiff = [
      span({
        op: "insert",
        text: added,
        anchor: { baseline_offset: 0, baseline_length: 0 },
      }),
    ];
    expect(reconstructInline(spans, "")).toEqual([{ kind: "diff_insert", text: added }]);
  });

  it("orders diff_insert AFTER diff_delete at the same baseline offset", () => {
    const spans: TextDiff = [
      span({
        op: "insert",
        text: "new",
        anchor: { baseline_offset: 13, baseline_length: 0 },
      }),
      span({
        op: "delete",
        text: "Committee",
        anchor: { baseline_offset: 13, baseline_length: 9 },
      }),
    ];
    const out = reconstructInline(spans, baseline);
    expect(out.map((c) => c.kind)).toEqual(["text", "diff_delete", "diff_insert", "text"]);
  });

  it("passes elision spans through with no baseline consumption", () => {
    const spans: TextDiff = [
      span({
        op: "elision",
        text: "*",
        anchor: { baseline_offset: 22, baseline_length: 0 },
      }),
    ];
    const out = reconstructInline(spans, baseline);
    // gap before elision becomes text; elision in place; tail becomes text
    expect(out.map((c) => c.kind)).toEqual(["text", "diff_elision", "text"]);
  });

  it("splits embedded newlines into paragraph_break markers", () => {
    // Baseline carries a real paragraph boundary; reconstructInline emits
    // a paragraph_break so splitParagraphs lays the result out across two
    // <p> elements at render time.
    const para = "First paragraph.\nSecond paragraph.";
    expect(reconstructInline([], para)).toEqual([
      { kind: "text", text: "First paragraph." },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second paragraph." },
    ]);
  });

  it("splits a multi-paragraph delete span into one diff_delete per paragraph", () => {
    // Whole-paragraph delete that crosses a paragraph_break boundary —
    // we want one struck run per paragraph, not a single run carrying
    // the newline character into the rendered span.
    const para = "P1.\nP2.";
    const spans: TextDiff = [
      span({
        op: "delete",
        text: para,
        anchor: { baseline_offset: 0, baseline_length: para.length },
      }),
    ];
    expect(reconstructInline(spans, para)).toEqual([
      { kind: "diff_delete", text: "P1." },
      { kind: "paragraph_break" },
      { kind: "diff_delete", text: "P2." },
    ]);
  });

  it("returns the baseline unchanged when any anchor is out of bounds (defensive)", () => {
    const spans: TextDiff = [
      span({
        op: "delete",
        text: "x",
        anchor: { baseline_offset: 1000, baseline_length: 50 },
      }),
    ];
    expect(reconstructInline(spans, baseline)).toEqual([{ kind: "text", text: baseline }]);
  });
});

describe("applyToBaseline", () => {
  const baseline = "The Advisory Committee shall provide input.";

  it("returns the baseline unchanged when spans is empty", () => {
    expect(applyToBaseline([], baseline)).toBe(baseline);
  });

  it("excises a delete and splices in an insert at the same offset", () => {
    const spans: TextDiff = [
      span({
        op: "delete",
        text: "Committee",
        anchor: { baseline_offset: 13, baseline_length: 9 },
      }),
      span({
        op: "insert",
        text: "Council",
        anchor: { baseline_offset: 13, baseline_length: 0 },
      }),
    ];
    const result = applyToBaseline(spans, baseline);
    expect(result).toBe("The Advisory Council shall provide input.");
  });

  it("handles non-overlapping inserts at multiple offsets in reverse order", () => {
    const spans: TextDiff = [
      span({
        op: "insert",
        text: "X ",
        anchor: { baseline_offset: 0, baseline_length: 0 },
      }),
      span({
        op: "insert",
        text: " Y",
        anchor: { baseline_offset: 22, baseline_length: 0 },
      }),
    ];
    const result = applyToBaseline(spans, baseline);
    expect(result).toBe("X The Advisory Committee Y shall provide input.");
  });

  it("treats context spans as anchor checkpoints (no mutation)", () => {
    const spans: TextDiff = [
      span({
        op: "context",
        text: "Advisory",
        anchor: { baseline_offset: 4, baseline_length: 8 },
      }),
    ];
    expect(applyToBaseline(spans, baseline)).toBe(baseline);
  });

  it("returns the baseline unchanged when any anchor points past the end (defensive)", () => {
    // Bad input: anchor offset + length > baseline.length. Real users
    // hit this when a corpus reload mid-render shrinks the baseline
    // under an already-rendered diff tab. Better to show the stale
    // baseline than slice garbage out of it.
    const spans: TextDiff = [
      span({
        op: "delete",
        text: "x",
        anchor: { baseline_offset: 1000, baseline_length: 50 },
      }),
    ];
    expect(applyToBaseline(spans, baseline)).toBe(baseline);
  });

  it("elision spans are no-ops on the baseline (wildcard length 0)", () => {
    const spans: TextDiff = [
      span({
        op: "elision",
        text: "*",
        anchor: { baseline_offset: 22, baseline_length: 0 },
      }),
    ];
    expect(applyToBaseline(spans, baseline)).toBe(baseline);
  });
});
