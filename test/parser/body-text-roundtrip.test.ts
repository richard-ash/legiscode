// Body-text roundtrip invariant test (CT1, plan implementation step 12).
//
// For every section in the buildCorpus output: derive raw text from
// body[] (concat text/citation-raw/defined-term/subsection-label
// segments; recurse format children; paragraph_break → \n) and assert
// the result equals section.text byte-for-byte.
//
// This is the keystone test for Commit 2 of feat/parse-html-ast. If
// buildBodySegments drops a character, double-emits one, or splits a
// segment incorrectly, this fails. It runs against the committed test
// fixture (sf-charter + sf-transportation, 10 sections); the
// operator-driven `mise run validate:full` extends the same invariant
// to the full ~11,659 production sections via build/modules/.

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCorpus } from "@/corpus";
import type { SectionFile } from "@/types";
import { bodyToText } from "@/types";

const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_MANIFEST = join(REPO_ROOT, "test", "fixtures", "sf", "jurisdiction.json");
const FIXTURE_SOURCE = join(REPO_ROOT, "test", "fixtures", "sf", "source.html");

// bodyToText is exported from @/types so the schema's superRefine and
// this corpus-wide test agree on what "body[] reflattens to text"
// means. A drift between the two definitions would let one check pass
// while the other failed.

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

describe("parse-html body-text roundtrip (every section's body[] reflattens to text)", () => {
  let outputDir: string;
  const sections: SectionFile[] = [];

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "legiscode-body-roundtrip-"));
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
        sections.push(JSON.parse(raw) as SectionFile);
      }
    }
  });

  afterAll(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("every section in the test fixture body-roundtrips to its text", () => {
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const reflattened = bodyToText(section.body);
      expect(
        reflattened,
        `body→text mismatch for ${section.id} (title: ${section.title}). ` +
          `Body had ${section.body.length} segments; ` +
          `reflattened length ${reflattened.length} vs text length ${section.text.length}.`,
      ).toBe(section.text);
    }
  });

  it("every active section has a non-empty body[]", () => {
    // Sanity check that Commit 2's body builder actually produces
    // segments. [Reserved.]/[Repealed.]/[Redesignated.] sections are
    // legitimately one-segment ([{kind: "text", text: "[Reserved.]"}]),
    // so we just check non-empty.
    for (const section of sections) {
      if (section.editorial_status === "active") {
        expect(section.body.length, `body is empty for ${section.id}`).toBeGreaterThan(0);
      }
    }
  });
});
