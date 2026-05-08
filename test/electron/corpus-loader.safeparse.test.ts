// Loader safeParse boundary regression tests (codex C8 / T1 #25 CRITICAL).
//
// Before this branch, electron/corpus-loader.ts at line 244 type-cast the
// raw section JSON via `as SectionFile` without validation — a malformed
// section file (e.g. an unknown body[] segment variant from a hand-edited
// --corpus-path bundle) would slip through and crash the renderer at
// resolve time. The boundary now runs SectionFileSchema.safeParse and
// surfaces failures as CorpusError("corrupt").
//
// These tests are non-negotiable per the legal-corpus completeness gate
// (project memory: legal_corpus_zero_skip). Without them, future loader
// changes could silently re-introduce the malformed-section pass-through.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetCorpusForTests, listCorpus, loadCorpus } from "../../electron/corpus-loader";

const MODULE_ID = "sf-port";

interface ModuleFixture {
  manifest?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  sections: Array<{ filename: string; body: unknown }>;
}

async function buildModuleFixture(root: string, fixture: ModuleFixture): Promise<void> {
  const moduleDir = join(root, MODULE_ID);
  await mkdir(moduleDir, { recursive: true });
  const manifest = fixture.manifest ?? {
    id: MODULE_ID,
    name: "San Francisco Port Code",
    code_title: "Port Code",
    jurisdiction: "City and County of San Francisco",
    module_version: "2026.04.01",
  };
  await writeFile(join(moduleDir, "manifest.json"), JSON.stringify(manifest));
  const meta = fixture.meta ?? {
    module_version: "2026.04.01",
    jurisdiction: "City and County of San Francisco",
  };
  await writeFile(join(moduleDir, "corpus-meta.json"), JSON.stringify(meta));
  const sectionsDir = join(moduleDir, "sections");
  await mkdir(sectionsDir, { recursive: true });
  for (const s of fixture.sections) {
    await writeFile(join(sectionsDir, s.filename), JSON.stringify(s.body));
  }
}

const validSection = {
  kind: "section",
  id: "1.1",
  title: "Definitions",
  text: "Sample text.",
  citations: [],
  defined_terms: [],
  hierarchy: ["Port Code"],
  editorial_status: "active",
  // body[] must re-flatten to text per the SectionFileSchema roundtrip
  // invariant. Spread overrides change either both fields together or
  // neither.
  body: [{ type: "text" as const, text: "Sample text." }],
};

describe("corpus-loader safeParse boundary (T1 #24-26)", () => {
  let dir: string;

  beforeEach(async () => {
    __resetCorpusForTests();
    dir = await mkdtemp(join(tmpdir(), "legiscode-safeparse-"));
  });

  afterEach(async () => {
    __resetCorpusForTests();
    await rm(dir, { recursive: true, force: true });
  });

  // T1 #24 — valid section JSON loads OK. Sanity check that adding the
  // safeParse layer didn't break the happy path.
  it("loads a valid section through the safeParse boundary", async () => {
    await buildModuleFixture(dir, {
      sections: [{ filename: "1.1.json", body: validSection }],
    });
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const list = listCorpus();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.sectionCount).toBe(1);
  });

  // T1 #24b — body-less JSON with non-empty text fails the roundtrip
  // invariant. The renderer iterates body[]; bodyless content would
  // render blank while search/export still see text. Stale --corpus-path
  // bundles built before body[] landed must be re-generated; the loader
  // surfaces the wedge as a corrupt error rather than silently miscoercing.
  it("surfaces CorpusError(corrupt) for a body-less section with non-empty text (roundtrip wedge)", async () => {
    const { body: _drop, ...bodyless } = validSection;
    await buildModuleFixture(dir, {
      sections: [{ filename: "1.1.json", body: bodyless }],
    });
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
  });

  // T1 #25 CRITICAL — malformed body[] (unknown variant) → CorpusError("corrupt").
  // This is the codex C8 regression test. Without it, future loader changes
  // could re-introduce silent malformed-section pass-through.
  it("surfaces CorpusError(corrupt) when a body segment has an unknown variant type", async () => {
    await buildModuleFixture(dir, {
      sections: [
        {
          filename: "1.1.json",
          body: { ...validSection, body: [{ type: "marquee", text: "nope" }] },
        },
      ],
    });
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
    expect(result.error.detail).toContain("1.1.json");
  });

  // T1 #25b — malformed body[] (citation_index out of range) hits the
  // superRefine, also surfacing as corrupt. Different code path than the
  // discriminated-union rejection above. Text matches body so the
  // roundtrip check passes and this test isolates citation_index.
  it("surfaces CorpusError(corrupt) when citation_index is out of range (superRefine)", async () => {
    await buildModuleFixture(dir, {
      sections: [
        {
          filename: "1.1.json",
          body: {
            ...validSection,
            text: "§ 1.01",
            citations: [],
            body: [{ type: "citation", raw: "§ 1.01", citation_index: 0 }],
          },
        },
      ],
    });
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
  });

  // T1 #26 — malformed top-level field (missing required `text`).
  // Same outcome — corrupt — different rejection path.
  it("surfaces CorpusError(corrupt) when a required top-level field is missing", async () => {
    const { text: _omit, ...incomplete } = validSection;
    await buildModuleFixture(dir, {
      sections: [{ filename: "1.1.json", body: incomplete }],
    });
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
  });

  // T1 #26b — invalid JSON parses cleanly into a corrupt error rather
  // than crashing the loader. Defense-in-depth: zod doesn't see this
  // because JSON.parse throws first; we catch and re-wrap.
  it("surfaces CorpusError(corrupt) when a section file is not valid JSON", async () => {
    await mkdir(join(dir, MODULE_ID), { recursive: true });
    await writeFile(
      join(dir, MODULE_ID, "manifest.json"),
      JSON.stringify({
        id: MODULE_ID,
        name: "Port",
        code_title: "Port",
        jurisdiction: "City and County of San Francisco",
        module_version: "2026.04.01",
      }),
    );
    await writeFile(
      join(dir, MODULE_ID, "corpus-meta.json"),
      JSON.stringify({ module_version: "2026.04.01" }),
    );
    await mkdir(join(dir, MODULE_ID, "sections"), { recursive: true });
    await writeFile(join(dir, MODULE_ID, "sections", "1.1.json"), "{ not json");
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
  });

  // T1 #25c — malformed editorial_status. The schema is strict on the
  // enum; an unknown value fails fast even though every other field is
  // valid.
  it("surfaces CorpusError(corrupt) when editorial_status is not a known enum value", async () => {
    await buildModuleFixture(dir, {
      sections: [
        {
          filename: "1.1.json",
          body: { ...validSection, editorial_status: "deprecated" },
        },
      ],
    });
    const result = await loadCorpus(dir);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.kind).toBe("corrupt");
  });
});
