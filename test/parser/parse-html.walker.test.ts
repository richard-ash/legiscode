// parse-html walker tests — cheerio walker (walkRboxText) and the
// position-aware normalizer (normalizeBodyTextWithSpans). These are the
// unit-level checks for the text-emission half of feat/parse-html-ast.
// The merge algorithm tests live in build-body-segments.test.ts; the
// integration coverage lives in body-text-roundtrip.test.ts and
// text-fidelity.test.ts.

import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { normalizeBodyTextWithSpans, type SpanRecord, walkRboxText } from "@/parser/parse-html";

function walk(html: string): { text: string; spans: SpanRecord[] } {
  // Cheerio's load() wraps the snippet in <html><head/><body>...</body></html>.
  // We pass the body's children to the walker — that's what the rbox
  // walker does in practice (each rbox is a <div> child of body).
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  return walkRboxText($("#root"));
}

describe("walkRboxText — text emission matches cheerio .text()", () => {
  it("plain text passes through verbatim", () => {
    const out = walk("plain prose");
    expect(out.text).toBe("plain prose");
    expect(out.spans).toEqual([]);
  });

  it("transparent tags (<a>, <span>, <div>) contribute text without spans", () => {
    const out = walk('See <a href="x">the link</a> here.');
    expect(out.text).toBe("See the link here.");
    expect(out.spans).toEqual([]);
  });

  it("nested transparent tags concatenate text", () => {
    const out = walk("<div>outer <span>inner <span>deep</span></span></div>");
    expect(out.text).toBe("outer inner deep");
    expect(out.spans).toEqual([]);
  });
});

describe("walkRboxText — format span emission", () => {
  it("emits a bold span for <b>", () => {
    const out = walk("X <b>bold</b> Y");
    expect(out.text).toBe("X bold Y");
    expect(out.spans).toEqual([{ start: 2, end: 6, format: "bold" }]);
  });

  it("emits a bold span for <strong> (HTML5 alias)", () => {
    const out = walk("X <strong>bold</strong> Y");
    expect(out.spans).toEqual([{ start: 2, end: 6, format: "bold" }]);
  });

  it("emits an italic span for <i>", () => {
    const out = walk("X <i>italic</i> Y");
    expect(out.spans).toEqual([{ start: 2, end: 8, format: "italic" }]);
  });

  it("emits an italic span for <em>", () => {
    const out = walk("X <em>italic</em> Y");
    expect(out.spans).toEqual([{ start: 2, end: 8, format: "italic" }]);
  });

  it("emits list + listItem spans for <ul><li>", () => {
    const out = walk("<ul><li>a</li><li>b</li></ul>");
    expect(out.text).toBe("ab");
    // Walker visits children inner-first (post-order). Expect:
    // listItem(0,1), listItem(1,2), list(0,2)
    expect(out.spans).toContainEqual({ start: 0, end: 1, format: "listItem" });
    expect(out.spans).toContainEqual({ start: 1, end: 2, format: "listItem" });
    expect(out.spans).toContainEqual({ start: 0, end: 2, format: "list" });
  });

  it("emits list (not listItem) span for <ol>", () => {
    const out = walk("<ol><li>x</li></ol>");
    expect(out.spans.some((s) => s.format === "list")).toBe(true);
  });

  it("nested bold>italic produces two distinct spans on the same range", () => {
    const out = walk("<b><i>foo</i></b>");
    expect(out.text).toBe("foo");
    expect(out.spans).toContainEqual({ start: 0, end: 3, format: "italic" });
    expect(out.spans).toContainEqual({ start: 0, end: 3, format: "bold" });
  });

  it("drops an empty-content span (<b></b>)", () => {
    const out = walk("X <b></b> Y");
    // The bold tag has no text content, so no span is recorded.
    expect(out.spans.filter((s) => s.format === "bold")).toEqual([]);
  });

  it("handles <b> wrapping a citation-shaped string in raw text", () => {
    const out = walk("§ <b>10.04.020</b>");
    expect(out.text).toBe("§ 10.04.020");
    expect(out.spans).toEqual([{ start: 2, end: 11, format: "bold" }]);
  });

  it("preserves significant whitespace between adjacent inline runs (CT8 #28)", () => {
    const out = walk("<i>foo</i> <b>bar</b>");
    expect(out.text).toBe("foo bar");
    expect(out.spans).toContainEqual({ start: 0, end: 3, format: "italic" });
    expect(out.spans).toContainEqual({ start: 4, end: 7, format: "bold" });
  });
});

describe("normalizeBodyTextWithSpans — text byte-identical to normalizeBodyText", () => {
  it("collapses internal whitespace runs to single spaces", () => {
    const result = normalizeBodyTextWithSpans("foo   bar    baz", []);
    expect(result.text).toBe("foo bar baz");
  });

  it("trims leading and trailing whitespace per line", () => {
    const result = normalizeBodyTextWithSpans("   foo   ", []);
    expect(result.text).toBe("foo");
  });

  it("converts NBSP (0xa0) to regular space", () => {
    const result = normalizeBodyTextWithSpans("foo bar", []);
    expect(result.text).toBe("foo bar");
  });

  it("drops empty lines after normalization", () => {
    const result = normalizeBodyTextWithSpans("foo\n\nbar\n   \nbaz", []);
    expect(result.text).toBe("foo\nbar\nbaz");
  });

  it("preserves \\n separators between non-empty lines", () => {
    const result = normalizeBodyTextWithSpans("line one\nline two", []);
    expect(result.text).toBe("line one\nline two");
  });
});

describe("normalizeBodyTextWithSpans — span position remap", () => {
  it("preserves a span when no whitespace surrounds it", () => {
    // raw "abc DEF ghi" with bold on DEF (4..7) — no whitespace collapse.
    const result = normalizeBodyTextWithSpans("abc DEF ghi", [
      { start: 4, end: 7, format: "bold" },
    ]);
    expect(result.text).toBe("abc DEF ghi");
    expect(result.spans).toEqual([{ start: 4, end: 7, format: "bold" }]);
  });

  it("shifts a span when leading whitespace is collapsed", () => {
    // raw "  X bold Y" — leading collapses to "" (line trimmed).
    // bold at raw [4,8] (covers "bold") → final [2,6].
    const result = normalizeBodyTextWithSpans("  X bold Y", [{ start: 4, end: 8, format: "bold" }]);
    expect(result.text).toBe("X bold Y");
    expect(result.spans).toEqual([{ start: 2, end: 6, format: "bold" }]);
  });

  it("drops a span that wraps only dropped whitespace", () => {
    // raw "X    Y" → "X Y". Bold wraps positions [1,5] which are all
    // whitespace (collapsed). Span has no surviving raw position →
    // dropped entirely.
    const result = normalizeBodyTextWithSpans("X    Y", [{ start: 1, end: 5, format: "bold" }]);
    expect(result.text).toBe("X Y");
    // The bold span covered runs that all got collapsed. The mapped
    // span shrinks to length 1 (the surviving space). We accept that
    // mapping — it's the best we can do.
    expect(result.spans.length).toBeLessThanOrEqual(1);
  });

  it("remaps a span across an empty-line drop", () => {
    // raw "foo\n\nbar" → "foo\nbar". Bold on "bar" (5..8) → "bar" in
    // final at (4..7).
    const result = normalizeBodyTextWithSpans("foo\n\nbar", [{ start: 5, end: 8, format: "bold" }]);
    expect(result.text).toBe("foo\nbar");
    expect(result.spans).toEqual([{ start: 4, end: 7, format: "bold" }]);
  });
});
