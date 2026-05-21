import { describe, expect, it } from "vitest";
import { allModules, findModuleByPhrase, getModule } from "@/citations/module-registry";
import type { ModuleId } from "@/types/identifiers";
import { ModuleIdSchema } from "@/types/identifiers";

describe("module-registry — schema integrity", () => {
  const modules = allModules();

  it("registers at least all 29 California codes plus federal entries", () => {
    expect(modules.length).toBeGreaterThanOrEqual(31);
  });

  it("every module_id is a valid ModuleId slug", () => {
    for (const m of modules) {
      expect(ModuleIdSchema.safeParse(m.module_id).success).toBe(true);
    }
  });

  it("every entry has a non-empty display_name", () => {
    for (const m of modules) {
      expect(m.display_name.length).toBeGreaterThan(0);
    }
  });

  it("module_ids are unique", () => {
    const ids = modules.map((m) => m.module_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getModule", () => {
  it("returns the registered entry for a known module_id", () => {
    const entry = getModule("ca-vehicle" as ModuleId);
    expect(entry?.display_name).toBe("California Vehicle Code");
  });

  it("returns null for an unknown module_id", () => {
    expect(getModule("ca-nonexistent" as ModuleId)).toBeNull();
  });
});

describe("findModuleByPhrase — round-trip", () => {
  // Phrase → expected module_id. Covers each registered phrase pattern
  // at least once; new phrases must add a row here per the
  // test-each-path-once rule.
  const cases: ReadonlyArray<[string, string]> = [
    ["Business and Professions Code", "ca-business-professions"],
    ["Bus. & Prof. Code", "ca-business-professions"],
    ["Civil Code", "ca-civil"],
    ["Cal. Civ. Code", "ca-civil"],
    ["Code of Civil Procedure", "ca-civil-procedure"],
    ["C.C.P.", "ca-civil-procedure"],
    ["Commercial Code", "ca-commercial"],
    ["Corporations Code", "ca-corporations"],
    ["Education Code", "ca-education"],
    ["Elections Code", "ca-elections"],
    ["Evidence Code", "ca-evidence"],
    ["Family Code", "ca-family"],
    ["Financial Code", "ca-financial"],
    ["Fish and Game Code", "ca-fish-game"],
    ["Food and Agricultural Code", "ca-food-agriculture"],
    ["Government Code", "ca-government"],
    ["Gov't Code", "ca-government"],
    ["Harbors and Navigation Code", "ca-harbors-navigation"],
    ["Health and Safety Code", "ca-health-safety"],
    ["Insurance Code", "ca-insurance"],
    ["Labor Code", "ca-labor"],
    ["Mil. and Vet. Code", "ca-military-veterans"],
    ["Penal Code", "ca-penal"],
    ["Probate Code", "ca-probate"],
    ["Public Contract Code", "ca-public-contract"],
    ["Public Resources Code", "ca-public-resources"],
    ["Cal. Pub. Res. Code", "ca-public-resources"],
    ["Public Utilities Code", "ca-public-utilities"],
    ["Revenue and Taxation Code", "ca-revenue-taxation"],
    ["Streets and Highways Code", "ca-streets-highways"],
    ["Unemployment Insurance Code", "ca-unemployment-insurance"],
    ["Vehicle Code", "ca-vehicle"],
    ["CVC", "ca-vehicle"],
    ["Water Code", "ca-water"],
    ["Welfare and Institutions Code", "ca-welfare-institutions"],
    ["U.S.C.", "us-code"],
    ["USC", "us-code"],
    ["C.F.R.", "us-cfr"],
    ["Code of Federal Regulations", "us-cfr"],
  ];

  it.each(cases)("%s → %s", (phrase, expected) => {
    expect(findModuleByPhrase(phrase)?.module_id).toBe(expected);
  });

  it("returns null when no phrase matches", () => {
    expect(findModuleByPhrase("Hogwarts Charter of Magical Education")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(findModuleByPhrase("")).toBeNull();
  });
});
