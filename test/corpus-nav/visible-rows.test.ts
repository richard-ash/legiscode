import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import {
  __resetVisibleRowsCache,
  alwaysTrue,
  defaultExpansion,
  emptyExpansion,
  expand,
  prefixMatch,
  visibleRows,
} from "@/corpus-nav";

const tree: CorpusTreeNode[] = [
  {
    id: "sf-port",
    code: "Port Code",
    name: "San Francisco Port Code",
    kind: "code",
    kids: [
      {
        id: "sf-port::ART1",
        code: "ARTICLE 1",
        name: "",
        kind: "chapter",
        kids: [
          {
            id: "sf-port::1.1",
            code: "§ 1.1",
            name: "Definitions",
            kind: "section",
            ref: { moduleId: "sf-port", sectionId: "1.1" },
          },
          {
            id: "sf-port::1.2",
            code: "§ 1.2",
            name: "Commission",
            kind: "section",
            ref: { moduleId: "sf-port", sectionId: "1.2" },
          },
        ],
      },
    ],
  },
];

beforeEach(() => {
  __resetVisibleRowsCache();
});

afterEach(() => {
  __resetVisibleRowsCache();
});

describe("visible-rows", () => {
  it("empty tree → empty rows", () => {
    expect(visibleRows([], emptyExpansion())).toEqual([]);
  });

  it("collapsed top-level → only top-level rows", () => {
    const rows = visibleRows(tree, emptyExpansion());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("sf-port");
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.hasKids).toBe(true);
    expect(rows[0]?.isExpanded).toBe(false);
  });

  it("expanded code reveals chapter; expanded chapter reveals sections", () => {
    const exp = defaultExpansion(tree);
    const rows = visibleRows(tree, exp);
    expect(rows.map((r) => r.id)).toEqual([
      "sf-port",
      "sf-port::ART1",
      "sf-port::1.1",
      "sf-port::1.2",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  });

  it("section rows carry a branded ref; non-section rows do not", () => {
    const exp = defaultExpansion(tree);
    const rows = visibleRows(tree, exp);
    expect(rows[0]?.ref).toBeNull();
    expect(rows[1]?.ref).toBeNull();
    expect(rows[2]?.ref?.module).toBe("sf-port");
    expect(rows[2]?.ref?.section).toBe("1.1");
  });

  it("hasKids and isExpanded reflect the tree + expansion state", () => {
    const exp = expand(emptyExpansion(), "sf-port");
    const rows = visibleRows(tree, exp);
    const port = rows.find((r) => r.id === "sf-port");
    const art1 = rows.find((r) => r.id === "sf-port::ART1");
    expect(port?.hasKids).toBe(true);
    expect(port?.isExpanded).toBe(true);
    expect(art1?.hasKids).toBe(true);
    expect(art1?.isExpanded).toBe(false);
  });

  it("memoization: same inputs return same array reference", () => {
    const exp = defaultExpansion(tree);
    const a = visibleRows(tree, exp);
    const b = visibleRows(tree, exp);
    expect(a).toBe(b);
  });

  it("memoization: different inputs return different array references", () => {
    const a = visibleRows(tree, emptyExpansion());
    const b = visibleRows(tree, defaultExpansion(tree));
    expect(a).not.toBe(b);
  });

  it("predicate filters rows: per-node semantics (descendants-aware filter is a future-search concern)", () => {
    const exp = defaultExpansion(tree);
    // prefixMatch("c") matches "Port Code" (token "code" starts with "c")
    // but not "ARTICLE 1" — in the simple per-node semantics, ARTICLE 1's
    // subtree is therefore skipped even though "Commission" would match.
    // Future search filter will need descendants-aware semantics; capture
    // the v1.0 contract here so a behavior change is a deliberate edit.
    const rows = visibleRows(tree, exp, prefixMatch("c"));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("sf-port"); // own token "code" matches
    expect(ids).not.toContain("sf-port::ART1"); // own token rejection skips subtree
    expect(ids).not.toContain("sf-port::1.2");
    expect(ids).not.toContain("sf-port::1.1");
  });

  it("predicate identity matters for memoization", () => {
    const exp = defaultExpansion(tree);
    const a = visibleRows(tree, exp, alwaysTrue);
    const b = visibleRows(tree, exp, alwaysTrue);
    expect(a).toBe(b);
    const c = visibleRows(tree, exp, prefixMatch("anything"));
    expect(c).not.toBe(a);
  });

  it("siblingPos and siblingSize are scoped to the parent (ARIA tree semantics)", () => {
    // Two top-level codes, two chapters under code A, three sections under
    // chapter A1. Each level's posinset/setsize must reflect its own group,
    // not the global flat-list position.
    const t: CorpusTreeNode[] = [
      {
        id: "A",
        code: "A",
        name: "",
        kind: "code",
        kids: [
          {
            id: "A1",
            code: "A1",
            name: "",
            kind: "chapter",
            kids: [
              { id: "A1s1", code: "A1s1", name: "", kind: "section" },
              { id: "A1s2", code: "A1s2", name: "", kind: "section" },
              { id: "A1s3", code: "A1s3", name: "", kind: "section" },
            ],
          },
          { id: "A2", code: "A2", name: "", kind: "chapter" },
        ],
      },
      { id: "B", code: "B", name: "", kind: "code" },
    ];
    const exp = new Set(["A", "A1"]);
    const rows = visibleRows(t, exp);
    const byId = (id: string) => rows.find((r) => r.id === id);

    // Two top-level codes — siblingSize 2 each.
    expect(byId("A")).toMatchObject({ siblingPos: 1, siblingSize: 2 });
    expect(byId("B")).toMatchObject({ siblingPos: 2, siblingSize: 2 });
    // Two chapters under A — siblingSize 2 each.
    expect(byId("A1")).toMatchObject({ siblingPos: 1, siblingSize: 2 });
    expect(byId("A2")).toMatchObject({ siblingPos: 2, siblingSize: 2 });
    // Three sections under A1 — siblingSize 3 each.
    expect(byId("A1s1")).toMatchObject({ siblingPos: 1, siblingSize: 3 });
    expect(byId("A1s2")).toMatchObject({ siblingPos: 2, siblingSize: 3 });
    expect(byId("A1s3")).toMatchObject({ siblingPos: 3, siblingSize: 3 });
  });

  it("siblingSize counts only post-predicate survivors", () => {
    const t: CorpusTreeNode[] = [
      { id: "x1", code: "x1", name: "", kind: "section" },
      { id: "y2", code: "y2", name: "", kind: "section" },
      { id: "x3", code: "x3", name: "", kind: "section" },
    ];
    const rows = visibleRows(t, emptyExpansion(), prefixMatch("x"));
    expect(rows.map((r) => r.id)).toEqual(["x1", "x3"]);
    expect(rows[0]).toMatchObject({ siblingPos: 1, siblingSize: 2 });
    expect(rows[1]).toMatchObject({ siblingPos: 2, siblingSize: 2 });
  });
});

// Synthesize an SF-Municipal-scale tree: 18 modules × 10 chapters × 65 sections
// = 11,700 visible-row leaves at full expansion. Mirrors the actual production
// scale rather than a small toy fixture so perf regressions (e.g., a quadratic
// walk introduced into computeRows or corpusRefFromWire) trip locally.
function makeBigTree(): CorpusTreeNode[] {
  const modules: CorpusTreeNode[] = [];
  for (let m = 0; m < 18; m++) {
    const moduleNode: CorpusTreeNode = {
      id: `mod-${m}`,
      code: `M${m}`,
      name: `Module ${m}`,
      kind: "code",
      kids: [],
    };
    for (let c = 0; c < 10; c++) {
      const chapter: CorpusTreeNode = {
        id: `mod-${m}::ch-${c}`,
        code: `Chapter ${c}`,
        name: "",
        kind: "chapter",
        kids: [],
      };
      for (let s = 0; s < 65; s++) {
        chapter.kids?.push({
          id: `mod-${m}::ch-${c}::s-${s}`,
          code: `§ ${m}.${c}.${s}`,
          name: `Section ${s}`,
          kind: "section",
          ref: { moduleId: `mod-${m}`, sectionId: `${m}.${c}.${s}` },
        });
      }
      moduleNode.kids?.push(chapter);
    }
    modules.push(moduleNode);
  }
  return modules;
}

describe("visible-rows perf assertion", () => {
  it("cached path returns the same reference (< 1ms mean after warmup) on a 12k-row tree", () => {
    const big = makeBigTree();
    const exp = defaultExpansion(big, 5);
    visibleRows(big, exp);
    const N = 200;
    const start = performance.now();
    for (let i = 0; i < N; i++) visibleRows(big, exp);
    const elapsed = performance.now() - start;
    expect(elapsed / N).toBeLessThan(1);
  });

  it("uncached recomputation completes under budget on a 12k-row tree", () => {
    // Defeats the single-entry memo cache by alternating two distinct
    // expansion sets per iteration, so every call is a real walk that
    // builds ~12k Row objects (including corpusRefFromWire validation).
    // Asserts the per-click cost stays well under 16ms (one frame at 60fps)
    // at SF Municipal scale, post-virtualization. Generous threshold (50ms)
    // gives headroom for jsdom + slow CI runners.
    const big = makeBigTree();
    const expA = defaultExpansion(big, 5);
    const expB = new Set(expA);
    expB.delete(`mod-0`); // perturb so the cache misses every alternation
    __resetVisibleRowsCache();
    const N = 50;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      visibleRows(big, i % 2 === 0 ? expA : expB);
    }
    const elapsed = performance.now() - start;
    expect(elapsed / N).toBeLessThan(50);
  });
});
