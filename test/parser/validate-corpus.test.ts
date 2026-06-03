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
  BodySegment,
  Definition,
  ModuleConfig,
  ParsedModule,
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
    display_label: id,
    title: "Test",
    text: "Test body",
    citations: [],
    defined_terms: [],
    hierarchy: [],
    editorial_status: "active",
    body: [],
  };
}

function makeParsedModule(overrides: Partial<ParsedModule> = {}): ParsedModule {
  const sections = overrides.sections ?? [makeSection("1.1")];
  const sectionPaths: Record<string, readonly string[]> = {};
  for (const s of sections) {
    sectionPaths[s.id] = [];
  }
  return {
    module: moduleConfig,
    sections,
    appendices: [],
    ordinanceHistories: [],
    resolutionHistories: [],
    moduleDefinitions: [],
    unresolvedReferences: [],
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

// D9 — vague reclass observability. The binder reclassifies bindable-
// shape-but-actually-unbindable cites as vague (no anchor / hierarchy
// disambiguation came up ambiguous). The validator buckets these by
// reason so an operator can tell "honest ambiguity" from "binder bug".
describe("validateCorpus — newly_vague_by_reason bucketing (D9)", () => {
  function sectionWithVague(
    id: string,
    hierarchy: readonly string[],
    vagueTarget: SectionFile["citations"][number]["target"],
  ): SectionFile {
    return {
      kind: "section",
      id,
      display_label: id,
      title: "T",
      text: "body",
      citations: [{ display_text: "x", target: vagueTarget }],
      defined_terms: [],
      hierarchy: [...hierarchy],
      editorial_status: "active",
      body: [],
    };
  }

  it("buckets a no-source_target vague as vague_external", () => {
    const sec = sectionWithVague("1.1", ["Code", "ARTICLE I"], {
      kind: "vague",
      raw: "the previous section",
    });
    const parsed = makeParsedModule({ sections: [sec] });

    const result = validateCorpus([parsed]);

    expect(result.citations.newly_vague_by_reason).toEqual({
      vague_external: 1,
      vague_collision_unresolvable: 0,
      vague_no_anchor: 0,
    });
  });

  it("buckets a vague with source_target into vague_collision_unresolvable when a collision family exists", () => {
    // The citing section is at ARTICLE I. Two family members "16.9-2"
    // and "16.9-5" also at ARTICLE I — hierarchy-ambiguous. The binder
    // would have reclassified the bare cite to "16.9" as vague with
    // source_target preserved. The validator finds the family and
    // attributes the vague to collision_unresolvable.
    const citing = sectionWithVague("8.1", ["Code", "ARTICLE I"], {
      kind: "vague",
      raw: "Section 16.9",
      source_target: { kind: "internal", section_id: "16.9" },
    });
    const sibling1 = makeSection("16.9-2");
    sibling1.hierarchy = ["Code", "ARTICLE I"];
    const sibling2 = makeSection("16.9-5");
    sibling2.hierarchy = ["Code", "ARTICLE I"];
    const parsed = makeParsedModule({ sections: [citing, sibling1, sibling2] });

    const result = validateCorpus([parsed]);

    expect(result.citations.newly_vague_by_reason.vague_collision_unresolvable).toBe(1);
    expect(result.citations.newly_vague_by_reason.vague_external).toBe(0);
  });

  it("buckets a vague with source_target into vague_no_anchor when no family exists", () => {
    // Source target named section_id "999" which has no anchor in
    // the module and no collision family — this is the D12 binder-
    // bug indicator. Acceptance metric requires zero.
    const citing = sectionWithVague("1.1", ["Code"], {
      kind: "vague",
      raw: "Section 999",
      source_target: { kind: "internal", section_id: "999" },
    });
    const parsed = makeParsedModule({ sections: [citing] });

    const result = validateCorpus([parsed]);

    expect(result.citations.newly_vague_by_reason.vague_no_anchor).toBe(1);
  });
});

describe("validateCorpus — section.id uniqueness gate", () => {
  // T1a (design doc + D2). The pre-fix corpus had ~141 colliding section.ids
  // in sf-administrative alone; the writer collapsed them onto the same
  // `<sectionId>.json` path. The gate must name the colliding id so an
  // operator can chase the parser regression without diffing the disk
  // layout against the source HTML.
  it("reports duplicateSectionIds when two SectionFiles in one module share an id", () => {
    const sectionA = makeSection("16.9");
    const sectionB = { ...makeSection("16.9"), text: "Different body" };

    const parsed = makeParsedModule({ sections: [sectionA, sectionB] });
    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.duplicateSectionIds).toEqual([{ id: "16.9", count: 2 }]);
  });

  // T1b (design doc). Sanity case for the happy path — every pre-existing
  // fixture hits this branch. Empty array, not undefined, so consumers
  // don't reach for optional chaining.
  it("reports an empty array when every section.id is unique", () => {
    const parsed = makeParsedModule({
      sections: [makeSection("1.1"), makeSection("1.2"), makeSection("1.3")],
    });
    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.duplicateSectionIds).toEqual([]);
  });

  // G2 (D6). Two distinct collisions in one module must report both.
  // Order is alphabetical by id so the BuildError message is stable
  // across runs and snapshot tests do not churn on iteration order.
  it("reports multiple distinct collisions, sorted by id ascending", () => {
    const parsed = makeParsedModule({
      sections: [
        makeSection("20.7"),
        makeSection("10.100"),
        makeSection("20.7"),
        makeSection("10.100"),
        makeSection("1.1"),
      ],
    });
    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.duplicateSectionIds).toEqual([
      { id: "10.100", count: 2 },
      { id: "20.7", count: 2 },
    ]);
  });

  // The aggregate report exposes duplicates per-module; corpus-wide
  // flattening is left to the orchestrator since the BuildError lives
  // per-module (operator needs to know WHICH module collided).
  it("isolates duplicate detection to its own module", () => {
    const charter = makeParsedModule({
      module: { ...moduleConfig, id: "sf-charter" },
      sections: [makeSection("1.1"), makeSection("1.1")],
    });
    const transportation = makeParsedModule({
      module: { ...moduleConfig, id: "sf-transportation" },
      sections: [makeSection("1.1")], // same id in sibling module is fine — module-scoped
    });

    const result = validateCorpus([charter, transportation]);
    const charterReport = result.perModule.find((m) => m.moduleId === "sf-charter");
    const transportationReport = result.perModule.find((m) => m.moduleId === "sf-transportation");

    expect(charterReport?.duplicateSectionIds).toEqual([{ id: "1.1", count: 2 }]);
    expect(transportationReport?.duplicateSectionIds).toEqual([]);
  });
});

describe("validateCorpus — unresolvable_def_id gate", () => {
  function makeDefinition(id: string, term: string): Definition {
    return {
      id,
      term,
      defined_in: "1.1",
      body_anchor: { start: 0, end: term.length },
      excerpt: `'${term}' means a thing.`,
      scope: { kind: "module" },
      extracted_by: "amlegal:pattern:shall-mean",
    };
  }

  function definedTerm(defId: string, raw = "Tenant"): BodySegment {
    return { kind: "defined_term", raw, def_id: defId };
  }

  // The loader's joinDefinitionsForSection used to silent-skip
  // defined_term occurrences whose def_id wasn't in the module index.
  // Per project_legal_corpus_zero_skip the gate moves to build time:
  // a missing definition becomes a typed BuildError so the runtime
  // loader can throw on the invariant violation instead.
  it("flags a defined_term whose def_id has no matching Definition", () => {
    const sectionA = makeSection("1.1");
    sectionA.body = [definedTerm("sf-charter/1.1#deadbeef")];
    const parsed = makeParsedModule({ sections: [sectionA], moduleDefinitions: [] });

    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.unresolvableDefIds).toEqual([
      { sectionId: "1.1", defId: "sf-charter/1.1#deadbeef" },
    ]);
  });

  it("returns an empty array when every def_id resolves", () => {
    const sectionA = makeSection("1.1");
    sectionA.body = [definedTerm("sf-charter/1.1#deadbeef", "Tenant")];
    const parsed = makeParsedModule({
      sections: [sectionA],
      moduleDefinitions: [makeDefinition("sf-charter/1.1#deadbeef", "Tenant")],
    });

    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.unresolvableDefIds).toEqual([]);
  });

  it("walks format.children so nested defined_term refs are gated too", () => {
    const sectionA = makeSection("1.1");
    sectionA.body = [
      {
        kind: "format",
        style: "bold",
        children: [definedTerm("sf-charter/1.1#deadbeef")],
      },
    ];
    const parsed = makeParsedModule({ sections: [sectionA], moduleDefinitions: [] });

    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.unresolvableDefIds).toEqual([
      { sectionId: "1.1", defId: "sf-charter/1.1#deadbeef" },
    ]);
  });

  // The BuildError message must be deterministic so snapshot tests and
  // operator-visible output don't churn on iteration order. Sort key is
  // (sectionId, defId) ascending.
  it("sorts unresolvable refs by (sectionId, defId) and de-dupes repeats within a section", () => {
    const sectionA = makeSection("1.2");
    sectionA.body = [
      definedTerm("sf-charter/9.9#bbbbbbbb"),
      definedTerm("sf-charter/9.9#aaaaaaaa"),
      // Repeat occurrence collapses to one row — the operator only
      // needs the (section, def_id) pair to chase the extractor bug.
      definedTerm("sf-charter/9.9#bbbbbbbb"),
    ];
    const sectionB = makeSection("1.1");
    sectionB.body = [definedTerm("sf-charter/9.9#cccccccc")];

    const parsed = makeParsedModule({
      sections: [sectionA, sectionB],
      moduleDefinitions: [],
    });

    const result = validateCorpus([parsed]);

    expect(result.perModule[0]?.unresolvableDefIds).toEqual([
      { sectionId: "1.1", defId: "sf-charter/9.9#cccccccc" },
      { sectionId: "1.2", defId: "sf-charter/9.9#aaaaaaaa" },
      { sectionId: "1.2", defId: "sf-charter/9.9#bbbbbbbb" },
    ]);
  });
});
