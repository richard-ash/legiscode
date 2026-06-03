import { describe, expect, it } from "vitest";
import { buildBodySegments } from "@/parser/build-body-segments";
import { extractCitations } from "@/parser/citations";
import { buildDefinitionId } from "@/parser/definition-id";
import { buildGlossaryRecognizer } from "@/parser/recognize";
import { type Definition, type ModuleConfig, SectionFileSchema, type SectionId } from "@/types";

// Mirrors the operand in manifests/sf/jurisdiction.json: each section-id
// component is an optional leading letter, digits, optional trailing
// letter, so a letter can sit on any component ("10A.4") or lead the id
// ("A8.400"). The component AFTER a hyphen is digit-led only — the leading
// letter is for the first operand (Charter "A8.400"), never the range/
// ordinal right-hand side, so "1-A2" can't be over-captured as a range.
// Kept in lockstep with the manifest by the citations.ts classifier, which
// re-parses the captured span.
const SF_PATTERN =
  "(?:§§?|\\bSections?\\b|\\bSec\\.|\\bArticles?\\b|\\bChapters?\\b|\\bDivisions?\\b|\\bTitles?\\b|\\bsubsections?\\b|\\bsubdivisions?\\b)\\s*(?:[A-Za-z]?\\d+[A-Za-z]?(?:\\.[A-Za-z]?\\d+[A-Za-z]?)*(?:-\\d+[A-Za-z]?(?:\\.[A-Za-z]?\\d+[A-Za-z]?)*)?(?:\\([a-z0-9]+\\))*|\\([a-z0-9]+\\)(?:\\([a-z0-9]+\\))*)";

const manifest: ModuleConfig = {
  id: "sf-administrative",
  name: "SF",
  code_title: "Administrative Code",
  module_version: "2026.04.30",
  citation_patterns: [SF_PATTERN],
  max_skip_count: 0,
  defined_term_patterns: ['"([^"]+)"\\s+means'],
};

describe("citation number grammar — bugs ③ and ④", () => {
  it("③ reads Section 10A.4 as one citation, not Section 10A + a stray .4", () => {
    const cites = extractCitations("benefits provided in this Section 10A.4.", manifest, {
      currentSectionId: "10a.4",
    });
    const cite = cites.find((c) => c.citation.display_text === "Section 10A.4");
    expect(cite?.citation.target).toEqual({ kind: "internal", section_id: "10a.4" });
    // The old grammar produced a truncated "Section 10A"; it must not.
    expect(cites.some((c) => c.citation.display_text === "Section 10A")).toBe(false);
  });

  it("④ recognizes a City Charter section that leads with a letter", () => {
    const cites = extractCitations(
      "compensation as determined under Section A8.400 of the City Charter and rules",
      manifest,
      { currentSectionId: "10a.4" },
    );
    const cite = cites.find((c) => c.citation.display_text === "Section A8.400");
    expect(cite).toBeDefined();
    const target = cite?.citation.target;
    // Recognized with section_id a8.400. Binding to an sf-charter anchor
    // is an install/build concern (recognition ≠ a working link); here we
    // only assert the span is recognized and shaped correctly.
    expect(target && "section_id" in target ? target.section_id : null).toBe("a8.400");
  });

  it("stays a strict superset — trailing-letter, ordinal, and range shapes still parse", () => {
    const trailing = extractCitations("see Section 102A here", manifest);
    expect(trailing[0]?.citation.target).toMatchObject({ section_id: "102a" });

    const ordinal = extractCitations("see Section 16.9-2(a) here", manifest);
    expect(ordinal[0]?.citation.target).toMatchObject({ section_id: "16.9-2", subsection: "(a)" });

    const range = extractCitations("see §§ 10.04.020-10.04.030 here", manifest);
    expect(range.find((c) => "range" in c.citation.target)?.citation.target).toMatchObject({
      section_id: "10.04.020",
      range: { from: "10.04.020", to: "10.04.030" },
    });
  });

  it("does not over-capture a letter-led hyphen tail as a range (1-A2 ≠ range 1..a2)", () => {
    // The hyphen right-hand side is digit-led, so "Section 1-A2" captures
    // only "Section 1" — it must NOT classify as an internal range 1..a2,
    // which would be a silently-wrong link target.
    const cites = extractCitations("governed by Section 1-A2 of the rules", manifest);
    expect(cites.some((c) => "range" in c.citation.target)).toBe(false);
    const cite = cites.find((c) => c.citation.display_text === "Section 1");
    expect(cite?.citation.target).toEqual({ kind: "internal", section_id: "1" });
  });
});

describe("citation_index integrity through the body builder", () => {
  it("keeps the citation and its index in sync after a citation/term overlap", () => {
    // "Person" (a defined term) overlaps the citation span. The arbiter
    // keeps the citation; the assembled SectionFile must still validate —
    // citation_index 0 points at a live citations[] entry whose
    // display_text equals the body segment's raw.
    const text = "Person 1.01 applies here.";
    const cite = {
      display_text: "Person 1.01",
      target: { kind: "internal" as const, section_id: "1.01" },
    };
    const moduleDefinitions: Definition[] = [
      {
        id: buildDefinitionId("sf-administrative", "def", "Person"),
        term: "Person",
        defined_in: "def" as SectionId,
        body_anchor: { start: 0, end: 6 },
        excerpt: '"Person" means a human.',
        scope: { kind: "module" },
        extracted_by: "amlegal:pattern:quoted-means",
      },
    ];
    const body = buildBodySegments({
      text,
      htmlSpans: [],
      citationMatches: [{ citation: cite, start: 0, end: 11, citation_index: 0 }],
      moduleDefinitions,
      glossaryRecognizer: buildGlossaryRecognizer(new Set(["Person"])),
      readerSection: { id: "reader" as SectionId, hierarchy: [] },
    });
    const section = {
      kind: "section" as const,
      id: "reader" as SectionId,
      display_label: "Reader",
      title: "",
      text,
      citations: [cite],
      defined_terms: ["Person"],
      hierarchy: [],
      editorial_status: "active" as const,
      body,
    };
    const result = SectionFileSchema.safeParse(section);
    expect(result.success).toBe(true);
    // The overlap resolved to the citation, not a defined_term.
    expect(body.some((s) => s.kind === "citation" && s.citation_index === 0)).toBe(true);
    expect(body.some((s) => s.kind === "defined_term")).toBe(false);
  });
});
