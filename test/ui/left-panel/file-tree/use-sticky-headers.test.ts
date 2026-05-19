// @vitest-environment jsdom
import type { Virtualizer } from "@tanstack/react-virtual";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import type { Row } from "@/corpus-nav";
import { useStickyHeaders } from "@/ui/left-panel/file-tree/use-sticky-headers";

// Hook-level test (D9 from the eng-review plan). The virtualizer is
// mocked end-to-end — we never instantiate @tanstack/react-virtual — so
// the assertions stay focused on the topmost-row pick and ancestor walk.

interface RowInit {
  id: string;
  depth: number;
  hasKids?: boolean;
  isExpanded?: boolean;
}

function makeRow({ id, depth, hasKids = false, isExpanded = false }: RowInit): Row {
  const node: CorpusTreeNode = { id, code: id, name: "", kind: "section" };
  return {
    id,
    depth,
    node,
    ref: null,
    hasKids,
    isExpanded,
    siblingPos: 1,
    siblingSize: 1,
  };
}

function indexMap(rows: readonly Row[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  rows.forEach((r, i) => {
    m.set(r.id, i);
  });
  return m;
}

interface VItem {
  index: number;
  start: number;
  size: number;
  end: number;
}

function vItem(index: number, start: number, size = 24): VItem {
  return { index, start, size, end: start + size };
}

interface MockVirtualizerArgs {
  virtualItems: VItem[];
  scrollOffset: number;
}

function mockVirtualizer(args: MockVirtualizerArgs): Virtualizer<HTMLDivElement, Element> {
  // The hook only reads `scrollOffset` and calls `getVirtualItems()`.
  // Mock just those surfaces and cast.
  return {
    scrollOffset: args.scrollOffset,
    getVirtualItems: () => args.virtualItems,
  } as unknown as Virtualizer<HTMLDivElement, Element>;
}

// Realistic tree: depth-0 code, depth-1 chapter, depth-2 article, depth-3
// sections. Mirrors what visibleRows() produces with the ancestors
// preceding descendants invariant.
function buildRows(): readonly Row[] {
  return [
    makeRow({ id: "code", depth: 0, hasKids: true, isExpanded: true }),
    makeRow({ id: "ch-1", depth: 1, hasKids: true, isExpanded: true }),
    makeRow({ id: "art-1", depth: 2, hasKids: true, isExpanded: true }),
    makeRow({ id: "sec-1", depth: 3 }),
    makeRow({ id: "sec-2", depth: 3 }),
    makeRow({ id: "sec-3", depth: 3 }),
    makeRow({ id: "art-2", depth: 2, hasKids: true, isExpanded: true }),
    makeRow({ id: "sec-4", depth: 3 }),
  ];
}

describe("useStickyHeaders — topmost picking (codex D13)", () => {
  // Overscan keeps off-screen rows mounted ahead of the viewport. The
  // hook MUST skip the off-screen overscan items and find the first item
  // whose `end` crosses the visible top edge. virtualItems[0] would
  // silently lag by up to 8 rows.
  it("skips overscan items and picks the first item with end > threshold", () => {
    const rows = buildRows();
    // Suppose scrollOffset = 96 (4 rows scrolled past). Overscan keeps
    // rows starting at index 0 mounted, but their `end` values are 24,
    // 48, 72, 96 — all <= the threshold. The first item with `end > 96`
    // is index 4 (sec-2), starting at 96, ending at 120.
    const virtualItems: VItem[] = [
      vItem(0, 0),
      vItem(1, 24),
      vItem(2, 48),
      vItem(3, 72),
      vItem(4, 96),
      vItem(5, 120),
      vItem(6, 144),
      vItem(7, 168),
    ];
    const { result } = renderHook(() =>
      useStickyHeaders({
        rows,
        rowIndexById: indexMap(rows),
        virtualizer: mockVirtualizer({ virtualItems, scrollOffset: 96 }),
        useVirtualization: true,
        stickyStackHeight: 0,
      }),
    );
    // sec-2 (depth 3) has ancestors code → ch-1 → art-1 in root-down order.
    expect(result.current.map((r) => r.id)).toEqual(["code", "ch-1", "art-1"]);
  });

  it("accounts for stickyStackHeight in the threshold", () => {
    const rows = buildRows();
    // scrollOffset 0, but sticky stack is 48px tall (e.g. depth-0 + depth-1
    // pinned). The visible top edge is 48px down — the row at start=48
    // (index 2 = art-1) is the topmost VISIBLE row, NOT index 0.
    const virtualItems: VItem[] = [vItem(0, 0), vItem(1, 24), vItem(2, 48), vItem(3, 72)];
    const { result } = renderHook(() =>
      useStickyHeaders({
        rows,
        rowIndexById: indexMap(rows),
        virtualizer: mockVirtualizer({ virtualItems, scrollOffset: 0 }),
        useVirtualization: true,
        stickyStackHeight: 48,
      }),
    );
    // art-1 (depth 2) → ancestors code, ch-1.
    expect(result.current.map((r) => r.id)).toEqual(["code", "ch-1"]);
  });
});

describe("useStickyHeaders — edge cases", () => {
  it("empty rows → empty ancestors", () => {
    const { result } = renderHook(() =>
      useStickyHeaders({
        rows: [],
        rowIndexById: new Map(),
        virtualizer: mockVirtualizer({ virtualItems: [], scrollOffset: 0 }),
        useVirtualization: true,
        stickyStackHeight: 0,
      }),
    );
    expect(result.current).toEqual([]);
  });

  it("topmost row at depth 0 → empty ancestors", () => {
    const rows = buildRows();
    const { result } = renderHook(() =>
      useStickyHeaders({
        rows,
        rowIndexById: indexMap(rows),
        // Topmost is `code` at index 0. Depth 0 has no ancestors.
        virtualizer: mockVirtualizer({ virtualItems: [vItem(0, 0)], scrollOffset: 0 }),
        useVirtualization: true,
        stickyStackHeight: 0,
      }),
    );
    expect(result.current).toEqual([]);
  });

  it("useVirtualization=false short-circuits to empty without touching the virtualizer", () => {
    const rows = buildRows();
    // Pass a virtualizer mock that THROWS if called — proves the hook
    // doesn't reach for it when virtualization is off.
    const guardedVirtualizer = {
      get scrollOffset() {
        throw new Error("should not be read when useVirtualization=false");
      },
      getVirtualItems() {
        throw new Error("should not be called when useVirtualization=false");
      },
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    const { result } = renderHook(() =>
      useStickyHeaders({
        rows,
        rowIndexById: indexMap(rows),
        virtualizer: guardedVirtualizer,
        useVirtualization: false,
        stickyStackHeight: 0,
      }),
    );
    expect(result.current).toEqual([]);
  });

  it("happy path: depth-N topmost yields N ancestors in root-down order", () => {
    const rows = buildRows();
    // sec-1 (depth 3) at index 3.
    const { result } = renderHook(() =>
      useStickyHeaders({
        rows,
        rowIndexById: indexMap(rows),
        virtualizer: mockVirtualizer({ virtualItems: [vItem(3, 72)], scrollOffset: 60 }),
        useVirtualization: true,
        stickyStackHeight: 0,
      }),
    );
    expect(result.current.map((r) => r.id)).toEqual(["code", "ch-1", "art-1"]);
  });
});

describe("useStickyHeaders — reference stability (D4 memoization invariant)", () => {
  // Sub-row scrolling within the same topmost row MUST NOT invalidate the
  // ancestor[] reference. If it does, StickyHeaderStack's React.memo (and
  // anything downstream that depends on identity) churns on every scroll
  // event. The test simulates the user scrolling within a single 24px row
  // window — the same row stays topmost, ancestors must be the same array.
  it("ancestors[] reference is stable when topmostRowId is unchanged", () => {
    const rows = buildRows();
    const map = indexMap(rows);
    const renderProps = (scrollOffset: number) => ({
      rows,
      rowIndexById: map,
      virtualizer: mockVirtualizer({
        virtualItems: [vItem(3, 72), vItem(4, 96), vItem(5, 120)],
        scrollOffset,
      }),
      useVirtualization: true,
      stickyStackHeight: 0,
    });
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof renderProps>) => useStickyHeaders(props),
      {
        // Initial scroll offset 60 — first item with end > 60 is index 3
        // (sec-1, end=96). Topmost = sec-1.
        initialProps: renderProps(60),
      },
    );
    const first = result.current;
    // Advance scroll by 10px — still inside sec-1's window (60 → 70 < 96
    // = sec-1's end). Topmost stays sec-1, ancestors identity must hold.
    rerender(renderProps(70));
    const second = result.current;
    expect(second).toBe(first);
  });

  it("ancestors[] reference changes when topmostRowId crosses a row boundary", () => {
    const rows = buildRows();
    const map = indexMap(rows);
    const renderProps = (scrollOffset: number) => ({
      rows,
      rowIndexById: map,
      virtualizer: mockVirtualizer({
        virtualItems: [vItem(3, 72), vItem(4, 96), vItem(5, 120), vItem(6, 144)],
        scrollOffset,
      }),
      useVirtualization: true,
      stickyStackHeight: 0,
    });
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof renderProps>) => useStickyHeaders(props),
      {
        initialProps: renderProps(60),
      },
    );
    const first = result.current;
    // Cross the boundary: scrollOffset 100 — sec-1 ends at 96 (no longer
    // > threshold), so topmost becomes sec-2 (end=120). Same ancestors
    // by content, but the memo's identity gate is by topmostRowId, so
    // the reference must differ.
    rerender(renderProps(100));
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });
});
