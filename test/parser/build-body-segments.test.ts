// buildBodySegments — merge algorithm unit tests.
//
// Covers the synthetic edge cases from the test plan paths 7-18 (parser
// emission) and 27-31 (codex CT8 hard cases). The function takes
// pre-extracted positions as input, so we don't need cheerio fixtures
// here — just synthetic position arrays that mimic what the upstream
// extractors would produce.

import { describe, expect, it } from "vitest";
import { buildBodySegments } from "@/parser/build-body-segments";
import { buildDefinitionId } from "@/parser/definition-id";
import type { Citation, Definition, SectionId } from "@/types";

const internalCite = (display_text: string, section_id: string): Citation => ({
  display_text,
  target: { kind: "internal", section_id },
});

// Test reader at an empty hierarchy — module-scoped Definitions
// resolve for this reader, which is what most of these tests want
// (they're exercising the body-builder, not the resolver).
const testReader = { id: "reader-section" as SectionId, hierarchy: [] };

const TEST_MODULE = "sf-test";
const TEST_DEFINER: SectionId = "test-def";

// Build a module-scoped mock Definition for a term. The L1 schema's
// uniqueness invariant means each term needs a distinct id, so the
// helper derives the id from (TEST_MODULE, TEST_DEFINER, term).
function mockDefinition(term: string, overrides: Partial<Definition> = {}): Definition {
  return {
    id: buildDefinitionId(TEST_MODULE, TEST_DEFINER, term),
    term,
    defined_in: TEST_DEFINER,
    body_anchor: { start: 0, end: term.length },
    excerpt: `"${term}" means a thing.`,
    scope: { kind: "module" },
    extracted_by: "amlegal:pattern:quoted-means",
    ...overrides,
  };
}

function expectedDefId(term: string): string {
  return buildDefinitionId(TEST_MODULE, TEST_DEFINER, term);
}

// Post-L2b defined_term segment shape: raw + def_id, no legacy term
// field. Helper takes the canonical term as a shorthand to derive the
// expected def_id (and the default raw when no override is supplied).
function definedTermSegment(term: string, raw?: string) {
  return {
    type: "defined_term" as const,
    raw: raw ?? term,
    def_id: expectedDefId(term),
  };
}

describe("buildBodySegments — primary annotation tiling", () => {
  it("emits a single text segment for plain text with no annotations (path 7)", () => {
    const out = buildBodySegments({
      text: "plain prose with no markup",
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [],
      readerSection: testReader,
    });
    expect(out).toEqual([{ type: "text", text: "plain prose with no markup" }]);
  });

  it("returns [] for empty text", () => {
    const out = buildBodySegments({
      text: "",
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [],
      readerSection: testReader,
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
      moduleDefinitions: [],
      readerSection: testReader,
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
      moduleDefinitions: [mockDefinition("Person")],
      readerSection: testReader,
    });
    expect(out).toEqual([
      { type: "text", text: "The " },
      definedTermSegment("Person"),
      { type: "text", text: " shall comply." },
    ]);
  });

  it("citation > defined_term overlap drops the defined_term (path 10, CQ2)", () => {
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
      moduleDefinitions: [mockDefinition("Person")],
      readerSection: testReader,
    });
    expect(out).toEqual([
      { type: "text", text: "see " },
      { type: "citation", raw: "Section 1.01", citation_index: 0 },
      { type: "text", text: " ('" },
      definedTermSegment("Person"),
      { type: "text", text: "')" },
    ]);
  });

  it("when citation and defined_term overlap, citation wins (path 10, true overlap)", () => {
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
      moduleDefinitions: [mockDefinition("Person")],
      readerSection: testReader,
    });
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
      moduleDefinitions: [],
      readerSection: testReader,
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
      moduleDefinitions: [],
      readerSection: testReader,
    });
    expect(out).toEqual([{ type: "text", text: "See option (a) of the rule." }]);
  });

  it("emits subsection_label after a paragraph_break (path 12, multi-paragraph)", () => {
    const text = "First paragraph.\n(b) The next subsection.";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 16, end: 17, format: "paragraph_break" }],
      citationMatches: [],
      moduleDefinitions: [],
      readerSection: testReader,
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
      moduleDefinitions: [],
      readerSection: testReader,
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
      moduleDefinitions: [],
      readerSection: testReader,
    });
    expect(out[0]).toEqual({ type: "text", text: "x " });
    expect(out[2]).toEqual({ type: "text", text: " y" });
    expect(out[1]?.type).toBe("format");
  });
});

// ─── CT8 hard cases (paths 27-31) ────────────────────────────────────────

describe("buildBodySegments — CT8 hard cases", () => {
  it("CT8 #27: format span partially crossing a citation is dropped (roundtrip safety)", () => {
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
      moduleDefinitions: [],
      readerSection: testReader,
    });
    expect(out).toEqual([{ type: "citation", raw: "§ 10.04.020", citation_index: 0 }]);
  });

  it("CT8 #27b: format span fully containing a citation wraps it atomically", () => {
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
      moduleDefinitions: [],
      readerSection: testReader,
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
    const text = "foo bar";
    const out = buildBodySegments({
      text,
      htmlSpans: [
        { start: 0, end: 3, format: "italic" },
        { start: 4, end: 7, format: "bold" },
      ],
      citationMatches: [],
      moduleDefinitions: [],
      readerSection: testReader,
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
      moduleDefinitions: [],
      readerSection: testReader,
    });
    expect(out).toEqual([
      { type: "citation", raw: "Section 1.01", citation_index: 0 },
      { type: "text", text: " amends " },
      { type: "citation", raw: "Section 1.01", citation_index: 1 },
      { type: "text", text: "." },
    ]);
  });

  it("CT8 #30: repeated defined-term occurrences — both highlighted", () => {
    const text = "A Person sees another Person.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [mockDefinition("Person")],
      readerSection: testReader,
    });
    expect(out).toEqual([
      { type: "text", text: "A " },
      definedTermSegment("Person"),
      { type: "text", text: " sees another " },
      definedTermSegment("Person"),
      { type: "text", text: "." },
    ]);
  });

  it("CT8 #31: links/citations inside nested formatting render as nested wrappers", () => {
    const text = "click";
    const out = buildBodySegments({
      text,
      htmlSpans: [{ start: 0, end: 5, format: "bold" }],
      citationMatches: [],
      moduleDefinitions: [mockDefinition("click")],
      readerSection: testReader,
    });
    expect(out).toEqual([
      {
        type: "format",
        style: "bold",
        children: [definedTermSegment("click")],
      },
    ]);
  });
});

describe("buildBodySegments — defined-term occurrence scanning", () => {
  it("matches longer terms before shorter substrings (longest-first)", () => {
    const text = "The Director of Transportation acts.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [
        mockDefinition("Director"),
        mockDefinition("Transportation"),
        mockDefinition("Director of Transportation"),
      ],
      readerSection: testReader,
    });
    expect(out).toEqual([
      { type: "text", text: "The " },
      definedTermSegment("Director of Transportation"),
      { type: "text", text: " acts." },
    ]);
  });

  it("uses word boundaries — 'Person' does not match 'Personal'", () => {
    const text = "A Personal note.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [mockDefinition("Person")],
      readerSection: testReader,
    });
    expect(out).toEqual([{ type: "text", text: "A Personal note." }]);
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
      moduleDefinitions: [],
      readerSection: testReader,
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

// ─── L2a per-occurrence resolution behavior ──────────────────────────────

describe("buildBodySegments — L2a per-occurrence resolution", () => {
  it("attaches def_id and raw to resolved defined_term segments", () => {
    const text = "The Person shall comply.";
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [mockDefinition("Person")],
      readerSection: testReader,
    });
    const segment = out.find((s) => s.type === "defined_term");
    expect(segment).toEqual(definedTermSegment("Person"));
  });

  it("drops defined_term primary when no in-scope Definition exists (unresolved → text gap)", () => {
    const text = "The Phantom moves.";
    const reports: { term: string }[] = [];
    const outOfScope = mockDefinition("Phantom", {
      scope: { kind: "hierarchy", prefix: ["Different Code"] },
    });
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [outOfScope],
      readerSection: testReader,
      onUnresolvedReference: (r) => reports.push({ term: r.term }),
    });
    // The defined_term primary is dropped; the gap-filler emits a
    // single text segment covering the whole string.
    expect(out).toEqual([{ type: "text", text: "The Phantom moves." }]);
    expect(reports).toEqual([{ term: "Phantom" }]);
  });

  it("self-suppression: definer section's canonical clause renders as plain text", () => {
    // The reader IS the definer; body_anchor 4..10 marks the canonical
    // definition. Other occurrences of the same term in the same section
    // stay tagged.
    const text = "The Person means a human. Other Person says hi.";
    const definer = mockDefinition("Person", {
      defined_in: "definer-id",
      body_anchor: { start: 4, end: 10 },
      scope: { kind: "module" },
    });
    const out = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [definer],
      readerSection: { id: "definer-id", hierarchy: [] },
    });
    // First occurrence (canonical) is suppressed; second stays tagged.
    expect(out).toEqual([
      { type: "text", text: "The Person means a human. Other " },
      { type: "defined_term", raw: "Person", def_id: definer.id },
      { type: "text", text: " says hi." },
    ]);
  });

  it("records candidates_dropped when multiple Definitions are in scope", () => {
    // Two module-scoped definitions of "City" — the precedence rule
    // picks the one with the ascending defined_in.
    const winner = mockDefinition("City", {
      defined_in: "a-100",
      id: buildDefinitionId("sf-admin", "a-100", "City"),
    });
    const loser = mockDefinition("City", {
      defined_in: "a-200",
      id: buildDefinitionId("sf-admin", "a-200", "City"),
    });
    const out = buildBodySegments({
      text: "The City acts.",
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [winner, loser],
      readerSection: testReader,
    });
    expect(out).toEqual([
      { type: "text", text: "The " },
      {
        type: "defined_term",
        raw: "City",
        def_id: winner.id,
        candidates_dropped: [loser.id],
      },
      { type: "text", text: " acts." },
    ]);
  });

  it("unresolved report carries reader_section, raw_text, excerpt, and out-of-scope candidate ids", () => {
    const outOfScope = mockDefinition("Phantom", {
      scope: { kind: "hierarchy", prefix: ["Different Code"] },
    });
    const reports: Array<{
      term: string;
      reader_section: string;
      raw_text: string;
      surrounding_excerpt: string;
      out_of_scope_candidate_ids: readonly string[];
    }> = [];
    buildBodySegments({
      text: "The Phantom haunts §401.\nAnother paragraph.",
      htmlSpans: [],
      citationMatches: [],
      moduleDefinitions: [outOfScope],
      readerSection: { id: "reader-section", hierarchy: ["Other"] },
      onUnresolvedReference: (r) => reports.push(r),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.term).toBe("Phantom");
    expect(reports[0]?.reader_section).toBe("reader-section");
    expect(reports[0]?.raw_text).toBe("Phantom");
    expect(reports[0]?.surrounding_excerpt).toBe("The Phantom haunts §401.");
    expect(reports[0]?.out_of_scope_candidate_ids).toEqual([outOfScope.id]);
  });
});
