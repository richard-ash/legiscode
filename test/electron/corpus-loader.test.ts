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
  body?: unknown[];
  defined_terms?: string[];
  /** Human-readable label. Defaults to `id` when omitted. */
  displayLabel?: string;
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
    definitions?: Record<string, Array<{ defined_in_section: string }>>;
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
    if (m.definitions) {
      await writeFile(join(moduleDir, "definitions.json"), JSON.stringify(m.definitions));
    }
    const sectionsDir = join(moduleDir, "sections");
    await mkdir(sectionsDir, { recursive: true });
    for (const s of m.sections) {
      const sectionText = s.text ?? "Sample text.";
      await writeFile(
        join(sectionsDir, `${s.id}.json`),
        JSON.stringify({
          kind: "section",
          id: s.id,
          display_label: s.displayLabel ?? s.id,
          title: s.title,
          text: sectionText,
          citations: [],
          defined_terms: s.defined_terms ?? [],
          hierarchy: s.hierarchy ?? [m.codeTitle],
          editorial_status: "active",
          // body[] must re-flatten to text per the SectionFileSchema
          // roundtrip invariant (loader runs safeParse, so a missing
          // body would surface as CorpusError("corrupt")).
          body: s.body ?? [{ type: "text", text: sectionText }],
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

  it("section tree node.code carries display_label, not section.id", async () => {
    // Codex-flagged [P2]: post-refoundation, anchor ids ("p109",
    // "b102a") can differ from the human label readers see ("109.0",
    // "102A"). The file tree, command palette, and inactive-tab titles
    // all render `node.code`, so the loader must surface display_label
    // there. The canonical anchor stays in `ref.sectionId` for routing.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-plumbing",
        name: "San Francisco Plumbing Code",
        codeTitle: "Plumbing Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "p109",
            displayLabel: "109.0",
            title: "Investigation Fees",
            hierarchy: ["Plumbing Code", "Chapter 1"],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codeNode = result.value.tree[0];
    const chapterNode = codeNode?.kids?.[0];
    const sectionNode = chapterNode?.kids?.[0];
    expect(sectionNode?.kind).toBe("section");
    expect(sectionNode?.code).toBe("§ 109.0");
    expect(sectionNode?.code).not.toContain("p109");
    // The canonical anchor still flows through ref for routing.
    expect(sectionNode?.ref).toEqual({ moduleId: "sf-plumbing", sectionId: "p109" });
  });

  it("section tree node carries a preview baked from section text (for hover popover)", async () => {
    // Pre-baking the excerpt on the tree blob lets the citation hover
    // popover render synchronously, matching the DefinedTerm tooltip
    // pattern (no IPC, no flicker).
    const longText =
      "Notwithstanding any other provision of this Chapter, the Traffic Engineer may establish a prima facie speed limit lower than that otherwise applicable upon finding that the lower limit is reasonable.";
    await buildFixtureCorpus(dir, [
      {
        id: "sf-traffic",
        name: "San Francisco Traffic Code",
        codeTitle: "Traffic Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "10.04.040",
            displayLabel: "10.04.040",
            title: "Prima Facie Limits",
            hierarchy: ["Traffic Code", "Chapter 10"],
            text: longText,
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.preview).toBeTruthy();
    expect(sectionNode?.preview?.startsWith("Notwithstanding any other provision")).toBe(true);
    expect(sectionNode?.preview?.endsWith("…")).toBe(true);
    // Trailing token before the ellipsis must be a complete word from the
    // source — i.e. the source has whitespace immediately after where we
    // cut. Catches naive `slice(0, N)` regressions that truncate
    // mid-word.
    const trailingWord = sectionNode?.preview?.match(/(\S+)…$/)?.[1];
    expect(trailingWord).toBeTruthy();
    expect(longText).toContain(`${trailingWord} `);
  });

  it("section tree preview omits the field when section text is empty", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-empty",
        name: "Empty Code",
        codeTitle: "Empty Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1",
            title: "Empty",
            hierarchy: ["Empty Code", "Chapter 1"],
            text: "",
            body: [],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.preview).toBeUndefined();
  });

  it("section tree node carries subsectionPreviews keyed by subsection_label", async () => {
    // The popover shows subsection-specific text when a cite targets a
    // subsection (e.g. "Subsection (a)"). Pre-baked at corpus-load time,
    // keyed by the subsection_label string emitted by the parser ("(a)",
    // "(1)"), and matched against the citation target's `subsection` field
    // (same string format).
    await buildFixtureCorpus(dir, [
      {
        id: "sf-planning",
        name: "Planning Code",
        codeTitle: "Planning Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "133",
            title: "Side Yards",
            hierarchy: ["Planning Code", "Article 1.2"],
            text: "Intro text.\n(a) Minimum side yards shall be provided as follows:\n(b) Where height does not exceed 25 feet…",
            body: [
              { type: "text", text: "Intro text." },
              { type: "paragraph_break" },
              { type: "subsection_label", label: "(a)" },
              { type: "text", text: " Minimum side yards shall be provided as follows:" },
              { type: "paragraph_break" },
              { type: "subsection_label", label: "(b)" },
              { type: "text", text: " Where height does not exceed 25 feet…" },
            ],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.subsectionPreviews).toBeDefined();
    expect(sectionNode?.subsectionPreviews?.["(a)"]).toBe(
      "Minimum side yards shall be provided as follows:",
    );
    expect(sectionNode?.subsectionPreviews?.["(b)"]).toBe("Where height does not exceed 25 feet…");
  });

  it("subsectionPreviews omits the field when no subsection_labels exist", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-flat",
        name: "Flat",
        codeTitle: "Flat",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1",
            title: "Flat",
            hierarchy: ["Flat", "Chapter 1"],
            text: "No subsections here.",
            body: [{ type: "text", text: "No subsections here." }],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.subsectionPreviews).toBeUndefined();
  });

  it("subsectionPreviews truncates long subsections with an ellipsis", async () => {
    const longText = "A".repeat(220);
    await buildFixtureCorpus(dir, [
      {
        id: "sf-long",
        name: "Long",
        codeTitle: "Long",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1",
            title: "Long",
            hierarchy: ["Long", "Chapter 1"],
            text: `(a) ${longText}`,
            body: [
              { type: "subsection_label", label: "(a)" },
              { type: "text", text: ` ${longText}` },
            ],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.subsectionPreviews?.["(a)"]?.endsWith("…")).toBe(true);
    expect(sectionNode?.subsectionPreviews?.["(a)"]?.length).toBeLessThanOrEqual(181);
  });

  it("subsectionPreviews recurses into nested format children (list/listItem)", async () => {
    // Subsection labels can live inside list / listItem wrappers; the
    // extractor must descend so e.g. (a) under <ul><li> still gets a preview.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-nested",
        name: "Nested",
        codeTitle: "Nested",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1",
            title: "Nested",
            hierarchy: ["Nested", "Chapter 1"],
            text: "(a) Inside list",
            body: [
              {
                type: "format",
                style: "list",
                children: [
                  {
                    type: "format",
                    style: "listItem",
                    children: [
                      { type: "subsection_label", label: "(a)" },
                      { type: "text", text: " Inside list" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.subsectionPreviews?.["(a)"]).toBe("Inside list");
  });

  it("section tree preview is the full text (no ellipsis) when text fits within the limit", async () => {
    const shortText = "Short section text.";
    await buildFixtureCorpus(dir, [
      {
        id: "sf-short",
        name: "Short Code",
        codeTitle: "Short Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1",
            title: "Short",
            hierarchy: ["Short Code", "Chapter 1"],
            text: shortText,
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0];
    expect(sectionNode?.preview).toBe(shortText);
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

  it("readSection joins module definitions.json entries for defined-term body segments (D-DELTA-2)", async () => {
    // body[] mentions "Person"; definitions.json maps "Person" → 1.1.
    // The definitions field on the response must surface the entry so
    // the renderer's hover tooltip is synchronous (no per-hover IPC).
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "San Francisco Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          { id: "1.1", title: "Definitions", hierarchy: ["Port Code", "ARTICLE 1"] },
          {
            id: "1.2",
            title: "Use",
            hierarchy: ["Port Code", "ARTICLE 1"],
            text: "Person",
            body: [{ type: "defined_term", term: "Person" }],
            defined_terms: ["Person"],
          },
        ],
        definitions: {
          Person: [{ defined_in_section: "1.1" }],
        },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.definitions).toEqual({ Person: [{ defined_in_section: "1.1" }] });
  });

  it("readSection preserves multi-section definition arrays (D-DELTA-2 data-loss guard)", async () => {
    // The original per-hover IPC plan flattened to a single defined_in.
    // The bulk pre-resolve preserves every entry — codex's data-loss catch.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          { id: "1.1", title: "Defs A", hierarchy: ["Port Code"] },
          { id: "1.2", title: "Defs B", hierarchy: ["Port Code"] },
          {
            id: "1.3",
            title: "Use",
            hierarchy: ["Port Code"],
            text: "Vessel",
            body: [{ type: "defined_term", term: "Vessel" }],
            defined_terms: ["Vessel"],
          },
        ],
        definitions: {
          Vessel: [{ defined_in_section: "1.1" }, { defined_in_section: "1.2" }],
        },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.3" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.definitions.Vessel).toEqual([
      { defined_in_section: "1.1" },
      { defined_in_section: "1.2" },
    ]);
  });

  it("readSection returns an empty definitions map when the section has no defined_term segments", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Port Code"] }],
        definitions: { Person: [{ defined_in_section: "1.1" }] },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.definitions).toEqual({});
  });

  it("readSection drops only the bad definitions.json keys, projects the valid ones", async () => {
    // Pre-existing parser bug emits some keys with stray whitespace
    // ("\nCity"). Per-key soft-fail: bad keys log and drop, valid keys
    // still load. The previous per-file policy turned 2 bad keys out
    // of 301 into 100%-no-tooltips for the entire module.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1.1",
            title: "Use",
            hierarchy: ["Port"],
            text: "Person Vessel",
            body: [
              { type: "defined_term", term: "Person" },
              { type: "text", text: " " },
              { type: "defined_term", term: "Vessel" },
            ],
            defined_terms: ["Person", "Vessel"],
          },
        ],
        definitions: {
          // Whitespace-padded key violates DefinedTermSchema → dropped.
          "\nPerson": [{ defined_in_section: "1.1" }],
          // Valid key → still projects.
          Vessel: [{ defined_in_section: "1.1" }],
        },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Person dropped (bad key), Vessel projects.
    expect(Object.hasOwn(r.value.definitions, "Person")).toBe(false);
    expect(r.value.definitions.Vessel).toEqual([{ defined_in_section: "1.1" }]);
    expect(r.value.section.body).toHaveLength(3);
  });

  it("readSection returns an empty map when every definitions.json entry is malformed", async () => {
    // The fully-broken case still loads the section — only tooltips
    // degrade. (The previous per-file policy collapsed to this same
    // outcome on a single bad key; per-key keeps the outcome as the
    // floor, not the ceiling.)
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1.1",
            title: "Use",
            hierarchy: ["Port"],
            text: "Person",
            body: [{ type: "defined_term", term: "Person" }],
            defined_terms: ["Person"],
          },
        ],
        definitions: { "\nPerson": [{ defined_in_section: "1.1" }] },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.definitions).toEqual({});
    expect(r.value.section.body).toHaveLength(1);
  });

  it("readSection projects defined-term entries even when the term name collides with Object.prototype", async () => {
    // A section body[] segment can name any defined-term string, including
    // ones that shadow Object.prototype properties ("constructor",
    // "toString", "__proto__"). With a plain `{}` accumulator the
    // `term in out` check would short-circuit on those terms and silently
    // drop the projection — the renderer would then read an inherited
    // function from the prototype and crash on tooltip hover. Null-prototype
    // accumulator + Object.hasOwn at the read site keeps the projection
    // honest end-to-end.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1.1",
            title: "Use",
            hierarchy: ["Port"],
            text: "constructor",
            body: [{ type: "defined_term", term: "constructor" }],
            defined_terms: ["constructor"],
          },
        ],
        definitions: { constructor: [{ defined_in_section: "1.1" }] },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.hasOwn(r.value.definitions, "constructor")).toBe(true);
    expect(r.value.definitions.constructor).toEqual([{ defined_in_section: "1.1" }]);
  });

  it("readSection returns an empty definitions map when the module has no definitions.json", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        // No `definitions` key → no definitions.json file written.
        sections: [
          {
            id: "1.1",
            title: "Use",
            hierarchy: ["Port Code"],
            text: "Person",
            body: [{ type: "defined_term", term: "Person" }],
            defined_terms: ["Person"],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.definitions).toEqual({});
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
