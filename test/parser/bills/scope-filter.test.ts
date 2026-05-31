import { describe, expect, it } from "vitest";
import { classifyBillTitle, type InstalledModule } from "@/parser/bills/scope-filter";

const SF_MODULES: InstalledModule[] = [
  { id: "sf-administrative", code_title: "Administrative Code" },
  { id: "sf-building", code_title: "Building Code" },
  { id: "sf-business", code_title: "Business and Tax Regulations Code" },
  { id: "sf-charter", code_title: "Charter" },
  { id: "sf-health", code_title: "Health Code" },
  { id: "sf-planning", code_title: "Planning Code" },
  { id: "sf-police", code_title: "Police Code" },
  { id: "sf-publicworks", code_title: "Public Works Code" },
];

describe("classifyBillTitle", () => {
  it("classifies amending titles as Class A and resolves single-code stubs", () => {
    const r = classifyBillTitle(
      "Ordinance amending the Planning Code to require larger setbacks.",
      SF_MODULES,
    );
    expect(r.class).toBe("A");
    expect(r.touched_code_stubs).toEqual(["Planning Code"]);
    expect(r.touched_modules).toEqual(["sf-planning"]);
    expect(r.not_installed_modules).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it("classifies multi-code amendment with Oxford-comma stub list", () => {
    const r = classifyBillTitle(
      "Ordinance amending the Administrative Code, Building Code, and Police Code to update fees.",
      SF_MODULES,
    );
    expect(r.class).toBe("A");
    expect(r.touched_modules).toEqual(["sf-administrative", "sf-building", "sf-police"]);
  });

  it("prefers the longer stub when two are prefix-overlapping (Business and Tax > Business)", () => {
    const r = classifyBillTitle(
      "Ordinance amending the Business and Tax Regulations Code to add filing fees.",
      SF_MODULES,
    );
    expect(r.class).toBe("A");
    expect(r.touched_modules).toEqual(["sf-business"]);
  });

  it("classifies waiving titles as Class B with no touched modules", () => {
    const r = classifyBillTitle(
      "Ordinance waiving Public Works Code requirements for one-time festival permits.",
      SF_MODULES,
    );
    expect(r.class).toBe("B");
    expect(r.touched_code_stubs).toEqual([]);
    expect(r.touched_modules).toEqual([]);
  });

  it("classifies appropriations titles as Class B", () => {
    const r = classifyBillTitle("Ordinance appropriating $42M for SFMTA operations.", SF_MODULES);
    expect(r.class).toBe("B");
  });

  it("classifies adding titles as Class A (new-chapter pattern)", () => {
    const r = classifyBillTitle(
      "Ordinance adding Chapter 94C to the Administrative Code establishing a new office.",
      SF_MODULES,
    );
    // The "adding ... to the {Code}" grammar is parsed by the alternate
    // sliceStubRegion path; we just assert the verb is Class A.
    expect(r.class).toBe("A");
  });

  it("places a known alias (Building Inspection Code) into touched_modules", () => {
    const r = classifyBillTitle(
      "Ordinance amending the Building Inspection Code to add accessibility provisions.",
      SF_MODULES,
    );
    expect(r.class).toBe("A");
    expect(r.touched_modules).toEqual(["sf-building"]);
    expect(r.unresolved).toEqual([]);
  });

  it("reports unresolved stubs when a code has no installed module + no alias", () => {
    // Labor and Employment Code is real (per the spike) but isn't installed
    // and has no alias entry. It should land in `unresolved`.
    const r = classifyBillTitle(
      "Ordinance amending the Labor and Employment Code to extend leave protections.",
      SF_MODULES,
    );
    expect(r.class).toBe("A");
    expect(r.touched_modules).toEqual([]);
    expect(r.unresolved).toEqual(["Labor and Employment Code"]);
  });

  it("matches Charter without the 'Code' suffix", () => {
    const r = classifyBillTitle(
      "Ordinance amending the Charter to extend term limits.",
      SF_MODULES,
    );
    expect(r.class).toBe("A");
    expect(r.touched_modules).toEqual(["sf-charter"]);
  });
});
