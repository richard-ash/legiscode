import { describe, expect, it } from "vitest";
import { extractCitations } from "@/parser/citations";
import type { ModuleConfig } from "@/types";

const SF_PATTERN =
  "(?:§§?|\\bSections?\\b|\\bSec\\.|\\bArticles?\\b|\\bChapters?\\b|\\bDivisions?\\b|\\bTitles?\\b|\\bsubsections?\\b|\\bsubdivisions?\\b)\\s*(?:\\d+(?:\\.\\d+)*(?:\\([a-z0-9]+\\))*(?:-\\d+(?:\\.\\d+)*)?|\\([a-z0-9]+\\)(?:\\([a-z0-9]+\\))*)";

const manifest: ModuleConfig = {
  id: "sf-municipal",
  name: "SF",
  code_title: "Municipal Code",
  module_version: "2026.04.30",
  citation_patterns: [SF_PATTERN],
  max_skip_count: 0,
  defined_term_patterns: ['"([^"]+)"\\s+means'],
};

describe("extractCitations — internal range (section_id === range.from invariant)", () => {
  it("captures §§ X-Y with section_id equal to range.from", () => {
    const cites = extractCitations("Sections §§ 10.04.020-10.04.030 apply.", manifest);
    // The new regex matches both "Sections §§ 10.04.020" and "§§ 10.04.020-…"
    // overlapping at the same anchor; dedup keeps both because their start
    // offsets differ. Range capture lands on the §§ form.
    const rangeCite = cites.find(
      (c) => c.citation.target.kind === "internal" && "range" in c.citation.target,
    );
    expect(rangeCite?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      range: { from: "10.04.020", to: "10.04.030" },
    });
  });

  it("classifies a Code-prefixed range as cross_module", () => {
    const cites = extractCitations(
      "Per Cal. Veh. Code §§ 22358-22359 the limits are tiered.",
      manifest,
    );
    const range = cites.find((c) => "range" in c.citation.target);
    expect(range?.citation.target).toEqual({
      kind: "cross_module",
      module_id: "ca-vehicle",
      section_id: "22358",
      range: { from: "22358", to: "22359" },
    });
  });

  it("captures §§ X-Y as a single range citation", () => {
    const cites = extractCitations("§§ 10.04.020-10.04.030", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      range: { from: "10.04.020", to: "10.04.030" },
    });
  });
});
