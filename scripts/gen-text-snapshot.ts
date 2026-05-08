#!/usr/bin/env -S node --experimental-vm-modules
// Pre-regen text snapshot generator (CT3 + codex finding #6).
//
// Why this exists: the feat/parse-html-ast branch ships in two commits.
// Commit 1 adds `body: BodySegment[]` to every fixture but leaves `text`
// untouched. Commit 2 changes the parser walker (span-table emission,
// 3-pass pipeline) and re-emits fixtures with populated body[]. Across
// that boundary, `text` MUST stay byte-identical — the renderer, the
// search index (#8), and downstream tools all assume `text` is stable.
//
// This script captures `text` for every section in the committed test
// fixture (test/fixtures/sf/source.html → sf-charter + sf-transportation
// modules) and writes test/fixtures/parser/text-snapshot.json. The
// companion test test/parser/text-fidelity.test.ts re-runs the build
// and asserts every section's text matches the snapshot byte-for-byte.
//
// Run via `mise run text-snapshot` whenever the parser intentionally
// changes `text` output (e.g. the source HTML fixture is updated).
// Outside of that, drift = bug.

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus } from "@/corpus";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

async function main(): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), "legiscode-text-snapshot-"));
  try {
    const result = await buildCorpus({
      manifestPath: FIXTURE_MANIFEST,
      sourcePath: FIXTURE_SOURCE,
      outputDir,
      snapshotAt: "2026-05-04T00:00:00Z",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `buildCorpus failed: exit ${result.exitCode}, errors: ${JSON.stringify(result.errors)}`,
      );
    }

    const snapshot: Record<string, string> = {};
    for (const moduleId of result.modulesBuilt) {
      const sectionsRoot = join(outputDir, moduleId, "sections");
      const files = await walkSectionFiles(sectionsRoot);
      for (const file of files) {
        const raw = await readFile(file, "utf8");
        const section = JSON.parse(raw) as { id: string; text: string };
        snapshot[`${moduleId}::${section.id}`] = section.text;
      }
    }

    const sortedKeys = Object.keys(snapshot).sort();
    const sortedSnapshot: Record<string, string> = {};
    for (const k of sortedKeys) sortedSnapshot[k] = snapshot[k] as string;

    await writeFile(SNAPSHOT_PATH, `${JSON.stringify(sortedSnapshot, null, 2)}\n`);
    process.stdout.write(`wrote ${SNAPSHOT_PATH} (${sortedKeys.length} sections)\n`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`gen-text-snapshot failed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
