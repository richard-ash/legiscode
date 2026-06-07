import { describe, expect, it } from "vitest";
import type { InstalledModule } from "@/parser/bills/scope-filter";
import { applyDisplayRules, runStructuralPass } from "@/parser/bills/structural-pass";

const SF_MODULES: InstalledModule[] = [
  { id: "sf-administrative", code_title: "Administrative Code" },
  { id: "sf-building", code_title: "Building Code" },
  { id: "sf-health", code_title: "Health Code" },
  { id: "sf-planning", code_title: "Planning Code" },
  { id: "sf-transportation", code_title: "Transportation Code" },
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
    expect(r.groups[0]?.targetHeaders.map((s) => s.raw_id)).toEqual(["10.04.020", "10.04.030"]);
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
    expect(r.groups[0]?.targetHeaders.map((s) => s.raw_id)).toEqual(["41.2"]);
    expect(r.groups[1]?.targetHeaders.map((s) => s.raw_id)).toEqual(["240"]);
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

  it("captures preamble_range and closing_range around the AMEND groups", () => {
    const text = `Preamble line one.
Preamble line two.

Section 1. The Health Code is hereby amended by revising Section 41.2:

SEC. 41.2. ANIMAL SHELTER FEES.
  Body.

Section 2. Scope of Ordinance.
Closing boilerplate.`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(1);
    // Preamble: everything before "Section 1." starts.
    const preamble = text.slice(r.preamble_range.start, r.preamble_range.end);
    expect(preamble).toContain("Preamble line one.");
    expect(preamble).toContain("Preamble line two.");
    expect(preamble).not.toContain("Section 1.");
    // Closing: everything after the last group ends (Section 2 boilerplate
    // is NOT an AMEND group — no "Code is hereby amended" clause).
    const closing = text.slice(r.closing_range.start, r.closing_range.end);
    expect(closing).toContain("Section 2. Scope of Ordinance.");
    expect(closing).toContain("Closing boilerplate.");
    expect(closing).not.toContain("SEC. 41.2.");
  });

  it("makes the whole text preamble when no AMEND groups match", () => {
    const text = "Just a paragraph with no ordinance structure at all.";
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(0);
    expect(r.preamble_range).toEqual({ start: 0, end: text.length });
    expect(r.closing_range).toEqual({ start: text.length, end: text.length });
  });

  it("captures a section header whose title wraps onto a second line", () => {
    // Long titles wrap at the SF Legistar template's column width. Before
    // the multi-line-title fix, only the first line was captured and the
    // second line ("OF PUBLIC STREETS.") bled into the section body and
    // polluted the section's diff input against baseline.
    const text = `
Section 4. The Transportation Code is hereby amended by revising Section 6.3:

SEC. 6.3. REQUEST FOR PERMISSION FOR TEMPORARY USE OR OCCUPANCY
OF PUBLIC STREETS.
  (a) Application and Fee Required. Body text follows.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups[0]?.targetHeaders).toHaveLength(1);
    expect(r.groups[0]?.targetHeaders[0]?.title).toBe(
      "REQUEST FOR PERMISSION FOR TEMPORARY USE OR OCCUPANCY OF PUBLIC STREETS.",
    );
    // text_offset_after_header advances past the wrapped title line so the
    // body parser doesn't re-include "OF PUBLIC STREETS." as a body token.
    const sec = r.groups[0]?.targetHeaders[0];
    const after = text.slice(sec?.text_offset_after_header ?? 0, sec?.text_offset_end ?? 0);
    expect(after).not.toContain("OF PUBLIC STREETS.");
  });

  it("accepts `/` inside section titles (compound names like BOARDS/COMMISSIONS)", () => {
    const text = `
Section 4. The Administrative Code is hereby amended by revising Section 10.04.020:

SEC. 10.04.020. PERMITS FOR BOARDS/COMMISSIONS.
  Body text.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups[0]?.targetHeaders[0]?.raw_id).toBe("10.04.020");
    expect(r.groups[0]?.targetHeaders[0]?.title).toBe("PERMITS FOR BOARDS/COMMISSIONS.");
  });

  it("treats ARTICLE N: headers as chapter boundaries that terminate the preceding section", () => {
    // Article headers (`ARTICLE 19A:`) appear between section groups in
    // chapter-spanning bills. Without recognizing them as a boundary the
    // article label leaked into the prior section's body, contaminating
    // the section's diff input with chapter-frame text.
    const text = `
Section 4. The Health Code is hereby amended by revising Sections 1005 and 1006:

SEC. 1005. PENALTIES AND ENFORCEMENT.
  Body of 1005.

ARTICLE 19A:
REGULATING SMOKING IN EATING ESTABLISHMENTS

SEC. 1006. PURPOSE.
  Body of 1006.
`;
    const r = runStructuralPass(text, SF_MODULES);
    const headers = r.groups[0]?.targetHeaders ?? [];
    expect(headers.map((h) => h.raw_id)).toEqual(["1005", "1006"]);
    // §1005's text_offset_end stops at the ARTICLE line so the body
    // parser doesn't include the article label.
    const sec1005 = headers[0];
    const body1005 = text.slice(
      sec1005?.text_offset_after_header ?? 0,
      sec1005?.text_offset_end ?? 0,
    );
    expect(body1005).not.toContain("ARTICLE 19A");
    expect(body1005).not.toContain("REGULATING SMOKING");
    expect(body1005).toContain("Body of 1005.");
  });

  it("matches `are hereby amended` (plural subject — matter 260538 §8 Admin Code)", () => {
    // Real bill text from matter 260538 — second Section 8 amends multiple
    // Administrative Code chapters, so the verb is plural. The old regex
    // accepted only `is hereby amended` and cascaded these headers into
    // the previous (Building Code) group.
    const text = `
Section 8. Section 107A of the Building Code is hereby amended by revising Section 107A.13 to read as follows:

SEC. 107A.13. DEVELOPMENT IMPACT AND IN-LIEU FEES.
  Body of 107A.13.

Section 8. Chapter 5, Article XXIX, and Chapter 10, Article XIII, of the Administrative Code are hereby amended by revising sections 5.29-6, and 10.100-49 respectively, to read as follows:

SEC. 5.29-6. MEETINGS AND PROCEDURES.
  Body of 5.29-6.

SEC. 10.100-49. CITYWIDE AFFORDABLE HOUSING FUND.
  Body of 10.100-49.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.module_id)).toEqual(["sf-building", "sf-administrative"]);
    expect(r.groups[0]?.targetHeaders.map((s) => s.raw_id)).toEqual(["107A.13"]);
    expect(r.groups[1]?.targetHeaders.map((s) => s.raw_id)).toEqual(["5.29-6", "10.100-49"]);
  });

  it("matches `is are hereby amended` (drafter typo — matter 260449 §3 Admin Code)", () => {
    // Real bill text from matter 260449 — the drafter started singular
    // ("is hereby amended") for a singular subject, switched to plural
    // ("Chapters 94A and 94D"), and forgot to delete "is". The Board
    // passed it through. The structural pass has to tolerate the typo.
    const text = `
Section 2. Division I of the Transportation Code is hereby amended by revising Section 6.1:

SEC. 6.1. PURPOSE.
  Body of 6.1.

Section 3. The Chapters 94A and 94D of the Administrative Code is are hereby amended by revising Sections 94A.2, 94A.4, and 94D.2 to read as follows:

SEC. 94A.2. APPLICABILITY.
  Body of 94A.2.

SEC. 94A.4. ENFORCEMENT.
  Body of 94A.4.

SEC. 94D.2. SCOPE.
  Body of 94D.2.
`;
    const r = runStructuralPass(text, SF_MODULES);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.module_id)).toEqual(["sf-transportation", "sf-administrative"]);
    expect(r.groups[0]?.targetHeaders.map((s) => s.raw_id)).toEqual(["6.1"]);
    expect(r.groups[1]?.targetHeaders.map((s) => s.raw_id)).toEqual(["94A.2", "94A.4", "94D.2"]);
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
