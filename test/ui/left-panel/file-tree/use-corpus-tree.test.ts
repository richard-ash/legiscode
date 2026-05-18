// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import { __resetVisibleRowsCache } from "@/corpus-nav";
import { useCorpusTree } from "@/ui/left-panel/file-tree/use-corpus-tree";

// Pins the memoization invariant from plan Risk #3:
//   "If rowIndexById is recomputed on every render instead of riding
//    rows's memoization, the perf 'fix' actually adds work."
// If a future refactor changes the useMemo deps or accidentally rebuilds
// the Map per render, this test catches it. The downstream KeyboardState
// + useRovingFocus contracts rely on rowIndexById identity tracking
// `rows` identity; without that, every keypress invalidates dispatcher
// callbacks and the perf assertion regresses.

const tree: readonly CorpusTreeNode[] = [
  {
    id: "sf-port",
    code: "Port Code",
    name: "",
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
        ],
      },
    ],
  },
];

afterEach(() => {
  __resetVisibleRowsCache();
});

describe("useCorpusTree — rowIndexById Map reference stability", () => {
  it("returns the same Map instance across renders when the input tree is unchanged", () => {
    const { result, rerender } = renderHook(() => useCorpusTree(tree));
    const firstMap = result.current.rowIndexById;
    const firstRows = result.current.rows;
    rerender();
    rerender();
    expect(result.current.rowIndexById).toBe(firstMap);
    expect(result.current.rows).toBe(firstRows);
  });

  it("rowIndexById entries reflect the visible-rows order", () => {
    const { result } = renderHook(() => useCorpusTree(tree));
    const { rows, rowIndexById } = result.current;
    rows.forEach((row, expectedIndex) => {
      expect(rowIndexById.get(row.id)).toBe(expectedIndex);
    });
    // Every visible row id is keyed.
    expect(rowIndexById.size).toBe(rows.length);
  });

  it("Map rebuilds when expansion state changes (different rows identity)", () => {
    const { result } = renderHook(() => useCorpusTree(tree));
    const firstMap = result.current.rowIndexById;
    // Collapse the chapter — different expansion state means visibleRows
    // returns a different array reference, which should trigger a new Map.
    act(() => {
      result.current.setExpansion(new Set(["sf-port"]));
    });
    expect(result.current.rowIndexById).not.toBe(firstMap);
    // The new Map must still correctly index the new rows.
    const { rows, rowIndexById } = result.current;
    rows.forEach((row, i) => {
      expect(rowIndexById.get(row.id)).toBe(i);
    });
  });
});
