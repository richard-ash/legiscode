import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CorpusReadError,
  readCorpusMeta,
  readJurisdictionManifest,
  readSection,
} from "@/types/validate";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "legiscode-readers-"));
});

afterEach(async () => {
  // Tests intentionally don't rm — node's tmpdir cleanup handles it; we
  // don't want a test-only cleanup helper masking real bugs.
});

describe("readers — file-not-found", () => {
  it("readSection throws CorpusReadError with stage='read'", async () => {
    const path = join(dir, "missing.json");
    await expect(readSection(path)).rejects.toMatchObject({
      name: "CorpusReadError",
      stage: "read",
      path,
    });
  });
});

describe("readers — invalid JSON", () => {
  it("readJurisdictionManifest throws CorpusReadError with stage='parse'", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json", "utf8");
    await expect(readJurisdictionManifest(path)).rejects.toMatchObject({
      name: "CorpusReadError",
      stage: "parse",
      path,
    });
  });
});

describe("readers — schema validation failure", () => {
  it("readCorpusMeta throws CorpusReadError with stage='validate' that names the field", async () => {
    const path = join(dir, "meta.json");
    await writeFile(
      path,
      JSON.stringify({
        jurisdiction: "x",
        module_id: "sf-municipal",
        snapshot_at: "2026-04-30T12:34:56-07:00",
        schema_version: 1,
        module_version: "2026.04.30",
        checksum: "deadbeef",
        skipped: [],
      }),
      "utf8",
    );
    let err: unknown;
    try {
      await readCorpusMeta(path);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(CorpusReadError);
    if (err instanceof CorpusReadError) {
      expect(err.stage).toBe("validate");
      expect(err.message).toContain("checksum");
    }
  });
});

describe("readers — happy path", () => {
  it("readSection returns a typed SectionFile", async () => {
    const path = join(dir, "10.04.020.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "10.04.020",
        display_label: "10.04.020",
        title: "Definitions",
        text: "...",
        citations: [],
        defined_terms: [],
        hierarchy: ["title-10", "ch-10.04"],
        body: [{ type: "text", text: "..." }],
      }),
      "utf8",
    );
    const section = await readSection(path);
    expect(section.id).toBe("10.04.020");
  });
});
