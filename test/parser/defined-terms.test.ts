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

describe("extractDefinedTerms (position-bearing per A1)", () => {
  it("captures a quoted term followed by 'means' with positions", () => {
    const matches = extractDefinedTerms(
      '"Director of Transportation" means the Director.',
      manifest,
    );
    expect(matches.map((m) => m.term)).toEqual(["Director of Transportation"]);
    // Position points at the captured term itself, not the surrounding "means".
    expect(matches[0]?.start).toBe(1);
    expect(matches[0]?.end).toBe(27);
  });

  it("captures a quoted term followed by 'shall mean'", () => {
    const matches = extractDefinedTerms('"Bicycle" shall mean a two-wheeled vehicle.', manifest);
    expect(matches.map((m) => m.term)).toEqual(["Bicycle"]);
  });

  it("returns multiple distinct terms in start order", () => {
    const matches = extractDefinedTerms(
      '"Bicycle" means a device. "Skateboard" means another device.',
      manifest,
    );
    expect(matches.map((m) => m.term)).toEqual(["Bicycle", "Skateboard"]);
    // Sorted by start position, not insertion order.
    if (matches.length === 2) {
      expect(matches[0]?.start).toBeLessThan(matches[1]?.start ?? 0);
    }
  });

  it("surfaces every occurrence of the same term — caller dedupes for SectionFile.defined_terms", () => {
    const matches = extractDefinedTerms(
      '"Bicycle" means a device. "Bicycle" means a wheeled thing.',
      manifest,
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.term)).toEqual(["Bicycle", "Bicycle"]);
  });

  it("ignores quoted phrases not followed by means/shall mean", () => {
    const matches = extractDefinedTerms('Cited as the "Traffic Code" of the City.', manifest);
    expect(matches).toEqual([]);
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

  it("existing pipeline callers get back the deduped string[] via .map().Set()", () => {
    // Pipeline.ts: defined_terms = Array.from(new Set(extractDefinedTerms(...).map(d => d.term)))
    // This test asserts that contract still produces the legacy shape.
    const matches = extractDefinedTerms(
      '"Bicycle" means a device. "Bicycle" means a wheeled thing.',
      manifest,
    );
    const legacyShape = Array.from(new Set(matches.map((d) => d.term)));
    expect(legacyShape).toEqual(["Bicycle"]);
  });

  // L2a: each match carries provenance (pattern_kind) and the full
  // match extent (full_match_end) so the canonical Definition extractor
  // can attribute extracted_by and bound the body_anchor / excerpt.
  it("classifies the canonical 'X means' pattern as quoted-means", () => {
    const matches = extractDefinedTerms('"Bicycle" means a device.', manifest);
    expect(matches[0]?.pattern_kind).toBe("quoted-means");
  });

  it("falls back to 'custom' for unrecognized operator regexes", () => {
    const customManifest: ModuleConfig = {
      ...manifest,
      defined_term_patterns: ["definitionOf\\(([a-z]+)\\)"],
    };
    const matches = extractDefinedTerms("definitionOf(thing)", customManifest);
    expect(matches[0]?.pattern_kind).toBe("custom");
  });

  it("full_match_end points past the trigger phrase, not just the term", () => {
    const text = '"Bicycle" means a device.';
    const matches = extractDefinedTerms(text, manifest);
    expect(matches[0]?.end).toBe(8); // end of "Bicycle" (before closing quote)
    // full_match_end covers `"Bicycle" means` (excluding text after the trigger).
    expect(matches[0]?.full_match_end).toBe(15);
    expect(text.slice(0, matches[0]?.full_match_end)).toBe('"Bicycle" means');
  });
});
