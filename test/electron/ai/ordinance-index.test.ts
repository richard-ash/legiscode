// Ordinance-index tests. Constructs a synthetic AiCorpusHandle with
// inline AMENDMENT HISTORY prose and asserts the regex extraction,
// dedupe, and sort order match the patterns the SF AmLegal corpus
// actually emits.

import { describe, expect, it } from "vitest";
import {
  __resetOrdinanceIndexForTests,
  getOrdinanceIndex,
} from "../../../electron/ai/ordinance-index";
import type { AiCorpusHandle } from "../../../electron/corpus-loader";

function makeHandle(): AiCorpusHandle {
  __resetOrdinanceIndexForTests();
  return {
    corpusHash: "abc123",
    rootDir: "/dev/null",
    modules: [
      {
        id: "sf-planning",
        name: "Planning Code",
        codeTitle: "Planning",
        jurisdiction: "San Francisco",
        sections: [
          {
            section: {
              kind: "section",
              id: "401a",
              display_label: "401A",
              title: "Findings",
              text: "(a) Findings text. (Added by Ord. 50-15, File No. 150149, App. 4/24/2015, Eff. 5/24/2015; amended by Ord. 188-15, File No. 150871, App. 11/4/2015, Eff. 12/4/2015; Ord. 193-23, File No. 230764, App. 9/15/2023, Eff. 10/16/2023)",
              citations: [],
              defined_terms: [],
              hierarchy: ["Planning"],
              editorial_status: "active",
              body: [],
              article: null,
            },
          },
          {
            section: {
              kind: "section",
              id: "415",
              display_label: "415",
              title: "Inclusionary",
              text: "(Added by Ord. 193-23, File No. 230764, App. 9/15/2023, Eff. 10/16/2023)",
              citations: [],
              defined_terms: [],
              hierarchy: ["Planning"],
              editorial_status: "active",
              body: [],
              article: null,
            },
          },
          {
            section: {
              kind: "section",
              id: "1.99",
              display_label: "1.99",
              title: "Vintage",
              text: "(Added by Ord. 153-93, App. 5/25/93)",
              citations: [],
              defined_terms: [],
              hierarchy: ["Planning"],
              editorial_status: "active",
              body: [],
              article: null,
            },
          },
        ],
        definitions: [],
        articles: [],
        sessionBills: [],
      },
    ],
    getSection() {
      return null;
    },
  };
}

describe("ordinance index", () => {
  it("extracts ordinance refs from AMENDMENT HISTORY prose", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const result = index.recent({ limit: 10 });
    expect(result.total).toBeGreaterThanOrEqual(3);
    const numbers = result.ordinances.map((o) => o.ordinance_number);
    expect(numbers).toContain("50-15");
    expect(numbers).toContain("188-15");
    expect(numbers).toContain("193-23");
    expect(numbers).toContain("153-93");
  });

  it("parses approved/effective dates into ISO", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const result = index.recent({ limit: 10 });
    const ord193 = result.ordinances.find((o) => o.ordinance_number === "193-23");
    expect(ord193?.approved_at).toBe("2023-09-15");
    expect(ord193?.effective_at).toBe("2023-10-16");
    expect(ord193?.file_number).toBe("230764");
  });

  it("expands 2-digit years using the ordinance year as a hint", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const result = index.recent({ limit: 10 });
    const ord153 = result.ordinances.find((o) => o.ordinance_number === "153-93");
    expect(ord153?.approved_at).toBe("1993-05-25");
    expect(ord153?.year).toBe(1993);
  });

  it("dedupes the same ordinance across multiple sections, merging cited_in", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const result = index.recent({ limit: 10 });
    const ord193 = result.ordinances.find((o) => o.ordinance_number === "193-23");
    expect(ord193?.cited_in).toHaveLength(2);
    const ids = ord193?.cited_in.map((c) => c.section_id);
    expect(ids).toContain("401a");
    expect(ids).toContain("415");
  });

  it("sorts newest first (effective date wins over approved + ord number)", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const result = index.recent({ limit: 10 });
    // 193-23 (Eff 2023-10-16) must come before 188-15 (Eff 2015-12-04)
    // which must come before 50-15 (Eff 2015-05-24) which must come
    // before 153-93 (App 1993-05-25, no Eff).
    const order = result.ordinances.map((o) => o.ordinance_number);
    const idx193 = order.indexOf("193-23");
    const idx188 = order.indexOf("188-15");
    const idx50 = order.indexOf("50-15");
    const idx153 = order.indexOf("153-93");
    expect(idx193).toBeLessThan(idx188);
    expect(idx188).toBeLessThan(idx50);
    expect(idx50).toBeLessThan(idx153);
  });

  it("filters by year", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const result = index.recent({ year: 2015, limit: 10 });
    const years = result.ordinances.map((o) => o.year);
    expect(years.every((y) => y === 2015)).toBe(true);
    expect(years.length).toBeGreaterThanOrEqual(2);
  });

  it("bySection returns the ordinances cited in that section", () => {
    const handle = makeHandle();
    const index = getOrdinanceIndex(handle);
    const ords = index.bySection("sf-planning", "401a");
    const numbers = ords.map((o) => o.ordinance_number);
    expect(numbers).toContain("50-15");
    expect(numbers).toContain("188-15");
    expect(numbers).toContain("193-23");
  });
});
