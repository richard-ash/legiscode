// Direct tests for the TOC coverage gate (validate-corpus.ts:computeCoverage).
// The gate is non-negotiable: every completeness gate is 100%/0% with no
// configurable threshold. A regression that stops populating coverage.missing
// would silently let modules ship with dropped sections, defeating the
// orchestrator's BuildError(toc_coverage_failed) check.
//
// validateCorpus is exported and pure-data, so we exercise it from typed
// fixtures rather than going through parseSingleModule + cheerio.

import { describe, expect, it } from "vitest";
import { validateCorpus } from "@/parser";
import type {
  DefinitionsFile,
  ModuleConfig,
  ParsedModule,
  ReferencesFile,
  SectionFile,
  SkippedEntry,
} from "@/types";

const moduleConfig: ModuleConfig = {
  id: "sf-charter",
  name: "SF Charter",
  code_title: "Charter",
  module_version: "2026.04.30",
  citation_patterns: ["x"],
  defined_term_patterns: ["x"],
  max_skip_count: 0,
};

function makeSection(id: string): SectionFile {
  return {
    kind: "section",
    id,
    title: "Test",
    text: "Test body",
    citations: [],
    defined_terms: [],
    hierarchy: [],
    editorial_status: "active",
  };
}

function makeParsedModule(overrides: Partial<ParsedModule> = {}): ParsedModule {
  const sections = overrides.sections ?? [makeSection("1.1")];
  const sectionPaths: Record<string, readonly string[]> = {};
  const references: ReferencesFile = {};
  for (const s of sections) {
    sectionPaths[s.id] = [];
    references[s.id] = { citations: [], cited_by: [] };
  }
  const definitions: DefinitionsFile = {};
  return {
    module: moduleConfig,
    sections,
    appendices: [],
    ordinanceHistories: [],
    resolutionHistories: [],
    definitions,
    references,
    skipped: [],
    warnings: [],
    corpusEntryKinds: ["section"],
    sectionPaths,
    tocAnchors: [],
    ...overrides,
  };
}

describe("validateCorpus — TOC coverage gate (failure paths)", () => {
  it("populates coverage.missing with every kind:'section' skip", () => {
    const skipped: SkippedEntry[] = [
      { kind: "section", id: "1.2", reason: "validator rejected" },
      { kind: "section", id: "1.3", reason: "validator rejected" },
    ];
    const parsed = makeParsedModule({ skipped });

    const result = validateCorpus([parsed]);

    expect(result.coverage.missing).toEqual(["1.2", "1.3"]);
    expect(result.coverage.covered).toBe(1);
    expect(result.coverage.total).toBe(3);
  });

  it("includes kind:'parse' skips with valid raw_id in coverage.missing", () => {
    const skipped: SkippedEntry[] = [
      {
        kind: "parse",
        raw_id: "9.99",
        source_location: { line: 42 },
        reason: "section validator rejected",
      },
    ];
    const parsed = makeParsedModule({ skipped });

    const result = validateCorpus([parsed]);

    expect(result.coverage.missing).toEqual(["9.99"]);
    expect(result.coverage.total).toBe(2);
  });

  it("excludes kind:'parse' skips with no raw_id from coverage.missing (still counted in skip total)", () => {
    const skipped: SkippedEntry[] = [
      {
        kind: "parse",
        source_location: { line: 7 },
        reason: "stray UTF-8 byte before any anchor",
      },
    ];
    const parsed = makeParsedModule({ skipped });

    const result = validateCorpus([parsed]);

    // No SectionId to enumerate, so missing[] stays empty even though a
    // skip happened. The skip-rate gate (in storage) still counts it via
    // parsed.skipped.length; coverage.missing is for the subset whose ids
    // we can name.
    expect(result.coverage.missing).toEqual([]);
    expect(result.coverage.covered).toBe(1);
    expect(result.coverage.total).toBe(1);
  });

  it("excludes kind:'parse' skips with non-conforming raw_id from coverage.missing", () => {
    const skipped: SkippedEntry[] = [
      {
        kind: "parse",
        raw_id: "BAD ID WITH SPACES",
        source_location: { line: 7 },
        reason: "non-conforming",
      },
    ];
    const parsed = makeParsedModule({ skipped });

    const result = validateCorpus([parsed]);

    // raw_id present but doesn't match the dotted/dashed lowercase shape;
    // can't be enumerated as a SectionId without breaking the type.
    expect(result.coverage.missing).toEqual([]);
  });

  it("flattens missing across modules at the corpus level", () => {
    const charter = makeParsedModule({
      module: { ...moduleConfig, id: "sf-charter" },
      skipped: [{ kind: "section", id: "1.2", reason: "x" }],
    });
    const transportation = makeParsedModule({
      module: { ...moduleConfig, id: "sf-transportation" },
      skipped: [{ kind: "section", id: "5.5", reason: "x" }],
    });

    const result = validateCorpus([charter, transportation]);

    expect([...result.coverage.missing].sort()).toEqual(["1.2", "5.5"]);
    expect(result.coverage.total).toBe(4);
    expect(result.coverage.covered).toBe(2);
  });
});
