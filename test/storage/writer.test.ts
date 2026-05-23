// Direct tests for the load-bearing gates inside writeModule. The
// 0%-skip-rate gate (enforceSkipGate) and the zero-sections gate are
// non-negotiable: every completeness gate is 100%/0% with no configurable
// threshold, and a regression that loosens either condition would silently
// ship corrupt corpora. Both gates run BEFORE any disk write so a contract
// violation never leaves bytes behind — the tests assert that.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicWriteError, ExitCodes, writeModule } from "@/storage";
import type {
  DefinitionsFile,
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

const jurisdiction = "City and County of San Francisco";
const sourceSha256 = "c".repeat(64);

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
  const definitions: DefinitionsFile = {};
  return {
    module: moduleConfig,
    sections,
    appendices: [],
    ordinanceHistories: [],
    resolutionHistories: [],
    definitions,
    skipped: [],
    warnings: [],
    corpusEntryKinds: ["section"],
    sectionPaths,
    tocAnchors: [],
    ...overrides,
  };
}

async function tmpOutputDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "legiscode-skipgate-"));
  return join(root, "module-output");
}

describe("writeModule — 0% skip-rate gate (enforceSkipGate)", () => {
  it("throws AtomicWriteError(PARSE) when skipped.length exceeds maxSkips", async () => {
    const skipped: SkippedEntry[] = [{ kind: "section", id: "1.2", reason: "validator rejected" }];
    const parsed = makeParsedModule({ skipped });
    const outputDir = await tmpOutputDir();

    let caught: unknown = null;
    try {
      await writeModule(parsed, {
        jurisdiction,
        outputDir,
        snapshotAt: "2026-05-04T12:00:00Z",
        maxSkips: 0,
        sourceSha256,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtomicWriteError);
    const error = caught as AtomicWriteError;
    expect(error.exitCode).toBe(ExitCodes.PARSE);
    expect(error.message).toContain("skipped 1 entries");
    expect(error.message).toContain("max_skip_count is 0");
    expect(error.message).toContain("Refusing to promote");
  });

  it("includes the first 5 skipped entries in the error message and a tail count for the rest", async () => {
    const skipped: SkippedEntry[] = Array.from({ length: 7 }, (_, i) => ({
      kind: "section",
      id: `1.${i + 10}`,
      reason: `reason ${i}`,
    }));
    const parsed = makeParsedModule({ skipped });
    const outputDir = await tmpOutputDir();

    let caught: unknown = null;
    try {
      await writeModule(parsed, {
        jurisdiction,
        outputDir,
        snapshotAt: "2026-05-04T12:00:00Z",
        maxSkips: 0,
        sourceSha256,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtomicWriteError);
    const error = caught as AtomicWriteError;
    expect(error.message).toContain("section 1.10");
    expect(error.message).toContain("section 1.14");
    expect(error.message).not.toContain("section 1.15");
    expect(error.message).toContain("... 2 more");
  });
});

describe("writeModule — zero-sections gate", () => {
  it("throws AtomicWriteError(PARSE) when parsed.sections is empty", async () => {
    const parsed = makeParsedModule({ sections: [] });
    const outputDir = await tmpOutputDir();

    let caught: unknown = null;
    try {
      await writeModule(parsed, {
        jurisdiction,
        outputDir,
        snapshotAt: "2026-05-04T12:00:00Z",
        maxSkips: 0,
        sourceSha256,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtomicWriteError);
    const error = caught as AtomicWriteError;
    expect(error.exitCode).toBe(ExitCodes.PARSE);
    expect(error.message).toContain("zero sections");
    expect(error.message).toContain("empty bundle");
  });
});

// T5 — Writer defense-in-depth for the section.id uniqueness invariant.
// The validateCorpus gate (D2) catches duplicates at pipeline time and
// the orchestrator short-circuits writeModule (D7). T5 is the second
// gate: even if a future regression bypassed validation (e.g. a debug
// flag, or two ParsedModules feeding the same writeModule call), the
// writer must refuse to drop bytes when a section's JSON path already
// exists. Two independent gates for one invariant per
// feedback_test_each_path_once — each layer-targeted, no duplicate
// coverage of the same path.
describe("writeModule — section path collision gate (T5)", () => {
  it("throws AtomicWriteError(PARSE) when two SectionFiles write to the same path", async () => {
    // Two sections with the same id. The 0%-skip + 0-sections gates
    // pass (no skips, sections.length === 2), so writeModule enters
    // the writeSection loop; the second writeSection probe hits the
    // file the first wrote and aborts.
    const sectionA = makeSection("16.9");
    const sectionB = { ...makeSection("16.9"), text: "different body" };
    const parsed = makeParsedModule({ sections: [sectionA, sectionB] });
    const outputDir = await tmpOutputDir();

    let caught: unknown = null;
    try {
      await writeModule(parsed, {
        jurisdiction,
        outputDir,
        snapshotAt: "2026-05-04T12:00:00Z",
        maxSkips: 0,
        sourceSha256,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtomicWriteError);
    const error = caught as AtomicWriteError;
    expect(error.exitCode).toBe(ExitCodes.PARSE);
    expect(error.message).toContain("writeSection collision");
    expect(error.message).toContain("16.9");
  });
});
