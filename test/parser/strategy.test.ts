// parser_strategy dispatch: parseExport switches on manifest.parser_strategy
// and fails closed on unknown tokens via ParseAbortError. Catching this at
// the parser layer means a manifest typo (or a future strategy that hasn't
// shipped) can't silently route through SF-specific rules.

import { describe, expect, it } from "vitest";
import { ParseAbortError, parseExport } from "@/parser";
import type { JurisdictionManifest } from "@/types";

function makeManifestWithStrategy(strategy: string): JurisdictionManifest {
  return {
    jurisdiction: "City and County of San Francisco",
    source: { format: "amlegal-html", path: "test/fixtures/inline" },
    parser_strategy: strategy,
    modules: [
      {
        id: "test-mod",
        name: "Test Module",
        code_title: "Test Code",
        jd_anchor: "Test",
        module_version: "2026.05.01",
        max_skip_count: 0,
        citation_patterns: ["§\\s*\\d+"],
        defined_term_patterns: ['"([^"]+)"\\s+means'],
      },
    ],
  } as JurisdictionManifest;
}

describe("parser_strategy dispatch", () => {
  it("accepts the known sf-amlegal strategy", () => {
    const manifest = makeManifestWithStrategy("sf-amlegal");
    const buffer = Buffer.from(
      '<html><body><div class="rbox Chapter"><div><a name="JD_Test" id="JD_Test" title="Test"></a>TEST CODE</div></div></body></html>',
    );
    expect(() => parseExport(buffer, manifest)).not.toThrow();
  });

  it("fails closed on an unknown parser_strategy", () => {
    const manifest = makeManifestWithStrategy("la-amlegal");
    const buffer = Buffer.from("<html><body></body></html>");
    expect(() => parseExport(buffer, manifest)).toThrow(ParseAbortError);
    expect(() => parseExport(buffer, manifest)).toThrow(/unknown parser_strategy "la-amlegal"/);
  });
});
