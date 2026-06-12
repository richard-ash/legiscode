// /modules/{m}/sections/{s}/dependencies — composed dependency picture
// over the hermetic corpus-min fixture. §1.1 cites §1.2 plus an
// uninstalled state-code section; both sit under article "1"; fixture
// bills 990001 (targets §1.1) and 990003 (targets §1.2) provide the
// pending-bill arms.

import { describe, expect, it } from "vitest";
import type { Definition, SectionFile } from "@/types";
import { dispatchTool } from "../../../electron/ai/tool-router";
import type { ToolContext } from "../../../electron/ai/tools/read";
import { buildSectionDependencies } from "../../../electron/ai/tools/section-dependencies";
import type { AiCorpusModule } from "../../../electron/corpus-loader";
import { loadFixtureCorpus } from "./load-fixture-corpus";

const TURN = 7;

interface DependenciesShape {
  kind: string;
  dependencies: {
    module_id: string;
    section_id: string;
    editorial_status: string;
    outbound_citations: readonly {
      module_id: string;
      section_id: string;
      installed: boolean;
      path: string | null;
      display_label: string | null;
      title: string | null;
    }[];
    inbound_citers: readonly { module_id: string; section_id: string; path: string }[];
    defined_terms_used: readonly {
      term: string;
      defined_in: readonly { module_id: string; section_id: string; path: string }[];
    }[];
    article: {
      article_id: string;
      title: string;
      siblings: readonly { section_id: string; path: string }[];
    } | null;
    pending_bills: readonly { file_no: string }[];
  };
}

async function readDependencies(path: string) {
  const corpus = await loadFixtureCorpus();
  return dispatchTool({ toolUseId: "u1", name: "read", input: { path } }, { corpus, turnId: TURN });
}

describe("read /modules/.../sections/.../dependencies", () => {
  it("composes outbound cites, siblings, and pending bills for §1.1", async () => {
    const result = await readDependencies("/modules/test-alpha/sections/1.1/dependencies");
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as DependenciesShape;
    expect(payload.kind).toBe("section-dependencies");
    expect(payload.dependencies.section_id).toBe("1.1");

    // Outbound: an installed sibling and an uninstalled state-code cite.
    expect(payload.dependencies.outbound_citations).toContainEqual({
      module_id: "test-alpha",
      section_id: "1.2",
      installed: true,
      path: "/modules/test-alpha/sections/1.2",
      display_label: "1.2",
      title: "Test Section 1.2",
    });
    expect(payload.dependencies.outbound_citations).toContainEqual({
      module_id: "ca-vehicle",
      section_id: "21",
      installed: false,
      path: null,
      display_label: null,
      title: null,
    });

    // Nothing cites §1.1 in the fixture.
    expect(payload.dependencies.inbound_citers).toEqual([]);

    // The fixture corpus carries no definitions; the section also
    // declares no defined terms, so the arm is empty.
    expect(payload.dependencies.defined_terms_used).toEqual([]);

    // Article "1" holds §1.1 and §1.2; siblings exclude the target.
    expect(payload.dependencies.article?.article_id).toBe("1");
    expect(payload.dependencies.article?.siblings.map((s) => s.section_id)).toEqual(["1.2"]);

    // Bill 990001 targets §1.1.
    expect(payload.dependencies.pending_bills.map((b) => b.file_no)).toEqual(["990001"]);

    // The target counts as fetched; citers/siblings do not.
    expect(result.payload.fetched).toEqual([{ module_id: "test-alpha", section_id: "1.1" }]);
    expect(result.payload.turn_id).toBe(TURN);
  });

  it("reports inbound citers for §1.2 and the bill that targets it", async () => {
    const result = await readDependencies("/modules/test-alpha/sections/1.2/dependencies");
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as DependenciesShape;
    expect(payload.dependencies.outbound_citations).toEqual([]);
    expect(payload.dependencies.inbound_citers).toEqual([
      {
        module_id: "test-alpha",
        section_id: "1.1",
        display_label: "1.1",
        title: "Test Section 1.1",
        path: "/modules/test-alpha/sections/1.1",
      },
    ]);
    expect(payload.dependencies.article?.siblings.map((s) => s.section_id)).toEqual(["1.1"]);
    expect(payload.dependencies.pending_bills.map((b) => b.file_no)).toEqual(["990003"]);
  });

  it("returns not_found for an unknown section", async () => {
    const result = await readDependencies("/modules/test-alpha/sections/9.9/dependencies");
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });

  it("rejects trailing segments after /dependencies", async () => {
    const result = await readDependencies("/modules/test-alpha/sections/1.1/dependencies/extra");
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});

// ─── buildSectionDependencies — unit (stub corpus) ──────────────────────────
//
// The corpus-min fixture carries no definitions and every fixture
// section sits under an article, so the defined-terms arm and both
// article-null branches are exercised here against a hand-built handle.

function makeSection(id: string, overrides: Partial<SectionFile> = {}): { section: SectionFile } {
  return {
    section: {
      kind: "section",
      id,
      display_label: id,
      title: `Stub Section ${id}`,
      text: "",
      citations: [],
      defined_terms: [],
      hierarchy: [],
      editorial_status: "active",
      body: [],
      article: null,
      ...overrides,
    },
  };
}

function makeDefinition(term: string, definedIn: string, moduleId: string): Definition {
  return {
    id: `${moduleId}/${definedIn}#deadbeef`,
    term,
    defined_in: definedIn,
    body_anchor: { start: 0, end: term.length },
    excerpt: `"${term}" means a stub term.`,
    scope: { kind: "module" },
    extracted_by: "test:stub",
  };
}

function makeDepsCtx(modules: readonly AiCorpusModule[]): ToolContext {
  const byKey = new Map<string, SectionFile>();
  for (const mod of modules) {
    for (const wrap of mod.sections) byKey.set(`${mod.id}::${wrap.section.id}`, wrap.section);
  }
  return {
    corpus: {
      // Unique hash so the cached reverse graph / bills index from the
      // fixture tests above never bleed into this stub.
      corpusHash: "stub-deps-unit",
      rootDir: "/stub",
      modules,
      getSection: (m, s) => byKey.get(`${m}::${s}`) ?? null,
    },
    turnId: TURN,
  };
}

describe("buildSectionDependencies — defined terms and missing articles (unit)", () => {
  const modX: AiCorpusModule = {
    id: "mod-x",
    name: "Stub Module X",
    codeTitle: "Stub Code X",
    jurisdiction: "test",
    sections: [
      // Double space in the used term: matching goes through
      // normalizeTerm (trim + lowercase + whitespace collapse).
      makeSection("2.1", { defined_terms: ["Special  Event", "ghost term"] }),
      makeSection("2.2", { article: { id: "Z", title: "Orphan Article", parents: [] } }),
    ],
    definitions: [
      makeDefinition("special event", "2.9", "mod-x"),
      makeDefinition("unrelated term", "2.8", "mod-x"),
    ],
    articles: [],
    sessionBills: [],
  };
  const modY: AiCorpusModule = {
    id: "mod-y",
    name: "Stub Module Y",
    codeTitle: "Stub Code Y",
    jurisdiction: "test",
    sections: [],
    definitions: [makeDefinition("Special Event", "9.1", "mod-y")],
    articles: [],
    sessionBills: [],
  };

  it("resolves used terms across every module's definitions, empty when undefined", () => {
    const result = buildSectionDependencies("mod-x", "2.1", makeDepsCtx([modX, modY]));
    if (!result.ok || result.kind !== "section-dependencies") {
      expect.fail("expected section-dependencies");
    } else {
      expect(result.dependencies.defined_terms_used).toEqual([
        {
          term: "Special  Event",
          defined_in: [
            { module_id: "mod-x", section_id: "2.9", path: "/modules/mod-x/sections/2.9" },
            { module_id: "mod-y", section_id: "9.1", path: "/modules/mod-y/sections/9.1" },
          ],
        },
        { term: "ghost term", defined_in: [] },
      ]);
      // A section with no article metadata reports article: null.
      expect(result.dependencies.article).toBeNull();
    }
  });

  it("reports article null when the section's article id is missing from the module index", () => {
    const result = buildSectionDependencies("mod-x", "2.2", makeDepsCtx([modX, modY]));
    if (!result.ok || result.kind !== "section-dependencies") {
      expect.fail("expected section-dependencies");
    } else {
      expect(result.dependencies.article).toBeNull();
    }
  });
});
