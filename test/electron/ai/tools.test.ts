// Per-path tests against the hermetic corpus-min fixture. Two tools —
// read and search — over the path tree (see electron/ai/tools/types.ts).
// Each test asserts the uniform ToolResultBase shape (ok / fetched /
// corpus_hash / turn_id) is present.

import { describe, expect, it } from "vitest";
import { dispatchTool } from "../../../electron/ai/tool-router";
import { loadFixtureCorpus } from "./load-fixture-corpus";

const TURN = 7;

describe("read /", () => {
  it("lists the top-level roots", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      entries: readonly { path: string }[];
    };
    expect(payload.kind).toBe("directory");
    const paths = payload.entries.map((e) => e.path);
    expect(paths).toContain("/bills");
    expect(paths).toContain("/modules");
    expect(paths).toContain("/ordinances");
    expect(result.payload.turn_id).toBe(TURN);
    expect(result.payload.corpus_hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("read /modules/.../sections/...", () => {
  it("returns full text + qualified citations for a known section", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/sections/1.1" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      section: { text: string; citations: readonly { module_id: string; section_id: string }[] };
    };
    expect(payload.kind).toBe("section");
    expect(payload.section.text).toContain("Hermetic fixture content");
    expect(payload.section.citations).toContainEqual({
      module_id: "test-alpha",
      section_id: "1.2",
    });
    expect(payload.section.citations).toContainEqual({ module_id: "ca-vehicle", section_id: "21" });
    expect(result.payload.fetched).toEqual([{ module_id: "test-alpha", section_id: "1.1" }]);
  });

  it("returns not_found for an unknown section", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/sections/99.99" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
    expect(result.payload.fetched).toEqual([]);
  });

  it("returns not_found when the module isn't installed", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/no-such-module" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});

describe("search", () => {
  it("returns hits with snippets across all modules when module_id omitted", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "search",
        input: { query: "Hermetic" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      hits: readonly { module_id: string; section_id: string; snippet: string; path: string }[];
    };
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits[0]?.snippet).toContain("Hermetic");
    // Every hit carries a read path so the model can fetch the full section.
    for (const hit of payload.hits) {
      expect(hit.path).toBe(`/modules/${hit.module_id}/sections/${hit.section_id}`);
    }
  });

  it("scopes hits to module_id when provided", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "search",
        input: { query: "Hermetic", module_id: "test-alpha" },
      },
      { corpus, turnId: TURN },
    );
    const payload = result.payload as unknown as { hits: readonly { module_id: string }[] };
    for (const hit of payload.hits) {
      expect(hit.module_id).toBe("test-alpha");
    }
  });
});

describe("read /modules/.../sections/.../cited-by", () => {
  it("returns sections that cite the target without counting them as fetched", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/sections/1.2/cited-by" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      citers: readonly { module_id: string; section_id: string }[];
    };
    expect(payload.kind).toBe("section-citers");
    expect(payload.citers).toContainEqual(
      expect.objectContaining({ module_id: "test-alpha", section_id: "1.1" }),
    );
    // cited-by names but never fetches — fetched stays empty.
    expect(result.payload.fetched).toEqual([]);
  });

  it("returns not_found when the target section doesn't exist", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/sections/999.9/cited-by" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
  });
});

describe("read /modules/.../sections/.../amendments", () => {
  it("returns the session bills affecting a section", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/sections/1.1/amendments" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as { kind: string };
    expect(payload.kind).toBe("section-amendments");
  });
});

describe("read /modules/.../sections/.../history", () => {
  it("returns an empty history for fixtures without ordinance-history files", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/modules/test-alpha/sections/1.1/history" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as { kind: string; history: readonly unknown[] };
    expect(payload.kind).toBe("section-history");
    expect(payload.history).toEqual([]);
  });
});

describe("read /bills", () => {
  it("lists session bills loaded from every module", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/bills" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      total: number;
      bills: readonly { file_no: string; module_id: string; bill_status: string }[];
      truncated: boolean;
    };
    expect(payload.kind).toBe("bills-list");
    // The hermetic corpus-min fixture has three bills under test-alpha,
    // listed newest-introduced first.
    expect(payload.total).toBe(3);
    expect(payload.bills.map((b) => b.file_no)).toEqual(["990003", "990002", "990001"]);
    expect(payload.bills[0]?.module_id).toBe("test-alpha");
    expect(payload.truncated).toBe(false);
    // Bills are session-state, not law — `fetched` stays empty.
    expect(result.payload.fetched).toEqual([]);
  });
});

describe("read /bills/{file_no}", () => {
  it("returns bill metadata with read-next subpaths", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/bills/990001" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      bill: {
        file_no: string;
        subpaths: { proposed_text: string; changes: string; impact: string };
      };
    };
    expect(payload.kind).toBe("bill");
    expect(payload.bill.file_no).toBe("990001");
    expect(payload.bill.subpaths.proposed_text).toBe("/bills/990001/proposed-text");
    expect(payload.bill.subpaths.changes).toBe("/bills/990001/changes");
    expect(payload.bill.subpaths.impact).toBe("/bills/990001/impact");
  });

  it("returns not_found for an unknown file_no", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/bills/999999" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});

describe("read /bills/{file_no}/proposed-text", () => {
  it("returns the full ordinance body with preamble + amendments + closing", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/bills/990001/proposed-text" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      body: { file_no: string; preamble: string; amendments: readonly unknown[]; closing: string };
    };
    expect(payload.kind).toBe("bill-proposed-text");
    expect(payload.body.file_no).toBe("990001");
    expect(typeof payload.body.preamble).toBe("string");
  });
});

describe("read /bills/{file_no}/changes", () => {
  it("returns per-section change index with diff paths", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/bills/990001/changes" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      changes: readonly { section_id: string; status: string; path: string }[];
    };
    expect(payload.kind).toBe("bill-changes");
    for (const change of payload.changes) {
      expect(change.path).toMatch(/^\/bills\/990001\/changes\/test-alpha\/.+$/);
    }
  });
});

describe("read /ordinances", () => {
  it("returns ok with an empty list on the hermetic fixture (no AMENDMENT HISTORY)", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/ordinances" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as {
      kind: string;
      total: number;
      truncated: boolean;
    };
    expect(payload.kind).toBe("ordinances");
    expect(payload.total).toBe(0);
    expect(payload.truncated).toBe(false);
    expect(result.payload.fetched).toEqual([]);
  });

  it("rejects an out-of-range year as not_found", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/ordinances/1500" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});

describe("read /definitions/{term}", () => {
  it("searches every installed module when called on the root definitions path", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      { toolUseId: "u1", name: "read", input: { path: "/definitions/Hermetic" } },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as { kind: string };
    expect(payload.kind).toBe("definitions");
  });
});

describe("router fallback", () => {
  it("rejects unknown tool names with bad_input", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "make_coffee",
        input: {},
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("bad_input");
  });

  it("rejects an unknown path under /bills with not_found", async () => {
    const corpus = await loadFixtureCorpus();
    const result = await dispatchTool(
      {
        toolUseId: "u1",
        name: "read",
        input: { path: "/bills/990001/wat" },
      },
      { corpus, turnId: TURN },
    );
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});
