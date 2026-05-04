import { describe, expect, it } from "vitest";
import { computeDefinitions } from "@/parser/definitions";
import { DefinitionsFileSchema, type SectionFile } from "@/types";

function section(id: string, defined_terms: string[]): SectionFile {
  return {
    kind: "section",
    id,
    title: id,
    text: "",
    citations: [],
    defined_terms,
    hierarchy: ["title-10", "ch-10.04"],
    editorial_status: "active",
  };
}

describe("computeDefinitions", () => {
  it("produces a single-section term entry of length 1", () => {
    const defs = computeDefinitions([section("10.04.020", ["Director of Transportation"])]);
    expect(defs["Director of Transportation"]).toEqual([{ defined_in_section: "10.04.020" }]);
  });

  it("produces a multi-section term entry of length > 1", () => {
    const defs = computeDefinitions([
      section("10.04.020", ["Bicycle"]),
      section("10.04.040", ["Bicycle"]),
    ]);
    expect(defs.Bicycle).toEqual([
      { defined_in_section: "10.04.020" },
      { defined_in_section: "10.04.040" },
    ]);
  });

  it("dedupes per (term, section): same term twice in one section -> one entry", () => {
    const defs = computeDefinitions([section("10.04.020", ["Bicycle", "Bicycle"])]);
    expect(defs.Bicycle).toHaveLength(1);
  });

  it("returns an empty object when no sections define terms", () => {
    expect(computeDefinitions([section("10.04.010", [])])).toEqual({});
  });

  it("output validates against DefinitionsFileSchema", () => {
    const defs = computeDefinitions([
      section("10.04.020", ["Director of Transportation", "Bicycle"]),
      section("10.04.040", ["Bicycle"]),
    ]);
    expect(DefinitionsFileSchema.safeParse(defs).success).toBe(true);
  });

  it("entries are sorted by section_id (deterministic)", () => {
    const defs = computeDefinitions([
      section("10.04.040", ["Bicycle"]),
      section("10.04.020", ["Bicycle"]),
    ]);
    expect(defs.Bicycle?.map((e) => e.defined_in_section)).toEqual(["10.04.020", "10.04.040"]);
  });
});
