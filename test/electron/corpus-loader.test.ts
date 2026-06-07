import { createHash } from "node:crypto";
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

// Test-only shorthand: term → array of defining section ids. Helper
// expands each entry into a full Definition record (module-scoped so any
// reader resolves) and writes them as definitions-v2.json.
type FixtureDefinitions = Record<string, string[]>;

// Mirror parser/definition-id.ts. Inline rather than imported so the
// electron-side loader test stays free of parser-side dependencies.
function fixtureDefId(moduleId: string, sectionId: string, term: string): string {
  const normalized = term.trim().replace(/\s+/g, " ");
  const sha8 = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 8);
  return `${moduleId}/${sectionId}#${sha8}`;
}

function buildDefinitionsV2(moduleId: string, definitions: FixtureDefinitions) {
  const out: Array<Record<string, unknown>> = [];
  for (const [term, sectionIds] of Object.entries(definitions)) {
    for (const sectionId of sectionIds) {
      out.push({
        id: fixtureDefId(moduleId, sectionId, term),
        term,
        defined_in: sectionId,
        body_anchor: { start: 0, end: 0 },
        excerpt: `"${term}" means a thing.`,
        scope: { kind: "module" },
        extracted_by: "amlegal:pattern:quoted-means",
      });
    }
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
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
    definitions?: FixtureDefinitions;
    /** Override the on-disk definitions-v2.json with a raw value
     *  (string or object). Used for tests that probe schema-failure
     *  paths. Wins over `definitions` when both are supplied. */
    definitionsV2Raw?: unknown;
    /** Override the corpus-meta.json schema_version field. Omit to
     *  skip the field entirely (loader treats absence as
     *  acceptable). Used by version-gate tests. */
    schemaVersion?: number;
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
    const corpusMetaPayload: Record<string, unknown> = {
      module_version: m.moduleVersion,
      jurisdiction: m.jurisdiction,
    };
    if (m.schemaVersion !== undefined) {
      corpusMetaPayload.schema_version = m.schemaVersion;
    }
    await writeFile(join(moduleDir, "corpus-meta.json"), JSON.stringify(corpusMetaPayload));
    if (m.definitionsV2Raw !== undefined) {
      await writeFile(
        join(moduleDir, "definitions-v2.json"),
        typeof m.definitionsV2Raw === "string"
          ? m.definitionsV2Raw
          : JSON.stringify(m.definitionsV2Raw),
      );
    } else if (m.definitions) {
      await writeFile(
        join(moduleDir, "definitions-v2.json"),
        JSON.stringify(buildDefinitionsV2(m.id, m.definitions)),
      );
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
          body: s.body ?? [{ kind: "text", text: sectionText }],
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

  it("uses build/modules in dev", () => {
    const path = resolveCorpusPath({
      argv: ["node", "main.js"],
      env: {},
      isPackaged: false,
      resourcesPath: "/ignored",
      projectRoot: "/repo",
    });
    expect(path).toBe("/repo/build/modules");
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
    expect(result.value.tree).toHaveLength(1);
    expect(result.value.tree[0]?.kind).toBe("jurisdiction");
    expect(result.value.tree[0]?.kids).toHaveLength(2);
    expect(result.value.tree[0]?.kids?.[0]?.kind).toBe("code");
    expect(result.value.defaultRef).toEqual({ moduleId: "sf-fire", sectionId: "1" });
    // No definitions-v2.json in either module fixture → field is the
    // empty array, not undefined. Consumers can branch on length
    // alone without an existence check.
    expect(result.value.definitions).toEqual([]);
  });

  it("aggregates definitions across modules as per-(term, module) rows (T1)", async () => {
    // Cross-module collision: "Director" defined in both sf-port and
    // sf-administrative must stay as two distinct rows. Silently
    // collapsing across modules would be materially wrong for legal
    // reading (D5 in the plan: a Director in sf-port is not the
    // Director in sf-administrative).
    await buildFixtureCorpus(dir, [
      {
        id: "sf-administrative",
        name: "Administrative Code",
        codeTitle: "Administrative Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "Defs", hierarchy: ["Administrative Code"] }],
        definitions: {
          Director: ["1.1"],
          City: ["1.1"],
        },
      },
      {
        id: "sf-port",
        name: "Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [
          { id: "1.1", title: "Defs", hierarchy: ["Port Code"] },
          { id: "1.2", title: "More Defs", hierarchy: ["Port Code"] },
        ],
        definitions: {
          // Intra-module collision: two definers in the same module.
          // Both preserved in `definers[]`; the renderer surfaces the
          // count as "+N more" but the data stays here.
          Director: ["1.1", "1.2"],
        },
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sorted by (term, moduleId): "City" first; then "Director" with
    // sf-administrative before sf-port alphabetically.
    expect(result.value.definitions).toEqual([
      { term: "City", moduleId: "sf-administrative", definers: ["1.1"] },
      { term: "Director", moduleId: "sf-administrative", definers: ["1.1"] },
      { term: "Director", moduleId: "sf-port", definers: ["1.1", "1.2"] },
    ]);
  });

  it("aggregated definitions omit modules with no definitions-v2.json (T1)", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-with-defs",
        name: "With Defs",
        codeTitle: "With Defs",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["With Defs"] }],
        definitions: { Person: ["1.1"] },
      },
      {
        id: "sf-without-defs",
        name: "Without Defs",
        codeTitle: "Without Defs",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Without Defs"] }],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definitions).toEqual([
      { term: "Person", moduleId: "sf-with-defs", definers: ["1.1"] },
    ]);
  });

  it("loadCorpus rejects a bundle with schema_version below MIN_SUPPORTED_SCHEMA_VERSION", async () => {
    // The --corpus-path flag bypasses the backend's per-version URL
    // namespacing, so a stale local bundle would otherwise crash
    // downstream on now-required record-level fields (def_id at v2;
    // text_diff anchor at v3; widened BillStatus enum at v4;
    // diff_chunks shape at v5). Loader
    // catches it at the trust boundary with a clear "rebuild your
    // corpus" message.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Port"] }],
        schemaVersion: 4, // stale: app requires >= 5
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("corrupt");
    expect(result.error.detail).toMatch(/schema_version 4/);
    expect(result.error.detail).toMatch(/requires >= 5/);
  });

  it("loadCorpus accepts a bundle whose schema_version matches MIN_SUPPORTED_SCHEMA_VERSION", async () => {
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Port"] }],
        schemaVersion: 5,
      },
    ]);
    await loadCorpus(dir);
    expect(listCorpus().ok).toBe(true);
  });

  it("loadCorpus tolerates a corpus-meta.json without schema_version (legacy / partial fixture)", async () => {
    // Fixtures without an explicit schema_version (the common case
    // across renderer unit tests) shouldn't trip the gate. The gate
    // only fires for bundles that explicitly advertise a stale
    // schema_version. This isn't a security gap — sections still
    // validate against SectionFileSchema (post-L2b requires def_id),
    // so any section file from an actual schema-1 build would fail
    // its own schema check.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Port"] }],
      },
    ]);
    await loadCorpus(dir);
    expect(listCorpus().ok).toBe(true);
  });

  it("loadCorpus hard-fails on a malformed definitions-v2.json (L2b policy)", async () => {
    // L2b cutover: per-key soft-fail is gone. By L2b the build pipeline
    // owns Definition uniqueness + per-record shape invariants
    // (ModuleDefinitionsSchema); a malformed file at load time means
    // the bundle is corrupt and the loader routes it to
    // CorpusError("corrupt") instead of silently dropping entries.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port",
        codeTitle: "Port",
        moduleVersion: "2026.05.20",
        jurisdiction: "City and County of San Francisco",
        sections: [{ id: "1.1", title: "X", hierarchy: ["Port"] }],
        // Raw value: not a Definition[] — wrong shape, fails schema.
        definitionsV2Raw: { notAnArray: true },
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("corrupt");
    expect(result.error.detail).toContain("definitions-v2.json");
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
    const codeNode = result.value.tree[0]?.kids?.[0];
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
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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
              { kind: "text", text: "Intro text." },
              { kind: "paragraph_break" },
              { kind: "subsection_label", label: "(a)" },
              { kind: "text", text: " Minimum side yards shall be provided as follows:" },
              { kind: "paragraph_break" },
              { kind: "subsection_label", label: "(b)" },
              { kind: "text", text: " Where height does not exceed 25 feet…" },
            ],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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
            body: [{ kind: "text", text: "No subsections here." }],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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
              { kind: "subsection_label", label: "(a)" },
              { kind: "text", text: ` ${longText}` },
            ],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const result = listCorpus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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
                kind: "format",
                style: "list",
                children: [
                  {
                    kind: "format",
                    style: "listItem",
                    children: [
                      { kind: "subsection_label", label: "(a)" },
                      { kind: "text", text: " Inside list" },
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
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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
    const sectionNode = result.value.tree[0]?.kids?.[0]?.kids?.[0]?.kids?.[0];
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

  it("readSection populates parents[].sectionId from the ancestor index", async () => {
    // Breadcrumb clickability contract: module-root parent is non-
    // interactive (sectionId === null); each chapter/article parent
    // points at the first contained section by id (numeric-aware) so
    // a parent-button click dispatches navigate() to a real ref.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "San Francisco Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          { id: "1.1", title: "Definitions", hierarchy: ["Port Code", "Article 1"] },
          { id: "1.2", title: "Commission", hierarchy: ["Port Code", "Article 1"] },
          { id: "2.1", title: "Other", hierarchy: ["Port Code", "Article 2"] },
        ],
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parents).toEqual([
      { code: "Port Code", name: "San Francisco Port Code", sectionId: null },
      { code: "Article 1", name: "", sectionId: "1.1" },
    ]);
    // Article 2 has only 2.1 — sole member is the first contained.
    const r2 = readSection({ moduleId: "sf-port", sectionId: "2.1" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.parents[1]).toEqual({
      code: "Article 2",
      name: "",
      sectionId: "2.1",
    });
  });

  it("ancestor-index prefix keys don't collide when labels contain the delimiter shape", async () => {
    // Fortification: the prefix-key delimiter must be one that cannot
    // appear inside a hierarchy label. A printable delimiter (e.g. a
    // single space) would collide between these two hierarchies — both
    // serialize to "Article 1 Subarticle" at depth 2:
    //   ["Article",   "1 Subarticle"]   → "Article" + sep + "1 Subarticle"
    //   ["Article 1", "Subarticle"]      → "Article 1" + sep + "Subarticle"
    // A collision would silently route 2.1's d=1 breadcrumb to the
    // first-contained section under "Article" (1.1), rather than
    // "Article 1"'s own first-contained section (2.1).
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "San Francisco Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        sections: [
          {
            id: "1.1",
            title: "A",
            hierarchy: ["Port Code", "Article", "1 Subarticle"],
          },
          {
            id: "2.1",
            title: "B",
            hierarchy: ["Port Code", "Article 1", "Subarticle"],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    const r1 = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    const r2 = readSection({ moduleId: "sf-port", sectionId: "2.1" });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Each section's depth-2 ancestor must point at ITSELF (each is the
    // sole member of its own subtree). A delimiter collision would make
    // 2.1's depth-2 entry mistakenly point at 1.1.
    expect(r1.value.parents[2]?.sectionId).toBe("1.1");
    expect(r2.value.parents[2]?.sectionId).toBe("2.1");
  });

  it("readSection joins module definitions-v2 entries for defined-term body segments (D-DELTA-2)", async () => {
    // body[] mentions "Person"; definitions-v2 has Person → 1.1.
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
            body: [
              {
                kind: "defined_term",
                raw: "Person",
                def_id: fixtureDefId("sf-port", "1.1", "Person"),
              },
            ],
            defined_terms: ["Person"],
          },
        ],
        definitions: {
          Person: ["1.1"],
        },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const personId = fixtureDefId("sf-port", "1.1", "Person");
    expect(r.value.definitions[personId]).toEqual({
      term: "Person",
      excerpt: '"Person" means a thing.',
      scope: { kind: "module" },
      first_use_section: "1.1",
    });
  });

  it("readSection projects one wire entry per def_id present in body[]", async () => {
    // L2b cutover: per-occurrence resolution means each defined_term
    // segment resolves to exactly ONE Definition (the precedence-rule
    // winner). Multiple definers of the same term across the module
    // become distinct Definitions with distinct def_ids; body[] picks
    // the winning def_id at build time. The wire shape carries one
    // entry per resolved def_id referenced by this section.
    const def11 = fixtureDefId("sf-port", "1.1", "Vessel");
    const def12 = fixtureDefId("sf-port", "1.2", "Vessel");
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
            text: "Vessel and Vessel",
            body: [
              { kind: "defined_term", raw: "Vessel", def_id: def11 },
              { kind: "text", text: " and " },
              { kind: "defined_term", raw: "Vessel", def_id: def12 },
            ],
            defined_terms: ["Vessel"],
          },
        ],
        definitions: {
          Vessel: ["1.1", "1.2"],
        },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.3" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.definitions).sort()).toEqual([def11, def12].sort());
    expect(r.value.definitions[def11]?.first_use_section).toBe("1.1");
    expect(r.value.definitions[def12]?.first_use_section).toBe("1.2");
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
        definitions: { Person: ["1.1"] },
      },
    ]);
    await loadCorpus(dir);
    const r = readSection({ moduleId: "sf-port", sectionId: "1.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.definitions).toEqual({});
  });

  it("readSection throws when a body def_id is missing from definitionsById (loader trusts the build-time gate)", async () => {
    // Inverse of the build-time `unresolvable_def_id` gate
    // (@/parser/validate-corpus): the build refuses to ship a module
    // whose body[] references a def_id with no matching Definition.
    // The loader trusts that invariant and throws if it's ever
    // violated — covers hand-edited / corrupted installs and surfaces
    // any future regression in the build pipeline loudly instead of
    // silent-skipping, which violated project_legal_corpus_zero_skip.
    const orphanDefId = fixtureDefId("sf-port", "1.1", "Phantom");
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
            text: "Phantom",
            // def_id points to a Definition that isn't in the module index.
            body: [{ kind: "defined_term", raw: "Phantom", def_id: orphanDefId }],
            defined_terms: ["Phantom"],
          },
        ],
        definitions: { Person: ["1.1"] },
      },
    ]);
    await loadCorpus(dir);
    expect(() => readSection({ moduleId: "sf-port", sectionId: "1.1" })).toThrow(
      /unresolvable_def_id gate should have rejected/,
    );
  });

  it("readSection throws when the module has no definitions-v2.json but sections reference def_ids", async () => {
    // Same loader-trust invariant: a corpus on disk without
    // definitions-v2.json AND with body[] defined_term refs is a
    // build-pipeline regression. The loader throws so the regression
    // surfaces immediately rather than rendering tooltipless
    // highlights and masking the bug.
    await buildFixtureCorpus(dir, [
      {
        id: "sf-port",
        name: "Port Code",
        codeTitle: "Port Code",
        moduleVersion: "2026.04.01",
        jurisdiction: "City and County of San Francisco",
        // No `definitions` key → no definitions-v2.json file written.
        sections: [
          {
            id: "1.1",
            title: "Use",
            hierarchy: ["Port Code"],
            text: "Person",
            body: [
              {
                kind: "defined_term",
                raw: "Person",
                def_id: fixtureDefId("sf-port", "1.1", "Person"),
              },
            ],
            defined_terms: ["Person"],
          },
        ],
      },
    ]);
    await loadCorpus(dir);
    expect(() => readSection({ moduleId: "sf-port", sectionId: "1.1" })).toThrow(
      /unresolvable_def_id gate should have rejected/,
    );
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
