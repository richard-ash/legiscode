// buildBodySegments — merge algorithm unit tests.
//
// Covers the synthetic edge cases from the test plan paths 7-18 (parser
// emission) and 27-31 (codex CT8 hard cases). The function takes
// pre-extracted positions as input, so we don't need cheerio fixtures
// here — just synthetic position arrays that mimic what the upstream
// extractors would produce.

import { describe, expect, it } from "vitest";
import { buildBodySegments } from "@/parser/build-body-segments";
import type { Citation } from "@/types";

const internalCite = (display_text: string, section_id: string): Citation => ({
  display_text,
  target: { kind: "internal", section_id },
});

describe("buildBodySegments — primary annotation tiling", () => {
  it("emits a single text segment for plain text with no annotations (path 7)", () => {
    const out = buildBodySegments({
      text: "plain prose with no markup",
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([{ type: "text", text: "plain prose with no markup" }]);
  });

  it("returns [] for empty text", () => {
    const out = buildBodySegments({
      text: "",
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("emits text → citation → text for one citation match (path 8)", () => {
    const text = "See § 1.01 for details.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [
        {
          citation: internalCite("§ 1.01", "1.01"),
          start: 4,
          end: 10,
          citation_index: 0,
        },
      ],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      { type: "text", text: "See " },
      { type: "citation", raw: "§ 1.01", citation_index: 0 },
      { type: "text", text: " for details." },
    ]);
  });

  it("emits text → defined_term → text for one defined-term occurrence (path 9)", () => {
    const text = "The Person shall comply.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(["Person"]),
    });
    expect(out).toEqual([
      { type: "text", text: "The " },
      { type: "defined_term", term: "Person" },
      { type: "text", text: " shall comply." },
    ]);
  });

  it("citation > defined_term overlap drops the defined_term (path 10, CQ2)", () => {
    // Text: "see Section 1.01 ('Person')"
    // Citation matches "Section 1.01" (4..16), defined_term "Person" (19..25).
    // No overlap here — both should be emitted.
    const text = "see Section 1.01 ('Person')";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [
        {
          citation: internalCite("Section 1.01", "1.01"),
          start: 4,
          end: 16,
          citation_index: 0,
        },
      ],
      moduleDefinedTerms: new Set(["Person"]),
    });
    expect(out).toEqual([
      { type: "text", text: "see " },
      { type: "citation", raw: "Section 1.01", citation_index: 0 },
      { type: "text", text: " ('" },
      { type: "defined_term", term: "Person" },
      { type: "text", text: "')" },
    ]);
  });

  it("when citation and defined_term overlap, citation wins (path 10, true overlap)", () => {
    // Synthetic: "Person 1.01" — citation "Person 1.01" (0..11) and
    // defined_term "Person" (0..6). Citation wins, defined_term dropped.
    const text = "Person 1.01 applies";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [
        {
          citation: internalCite("Person 1.01", "1.01"),
          start: 0,
          end: 11,
          citation_index: 0,
        },
      ],
      moduleDefinedTerms: new Set(["Person"]),
    });
    // Defined-term is dropped; citation tiles 0..11.
    expect(out).toEqual([
      { type: "citation", raw: "Person 1.01", citation_index: 0 },
      { type: "text", text: " applies" },
    ]);
  });

  it("emits subsection_label at paragraph start (path 12)", () => {
    const text = "(a) The mayor shall act.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      { type: "subsection_label", label: "(a)" },
      { type: "text", text: " The mayor shall act." },
    ]);
  });

  it("does NOT emit subsection_label mid-paragraph (path 13)", () => {
    const text = "See option (a) of the rule.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([{ type: "text", text: "See option (a) of the rule." }]);
  });

  it("emits subsection_label after a paragraph_break (path 12, multi-paragraph)", () => {
    // \n triggers paragraph-break detection. The label after \n should
    // count as paragraph-start.
    const text = "First paragraph.\n(b) The next subsection.";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 16, end: 17, format: "paragraph_break" }],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      { type: "text", text: "First paragraph." },
      { type: "paragraph_break" },
      { type: "subsection_label", label: "(b)" },
      { type: "text", text: " The next subsection." },
    ]);
  });
});

describe("buildBodySegments — format wrapping", () => {
  it("wraps a citation in format(bold) when bold spans the citation (path 15)", () => {
    // text: "X bold-cite Y" where "bold-cite" is bolded and is a citation
    const text = "X bold-cite Y";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 2, end: 11, format: "bold" }],
      citationMatches: [
        {
          citation: internalCite("bold-cite", "1.01"),
          start: 2,
          end: 11,
          citation_index: 0,
        },
      ],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      { type: "text", text: "X " },
      {
        type: "format",
        style: "bold",
        children: [{ type: "citation", raw: "bold-cite", citation_index: 0 }],
      },
      { type: "text", text: " Y" },
    ]);
  });

  it("nests format(italic) inside format(bold) for nested markup (path 16)", () => {
    const text = "x foo y";
    const out = buildBodySegments({
      text,
      htmlSpans: [
        { start: 2, end: 5, format: "bold" },
        { start: 2, end: 5, format: "italic" },
      ],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    // Either bold(italic(foo)) or italic(bold(foo)) is acceptable
    // depending on emission order; we asserted via sort: outer first.
    expect(out[0]).toEqual({ type: "text", text: "x " });
    expect(out[2]).toEqual({ type: "text", text: " y" });
    expect(out[1]?.type).toBe("format");
  });
});

// ─── CT8 hard cases (paths 27-31) ────────────────────────────────────────

describe("buildBodySegments — CT8 hard cases", () => {
  it("CT8 #27: format span partially crossing a citation is dropped (roundtrip safety)", () => {
    // Source: `§ <b>10.04.020</b>`. After flatten + normalize:
    // "§ 10.04.020". Bold covers positions 2-11; citation covers
    // 0-11. Bold partially crosses the citation (starts inside it),
    // which would force sliceSegment to double-emit the citation —
    // breaking the body-text roundtrip. The format-span filter drops
    // the partial-cross format span. We lose the bold styling on the
    // section number; the citation renders atomically. This is the
    // intentional trade-off for roundtrip correctness on production
    // AmLegal HTML where partial-bolded citations occur.
    const text = "§ 10.04.020";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 2, end: 11, format: "bold" }],
      citationMatches: [
        {
          citation: internalCite("§ 10.04.020", "10.04.020"),
          start: 0,
          end: 11,
          citation_index: 0,
        },
      ],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([{ type: "citation", raw: "§ 10.04.020", citation_index: 0 }]);
  });

  it("CT8 #27b: format span fully containing a citation wraps it atomically", () => {
    // Companion to #27: when the format span fully contains the
    // citation (e.g., the whole `§ 10.04.020` is bolded), the citation
    // is emitted once inside format(bold). Roundtrip-safe.
    const text = "§ 10.04.020";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 0, end: 11, format: "bold" }],
      citationMatches: [
        {
          citation: internalCite("§ 10.04.020", "10.04.020"),
          start: 0,
          end: 11,
          citation_index: 0,
        },
      ],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      {
        type: "format",
        style: "bold",
        children: [{ type: "citation", raw: "§ 10.04.020", citation_index: 0 }],
      },
    ]);
  });

  it("CT8 #28: adjacent inline runs with significant whitespace between", () => {
    // Text after normalize: "foo bar" with format runs on "foo" (0-3) and
    // "bar" (4-7); the space between is plain text.
    const text = "foo bar";
    const out = buildBodySegments({
      text,
      htmlSpans: [
        { start: 0, end: 3, format: "italic" },
        { start: 4, end: 7, format: "bold" },
      ],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      {
        type: "format",
        style: "italic",
        children: [{ type: "text", text: "foo" }],
      },
      { type: "text", text: " " },
      {
        type: "format",
        style: "bold",
        children: [{ type: "text", text: "bar" }],
      },
    ]);
  });

  it("CT8 #29: duplicate citation text — two distinct citations at distinct positions", () => {
    const text = "Section 1.01 amends Section 1.01.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [
        {
          citation: internalCite("Section 1.01", "1.01"),
          start: 0,
          end: 12,
          citation_index: 0,
        },
        {
          citation: internalCite("Section 1.01", "1.01"),
          start: 20,
          end: 32,
          citation_index: 1,
        },
      ],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      { type: "citation", raw: "Section 1.01", citation_index: 0 },
      { type: "text", text: " amends " },
      { type: "citation", raw: "Section 1.01", citation_index: 1 },
      { type: "text", text: "." },
    ]);
  });

  it("CT8 #30: repeated defined-term occurrences — both highlighted", () => {
    // The dictionary has "Person"; the text has it twice. Both
    // occurrences become defined_term segments.
    const text = "A Person sees another Person.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(["Person"]),
    });
    expect(out).toEqual([
      { type: "text", text: "A " },
      { type: "defined_term", term: "Person" },
      { type: "text", text: " sees another " },
      { type: "defined_term", term: "Person" },
      { type: "text", text: "." },
    ]);
  });

  it("CT8 #31: links/citations inside nested formatting render as nested wrappers", () => {
    // text: "click here" (5 chars: "click"), bold wrapping it, defined-term inside.
    // defined-term "click" at 0..5, bold at 0..5.
    const text = "click";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 0, end: 5, format: "bold" }],
      citationMatches: [],
      moduleDefinedTerms: new Set(["click"]),
    });
    expect(out).toEqual([
      {
        type: "format",
        style: "bold",
        children: [{ type: "defined_term", term: "click" }],
      },
    ]);
  });
});

describe("buildBodySegments — defined-term occurrence scanning", () => {
  it("matches longer terms before shorter substrings (longest-first)", () => {
    // "Director of Transportation" should match as a single term,
    // not as two separate terms ("Director" and "Transportation").
    const text = "The Director of Transportation acts.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(["Director", "Transportation", "Director of Transportation"]),
    });
    expect(out).toEqual([
      { type: "text", text: "The " },
      { type: "defined_term", term: "Director of Transportation" },
      { type: "text", text: " acts." },
    ]);
  });

  it("uses word boundaries — 'Person' does not match 'Personal'", () => {
    const text = "A Personal note.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set(["Person"]),
    });
    expect(out).toEqual([{ type: "text", text: "A Personal note." }]);
  });

  it("ignores empty-string entries in the dictionary", () => {
    const text = "no marker here";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinedTerms: new Set([""]),
    });
    expect(out).toEqual([{ type: "text", text: "no marker here" }]);
  });
});

describe("buildBodySegments — paragraph_break", () => {
  it("emits paragraph_break for each \\n marker in htmlSpans", () => {
    const text = "Line 1.\nLine 2.\nLine 3.";
    const out = buildBodySegments({
      text,
      htmlSpans: [
        { start: 7, end: 8, format: "paragraph_break" },
        { start: 15, end: 16, format: "paragraph_break" },
      ],
      citationMatches: [],
      moduleDefinedTerms: new Set(),
    });
    expect(out).toEqual([
      { type: "text", text: "Line 1." },
      { type: "paragraph_break" },
      { type: "text", text: "Line 2." },
      { type: "paragraph_break" },
      { type: "text", text: "Line 3." },
    ]);
  });
});
