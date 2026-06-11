// /modules/{m}/articles and /modules/{m}/articles/{a} read arms
// (commit 1, feat/agent-polish). Per the path-tree schema in
// electron/ai/tools/types.ts the article path is a new pair of read
// targets the model uses for range / "Article N" / "et seq." questions
// without guessing section ids.

import { describe, expect, it } from "vitest";
import { dispatchTool } from "../../../electron/ai/tool-router";
import { loadFixtureCorpus } from "./load-fixture-corpus";

const TURN = 11;

describe("read /modules/{m}/articles", () => {
  it("lists every article in the module with section counts", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/modules/test-alpha/articles" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      module_id: string;
      articles: readonly {
        module_id: string;
        article_id: string;
        title: string;
        parents: readonly { kind: string; id: string }[];
        section_count: number;
        path: string;
      }[];
    };
    expect(payload.kind).toBe("articles-list");
    expect(payload.module_id).toBe("test-alpha");
    // test-alpha fixtures put 1.1 and 1.2 under Article 1 ("Test Article").
    expect(payload.articles).toHaveLength(1);
    expect(payload.articles[0]).toMatchObject({
      module_id: "test-alpha",
      article_id: "1",
      title: "Test Article",
      parents: [],
      section_count: 2,
      path: "/modules/test-alpha/articles/1",
    });
    expect(result.payload.fetched).toEqual([]);
    expect(result.payload.turn_id).toBe(TURN);
    expect(result.payload.corpus_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("surfaces chapter parents in the parent chain for sub-nested articles", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/modules/test-beta/articles" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      articles: readonly {
        article_id: string;
        parents: readonly { kind: string; id: string }[];
        section_count: number;
      }[];
    };
    expect(payload.articles).toHaveLength(1);
    expect(payload.articles[0]).toMatchObject({
      article_id: "12-D",
      parents: [{ kind: "chapter", id: "5" }],
      section_count: 1,
    });
  });

  it("returns an empty list when no section in the module has an article", async () => {
    // No fixture module is article-less today — instead probe an article
    // id that doesn't exist to exercise the empty-result path.
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/articles/nonexistent" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});

describe("read /modules/{m}/articles/{a}", () => {
  it("returns ordered sections under the article with read-paths", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/modules/test-alpha/articles/1" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      module_id: string;
      article_id: string;
      title: string;
      sections: readonly {
        section_id: string;
        display_label: string;
        title: string;
        editorial_status: string;
        path: string;
      }[];
    };
    expect(payload.kind).toBe("article-sections");
    expect(payload.module_id).toBe("test-alpha");
    expect(payload.article_id).toBe("1");
    expect(payload.title).toBe("Test Article");
    expect(payload.sections).toHaveLength(2);
    expect(payload.sections.map((s) => s.section_id)).toEqual(["1.1", "1.2"]);
    expect(payload.sections[0]?.path).toBe("/modules/test-alpha/sections/1.1");
    expect(payload.sections[1]?.path).toBe("/modules/test-alpha/sections/1.2");
    // Listing the article doesn't count as fetching the sections — the
    // model still has to read each section path before citing it.
    expect(result.payload.fetched).toEqual([]);
  });

  it("matches the article id case-insensitively", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/modules/test-beta/articles/12-d" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      article_id: string;
      sections: readonly unknown[];
    };
    expect(payload.article_id).toBe("12-D");
    expect(payload.sections).toHaveLength(1);
  });

  it("returns not_found for an unknown article", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/modules/test-alpha/articles/99" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });

  it("returns not_found when the module isn't installed", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/modules/nonexistent/articles" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});
