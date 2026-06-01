import { describe, expect, it } from "vitest";
import type { InstalledModule } from "@/parser/bills/scope-filter";
import { applyDisplayRules, runStructuralPass } from "@/parser/bills/structural-pass";

const SF_MODULES: InstalledModule[] = [
  { id: "sf-administrative", code_title: "Administrative Code" },
  { id: "sf-building", code_title: "Building Code" },
  { id: "sf-health", code_title: "Health Code" },
  { id: "sf-planning", code_title: "Planning Code" },
];

describe("runStructuralPass", () => {
  it("captures a single AMEND group with its nested section headers", () => {
    const text = `
Section 4. Chapter 2A of the Administrative Code is hereby amended by
revising Sections 10.04.020 and 10.04.030, to read as follows:

SEC. 10.04.020. PURPOSE.
  Body text here.

SEC. 10.04.030. APPLICABILITY.
  More body.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.module_id).toBe("sf-administrative");
    expect(r.groups[0]?.code_name.toLowerCase()).toContain("administrative code");
    expect(r.groups[0]?.sections.map((s) => s.raw_id)).toEqual(["10.04.020", "10.04.030"]);
    expect(r.has_structural_action).toBe(false);
  });

  it("captures multiple AMEND groups in order and resolves each to a module", () => {
    const text = `
Section 1. Findings.

Section 2. The Health Code is hereby amended by revising Section 41.2:

SEC. 41.2. ANIMAL SHELTER FEES.
  Body.

Section 3. The Planning Code is hereby amended by revising Section 240:

SEC. 240. USE DISTRICTS.
  Body.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.module_id)).toEqual(["sf-health", "sf-planning"]);
    expect(r.groups[0]?.sections.map((s) => s.raw_id)).toEqual(["41.2"]);
    expect(r.groups[1]?.sections.map((s) => s.raw_id)).toEqual(["240"]);
  });

  it("marks structural_change when 'by adding Chapter X' is present", () => {
    const text = `
Section 1. The Administrative Code is hereby amended by adding Chapter 94C
to establish a Climate Emergency Mobilization Office.

SEC. 94C.1. FINDINGS.
  Body.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.has_structural_action).toBe(true);
    expect(r.structural_action_text).toMatch(/by\s+adding\s+Chapter\s+94C/i);
    // Group still emitted so the renderer can show the chapter scope.
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.module_id).toBe("sf-administrative");
  });

  it("leaves module_id null when the code name has no installed match", () => {
    const text = `
Section 4. The Labor and Employment Code is hereby amended by revising Section 5.0:

SEC. 5.0. LEAVE PROTECTIONS.
  Body.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.module_id).toBeNull();
  });
});

describe("applyDisplayRules", () => {
  it("returns the bare lowercase id when no rules are given", () => {
    expect(applyDisplayRules("10.04.020", undefined)).toEqual(["10.04.020"]);
  });

  it("emits both bare and prefixed candidates with a single prefix rule", () => {
    expect(applyDisplayRules("102A", { prefix: "b", alpha_suffix: true })).toEqual([
      "102a",
      "b102a",
    ]);
  });

  it("strips a trailing .0 when configured (plumbing/housing pattern)", () => {
    expect(applyDisplayRules("109.0", { prefix: "p", strip_trailing_zero: true })).toEqual([
      "109",
      "p109",
    ]);
  });

  it("emits a candidate per extra_prefix entry (charter appendix-A/D pattern)", () => {
    expect(applyDisplayRules("4-101", { prefix: null, extra_prefixes: ["a", "d"] })).toEqual([
      "4-101",
      "a4-101",
      "d4-101",
    ]);
  });
});
