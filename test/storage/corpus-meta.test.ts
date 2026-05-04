import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeCorpusMeta, computeChecksum, writeCorpusMeta, writeJson } from "@/storage";
import { CorpusMetaSchema, KNOWN_SCHEMA_VERSION, type ModuleConfig } from "@/types";

const moduleConfig: ModuleConfig = {
  id: "sf-municipal",
  name: "SF",
  code_title: "Municipal Code",
  module_version: "2026.04.30",
  citation_patterns: ["x"],
  max_skip_count: 0,
  defined_term_patterns: ["x"],
};

const jurisdiction = "City and County of San Francisco";
// 64-char hex placeholder; the value is opaque to composeCorpusMeta
// (it just round-trips through the schema regex).
const sourceSha256 = "a".repeat(64);

async function makeModuleDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "legiscode-meta-"));
  await writeJson(join(dir, "references.json"), {});
  await writeJson(join(dir, "definitions.json"), {});
  await writeJson(join(dir, "manifest.json"), { id: moduleConfig.id });
  return dir;
}

describe("composeCorpusMeta", () => {
  it("produces valid CorpusMeta with schema_version 1 and a sha256 checksum", async () => {
    const dir = await makeModuleDir();
    const meta = await composeCorpusMeta({
      jurisdiction,
      module: moduleConfig,
      moduleDir: dir,
      snapshotAt: "2026-04-30T12:34:56-07:00",
      skipped: [],
      corpusEntryKinds: ["section"],
      sourceSha256,
    });
    expect(meta.schema_version).toBe(KNOWN_SCHEMA_VERSION);
    expect(meta.module_version).toBe("2026.04.30");
    expect(meta.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(CorpusMetaSchema.safeParse(meta).success).toBe(true);
  });

  it("writes corpus-meta.json as canonical JSON in the module dir", async () => {
    const dir = await makeModuleDir();
    const meta = await composeCorpusMeta({
      jurisdiction,
      module: moduleConfig,
      moduleDir: dir,
      snapshotAt: "2026-04-30T12:34:56Z",
      skipped: [{ kind: "section", id: "10.04.020", reason: "validator failed" }],
      corpusEntryKinds: ["section"],
      sourceSha256,
    });
    await writeCorpusMeta(dir, meta);
    const body = await readFile(join(dir, "corpus-meta.json"), "utf8");
    // Sorted keys means "checksum" appears before "jurisdiction" alphabetically.
    expect(body.indexOf('"checksum"')).toBeLessThan(body.indexOf('"jurisdiction"'));
    expect(body.endsWith("\n")).toBe(true);
  });
});

describe("computeChecksum", () => {
  it("excludes corpus-meta.json from the hash", async () => {
    const dir = await makeModuleDir();
    const beforeMeta = await computeChecksum(dir);
    const meta = await composeCorpusMeta({
      jurisdiction,
      module: moduleConfig,
      moduleDir: dir,
      snapshotAt: "2026-04-30T12:34:56Z",
      skipped: [],
      corpusEntryKinds: ["section"],
      sourceSha256,
    });
    await writeCorpusMeta(dir, meta);
    const afterMeta = await computeChecksum(dir);
    expect(afterMeta).toBe(beforeMeta);
  });

  it("changes when any other file changes", async () => {
    const dir = await makeModuleDir();
    const before = await computeChecksum(dir);
    await writeJson(join(dir, "references.json"), { added: { citations: [], cited_by: [] } });
    const after = await computeChecksum(dir);
    expect(after).not.toBe(before);
  });
});
