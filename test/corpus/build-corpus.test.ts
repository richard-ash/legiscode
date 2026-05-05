// In-process tests for `buildCorpus`. The subprocess-style coverage of
// the CLI contract lives in test/cli/sync-corpus.test.ts; this file
// exercises @/corpus directly so failures surface at the orchestrator
// boundary rather than via argv → exit-code translation.

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type BuildResult, buildCorpus } from "@/corpus";

const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_MANIFEST = join(REPO_ROOT, "test", "fixtures", "sf", "jurisdiction.json");
const FIXTURE_SOURCE = join(REPO_ROOT, "test", "fixtures", "sf", "source.html");

interface InvokeOptions {
  outputDir: string;
  snapshotAt?: string;
  only?: readonly string[];
  maxSkips?: number;
  manifestPath?: string;
  sourcePath?: string;
}

async function invoke(opts: InvokeOptions): Promise<BuildResult> {
  return await buildCorpus({
    manifestPath: opts.manifestPath ?? FIXTURE_MANIFEST,
    sourcePath: opts.sourcePath ?? FIXTURE_SOURCE,
    outputDir: opts.outputDir,
    snapshotAt: opts.snapshotAt ?? "2026-05-04T00:00:00Z",
    only: opts.only,
    maxSkips: opts.maxSkips,
  });
}

async function makeOutputDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "legiscode-build-"));
}

describe("buildCorpus — happy path against committed jurisdiction fixture", () => {
  let outputDir: string;
  let result: BuildResult;

  beforeAll(async () => {
    outputDir = await makeOutputDir();
    result = await invoke({ outputDir });
  });

  it("returns exitCode OK", () => {
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("populates modulesBuilt with every module in the manifest", () => {
    expect(result.modulesBuilt.sort()).toEqual(["sf-charter", "sf-transportation"]);
  });

  it("computes a sha256 of the source bytes", () => {
    expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("propagates snapshotAt verbatim", () => {
    expect(result.snapshotAt).toBe("2026-05-04T00:00:00Z");
  });

  it("records non-zero durationMs", () => {
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("populates coverage and citations from validateCorpus", () => {
    // Fixture is small but real — total is the count of attempted entries
    // (parsed sections + skipped); covered equals the parsed count for a
    // 0-skip fixture; missing is empty.
    expect(result.coverage.missing).toEqual([]);
    expect(result.coverage.covered).toBe(result.coverage.total);
    expect(result.coverage.total).toBeGreaterThan(0);
    expect(result.citations.unresolvedIntra).toEqual([]);
    // Citation totals reflect the fixture's actual citation count.
    expect(result.citations.resolved).toBe(result.citations.total);
  });

  it("writes per-module bundles to disk", async () => {
    for (const moduleId of ["sf-charter", "sf-transportation"]) {
      const moduleDir = join(outputDir, moduleId);
      expect((await stat(moduleDir)).isDirectory()).toBe(true);
      expect((await stat(join(moduleDir, "manifest.json"))).isFile()).toBe(true);
      expect((await stat(join(moduleDir, "corpus-meta.json"))).isFile()).toBe(true);
    }
  });

  it("writes corpus-level corpus-meta.json with valid=true and matching sha256", async () => {
    const meta = JSON.parse(await readFile(join(outputDir, "corpus-meta.json"), "utf8"));
    expect(meta.valid).toBe(true);
    expect(meta.source_sha256).toBe(result.sourceSha256);
    expect(meta.snapshot_at).toBe("2026-05-04T00:00:00Z");
    expect(meta.modules_built.sort()).toEqual(["sf-charter", "sf-transportation"]);
    expect(meta.errors).toEqual([]);
    expect(meta.skips.total).toBe(0);
  });
});

describe("buildCorpus — outputDir purge (D6)", () => {
  it("removes pre-existing files before building", async () => {
    const outputDir = await makeOutputDir();
    const stale = join(outputDir, "stale-file.txt");
    await writeFile(stale, "this should be deleted");
    expect((await stat(stale)).isFile()).toBe(true);

    const result = await invoke({ outputDir });

    expect(result.exitCode).toBe(0);
    await expect(stat(stale)).rejects.toThrow();
  });
});

describe("buildCorpus — only filter", () => {
  it("builds only the named module", async () => {
    const outputDir = await makeOutputDir();
    const result = await invoke({ outputDir, only: ["sf-transportation"] });

    expect(result.exitCode).toBe(0);
    expect(result.modulesBuilt).toEqual(["sf-transportation"]);
    expect((await stat(join(outputDir, "sf-transportation"))).isDirectory()).toBe(true);
    await expect(stat(join(outputDir, "sf-charter"))).rejects.toThrow();
  });

  it("silently produces zero modules when filter matches nothing", async () => {
    const outputDir = await makeOutputDir();
    const result = await invoke({ outputDir, only: ["not-a-real-module"] });

    expect(result.exitCode).toBe(0);
    expect(result.modulesBuilt).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("preserves modules outside the --only filter on a partial rebuild", async () => {
    // Full build first, then a partial rebuild with --only must NOT delete
    // the unselected module's bundle. Without the conditional purge, the
    // pre-delete of outputDir would wipe sf-charter and operators iterating
    // on a single module would silently lose every other module.
    const outputDir = await makeOutputDir();
    await invoke({ outputDir });
    expect((await stat(join(outputDir, "sf-charter"))).isDirectory()).toBe(true);

    const partial = await invoke({ outputDir, only: ["sf-transportation"] });
    expect(partial.exitCode).toBe(0);
    expect(partial.modulesBuilt).toEqual(["sf-transportation"]);
    expect((await stat(join(outputDir, "sf-transportation"))).isDirectory()).toBe(true);
    expect((await stat(join(outputDir, "sf-charter"))).isDirectory()).toBe(true);
  });

  it("does not overwrite the corpus-level corpus-meta.json on a partial rebuild", async () => {
    // The corpus-meta written on a full build claims modules_built for
    // every module. A --only rebuild's modules_built reflects only the
    // subset, so writing it would corrupt the corpus-level sentinel.
    const outputDir = await makeOutputDir();
    const full = await invoke({ outputDir });
    const fullMeta = JSON.parse(await readFile(join(outputDir, "corpus-meta.json"), "utf8"));
    expect(fullMeta.modules_built.sort()).toEqual(["sf-charter", "sf-transportation"]);

    await invoke({ outputDir, only: ["sf-transportation"] });
    const afterPartial = JSON.parse(await readFile(join(outputDir, "corpus-meta.json"), "utf8"));
    // corpus-meta should be unchanged from the full build.
    expect(afterPartial.modules_built.sort()).toEqual(["sf-charter", "sf-transportation"]);
    expect(afterPartial.source_sha256).toBe(full.sourceSha256);
  });
});

describe("buildCorpus — manifest pattern errors", () => {
  it("returns manifest_invalid for an invalid citation_patterns regex", async () => {
    // citation_patterns is a list of regex strings. A typo (unbalanced
    // group, dangling escape) compiles into RegExp at parse time and throws
    // CitationPatternError. The orchestrator must catch this and return a
    // typed manifest_invalid instead of letting the exception escape.
    const outputDir = await makeOutputDir();
    const badManifestPath = join(outputDir, "bad-manifest.json");
    const goodManifest = JSON.parse(await readFile(FIXTURE_MANIFEST, "utf8"));
    goodManifest.modules[0].citation_patterns = ["(unclosed-group"];
    await writeFile(badManifestPath, JSON.stringify(goodManifest));

    const result = await invoke({ outputDir, manifestPath: badManifestPath });

    expect(result.exitCode).toBe(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("manifest_invalid");
    if (result.errors[0]?.kind === "manifest_invalid") {
      expect(result.errors[0].reason).toMatch(/citation_pattern/i);
    }
  });

  it("returns manifest_invalid for an invalid defined_term_patterns regex", async () => {
    const outputDir = await makeOutputDir();
    const badManifestPath = join(outputDir, "bad-manifest.json");
    const goodManifest = JSON.parse(await readFile(FIXTURE_MANIFEST, "utf8"));
    goodManifest.modules[0].defined_term_patterns = ["[unclosed-class"];
    await writeFile(badManifestPath, JSON.stringify(goodManifest));

    const result = await invoke({ outputDir, manifestPath: badManifestPath });

    expect(result.exitCode).toBe(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("manifest_invalid");
    if (result.errors[0]?.kind === "manifest_invalid") {
      expect(result.errors[0].reason).toMatch(/defined_term_pattern/i);
    }
  });
});

describe("buildCorpus — manifest errors", () => {
  it("returns manifest_invalid for a missing manifest file", async () => {
    const outputDir = await makeOutputDir();
    const result = await invoke({
      outputDir,
      manifestPath: join(REPO_ROOT, "does-not-exist.json"),
    });

    expect(result.exitCode).toBe(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("manifest_invalid");
    expect(result.modulesBuilt).toEqual([]);
  });
});

describe("buildCorpus — source errors", () => {
  it("returns source_unreadable for a missing source path", async () => {
    const outputDir = await makeOutputDir();
    const result = await invoke({
      outputDir,
      sourcePath: join(REPO_ROOT, "does-not-exist.html"),
    });

    expect(result.exitCode).toBe(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("source_unreadable");
  });
});

describe("buildCorpus — determinism", () => {
  it("produces identical sourceSha256 across runs", async () => {
    const a = await invoke({ outputDir: await makeOutputDir() });
    const b = await invoke({ outputDir: await makeOutputDir() });
    expect(a.sourceSha256).toBe(b.sourceSha256);
  });
});
