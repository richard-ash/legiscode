// Citation parser tests. Asserts both qualified and bare forms surface.

import { describe, expect, it } from "vitest";
import { extractAnswerCitations } from "../../../src/parser/citation-verify/parse-citations";

describe("extractAnswerCitations", () => {
  it("extracts the qualified bracket form", () => {
    const cites = extractAnswerCitations("As stated in [test-alpha § 1.1], the rule…");
    expect(cites).toContainEqual(
      expect.objectContaining({
        qualified: { module_id: "test-alpha", section_id: "1.1" },
      }),
    );
  });

  it("extracts a bare § form", () => {
    const cites = extractAnswerCitations("Per § 10.04.020 the rule…");
    expect(cites).toContainEqual(
      expect.objectContaining({
        qualified: null,
        bareSectionId: "10.04.020",
      }),
    );
  });

  it("dedupes a repeated qualified cite", () => {
    const cites = extractAnswerCitations("[test-alpha § 1.1] and again [test-alpha § 1.1]");
    const qualifieds = cites.filter((c) => c.qualified !== null);
    expect(qualifieds).toHaveLength(1);
  });

  it("returns empty for prose with no cites", () => {
    expect(extractAnswerCitations("Just plain text here.")).toEqual([]);
  });
});
