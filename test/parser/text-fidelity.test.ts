// Text-fidelity regression test (CT3 + codex finding #6).
//
// Re-runs buildCorpus against the committed test/fixtures/sf/source.html
// and asserts every section's `text` field matches the byte-for-byte
// snapshot in test/fixtures/parser/text-snapshot.json.
//
// Why this test exists: feat/parse-html-ast ships in two commits.
// Commit 1 adds `body: BodySegment[]` to every section but leaves `text`
// alone. Commit 2 changes the parser walker (span-table emission) and
// re-emits sections with populated body[]. Across the boundary, `text`
// MUST stay byte-identical — search (#8), ripgrep, and downstream tools
// all assume text is stable. If a Commit 2 change perturbs whitespace
// normalization or any per-segment trim behavior, this test fails before
// the broken artifact is merged.
//
// To regenerate the snapshot (only when the parser INTENTIONALLY changes
// text output — e.g. the source HTML fixture is updated):
//   mise run text-snapshot
//
// Failures here mean a parser change drifted text. Investigate root cause
// before regenerating.

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCorpus } from "@/corpus";

const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_MANIFEST = join(REPO_ROOT, "test", "fixtures", "sf", "jurisdiction.json");
const FIXTURE_SOURCE = join(REPO_ROOT, "test", "fixtures", "sf", "source.html");
const SNAPSHOT_PATH = join(REPO_ROOT, "test", "fixtures", "parser", "text-snapshot.json");

async function walkSectionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const exists = await stat(dir).catch(() => null);
    if (!exists?.isDirectory()) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith(".json")) out.push(full);
    }
  }
  return out;
}

describe("parser text fidelity (CT3 — text byte-identical across two-commit migration)", () => {
  let outputDir: string;
  const actual: Record<string, string> = {};
  const expectedSnapshot: Record<string, string> = {};

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "legiscode-text-fidelity-"));
    const result = await buildCorpus({
      manifestPath: FIXTURE_MANIFEST,
      sourcePath: FIXTURE_SOURCE,
      outputDir,
      snapshotAt: "2026-05-04T00:00:00Z",
    });
    expect(result.exitCode, JSON.stringify(result.errors)).toBe(0);

    for (const moduleId of result.modulesBuilt) {
      const sectionsRoot = join(outputDir, moduleId, "sections");
      const files = await walkSectionFiles(sectionsRoot);
      for (const file of files) {
        const raw = await readFile(file, "utf8");
        const section = JSON.parse(raw) as { id: string; text: string };
        actual[`${moduleId}::${section.id}`] = section.text;
      }
    }

    Object.assign(
      expectedSnapshot,
      JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as Record<string, string>,
    );
  });

  afterAll(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("emits the same set of sections as the snapshot (no sections lost or gained)", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expectedSnapshot).sort());
  });

  it("emits text byte-identical to the snapshot for every section", () => {
    for (const key of Object.keys(expectedSnapshot)) {
      expect(
        actual[key],
        `text drift detected for ${key} — see comment in text-fidelity.test.ts`,
      ).toBe(expectedSnapshot[key]);
    }
  });
});
