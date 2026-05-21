import { describe, expect, it } from "vitest";
import { CorpusEntrySchema } from "@/types";

const sectionEntry = {
  kind: "section" as const,
  id: "1.234",
  display_label: "1.234",
  title: "Definitions",
  text: "",
  citations: [],
  defined_terms: [],
  hierarchy: ["Charter"],
  editorial_status: "active" as const,
};

const appendixEntry = {
  kind: "appendix" as const,
  id: "article-10-appendix-a",
  parent: { kind: "article" as const, number: 10 },
  letter: "a",
  title: "Land Use",
  body: "...",
  figures: [],
  source_location: { line: 1 },
};

const ordinanceHistoryEntry = {
  kind: "ordinance_history" as const,
  id: "2023-ordinances",
  year: 2023,
  module_id: "sf-transportation",
  items: [],
  source_location: { line: 1 },
};

const resolutionHistoryEntry = {
  kind: "resolution_history" as const,
  id: "2023-resolutions",
  year: 2023,
  module_id: "sf-transportation",
  items: [],
  source_location: { line: 1 },
};

describe("CorpusEntrySchema", () => {
  it("dispatches to Section on kind: 'section'", () => {
    const result = CorpusEntrySchema.parse(sectionEntry);
    expect(result.kind).toBe("section");
  });

  it("dispatches to Appendix on kind: 'appendix'", () => {
    const result = CorpusEntrySchema.parse(appendixEntry);
    expect(result.kind).toBe("appendix");
  });

  it("dispatches to OrdinanceHistory on kind: 'ordinance_history'", () => {
    const result = CorpusEntrySchema.parse(ordinanceHistoryEntry);
    expect(result.kind).toBe("ordinance_history");
  });

  it("dispatches to ResolutionHistory on kind: 'resolution_history'", () => {
    const result = CorpusEntrySchema.parse(resolutionHistoryEntry);
    expect(result.kind).toBe("resolution_history");
  });

  it("rejects unknown kinds", () => {
    const result = CorpusEntrySchema.safeParse({ ...sectionEntry, kind: "made-up" });
    expect(result.success).toBe(false);
  });

  it("validates the dispatched member's own schema (not just the kind)", () => {
    // An entry with kind: "section" but malformed Section payload (whitespace
    // in the id) must fail SectionIdSchema, not silently pass via the union
    // discriminator.
    const result = CorpusEntrySchema.safeParse({
      ...sectionEntry,
      id: "INVALID ID",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry with kind: 'appendix' that's missing required Appendix fields", () => {
    const result = CorpusEntrySchema.safeParse({
      kind: "appendix",
      id: "article-10-appendix-a",
      // missing: parent, letter, title, body, source_location
    });
    expect(result.success).toBe(false);
  });
});
