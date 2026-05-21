import { describe, expect, it } from "vitest";
import { canonicalizeNum, rank, type SearchableItem } from "../../../src/ui/command-palette/score";

function section(
  num: string,
  name: string,
  path = "Port Code · ARTICLE 1",
  sectionId = num.replace(/[§\s]/g, ""),
  moduleId = "sf-port",
): SearchableItem {
  return {
    kind: "section",
    moduleId,
    sectionId,
    num,
    name,
    path,
    numCanonical: canonicalizeNum(num),
    nameLower: name.toLowerCase(),
    pathLower: path.toLowerCase(),
  };
}

function definedTerm(term: string, moduleId = "sf-port", definers = ["1.1"]): SearchableItem {
  return {
    kind: "defined-term",
    moduleId,
    term,
    termLower: term.toLowerCase(),
    definers,
  };
}

describe("canonicalizeNum", () => {
  it("strips § sigil and all whitespace", () => {
    expect(canonicalizeNum("§ 1.01")).toBe("1.01");
    expect(canonicalizeNum("§ 133")).toBe("133"); // non-breaking space
    expect(canonicalizeNum("  §   133  ")).toBe("133");
  });
  it("preserves dots, dashes, and other separators inside the number", () => {
    expect(canonicalizeNum("§ 10.04.020")).toBe("10.04.020");
    expect(canonicalizeNum("§ 1-A")).toBe("1-a");
  });
  it("lowercases", () => {
    expect(canonicalizeNum("§ 109.A")).toBe("109.a");
  });
});

describe("rank — empty query", () => {
  it("returns input unchanged when q is empty", () => {
    const items = [section("§ 1.1", "A"), section("§ 1.2", "B"), section("§ 1.3", "C")];
    const result = rank(items, "");
    expect(result).toEqual(items);
  });
  it("returns input unchanged when q is whitespace-only", () => {
    const items = [section("§ 1.1", "A"), section("§ 1.2", "B")];
    expect(rank(items, "   ")).toEqual(items);
  });
  it("returns input mode-filtered when q is empty in defined-term mode", () => {
    const items: SearchableItem[] = [
      section("§ 1.1", "A"),
      definedTerm("Director"),
      section("§ 1.2", "B"),
    ];
    const result = rank(items, "", "defined-term");
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("defined-term");
  });
});

describe("rank — U1 §133 headline bug", () => {
  it("§ 133 ranks above § 1.33, § 1330, § 11.33 when typing '133'", () => {
    // The placeholder palette's `${num} ${name} ${path}.includes(q)`
    // would surface all four — and would order them by tree position,
    // which puts the user's actual target wherever it happens to land.
    const items = [
      section("§ 1.33", "Subpart"),
      section("§ 1330", "Different"),
      section("§ 11.33", "Other"),
      section("§ 133", "Target"),
    ];
    const result = rank(items, "133");
    expect(result[0]?.kind === "section" ? result[0].num : null).toBe("§ 133");
    // §1.33's canonical "1.33" does NOT contain "133" — the dot
    // interrupts. §11.33 similarly. So those two drop out completely
    // (numCanonical miss + no name/path match). §133 and §1330 win.
    const nums = result
      .filter((r): r is Extract<SearchableItem, { kind: "section" }> => r.kind === "section")
      .map((r) => r.num);
    expect(nums).toEqual(["§ 133", "§ 1330"]);
  });
  it("typing '1.33' matches § 1.33 exact ahead of § 1.330 prefix", () => {
    const items = [section("§ 1.330", "Long"), section("§ 1.33", "Short")];
    const result = rank(items, "1.33");
    expect(result[0]?.kind === "section" ? result[0].num : null).toBe("§ 1.33");
  });
});

describe("rank — field weighting", () => {
  it("numCanonical exact beats name exact", () => {
    const numHit = section("§ habitable", "Other");
    const nameHit = section("§ 999", "habitable");
    const result = rank([nameHit, numHit], "habitable");
    expect(result[0]).toBe(numHit);
  });
  it("name exact beats path substring", () => {
    const nameHit = section("§ 1", "habitable", "Port Code · CHAPTER 99");
    const pathHit = section("§ 2", "Other thing", "habitable · CHAPTER 99");
    const result = rank([pathHit, nameHit], "habitable");
    expect(result[0]).toBe(nameHit);
  });
  it("name prefix beats name substring at same position", () => {
    const prefix = section("§ 1", "habitable Room");
    const substring = section("§ 2", "The habitable Room");
    const result = rank([substring, prefix], "habitable");
    expect(result[0]).toBe(prefix);
  });
  it("earlier substring position beats later substring position in the same field", () => {
    const early = section("§ 1", "Foo habitable bar");
    const late = section("§ 2", "Foo bar baz qux habitable");
    const result = rank([late, early], "habitable");
    expect(result[0]).toBe(early);
  });
});

describe("rank — case folding and trimming (Codex F3)", () => {
  it("case-folds both query and item fields for sections", () => {
    const items = [section("§ 1", "HABITABLE Room")];
    expect(rank(items, "habitable")).toHaveLength(1);
    expect(rank(items, "HABITABLE")).toHaveLength(1);
  });
  it("trims the query", () => {
    const items = [section("§ 1", "habitable Room")];
    expect(rank(items, "  habitable  ")).toHaveLength(1);
  });
});

describe("rank — defined-term mode (Codex F3 + D5)", () => {
  it("filters to defined-term items when mode is defined-term", () => {
    const items: SearchableItem[] = [
      section("§ 1", "Director Office"), // would match in section mode
      definedTerm("Director"),
      section("§ 2", "Other"),
    ];
    const result = rank(items, "director", "defined-term");
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("defined-term");
  });
  it("ranks exact term match above prefix match", () => {
    const items: SearchableItem[] = [
      definedTerm("Directorate", "sf-port"),
      definedTerm("Director", "sf-port"),
    ];
    const result = rank(items, "director", "defined-term");
    expect(result[0]?.kind === "defined-term" ? result[0].term : null).toBe("Director");
  });
  it("preserves per-(term, module) rows for cross-module collisions (D5)", () => {
    // The aggregator emits two rows for "Director" across modules; the
    // scorer must keep both — silent collapse across modules would be
    // materially wrong for legal reading.
    const items: SearchableItem[] = [
      definedTerm("Director", "sf-port"),
      definedTerm("Director", "sf-administrative"),
    ];
    const result = rank(items, "Director", "defined-term");
    expect(result).toHaveLength(2);
    const modules = result
      .filter(
        (r): r is Extract<SearchableItem, { kind: "defined-term" }> => r.kind === "defined-term",
      )
      .map((r) => r.moduleId);
    expect(modules.sort()).toEqual(["sf-administrative", "sf-port"]);
  });
});

describe("rank — F7 filter-before-sort", () => {
  it("drops items scoring 0 (no match in any field)", () => {
    const items = [
      section("§ 1", "Definitions"),
      section("§ 2", "Commission"),
      section("§ 3", "Scope"),
    ];
    const result = rank(items, "habitable");
    expect(result).toEqual([]);
  });
});

describe("rank — stable sort on ties", () => {
  it("preserves input order when scores tie", () => {
    // Both items get the same numCanonical exact score (1000).
    // They tie; original index ordering breaks the tie.
    const a = section("§ 1", "A");
    const b = section("§ 1", "B");
    const result = rank([a, b], "1");
    // "1" against numCanonical "1": exact match — both score 1000.
    expect(result).toEqual([a, b]);
  });
});

describe("rank — F1 canonical-num query normalization", () => {
  it("query '§ 133' matches § 133 (sigil tolerated in input)", () => {
    const items = [section("§ 1330", "X"), section("§ 133", "Y")];
    const result = rank(items, "§ 133");
    expect(result[0]?.kind === "section" ? result[0].num : null).toBe("§ 133");
  });
  it("query '1.01.010' matches § 1.01.010 exact even with whitespace", () => {
    const items = [section("§ 1.01.010", "Y"), section("§ 1.01.020", "X")];
    const result = rank(items, " 1.01.010 ");
    expect(result[0]?.kind === "section" ? result[0].num : null).toBe("§ 1.01.010");
  });
});

describe("rank — multi-term AND", () => {
  it("'133 planning' narrows § 133 to the Planning Code module", () => {
    // The dogfood case: § 133 exists in multiple codes; typing the
    // module's name after the number must filter to that module only.
    const planning = section("§ 133", "Side Yards", "Planning Code · ARTICLE 1");
    const police = section("§ 133", "Police Powers", "Police Code · CHAPTER 1");
    const result = rank([planning, police], "133 planning");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(planning);
  });
  it("token order does not matter (AND is commutative)", () => {
    const planning = section("§ 133", "Side Yards", "Planning Code · ARTICLE 1");
    const police = section("§ 133", "Police Powers", "Police Code · CHAPTER 1");
    const result = rank([planning, police], "planning 133");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(planning);
  });
  it("drops items where any token fails to match", () => {
    const a = section("§ 1", "habitable Room", "Port Code");
    const b = section("§ 2", "Other", "Port Code · habitable area");
    // Token "habitable" matches name on `a` and path on `b`. Token
    // "zzz" matches neither → both drop.
    const result = rank([a, b], "habitable zzz");
    expect(result).toEqual([]);
  });
  it("per-token score uses best field, summed across tokens", () => {
    // Token "habitable": exact name on `exactName` (400), prefix on
    // `prefixName` (300). Token "port": path substring at pos 0 on
    // both (50). Totals: exactName=450, prefixName=350.
    const exactName = section("§ 1", "habitable", "Port Code · ARTICLE 1");
    const prefixName = section("§ 2", "habitable Other Thing", "Port Code · ARTICLE 1");
    const result = rank([prefixName, exactName], "habitable port");
    expect(result[0]).toBe(exactName);
    expect(result[1]).toBe(prefixName);
  });
  it("multi-term works in defined-term mode", () => {
    // The user types `:def director building` and expects "Director of
    // Building Inspection" to surface over a plain "Director" row.
    const directorOfBuilding = definedTerm("Director of Building Inspection");
    const director = definedTerm("Director");
    const result = rank([director, directorOfBuilding], "director building", "defined-term");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(directorOfBuilding);
  });
  it("'§ 133 planning' (sigil + multi-token) tokenizes correctly", () => {
    // Sigil strip must happen before tokenization or "§" becomes its own
    // token and drops every row.
    const planning = section("§ 133", "Side Yards", "Planning Code · ARTICLE 1");
    const result = rank([planning], "§ 133 planning");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(planning);
  });
  it("max-first sort: exact num hit beats prefix-num + name-exact across tokens", () => {
    // The codex-flagged ranking trap. With a pure sum:
    //   target  → 1000 (num exact) + 50 (path)        = 1050
    //   decoy   → 800  (num prefix) + 400 (name exact) = 1200
    // …decoy sorts above target, which would re-surface the U1 bug
    // ("typing '133' should pick § 133, not § 1330") in multi-token
    // form. Max-first lex sort keeps target on top: max(1000) > max(800).
    const target = section("§ 133", "Side Yards", "Planning Code · ARTICLE 1");
    const decoy = section("§ 1330", "Planning", "Some Code · CHAPTER X");
    const result = rank([decoy, target], "133 planning");
    expect(result[0]).toBe(target);
    expect(result[1]).toBe(decoy);
  });
});
