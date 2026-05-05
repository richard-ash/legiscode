import { describe, expect, it } from "vitest";
import { computeReferences } from "@/parser/references";
import type { Citation, EntryRef, SectionFile } from "@/types";

const MODULE_ID = "sf-transportation";

function section(id: string, citations: Citation[], defined_terms: string[] = []): SectionFile {
  return {
    kind: "section",
    id,
    title: id,
    text: "",
    citations,
    defined_terms,
    hierarchy: ["title-10", "ch-10.04"],
    editorial_status: "active",
  };
}

const internal = (sectionId: string): Citation => ({
  display_text: `§ ${sectionId}`,
  target: { kind: "internal", section_id: sectionId },
});

const external = (raw: string): Citation => ({
  display_text: raw,
  target: { kind: "external", raw },
});

const crossModule = (moduleId: string, sectionId: string): Citation => ({
  display_text: `(${moduleId}) § ${sectionId}`,
  target: { kind: "cross_module", module_id: moduleId, section_id: sectionId },
});

const sectionRef = (id: string): EntryRef => ({
  module_id: MODULE_ID,
  kind: "section",
  id,
});

describe("computeReferences", () => {
  it("populates citations verbatim and computes internal cited_by", () => {
    const sections = [
      section("10.04.010", []),
      section("10.04.020", [internal("10.04.030")]),
      section("10.04.030", [internal("10.04.020")]),
    ];
    const refs = computeReferences(sections, MODULE_ID);
    expect(refs["10.04.020"]?.cited_by).toEqual([sectionRef("10.04.030")]);
    expect(refs["10.04.030"]?.cited_by).toEqual([sectionRef("10.04.020")]);
    expect(refs["10.04.010"]?.cited_by).toEqual([]);
  });

  it("bidirectional invariant: every cited_by has a matching internal forward edge", () => {
    const sections = [
      section("a", [internal("b"), internal("c")]),
      section("b", [internal("c")]),
      section("c", []),
    ];
    const refs = computeReferences(sections, MODULE_ID);
    for (const [target, entry] of Object.entries(refs)) {
      for (const citer of entry.cited_by) {
        // Every cited_by entry must be a section in this module with a real
        // internal edge back at the target.
        expect(citer.module_id).toBe(MODULE_ID);
        expect(citer.kind).toBe("section");
        const citerCites = refs[citer.id]?.citations ?? [];
        const hasInternalEdge = citerCites.some(
          (c) => c.target.kind === "internal" && c.target.section_id === target,
        );
        expect(hasInternalEdge).toBe(true);
      }
    }
  });

  it("external + cross_module appear in citations but never in any cited_by", () => {
    const sections = [
      section("a", [external("Cal. Veh. Code § 22358"), crossModule("ca-vehicle", "22358")]),
      section("b", [internal("a")]),
    ];
    const refs = computeReferences(sections, MODULE_ID);
    expect(refs.a?.citations).toHaveLength(2);
    expect(refs.a?.cited_by).toEqual([sectionRef("b")]);
    // No section in this module has an entry under "ca-vehicle:22358".
    expect(Object.keys(refs)).not.toContain("22358");
    // No cited_by list anywhere should reference a cross-module section_id.
    for (const entry of Object.values(refs)) {
      const ids = entry.cited_by.map((ref) => ref.id);
      expect(ids).not.toContain("22358");
    }
  });

  it("broken targets (internal citation to a missing section) are tolerated, not crashed", () => {
    const sections = [section("a", [internal("ghost")])];
    const refs = computeReferences(sections, MODULE_ID);
    expect(refs.a?.citations).toHaveLength(1);
    expect(refs.a?.cited_by).toEqual([]);
    expect(refs.ghost).toBeUndefined();
  });

  it("self-citation does not add the section to its own cited_by", () => {
    const sections = [section("a", [internal("a")])];
    const refs = computeReferences(sections, MODULE_ID);
    expect(refs.a?.cited_by).toEqual([]);
  });

  it("cited_by is sorted (deterministic output)", () => {
    const sections = [
      section("z", [internal("a")]),
      section("m", [internal("a")]),
      section("a", []),
    ];
    const refs = computeReferences(sections, MODULE_ID);
    expect(refs.a?.cited_by).toEqual([sectionRef("m"), sectionRef("z")]);
  });

  it("stamps the supplied moduleId on every cited_by entry", () => {
    const sections = [section("a", [internal("b")]), section("b", [])];
    const refs = computeReferences(sections, "sf-charter");
    expect(refs.b?.cited_by).toEqual([{ module_id: "sf-charter", kind: "section", id: "a" }]);
  });
});
