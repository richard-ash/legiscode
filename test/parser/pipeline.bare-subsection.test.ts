// Pipeline-level regression: bare `subsection (a)` / `subdivision (b)`
// cites inside a section must resolve to that section's own id when the
// production pipeline runs end-to-end. The bug this test guards against:
// the extractor's `currentSectionId` option was wired but pipeline.ts
// called `extractCitations(ps.text, module)` without it, so bare-subsection
// cites silently dropped from every generated corpus even though the
// direct extractor tests passed.

import { describe, expect, it } from "vitest";
import { type ParsedModule, parseExport } from "@/parser";
import type { JurisdictionManifest } from "@/types";

const SUBSECTION_PATTERN =
  "(?:§§?|\\bSections?\\b|\\bSec\\.|\\bsubsections?\\b|\\bsubdivisions?\\b)\\s*(?:\\d+(?:\\.\\d+)*(?:\\([a-z0-9]+\\))*|\\([a-z0-9]+\\)(?:\\([a-z0-9]+\\))*)";

function makeManifest(): JurisdictionManifest {
  return {
    jurisdiction: "Test",
    source: { format: "amlegal-html", path: "test/fixtures/inline" },
    parser_strategy: "sf-amlegal",
    modules: [
      {
        id: "test-mod",
        name: "Test",
        code_title: "Test Code",
        jd_anchor: "Test",
        module_version: "2026.05.20",
        max_skip_count: 0,
        citation_patterns: [SUBSECTION_PATTERN],
        defined_term_patterns: ['"([^"]+)"\\s+means'],
      },
    ],
  };
}

function html(...rboxes: string[]): Buffer {
  const body = rboxes.map((r) => `${r}\n<div class="clearfix"></div>`).join("\n");
  return Buffer.from(`<html><body>\n${body}\n</body></html>`);
}

function root(jdAnchor: string, title: string): string {
  return `<div><div class="rbox Chapter"><div><a name="JD_${jdAnchor}" id="JD_${jdAnchor}" title="${jdAnchor}"></a>${title}</div></div></div>`;
}

function section(rid: string, sectionId: string, heading: string, body: string): string {
  return `
    <div id="rid-${rid}" class="Section toc-destination rbox"><h3><a name="JD_${sectionId}" id="JD_${sectionId}" title="${sectionId}"></a>SEC. ${sectionId}.  ${heading}</h3></div>
    <div id="rid-${rid}-body" class="rbox Normal-Level"><div>${body}</div></div>`;
}

function parseSingleModule(buffer: Buffer): ParsedModule {
  const modules = parseExport(buffer, makeManifest());
  if (modules.length !== 1 || !modules[0]) {
    throw new Error(`expected one parsed module, got ${modules.length}`);
  }
  return modules[0];
}

describe("pipeline — bare subsection cites resolve to the citing section", () => {
  it("classifies 'subsection (a)' as a section-ref anchored to the citing section's id", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      section("s1", "10.04.020", "RULES.", "See subsection (a) above for the threshold."),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    const sec = result.sections.find((s) => s.id === "10.04.020");
    expect(sec).toBeDefined();
    // Phase 2 binder rewrites resolvable internal targets to section-ref.
    // The original-section anchor exists in the parsed corpus, so the
    // bind succeeds and the on-disk target carries anchor_id + module_id.
    expect(sec?.citations).toContainEqual({
      display_text: "subsection (a)",
      target: {
        kind: "section-ref",
        anchor_id: "10.04.020",
        module_id: "test-mod",
        subsection: "(a)",
      },
    });
  });

  it("classifies 'subdivision (b)' the same way", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      section("s1", "10.04.020", "RULES.", "Per subdivision (b), the rate applies."),
    );
    const result = parseSingleModule(buffer);
    const sec = result.sections.find((s) => s.id === "10.04.020");
    expect(sec?.citations).toContainEqual({
      display_text: "subdivision (b)",
      target: {
        kind: "section-ref",
        anchor_id: "10.04.020",
        module_id: "test-mod",
        subsection: "(b)",
      },
    });
  });
});
