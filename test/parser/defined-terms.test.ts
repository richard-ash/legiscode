import { describe, expect, it } from "vitest";
import { DefinedTermPatternError, extractDefinedTerms } from "@/parser/defined-terms";
import type { ModuleConfig } from "@/types";

const manifest: ModuleConfig = {
  id: "sf-municipal",
  name: "SF",
  code_title: "Municipal Code",
  module_version: "2026.04.30",
  citation_patterns: ["§"],
  max_skip_count: 0,
  defined_term_patterns: ['"([^"]+)"\\s+means', '"([^"]+)"\\s+shall mean'],
};

describe("extractDefinedTerms", () => {
  it("captures a quoted term followed by 'means'", () => {
    const terms = extractDefinedTerms('"Director of Transportation" means the Director.', manifest);
    expect(terms).toEqual(["Director of Transportation"]);
  });

  it("captures a quoted term followed by 'shall mean'", () => {
    const terms = extractDefinedTerms('"Bicycle" shall mean a two-wheeled vehicle.', manifest);
    expect(terms).toEqual(["Bicycle"]);
  });

  it("returns multiple distinct terms", () => {
    const terms = extractDefinedTerms(
      '"Bicycle" means a device. "Skateboard" means another device.',
      manifest,
    );
    expect(terms.sort()).toEqual(["Bicycle", "Skateboard"]);
  });

  it("dedupes the same term repeated in one section", () => {
    const terms = extractDefinedTerms(
      '"Bicycle" means a device. "Bicycle" means a wheeled thing.',
      manifest,
    );
    expect(terms).toEqual(["Bicycle"]);
  });

  it("ignores quoted phrases not followed by means/shall mean", () => {
    const terms = extractDefinedTerms('Cited as the "Traffic Code" of the City.', manifest);
    expect(terms).toEqual([]);
  });

  it("returns [] on empty text", () => {
    expect(extractDefinedTerms("", manifest)).toEqual([]);
  });

  it("throws DefinedTermPatternError on a malformed regex pattern", () => {
    const bad: ModuleConfig = { ...manifest, defined_term_patterns: ["[unclosed"] };
    expect(() => extractDefinedTerms('"Bicycle" means a device.', bad)).toThrow(
      DefinedTermPatternError,
    );
  });
});
