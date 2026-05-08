import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetCorpusForTests,
  listCorpus,
  loadCorpus,
  readSection,
  resolveCorpusPath,
} from "../../electron/corpus-loader";

interface FixtureSection {
  id: string;
  title: string;
  text?: string;
  hierarchy?: string[];
}

async function buildFixtureCorpus(
  root: string,
  modules: Array<{
    id: string;
    name: string;
    codeTitle: string;
    moduleVersion: string;
    jurisdiction: string;
    sections: FixtureSection[];
  }>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const m of modules) {
    const moduleDir = join(root, m.id);
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
      join(moduleDir, "manifest.json"),
      JSON.stringify({
        id: m.id,
        name: m.name,
        code_title: m.codeTitle,
        jurisdiction: m.jurisdiction,
        module_version: m.moduleVersion,
        citation_patterns: [],
        defined_term_patterns: [],
      }),
    );
    await writeFile(
      join(moduleDir, "corpus-meta.json"),
      JSON.stringify({ module_version: m.moduleVersion, jurisdiction: m.jurisdiction }),
    );
    const sectionsDir = join(moduleDir, "sections");
    await mkdir(sectionsDir, { recursive: true });
    for (const s of m.sections) {
      const sectionText = s.text ?? "Sample text.";
      await writeFile(
        join(sectionsDir, `${s.id}.json`),
        JSON.stringify({
          kind: "section",
          id: s.id,
          title: s.title,
          text: sectionText,
          citations: [],
          defined_terms: [],
          hierarchy: s.hierarchy ?? [m.codeTitle],
          editorial_status: "active",
          // body[] must re-flatten to text per the SectionFileSchema
          // roundtrip invariant (loader runs safeParse, so a missing
          // body would surface as CorpusError("corrupt")).
          body: [{ type: "text", text: sectionText }],
        }),
      );
    }
  }
}

describe("resolveCorpusPath", () => {
  it("uses --corpus-path argv flag when provided (absolute)", () => {
    const path = resolveCorpusPath({
      argv: ["node", "main.js", "--corpus-path=/abs/corpus"],
      env: {},
      isPackaged: true,
      resourcesPath: "/Resources",
      projectRoot: "/repo",
    });
    expect(path).toBe("/abs/corpus");
  });

  it("falls back to LEGISCODE_CORPUS_PATH env var", () => {
    const path = resolveCorpusPath({
      argv: ["node", "main.js"],
      env: { LEGISCODE_CORPUS_PATH: "/env/corpus" },
      isPackaged: true,
      resourcesPath: "/Resources",
      projectRoot: "/repo",
    });
    expect(path).toBe("/env/corpus");
  });

  it("uses build/modules-full in dev", () => {
    const path = resolveCorpusPath({
      argv: ["node", "main.js"],
      env: {},
      isPackaged: false,
      resourcesPath: "/ignored",
      projectRoot: "/repo",
    });
    expect(path).toBe("/repo/build/modules-full");
  });

  it("uses process.resourcesPath/corpus in prod", () => {
    const path = resolveCorpusPath({
      argv: ["node", "main.js"],
      env: {},
      isPackaged: true,
      resourcesPath: "/Resources",
      projectRoot: "/repo",
    });
    expect(path).toBe("/Resources/corpus");
  });
});

describe("loadCorpus + listCorpus + readSection", () => {
  let dir: string;

  beforeEach(async () => {
    __resetCorpusForTests();
    dir = await mkdtemp(join(tmpdir(), "legiscode-corpus-"));
  });

  afterEach(async () => {
    __resetCorpusForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a valid jurisdiction with two modules and exposes a tree", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "San Francisco Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          { id: "1.1", title: "Definitions", hierarchy: ["Port Code", "ARTICLE 1"] },
          { id: "1.2", title: "Commission", hierarchy: ["Port Code", "ARTICLE 1"] },
        ],
      },
      {
        id: "sf-fire",
        name: "San Francisco Fire Code",
        codeTitle: "Fire Code",
        moduleVersion: "2026.05.01",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1", title: "Title", hierarchy: ["Fire Code", "Chapter 1"] }],
      },
    ]);

    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codeCount).toBe(2);
    expect(result.value.sectionCount).toBe(3);
    expect(result.value.jurisdictionVersion).toBe("2026.05.01");
    expect(result.value.rootLabel).toContain("San Francisco");
    expect(result.value.tree).toHaveLength(2);
    expect(result.value.tree[0]?.kind).toBe("code");
    expect(result.value.defaultRef).toEqual({ moduleId: "sf-fire", sectionId: "1" });
  });

  it("returns a not_loaded error when corpus directory is missing", async () => {
    const result = await loadCorpus(join(dir, "does-not-exist"));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("not_loaded");
  });

  it("returns a not_loaded error when corpus directory is empty", async () => {
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("not_loaded");
  });

  it("returns a corrupt error when a manifest is invalid JSON", async () => {
    const moduleDir = join(dir, "sf-bad");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(moduleDir, "manifest.json"), "{not json");
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
  });

  it("readSection resolves a section with parents and prev/next refs", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "San Francisco Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          { id: "1.1", title: "Definitions", hierarchy: ["Port Code", "ARTICLE 1"] },
          { id: "1.2", title: "Commission", hierarchy: ["Port Code", "ARTICLE 1"] },
          { id: "1.3", title: "Powers", hierarchy: ["Port Code", "ARTICLE 1"] },
        ],
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.section.title).toBe("Commission");
    expect(r.value.parents.map((p) => p.code)).toEqual(["Port Code", "ARTICLE 1"]);
    expect(r.value.prev).toEqual({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.value.next).toEqual({ moduleId: "sf-port", sectionId: "1.3" });
  });

  it("readSection returns not_found for unknown ids", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Port"] }],
      },
    ]);
    await loadCorpus(dir);
    const missingModule = readSection({ moduleId: "sf-fire", sectionId: "1.1" });
    expect(missingModule.ok).toBe(false);
    if (missingModule.ok) return;
    expect(missingModule.error.kind).toBe("not_found");

    const missingSection = readSection({ moduleId: "sf-port", sectionId: "9.9" });
    expect(missingSection.ok).toBe(false);
    if (missingSection.ok) return;
    expect(missingSection.error.kind).toBe("not_found");
  });
});
