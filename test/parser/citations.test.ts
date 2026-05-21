import { describe, expect, it } from "vitest";
import { CitationPatternError, extractCitations } from "@/parser/citations";
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

describe("extractCitations — internal section refs", () => {
  it("classifies a bare § N as internal", () => {
    const cites = extractCitations("See § 10.04.020 for details.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({ kind: "internal", section_id: "10.04.020" });
    expect(cites[0]?.citation.display_text).toBe("§ 10.04.020");
    expect(cites[0]?.start).toBe(4);
    expect(cites[0]?.end).toBe(15);
  });

  it("classifies 'Section N' as internal", () => {
    const cites = extractCitations("As provided in Section 5 above.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({ kind: "internal", section_id: "5" });
  });

  it("classifies 'Sec. N' as internal", () => {
    const cites = extractCitations("Per Sec. 12.4, this applies.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({ kind: "internal", section_id: "12.4" });
  });

  it("captures attached subsections on section refs", () => {
    const cites = extractCitations("See § 10.04.020(a)(2).", manifest);
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      subsection: "(a)(2)",
    });
  });

  it("dedupes by (offset, text); distinct offsets keep both", () => {
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

describe("extractCitations — §§ ranges", () => {
  it("classifies §§ N-M as internal with range", () => {
    const cites = extractCitations("See §§ 1.1-1.5 for the schedule.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "1.1",
      range: { from: "1.1", to: "1.5" },
    });
  });
});

describe("extractCitations — cross_module via active code prefix", () => {
  it("classifies § N as cross_module when California Vehicle Code is in scope", () => {
    const cites = extractCitations("Per Cal. Veh. Code § 22358 the limit is 25mph.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({
      kind: "cross_module",
      module_id: "ca-vehicle",
      section_id: "22358",
    });
  });

  it("carries the subsection across into the cross_module target", () => {
    const cites = extractCitations("Per Cal. Veh. Code § 22358(b), ...", manifest);
    expect(cites[0]?.citation.target).toEqual({
      kind: "cross_module",
      module_id: "ca-vehicle",
      section_id: "22358",
      subsection: "(b)",
    });
  });

  it("recognizes U.S.C. as us-code", () => {
    const cites = extractCitations("Under 42 U.S.C. § 1983, plaintiffs may...", manifest);
    expect(cites[0]?.citation.target).toEqual({
      kind: "cross_module",
      module_id: "us-code",
      section_id: "1983",
    });
  });

  it("resets the active prefix at paragraph boundaries", () => {
    const cites = extractCitations(
      "Per Cal. Veh. Code § 22358.\n\nA later § 99 stands alone.",
      manifest,
    );
    expect(cites).toHaveLength(2);
    expect(cites[0]?.citation.target.kind).toBe("cross_module");
    // The second cite is in a fresh paragraph; no active prefix → internal.
    expect(cites[1]?.citation.target).toEqual({ kind: "internal", section_id: "99" });
  });

  it("Unemployment Insurance Code outranks Insurance Code on overlapping phrase", () => {
    const cites = extractCitations(
      "Under the Unemployment Insurance Code § 1256, claimants...",
      manifest,
    );
    expect(cites[0]?.citation.target).toEqual({
      kind: "cross_module",
      module_id: "ca-unemployment-insurance",
      section_id: "1256",
    });
  });
});

describe("extractCitations — structural", () => {
  it("classifies 'Article N' as structural", () => {
    const cites = extractCitations("See Article 5 of this code.", manifest);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.citation.target).toEqual({
      kind: "structural",
      level: "article",
      number: "5",
    });
  });

  it("classifies Chapter, Division, Title each at their own level", () => {
    const cases: Array<[string, "chapter" | "division" | "title"]> = [
      ["See Chapter 12.", "chapter"],
      ["See Division 3.", "division"],
      ["See Title 7.", "title"],
    ];
    for (const [text, level] of cases) {
      const cites = extractCitations(text, manifest);
      expect(cites[0]?.citation.target).toEqual({
        kind: "structural",
        level,
        number: text.match(/\d+/)?.[0],
      });
    }
  });

  it("plural prefixes (Chapters/Articles/...) classify the same as singular", () => {
    const cites = extractCitations("Articles 5 and similar protections.", manifest);
    expect(cites[0]?.citation.target).toEqual({
      kind: "structural",
      level: "article",
      number: "5",
    });
  });
});

describe("extractCitations — same-section subsection refs", () => {
  it("classifies 'subsection (a)' as internal anchored to currentSectionId", () => {
    const cites = extractCitations("Per subsection (a) above, ...", manifest, {
      currentSectionId: "10.04.020",
    });
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      subsection: "(a)",
    });
  });

  it("classifies 'subdivision (b)' the same as subsection", () => {
    const cites = extractCitations("See subdivision (b).", manifest, {
      currentSectionId: "10.04.020",
    });
    expect(cites[0]?.citation.target).toEqual({
      kind: "internal",
      section_id: "10.04.020",
      subsection: "(b)",
    });
  });

  it("drops a bare subsection ref when no currentSectionId is provided", () => {
    const cites = extractCitations("Per subsection (a) above, ...", manifest);
    expect(cites).toHaveLength(0);
  });
});

describe("extractCitations — negative cases", () => {
  it("does not match 'this section' (no digit follows)", () => {
    const cites = extractCitations("As noted in this section, ...", manifest);
    expect(cites).toHaveLength(0);
  });

  it("does not match 'Section A' (letter, not digit)", () => {
    const cites = extractCitations("See Section A of the appendix.", manifest);
    expect(cites).toHaveLength(0);
  });

  it("does not match a bare '(a)' without a prefix word", () => {
    const cites = extractCitations("(a) The director shall...", manifest, {
      currentSectionId: "10.04.020",
    });
    expect(cites).toHaveLength(0);
  });
});

describe("extractCitations — error handling", () => {
  it("throws CitationPatternError on a malformed regex pattern", () => {
    const bad: ModuleConfig = { ...manifest, citation_patterns: ["[unclosed"] };
    expect(() => extractCitations("§ 10.04.020", bad)).toThrow(CitationPatternError);
  });
});
