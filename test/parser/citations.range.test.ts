import { describe, expect, it } from "vitest";
import { extractCitations } from "@/parser/citations";
import type { ModuleConfig } from "@/types";

const manifest: ModuleConfig = {
  id: "sf-municipal",
  name: "SF",
  code_title: "Municipal Code",
  module_version: "2026.04.30",
  citation_patterns: [
    "(?<!§)§\\s*\\d+(?:\\.\\d+)*(?:\\([a-z0-9]+\\))*",
    "§§\\s*\\d+(?:\\.\\d+)*\\s*-\\s*\\d+(?:\\.\\d+)*",
  ],
  max_skip_count: 0,
  defined_term_patterns: ['"([^"]+)"\\s+means'],
};

describe("extractCitations — internal range (section_id === range.from invariant)", () => {
  it("captures §§ X-Y with section_id equal to range.from", () => {
    const cites = extractCitations("Sections §§ 10.04.020-10.04.030 apply.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      range: { from: "10.04.020", to: "10.04.030" },
    });
  });

  it("classifies a Code-prefixed range as external", () => {
    const cites = extractCitations(
      "Per Cal. Veh. Code §§ 22358-22359 the limits are tiered.",
      manifest,
    );
    expect(cites[0]?.citation.target.kind).toBe("external");
  });

  it("does NOT produce both a single + a range from §§ X-Y", () => {
    // The §§ pattern matches once; the § pattern shouldn't double-count.
    // With our patterns the § version doesn't match the §§ form because of
    // anchor differences, so we should see exactly one citation.
    const cites = extractCitations("§§ 10.04.020-10.04.030", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target.kind).toBe("internal");
  });
});
