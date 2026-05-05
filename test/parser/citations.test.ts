import { describe, expect, it } from "vitest";
import { CitationPatternError, extractCitations } from "@/parser/citations";
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

describe("extractCitations — internal", () => {
  it("classifies a bare § N as internal", () => {
    const cites = extractCitations("See § 10.04.020 for details.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.target).toEqual({ kind: "internal", section_id: "10.04.020" });
    expect(cites[0]?.display_text).toBe("§ 10.04.020");
  });

  it("dedupes repeated identical citations at the same offset is impossible; distinct offsets keep both", () => {
    const cites = extractCitations("§ 10.04.020 and again § 10.04.020.", manifest);
    expect(cites).toHaveLength(2);
  });

  it("returns [] on empty text", () => {
    expect(extractCitations("", manifest)).toEqual([]);
  });

  it("ignores text with no citations", () => {
    expect(extractCitations("plain text, no references", manifest)).toEqual([]);
  });
});

describe("extractCitations — external (Code-prefix detection)", () => {
  it("classifies a Cal. Veh. Code citation as external", () => {
    const cites = extractCitations("Per Cal. Veh. Code § 22358 the limit is 25mph.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.target).toEqual({ kind: "external", raw: "§ 22358" });
  });

  it("classifies U.S.C. references as external", () => {
    const cites = extractCitations("Under 42 U.S.C. § 1983 ...", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.target.kind).toBe("external");
  });

  it("classifies C.F.R. references as external", () => {
    const cites = extractCitations("See 28 C.F.R. § 35.130 for the rule.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.target.kind).toBe("external");
  });

  it("treats the same § N as internal when no Code-prefix marker is nearby", () => {
    const cites = extractCitations("Refer to § 22358 for the limit.", manifest);
    expect(cites[0]?.target.kind).toBe("internal");
  });
});

describe("extractCitations — error handling", () => {
  it("throws CitationPatternError on a malformed regex pattern", () => {
    const bad: ModuleConfig = { ...manifest, citation_patterns: ["[unclosed"] };
    expect(() => extractCitations("§ 10.04.020", bad)).toThrow(CitationPatternError);
  });
});

describe("extractCitations — cross_module / vague (NOT produced today)", () => {
  it("does not synthesize cross_module targets without manifest support", () => {
    // The schema accepts cross_module, but the simple-pattern extractor
    // doesn't produce it; resolution is a future enhancement.
    const cites = extractCitations("See § 10.04.020 (sf-municipal).", manifest);
    expect(cites.every((c) => c.target.kind !== "cross_module")).toBe(true);
  });

  it("does not produce vague targets (the simple extractor sees no signal)", () => {
    const cites = extractCitations("As described in the previous section, ...", manifest);
    expect(cites.every((c) => c.target.kind !== "vague")).toBe(true);
  });
});
