// Title-prettifier unit tests. Hit the rule branches that the parser
// would otherwise have to integration-test (small-word lowercase,
// hyphen capitalization, apostrophe handling, acronym whitelist,
// bracketed punctuation, mixed-case passthrough, non-ASCII).

import { describe, expect, it } from "vitest";
import { KNOWN_ACRONYMS, prettifyTitle } from "@/corpus/pretty-title";

describe("prettifyTitle — basic title-case rules", () => {
  it("title-cases a simple ALL-CAPS phrase", () => {
    expect(prettifyTitle("RENT LIMITATIONS")).toBe("Rent Limitations");
  });

  it("preserves leading bracket punctuation: [REPEALED.] → [Repealed.]", () => {
    expect(prettifyTitle("[REPEALED.]")).toBe("[Repealed.]");
  });

  it("capitalizes after hyphens: CITY-OPERATED → City-Operated", () => {
    expect(prettifyTitle("CITY-OPERATED FARMERS' MARKETS")).toBe("City-Operated Farmers' Markets");
  });

  it("preserves apostrophes inside possessives without re-capitalizing", () => {
    expect(prettifyTitle("FARMERS' MARKETS")).toBe("Farmers' Markets");
  });

  it("lowercases small words in the interior, capitalizes at start / end", () => {
    expect(prettifyTitle("RESIDENTIAL RENT STABILIZATION AND ARBITRATION ORDINANCE")).toBe(
      "Residential Rent Stabilization and Arbitration Ordinance",
    );
  });

  it("first and last words always capitalize, even when they would otherwise be small", () => {
    expect(prettifyTitle("OF THE PEOPLE BY THE")).toBe("Of the People by The");
  });
});

describe("prettifyTitle — acronym whitelist", () => {
  it("preserves CEQA / NEPA / DNA / HIV / SFMTA / BART and friends", () => {
    expect(prettifyTitle("CEQA REVIEW")).toBe("CEQA Review");
    expect(prettifyTitle("NEPA AND CEQA")).toBe("NEPA and CEQA");
    expect(prettifyTitle("HIV AND AIDS")).toBe("HIV and AIDS");
    expect(prettifyTitle("SFMTA POLICY")).toBe("SFMTA Policy");
    expect(prettifyTitle("BART STATION ACCESS")).toBe("BART Station Access");
  });

  it('preserves "U.S." inside a longer title', () => {
    expect(prettifyTitle("U.S. DEPARTMENT OF LABOR")).toBe("U.S. Department of Labor");
  });

  it("whitelist coverage matches the documented set", () => {
    expect(KNOWN_ACRONYMS.has("CEQA")).toBe(true);
    expect(KNOWN_ACRONYMS.has("U.S.")).toBe(true);
    expect(KNOWN_ACRONYMS.has("LGBT")).toBe(true);
    // Sanity: a non-listed acronym does NOT survive the whitelist.
    expect(prettifyTitle("NASA POLICY")).toBe("Nasa Policy");
  });
});

describe("prettifyTitle — per-token lowercase preservation", () => {
  it("preserves section-reference letters in an otherwise ALL-CAPS title", () => {
    // The original bug: "(a)" disqualified the whole title from
    // prettification because the loader used a string-shape heuristic
    // ("is the entire string uppercase?"). Per-word logic preserves
    // the lowercase "a" token while still prettifying the rest.
    expect(prettifyTitle("TENANT RIGHTS IN CERTAIN DISPLACEMENTS UNDER SECTION 37.9(a)(13)")).toBe(
      "Tenant Rights in Certain Displacements Under Section 37.9(a)(13)",
    );
  });

  it("preserves chained section refs like (a)(1)(B)", () => {
    // Mixed-case ref letters: lowercase tokens preserved, uppercase
    // tokens re-cased per the same rules as outside-the-paren words.
    expect(prettifyTitle("RULES (a)(1)(B) APPLY")).toBe("Rules (a)(1)(B) Apply");
  });

  it("preserves a trailing subsection-only ref", () => {
    expect(prettifyTitle("PENALTIES UNDER SUBSECTION (b)")).toBe("Penalties Under Subsection (b)");
  });
});

describe("prettifyTitle — pass-through cases", () => {
  it("returns a fully mixed-case title unchanged", () => {
    // Every token has at least one lowercase letter → every token is
    // preserved verbatim. Authors of mixed-case sources (or callers
    // who want a no-op) get exact identity.
    expect(prettifyTitle("Already Cased Title")).toBe("Already Cased Title");
    expect(prettifyTitle("camelCaseInput")).toBe("camelCaseInput");
  });

  it("returns empty / non-letter strings unchanged", () => {
    expect(prettifyTitle("")).toBe("");
    expect(prettifyTitle("12345")).toBe("12345");
    expect(prettifyTitle("[]")).toBe("[]");
  });

  it("non-ASCII characters survive the transform", () => {
    // Unicode-aware tokenization keeps accented letters as part of
    // the word so locale-aware lowercase produces "café" / "musée".
    // "Et" stays capitalized because it isn't in the English
    // small-word list (the corpus is English; French / Spanish
    // small-word rules can be added later when a real jurisdiction
    // needs them).
    expect(prettifyTitle("CAFÉ ET MUSÉE")).toBe("Café Et Musée");
    expect(prettifyTitle("DEPARTMENT — INTERIM")).toBe("Department — Interim");
  });
});
