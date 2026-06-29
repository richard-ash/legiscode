import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogIndexSchema, JurisdictionCatalogSchema } from "@/corpus/catalog";
import { packModules } from "../../scripts/pack-modules";

// Minimal corpus-meta.json with all required fields
const FAKE_CHECKSUM = "a".repeat(64);
const FAKE_SOURCE_SHA256 = "b".repeat(64);

function makeCorpusMeta(moduleId: string) {
  return {
    jurisdiction: "Test Jurisdiction",
    module_id: moduleId,
    snapshot_at: "2026-06-01T00:00:00Z",
    schema_version: 5,
    module_version: "2026.06.01",
    checksum: FAKE_CHECKSUM,
    source_sha256: FAKE_SOURCE_SHA256,
    skipped: [],
    corpus_entry_kinds: ["section"],
  };
}

function makeManifest(moduleId: string) {
  return {
    id: moduleId,
    name: `${moduleId} Code`,
    code_title: moduleId,
    jurisdiction: "Test Jurisdiction",
    module_version: "2026.06.01",
    citation_patterns: [],
    defined_term_patterns: [],
  };
}

async function buildFixtureModule(modulesDir: string, moduleId: string): Promise<void> {
  const moduleDir = join(modulesDir, moduleId);
  await mkdir(join(moduleDir, "sections"), { recursive: true });

  await writeFile(
    join(moduleDir, "corpus-meta.json"),
    JSON.stringify(makeCorpusMeta(moduleId)),
    "utf8",
  );
  await writeFile(join(moduleDir, "manifest.json"), JSON.stringify(makeManifest(moduleId)), "utf8");
  // At least one file in sections so the tar is non-trivial
  await writeFile(
    join(moduleDir, "sections", "1.json"),
    JSON.stringify({ id: "1", title: "Test Section" }),
    "utf8",
  );
}

describe("packModules", () => {
  let modulesDir: string;
  let outputDir: string;

  beforeEach(async () => {
    modulesDir = await mkdtemp(join(tmpdir(), "legiscode-modules-"));
    outputDir = await mkdtemp(join(tmpdir(), "legiscode-dist-"));
    await buildFixtureModule(modulesDir, "sf-alpha");
  });

  afterEach(async () => {
    await rm(modulesDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  it("emits archive, index.json, and catalog-sf.json that validate against schemas", async () => {
    await packModules({ modulesDir, outputDir });

    const distFiles = await readdir(outputDir);
    expect(distFiles).toContain("index.json");
    expect(distFiles).toContain("catalog-sf.json");
    expect(distFiles).toContain("sf-alpha@2026.06.01.tar.gz");

    const index = CatalogIndexSchema.parse(
      JSON.parse(await readFile(join(outputDir, "index.json"), "utf8")),
    );
    expect(index.jurisdictions).toHaveLength(1);
    const jd = index.jurisdictions[0]!;
    expect(jd.id).toBe("sf");
    expect(jd.module_count).toBe(1);

    const catalog = JurisdictionCatalogSchema.parse(
      JSON.parse(await readFile(join(outputDir, "catalog-sf.json"), "utf8")),
    );
    expect(catalog.modules).toHaveLength(1);
  });

  it("content_checksum equals the corpus-meta checksum", async () => {
    await packModules({ modulesDir, outputDir });

    const catalog = JurisdictionCatalogSchema.parse(
      JSON.parse(await readFile(join(outputDir, "catalog-sf.json"), "utf8")),
    );
    expect(catalog.modules[0]?.content_checksum).toBe(FAKE_CHECKSUM);
  });

  it("archive_sha256 matches the archive bytes", async () => {
    await packModules({ modulesDir, outputDir });

    const catalog = JurisdictionCatalogSchema.parse(
      JSON.parse(await readFile(join(outputDir, "catalog-sf.json"), "utf8")),
    );
    const archiveEntry = catalog.modules[0]!;
    const archiveBytes = await readFile(join(outputDir, archiveEntry.archive));
    const actual = createHash("sha256").update(archiveBytes).digest("hex");
    expect(archiveEntry.archive_sha256).toBe(actual);
  });

  it("tar round-trips — extracted contents match the source module", async () => {
    await packModules({ modulesDir, outputDir });

    const catalog = JurisdictionCatalogSchema.parse(
      JSON.parse(await readFile(join(outputDir, "catalog-sf.json"), "utf8")),
    );
    const archiveEntry = catalog.modules[0]!;
    const extractDir = await mkdtemp(join(tmpdir(), "legiscode-extract-"));

    try {
      execFileSync("tar", ["-xzf", join(outputDir, archiveEntry.archive), "-C", extractDir]);

      const originalMeta = await readFile(join(modulesDir, "sf-alpha", "corpus-meta.json"), "utf8");
      const extractedMeta = await readFile(
        join(extractDir, "sf-alpha", "corpus-meta.json"),
        "utf8",
      );
      expect(extractedMeta).toBe(originalMeta);

      const originalSection = await readFile(
        join(modulesDir, "sf-alpha", "sections", "1.json"),
        "utf8",
      );
      const extractedSection = await readFile(
        join(extractDir, "sf-alpha", "sections", "1.json"),
        "utf8",
      );
      expect(extractedSection).toBe(originalSection);
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });
});
