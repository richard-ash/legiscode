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

describe("extractCitations — internal subsection", () => {
  it("captures (a)(2) as a subsection on internal targets", () => {
    const cites = extractCitations("As stated in § 10.04.020(a)(2), ...", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      subsection: "(a)(2)",
    });
    expect(cites[0]?.citation.display_text).toBe("§ 10.04.020(a)(2)");
  });

  it("captures a single-letter subsection (a)", () => {
    const cites = extractCitations("§ 10.04.020(a) applies.", manifest);
    expect(cites[0]?.citation.target).toMatchObject({
      kind: "internal",
      section_id: "10.04.020",
      subsection: "(a)",
    });
  });

  it("does NOT carry a subsection for plain § N", () => {
    const cites = extractCitations("See § 10.04.020 for the rule.", manifest);
    expect(cites[0]?.citation.target).toEqual({ kind: "internal", section_id: "10.04.020" });
  });

  it("classifies external Code citations even when a subsection is present", () => {
    const cites = extractCitations("Per Cal. Veh. Code § 22358(b), ...", manifest);
    expect(cites[0]?.citation.target.kind).toBe("external");
  });
});
