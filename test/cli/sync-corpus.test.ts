import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { computeChecksum } from "@/storage";
import {
  AppendixSchema,
  CorpusMetaSchema,
  DistributedModuleManifestSchema,
  KNOWN_SCHEMA_VERSION,
  ModuleDefinitionsSchema,
  OrdinanceHistorySchema,
  ResolutionHistorySchema,
  SectionFileSchema,
} from "@/types";
import { run } from "../../scripts/sync-corpus";

const REPO_MANIFEST = join(__dirname, "..", "fixtures", "sf", "jurisdiction.json");

interface BuildResult {
  outputBase: string;
  exit: number;
}

async function buildOnce(snapshot: string, only?: string): Promise<BuildResult> {
  const root = await mkdtemp(join(tmpdir(), "legiscode-e2e-"));
  const outputBase = join(root, "modules");
  const argv = ["--source", REPO_MANIFEST, "--output", outputBase, "--snapshot-at", snapshot];
  if (only) argv.push("--only", only);
  const exit = await run(argv);
  return { outputBase, exit };
}

let firstBuild: BuildResult;

beforeAll(async () => {
  firstBuild = await buildOnce("2026-05-02T12:00:00Z");
});

describe("sync-corpus E2E — happy path against committed jurisdiction fixture", () => {
  it("exits 0", () => {
    expect(firstBuild.exit).toBe(0);
  });

  it("produces a complete sf-transportation module bundle", async () => {
    const out = join(firstBuild.outputBase, "sf-transportation");
    expect((await stat(out)).isDirectory()).toBe(true);
    expect((await stat(join(out, "manifest.json"))).isFile()).toBe(true);
    expect((await stat(join(out, "definitions-v2.json"))).isFile()).toBe(true);
    expect((await stat(join(out, "unresolved_references.json"))).isFile()).toBe(true);
    expect((await stat(join(out, "corpus-meta.json"))).isFile()).toBe(true);
    const sections = await readdir(
      join(out, "sections", "transportation-code", "division-i", "article-1"),
    );
    expect(sections.sort()).toEqual([
      "1.1.json",
      "1.2.json",
      "1.3.json",
      "1.4.json",
      "1.5.json",
      "1.6-fn1.json",
    ]);
  });

  // Updated under section-id-uniqueness: the asterisk on `1.6*` was
  // historically stripped to `1.6` as a no-op editorial marker, but
  // empirical scan found 11 SF source anchors where `JD_X*` and `JD_X`
  // coexist as distinct sections. The asterisk is now encoded as the
  // disambiguator suffix `-fn<count>` so collisions never silently
  // drop bytes at write time.
  it("encodes the asterisk-suffixed section id (1.6* -> 1.6-fn1)", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-transportation",
      "sections",
      "transportation-code",
      "division-i",
      "article-1",
      "1.6-fn1.json",
    );
    const section = SectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(section.id).toBe("1.6-fn1");
    expect(section.editorial_status).toBe("active");
  });

  it("produces a complete sf-charter module bundle", async () => {
    const out = join(firstBuild.outputBase, "sf-charter");
    expect((await stat(out)).isDirectory()).toBe(true);
    const sections = await readdir(join(out, "sections", "charter", "division-i", "article-i"));
    expect(sections.sort()).toEqual(["1.100.json", "1.101.json", "1.102.json", "1.103.json"]);
  });

  it("transportation section 1.1 has parsed title + body content from the wedge", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-transportation",
      "sections",
      "transportation-code",
      "division-i",
      "article-1",
      "1.1.json",
    );
    const section = SectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(section.id).toBe("1.1");
    expect(section.title.toUpperCase()).toContain("DEFINITIONS");
    expect(section.text).toContain("Director of Transportation");
    expect(section.hierarchy).toEqual(["Transportation Code", "DIVISION I.", "ARTICLE 1:"]);
  });

  it("transportation section 1.5 captures the severability prose", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-transportation",
      "sections",
      "transportation-code",
      "division-i",
      "article-1",
      "1.5.json",
    );
    const section = SectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(section.id).toBe("1.5");
    expect(section.title.toUpperCase()).toContain("SEVERABILITY");
    expect(section.text.toLowerCase()).toContain("unconstitutional");
  });

  it("charter section 1.100 has the synthetic stub content", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-charter",
      "sections",
      "charter",
      "division-i",
      "article-i",
      "1.100.json",
    );
    const section = SectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(section.id).toBe("1.100");
    expect(section.title.toUpperCase()).toContain("NAME AND BOUNDARIES");
    expect(section.hierarchy).toEqual(["Charter", "DIVISION I.", "ARTICLE I:"]);
  });

  it("[Reserved.] section 1.102 emits with editorial_status: reserved", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-charter",
      "sections",
      "charter",
      "division-i",
      "article-i",
      "1.102.json",
    );
    const section = SectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(section.editorial_status).toBe("reserved");
    expect(section.text).toBe("[Reserved.]");
    expect(section.title).toBe("[Reserved.]");
    expect(section.redirect_to).toBeUndefined();
  });

  it("[Redesignated.] section 1.103 emits with editorial_status: redesignated and a redirect_to", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-charter",
      "sections",
      "charter",
      "division-i",
      "article-i",
      "1.103.json",
    );
    const section = SectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(section.editorial_status).toBe("redesignated");
    expect(section.text).toBe("[Redesignated.]");
    expect(section.redirect_to).toBe("1.105");
  });

  it("emits Appendix A under appendices/article-1/", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-charter",
      "appendices",
      "article-1",
      "article-1-appendix-a.json",
    );
    const appendix = AppendixSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(appendix.kind).toBe("appendix");
    expect(appendix.id).toBe("article-1-appendix-a");
    expect(appendix.parent.kind).toBe("article");
    expect(appendix.parent.number).toBe(1);
    expect(appendix.letter).toBe("a");
    expect(appendix.title.toUpperCase()).toContain("BOUNDARY DESCRIPTIONS");
    expect(appendix.body).toContain("boundaries of the City");
  });

  it("emits OrdinanceHistory at ordinance-history/2023-ordinances.json", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-charter",
      "ordinance-history",
      "2023-ordinances.json",
    );
    const history = OrdinanceHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(history.kind).toBe("ordinance_history");
    expect(history.year).toBe(2023);
    expect(history.module_id).toBe("sf-charter");
    expect(history.id).toBe("2023-ordinances");
  });

  it("emits ResolutionHistory at resolution-history/2023-resolutions.json", async () => {
    const path = join(
      firstBuild.outputBase,
      "sf-charter",
      "resolution-history",
      "2023-resolutions.json",
    );
    const history = ResolutionHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(history.kind).toBe("resolution_history");
    expect(history.year).toBe(2023);
    expect(history.module_id).toBe("sf-charter");
    expect(history.id).toBe("2023-resolutions");
  });

  it("corpus-meta corpus_entry_kinds reflects every kind the bundle contains", async () => {
    const charterMeta = CorpusMetaSchema.parse(
      JSON.parse(
        await readFile(join(firstBuild.outputBase, "sf-charter", "corpus-meta.json"), "utf8"),
      ),
    );
    expect(charterMeta.corpus_entry_kinds.sort()).toEqual([
      "appendix",
      "ordinance_history",
      "resolution_history",
      "section",
    ]);

    const transportMeta = CorpusMetaSchema.parse(
      JSON.parse(
        await readFile(
          join(firstBuild.outputBase, "sf-transportation", "corpus-meta.json"),
          "utf8",
        ),
      ),
    );
    expect(transportMeta.corpus_entry_kinds).toEqual(["section"]);
  });

  it("definitions-v2.json validates as ModuleDefinitions[] for each module", async () => {
    ModuleDefinitionsSchema.parse(
      JSON.parse(
        await readFile(
          join(firstBuild.outputBase, "sf-transportation", "definitions-v2.json"),
          "utf8",
        ),
      ),
    );
    ModuleDefinitionsSchema.parse(
      JSON.parse(
        await readFile(join(firstBuild.outputBase, "sf-charter", "definitions-v2.json"), "utf8"),
      ),
    );
  });

  it("each module's manifest.json round-trips as a DistributedModuleManifest", async () => {
    const transportManifestBody = await readFile(
      join(firstBuild.outputBase, "sf-transportation", "manifest.json"),
      "utf8",
    );
    expect(transportManifestBody.endsWith("\n")).toBe(true);
    const transportManifest = DistributedModuleManifestSchema.parse(
      JSON.parse(transportManifestBody),
    );
    expect(transportManifest.id).toBe("sf-transportation");
    expect(transportManifest.jurisdiction).toBe("City and County of San Francisco");
    // text_source must NOT leak into the distributed bundle.
    expect("text_source" in transportManifest).toBe(false);

    const charterManifest = DistributedModuleManifestSchema.parse(
      JSON.parse(
        await readFile(join(firstBuild.outputBase, "sf-charter", "manifest.json"), "utf8"),
      ),
    );
    expect(charterManifest.id).toBe("sf-charter");
  });

  it("corpus-meta.json has schema_version=KNOWN_SCHEMA_VERSION, sha256 checksum + source_sha256, ISO 8601 snapshot_at, no skips", async () => {
    const transportMeta = CorpusMetaSchema.parse(
      JSON.parse(
        await readFile(
          join(firstBuild.outputBase, "sf-transportation", "corpus-meta.json"),
          "utf8",
        ),
      ),
    );
    expect(transportMeta.schema_version).toBe(KNOWN_SCHEMA_VERSION);
    expect(transportMeta.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(transportMeta.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(transportMeta.snapshot_at).toBe("2026-05-02T12:00:00Z");
    expect(transportMeta.skipped).toEqual([]);
    expect(transportMeta.module_id).toBe("sf-transportation");
    expect(transportMeta.module_version).toBe("2026.05.01");

    const charterMeta = CorpusMetaSchema.parse(
      JSON.parse(
        await readFile(join(firstBuild.outputBase, "sf-charter", "corpus-meta.json"), "utf8"),
      ),
    );
    expect(charterMeta.module_id).toBe("sf-charter");
    expect(charterMeta.module_version).toBe("2026.05.02");
    // Both modules in a single build read the same source bytes.
    expect(charterMeta.source_sha256).toBe(transportMeta.source_sha256);
  });

  it("checksum re-computes equal to the stored value for each module", async () => {
    for (const moduleId of ["sf-transportation", "sf-charter"]) {
      const moduleDir = join(firstBuild.outputBase, moduleId);
      const meta = CorpusMetaSchema.parse(
        JSON.parse(await readFile(join(moduleDir, "corpus-meta.json"), "utf8")),
      );
      expect(await computeChecksum(moduleDir)).toBe(meta.checksum);
    }
  });
});

describe("sync-corpus determinism — only snapshot_at varies", () => {
  it("two runs differ ONLY in corpus-meta.json's snapshot_at field per module", async () => {
    const first = firstBuild;
    const second = await buildOnce("2026-05-02T13:00:00Z");
    expect(second.exit).toBe(0);

    for (const moduleId of ["sf-transportation", "sf-charter"]) {
      const firstMeta = CorpusMetaSchema.parse(
        JSON.parse(await readFile(join(first.outputBase, moduleId, "corpus-meta.json"), "utf8")),
      );
      const secondMeta = CorpusMetaSchema.parse(
        JSON.parse(await readFile(join(second.outputBase, moduleId, "corpus-meta.json"), "utf8")),
      );
      expect(firstMeta.checksum).toBe(secondMeta.checksum);
      expect(firstMeta.snapshot_at).not.toBe(secondMeta.snapshot_at);

      const compare = async (rel: string) => {
        const a = await readFile(join(first.outputBase, moduleId, rel));
        const b = await readFile(join(second.outputBase, moduleId, rel));
        expect(b.equals(a)).toBe(true);
      };
      await compare("manifest.json");
      await compare("definitions-v2.json");
      await compare("unresolved_references.json");
    }
  });
});

describe("sync-corpus — module promotion atomicity", () => {
  it("running twice produces a new live output (no .new or .old orphans)", async () => {
    const second = await buildOnce("2026-05-02T14:00:00Z");
    expect(second.exit).toBe(0);
    for (const moduleId of ["sf-transportation", "sf-charter"]) {
      const out = join(second.outputBase, moduleId);
      await expect(stat(`${out}.new`)).rejects.toThrow();
      await expect(stat(`${out}.old`)).rejects.toThrow();
    }
  });
});

describe("sync-corpus --only filter", () => {
  it("builds only the named module when --only is set", async () => {
    const result = await buildOnce("2026-05-02T15:00:00Z", "sf-transportation");
    expect(result.exit).toBe(0);
    expect((await stat(join(result.outputBase, "sf-transportation"))).isDirectory()).toBe(true);
    await expect(stat(join(result.outputBase, "sf-charter"))).rejects.toThrow();
  });

  it("rejects an --only target not declared in the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "legiscode-e2e-"));
    const outputBase = join(root, "modules");
    const exit = await run([
      "--source",
      REPO_MANIFEST,
      "--output",
      outputBase,
      "--only",
      "not-a-real-module",
    ]);
    // Args error → exit 2 per HELP_TEXT.
    expect(exit).toBe(2);
  });
});

describe("sync-corpus — 0% skip gate (happy path)", () => {
  // Wiring check: the existing fixture produces 0 skips, so the build at
  // every test in this file (which uses the default max_skip_count: 0)
  // implicitly proves the gate doesn't false-trip on a clean corpus.
  // Direct gate-trip behavior is exercised at the unit level via
  // args.test.ts (--max-skips parsing) and manifest.test.ts (max_skip_count
  // schema validation). A real-data trip case will surface when an
  // operator runs the full SF manifest against the production fetcher
  // output.
  it("clean build emits skipped: [] (gate does not false-trip)", async () => {
    for (const moduleId of ["sf-transportation", "sf-charter"]) {
      const meta = CorpusMetaSchema.parse(
        JSON.parse(
          await readFile(join(firstBuild.outputBase, moduleId, "corpus-meta.json"), "utf8"),
        ),
      );
      expect(meta.skipped).toEqual([]);
    }
  });
});
