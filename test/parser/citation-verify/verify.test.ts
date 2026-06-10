// Citation verifier tests. Asserts the disjoint-cite invariant fails
// closed, and that bare cites resolve against the anchor module.

import { describe, expect, it } from "vitest";
import { formatVerificationFailure, verifyCitations } from "../../../src/parser/citation-verify";

describe("verifyCitations", () => {
  it("passes when every qualified cite is in fetched", () => {
    const result = verifyCitations({
      text: "Per [test-alpha § 1.1], the rule applies.",
      fetched: [{ module_id: "test-alpha", section_id: "1.1" }],
      anchorModule: "test-alpha",
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.matched).toHaveLength(1);
  });

  it("fails when a qualified cite is missing from fetched", () => {
    const result = verifyCitations({
      text: "Per [test-alpha § 1.1] and [test-beta § 2.2], the rule applies.",
      fetched: [{ module_id: "test-alpha", section_id: "1.1" }],
      anchorModule: "test-alpha",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual({
      display: "[test-beta § 2.2]",
      module_id: "test-beta",
      section_id: "2.2",
    });
  });

  it("resolves bare cites against the anchor module", () => {
    const result = verifyCitations({
      text: "Per § 1.1, the rule applies.",
      fetched: [{ module_id: "test-alpha", section_id: "1.1" }],
      anchorModule: "test-alpha",
    });
    expect(result.ok).toBe(true);
  });

  it("falls back across modules when the bare cite isn't in the anchor", () => {
    const result = verifyCitations({
      text: "Per § 2.2, the rule applies.",
      fetched: [{ module_id: "test-beta", section_id: "2.2" }],
      anchorModule: "test-alpha",
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok=true for prose with no citations", () => {
    const result = verifyCitations({
      text: "I searched and found no matching section.",
      fetched: [],
      anchorModule: "test-alpha",
    });
    expect(result.ok).toBe(true);
  });

  it("formatVerificationFailure returns empty when ok", () => {
    expect(formatVerificationFailure({ ok: true, missing: [], matched: [] })).toBe("");
  });

  it("formatVerificationFailure tags the wrap with verification_failure", () => {
    const msg = formatVerificationFailure({
      ok: false,
      missing: [{ display: "[test-beta § 2.2]", module_id: "test-beta", section_id: "2.2" }],
      matched: [],
    });
    expect(msg).toContain("<verification_failure>");
    expect(msg).toContain("[test-beta § 2.2]");
    expect(msg).toContain("</verification_failure>");
  });
});
