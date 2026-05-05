// @vitest-environment jsdom
/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "vitest";
import { readActiveSection, writeActiveSection } from "../../src/app/active-section";

beforeEach(() => {
  localStorage.clear();
});

describe("active-section persistence", () => {
  it("returns null when nothing is stored", () => {
    expect(readActiveSection()).toBeNull();
  });

  it("round-trips a (moduleId, sectionId) pair", () => {
    writeActiveSection({ moduleId: "sf-port", sectionId: "1.4" });
    expect(readActiveSection()).toEqual({ moduleId: "sf-port", sectionId: "1.4" });
  });

  it("returns null on corrupted JSON instead of throwing", () => {
    localStorage.setItem("legiscode.activeSection", "not-json");
    expect(readActiveSection()).toBeNull();
  });

  it("returns null when stored value lacks expected keys", () => {
    localStorage.setItem("legiscode.activeSection", JSON.stringify({ moduleId: "sf-port" }));
    expect(readActiveSection()).toBeNull();
  });
});
