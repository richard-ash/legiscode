import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Capture, diff } from "../../scripts/recall-diff";

// The diff() gate prints its classified report to stdout; silence it so the
// test output stays clean. The return code is the gate (0 = pass, 1 = fail).
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Build a one-module capture. def_id format is <module>/<section>#<sha8>;
// the section component is what definerSection() parses to decide whether a
// drop is a self-reference (intended) or a usage-site regression.
function capture(
  terms: Record<string, string>,
  defined: { section_id: string; def_id: string }[],
  cites: { section_id: string; raw: string }[] = [],
): Capture {
  return { terms, modules: { m: { defined, cites } } };
}

describe("recall-diff diff() — D9 classified gate", () => {
  it("passes when nothing is dropped", () => {
    const terms = { "m/def#aaaaaaaa": "fiscal year" };
    const base = capture(terms, [{ section_id: "s1", def_id: "m/def#aaaaaaaa" }]);
    expect(diff(base, base)).toBe(0);
  });

  it("FAILS when a lower-case term is dropped outside its definer section", () => {
    // This is the regression the whole arch decision guards against: a
    // lower-case defined term losing its tag at a usage site.
    const terms = { "m/def#aaaaaaaa": "fiscal year" };
    const base = capture(terms, [{ section_id: "usage", def_id: "m/def#aaaaaaaa" }]);
    const after = capture(terms, []);
    expect(diff(base, after)).toBe(1);
  });

  it("does not fail on an intended capitalised drop (bug ① head-suppression)", () => {
    const terms = { "m/def#bbbbbbbb": "Department" };
    const base = capture(terms, [{ section_id: "usage", def_id: "m/def#bbbbbbbb" }]);
    const after = capture(terms, []);
    expect(diff(base, after)).toBe(0);
  });

  it("does not fail on a lower-case drop inside the term's own definer section (②)", () => {
    const terms = { "m/def#cccccccc": "fiscal year" };
    const base = capture(terms, [{ section_id: "def", def_id: "m/def#cccccccc" }]);
    const after = capture(terms, []);
    expect(diff(base, after)).toBe(0);
  });

  it("reports cite re-shapes and new defined tags without failing the gate", () => {
    // A citation boundary correction ("Section 10A" → "Section 10A.4") and a
    // newly-recognized defined tag exercise the cite-diff and defined-adds
    // branches; neither is a lower-case regression, so the gate passes.
    const terms = { "m/def#dddddddd": "Department" };
    const base = capture(terms, [], [{ section_id: "s1", raw: "Section 10A" }]);
    const after = capture(
      terms,
      [{ section_id: "s1", def_id: "m/def#dddddddd" }],
      [{ section_id: "s1", raw: "Section 10A.4" }],
    );
    expect(diff(base, after)).toBe(0);
  });
});
