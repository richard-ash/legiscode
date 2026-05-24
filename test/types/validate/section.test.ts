import { describe, expect, it } from "vitest";
import { SectionFileSchema, bodyToText } from "@/types";

// validSection's `text` is empty so body defaults to [] and the
// roundtrip invariant (bodyToText(body) === text) passes vacuously.
// Tests that exercise non-empty body[] override both fields together.
const validSection = {
  id: "10.04.020",
  display_label: "10.04.020",
  title: "Definitions",
  text: "",
  citations: [],
  defined_terms: [],
  hierarchy: ["title-10", "ch-10.04"],
};

describe("SectionFileSchema", () => {
  it("accepts a minimal section", () => {
    expect(SectionFileSchema.parse(validSection).id).toBe("10.04.020");
  });

  it("defaults kind to 'section' when omitted", () => {
    expect(SectionFileSchema.parse(validSection).kind).toBe("section");
  });

  it("defaults editorial_status to 'active' when omitted", () => {
    expect(SectionFileSchema.parse(validSection).editorial_status).toBe("active");
  });

  it("rejects an invalid section id", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, id: "INVALID ID" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("id");
    }
  });

  it("rejects extra fields under strict()", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field", () => {
    const { text: _text, ...incomplete } = validSection;
    const result = SectionFileSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("text");
    }
  });

  it("rejects wrong field type", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      hierarchy: "title-10",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("hierarchy");
    }
  });

  it("rejects kind: 'section' written with the wrong literal value", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, kind: "appendix" });
    expect(result.success).toBe(false);
  });

  it("accepts editorial_status: 'reserved' / 'repealed' / 'redesignated'", () => {
    for (const status of ["reserved", "repealed", "redesignated"] as const) {
      const result = SectionFileSchema.safeParse({ ...validSection, editorial_status: status });
      expect(result.success).toBe(true);
    }
  });

  it("accepts redirect_to when editorial_status is 'redesignated'", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      editorial_status: "redesignated",
      redirect_to: "10.05.020",
    });
    expect(result.success).toBe(true);
  });

  it("rejects redirect_to when editorial_status is not 'redesignated'", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        editorial_status: "active",
        redirect_to: "10.05.020",
      }).success,
    ).toBe(false);
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        editorial_status: "repealed",
        redirect_to: "10.05.020",
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid redirect_to id", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      editorial_status: "redesignated",
      redirect_to: "INVALID",
    });
    expect(result.success).toBe(false);
  });

  it("defaults body to [] when omitted (CT7 — old --corpus-path JSON compat)", () => {
    expect(SectionFileSchema.parse(validSection).body).toEqual([]);
  });

  // Phase 5 — section.id IS the anchor; display_label carries the
  // human-readable form. The Phase 1 anchor_id field collapsed into
  // section.id during this commit; legacy fixtures with anchor_id are
  // rejected by strict() so callers update.
  it("requires display_label", () => {
    const { display_label: _drop, ...withoutLabel } = validSection;
    const result = SectionFileSchema.safeParse(withoutLabel);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("display_label");
    }
  });

  it("rejects an empty display_label", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, display_label: "" });
    expect(result.success).toBe(false);
  });

  it("rejects the legacy anchor_id field (collapsed in Phase 5)", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, anchor_id: "p109" });
    expect(result.success).toBe(false);
  });
});

// BodySegment discriminated union — one focused test per variant. Each
// asserts the happy-path shape parses, and one shape-level rejection per
// variant catches the most common authoring mistake. Happy-path fixtures
// set both `text` and `body` so the roundtrip invariant in superRefine
// is satisfied (bodyToText(body) === text). Rejection fixtures fail at
// the segment schema before superRefine runs, so text doesn't matter.
describe("BodySegment via SectionFileSchema.body", () => {
  const withBody = (body: unknown) => ({ ...validSection, body });

  it("accepts a text segment", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "hello",
        body: [{ type: "text", text: "hello" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a citation segment when citation_index is in range", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "§ 1.01",
      citations: [{ display_text: "§ 1.01", target: { kind: "internal", section_id: "1.01" } }],
      body: [{ type: "citation", raw: "§ 1.01", citation_index: 0 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a citation segment with a negative citation_index", () => {
    const result = SectionFileSchema.safeParse(
      withBody([{ type: "citation", raw: "x", citation_index: -1 }]),
    );
    expect(result.success).toBe(false);
  });

  // L2b cutover: defined_term segments REQUIRE raw + def_id; the
  // legacy `term` field is gone, and bodyToText emits `raw`. The
  // roundtrip invariant constrains text === raw in fixtures.
  it("accepts a defined_term segment with raw and def_id", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "Tenant",
        body: [
          {
            type: "defined_term",
            raw: "Tenant",
            def_id: "sf-housing/h401#a1b2c3d4",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts a defined_term segment with candidates_dropped (per-occurrence runner-ups)", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "City",
        body: [
          {
            type: "defined_term",
            raw: "City",
            def_id: "sf-administrative/a-100#deadbeef",
            candidates_dropped: [
              "sf-administrative/a-200#deadbeee",
              "sf-administrative/a-300#deadbeed",
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a defined_term segment missing def_id", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "Person",
        body: [{ type: "defined_term", raw: "Person" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a defined_term segment missing raw", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "Person",
        body: [{ type: "defined_term", def_id: "sf-housing/h401#a1b2c3d4" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a defined_term segment carrying the legacy term field (strict mode)", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "Person",
        body: [
          {
            type: "defined_term",
            term: "Person",
            raw: "Person",
            def_id: "sf-housing/h401#a1b2c3d4",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a defined_term segment with a malformed def_id", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "Person",
        body: [{ type: "defined_term", raw: "Person", def_id: "not-a-valid-id" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a defined_term segment with a malformed entry in candidates_dropped", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "City",
        body: [
          {
            type: "defined_term",
            raw: "City",
            def_id: "sf-administrative/a-100#deadbeef",
            candidates_dropped: ["bad"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a subsection_label segment", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "(a)",
        body: [{ type: "subsection_label", label: "(a)" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a paragraph_break segment", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        text: "\n",
        body: [{ type: "paragraph_break" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a format segment with recursive children", () => {
    const body = [
      {
        type: "format",
        style: "bold",
        children: [
          {
            type: "format",
            style: "italic",
            children: [{ type: "text", text: "foo" }],
          },
        ],
      },
    ];
    expect(SectionFileSchema.safeParse({ ...validSection, text: "foo", body }).success).toBe(true);
  });

  it("rejects a format segment with empty children (walker / normalizer drop empty spans)", () => {
    expect(
      SectionFileSchema.safeParse(withBody([{ type: "format", style: "bold", children: [] }]))
        .success,
    ).toBe(false);
  });

  it("rejects a format segment with an unknown style", () => {
    const result = SectionFileSchema.safeParse(
      withBody([{ type: "format", style: "underline", children: [{ type: "text", text: "x" }] }]),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a body segment with an unknown variant type (CT8 hard case)", () => {
    expect(SectionFileSchema.safeParse(withBody([{ type: "marquee" }])).success).toBe(false);
  });
});

// superRefine — citation_index must be in range. This is the cross-field
// invariant the per-segment schema can't reach; CT9 added it because a
// drifting index would crash the renderer at resolve time. Fixtures set
// `text` to bodyToText(body) so the roundtrip check passes and these
// tests isolate the citation_index path.
describe("SectionFileSchema citation_index superRefine", () => {
  const withCitation = (text: string, citations: unknown[], body: unknown[]) => ({
    ...validSection,
    text,
    citations,
    body,
  });

  it("rejects a citation segment whose index >= citations.length", () => {
    const result = SectionFileSchema.safeParse(
      withCitation(
        "§ 1.01",
        [{ display_text: "§ 1.01", target: { kind: "internal", section_id: "1.01" } }],
        [{ type: "citation", raw: "§ 1.01", citation_index: 5 }],
      ),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("citation_index"));
      expect(issue).toBeDefined();
    }
  });

  it("rejects a citation segment whose index >= citations.length when nested inside a format span", () => {
    const result = SectionFileSchema.safeParse(
      withCitation(
        "§ 1.01",
        [{ display_text: "§ 1.01", target: { kind: "internal", section_id: "1.01" } }],
        [
          {
            type: "format",
            style: "bold",
            children: [{ type: "citation", raw: "§ 1.01", citation_index: 7 }],
          },
        ],
      ),
    );
    expect(result.success).toBe(false);
  });

  it("accepts citation_index === citations.length - 1 (boundary case)", () => {
    const result = SectionFileSchema.safeParse(
      withCitation(
        "§ 1.01",
        [{ display_text: "§ 1.01", target: { kind: "internal", section_id: "1.01" } }],
        [{ type: "citation", raw: "§ 1.01", citation_index: 0 }],
      ),
    );
    expect(result.success).toBe(true);
  });
});

// Roundtrip invariant: bodyToText(body) must equal text. The renderer
// iterates body[]; search and export read text. Drift between the two
// representations is the corruption mode body[] was added to prevent,
// so the schema fails closed at parse time.
describe("SectionFileSchema body[]/text roundtrip superRefine", () => {
  it("rejects a non-empty text with empty body[]", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "Section content the renderer would never see.",
      body: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("body"));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("roundtrip");
    }
  });

  it("rejects body[] whose flattened text disagrees with text byte-for-byte", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "hello",
      body: [{ type: "text", text: "world" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when paragraph_break is missing from body[] but present as \\n in text", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "first\nsecond",
      body: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts body[] that re-flattens through nested format spans", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "see foo bar",
      body: [
        { type: "text", text: "see " },
        {
          type: "format",
          style: "bold",
          children: [
            { type: "text", text: "foo " },
            { type: "format", style: "italic", children: [{ type: "text", text: "bar" }] },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty section (text='' and body=[]) — vacuous roundtrip", () => {
    expect(SectionFileSchema.safeParse(validSection).success).toBe(true);
  });
});

// Citation raw must match the indexed citations[] entry's display_text.
// Bounds-only is too loose: a hand-edit drift could put raw="§ 1.01"
// against a citation whose display_text is "§ 2.02", silently sending
// the click to the wrong target.
describe("SectionFileSchema citation raw/display_text consistency superRefine", () => {
  it("rejects when raw !== citations[citation_index].display_text", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "§ 1.01",
      citations: [{ display_text: "§ 2.02", target: { kind: "internal", section_id: "2.02" } }],
      body: [{ type: "citation", raw: "§ 1.01", citation_index: 0 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.includes("raw") && i.message.includes("display_text"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects raw mismatch when nested inside a format span", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "§ 1.01",
      citations: [{ display_text: "§ 2.02", target: { kind: "internal", section_id: "2.02" } }],
      body: [
        {
          type: "format",
          style: "bold",
          children: [{ type: "citation", raw: "§ 1.01", citation_index: 0 }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts raw === citations[citation_index].display_text", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      text: "§ 1.01",
      citations: [{ display_text: "§ 1.01", target: { kind: "internal", section_id: "1.01" } }],
      body: [{ type: "citation", raw: "§ 1.01", citation_index: 0 }],
    });
    expect(result.success).toBe(true);
  });
});

// bodyToText is exported so test code uses the same definition the
// schema runs. A drift between the two would let the trust-boundary
// check disagree with the corpus-wide test invariant.
describe("bodyToText helper", () => {
  it("re-flattens text/citation/defined_term/subsection_label/paragraph_break/format", () => {
    expect(
      bodyToText([
        { type: "text", text: "see " },
        { type: "citation", raw: "§ 1.01", citation_index: 0 },
        { type: "text", text: " ('" },
        { type: "defined_term", raw: "Person", def_id: "sf-housing/h401#a1b2c3d4" },
        { type: "text", text: "')" },
        { type: "paragraph_break" },
        { type: "subsection_label", label: "(a)" },
        { type: "format", style: "bold", children: [{ type: "text", text: " bold" }] },
      ]),
    ).toBe("see § 1.01 ('Person')\n(a) bold");
  });

  it("returns '' for empty body[]", () => {
    expect(bodyToText([])).toBe("");
  });
});
