// @vitest-environment jsdom
import type { Virtualizer } from "@tanstack/react-virtual";
import { act, renderHook } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import type { Row } from "@/corpus-nav";
import { useRovingFocus } from "@/ui/left-panel/file-tree/use-roving-focus";
import { emptyOpenItems } from "@/workbench";

// Hook-level test (D7 in the eng-review plan). The virtualization branch is
// forced via the `useVirtualization` prop directly, so we never need a
// JSDOM_GUARD_ROW_COUNT-sized fixture to cross @tanstack/react-virtual's
// jsdom guard. Build Row fixtures by hand — visibleRows() isn't under test
// here and we want full control over divergent rows/rowIndexById pairs
// (the F-perf contract check below depends on that divergence).

interface RowOverrides {
  depth?: number;
  hasKids?: boolean;
  isExpanded?: boolean;
}

function makeRow(id: string, o: RowOverrides = {}): Row {
  const node: CorpusTreeNode = { id, code: id, name: "", kind: "section" };
  return {
    id,
    depth: o.depth ?? 0,
    node,
    ref: null,
    hasKids: o.hasKids ?? false,
    isExpanded: o.isExpanded ?? false,
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

// The hook only calls `virtualizer.scrollToIndex`. Everything else on the
// Virtualizer surface stays unreferenced, so we mock just that one method
// and cast.
function makeMockVirtualizer(): {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollToIndex: ReturnType<typeof vi.fn>;
} {
  const scrollToIndex = vi.fn();
  return {
    virtualizer: { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>,
    scrollToIndex,
  };
}

interface HookProps {
  rows: readonly Row[];
  rowIndexById: ReadonlyMap<string, number>;
  useVirtualization: boolean;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  containerRef: RefObject<HTMLDivElement | null>;
}

function renderRovingFocus(initial: HookProps) {
  return renderHook(
    (props: HookProps) =>
      useRovingFocus({
        rows: props.rows,
        rowIndexById: props.rowIndexById,
        openItems: emptyOpenItems(),
        containerRef: props.containerRef,
        virtualizer: props.virtualizer,
        useVirtualization: props.useVirtualization,
      }),
    { initialProps: initial },
  );
}

describe("useRovingFocus — F-pendingFocus collapse-race regression (IRON RULE)", () => {
  // The bug being guarded: keyboard nav into a virtualized-out row stashes
  // its id in `pendingFocusRowRef`. If the user collapses the parent
  // containing that row before it mounts, the stash sits forever; later,
  // when an unrelated row at the same id remounts (e.g. after a different
  // expand cycle), the stash steals focus to the wrong place. The fix is
  // the effect-level pending-clear keyed to `rowIndexById.has(id)`. This
  // test demonstrates the regression would re-emerge if the clear is
  // removed.
  it("clears pending stash when the stashed row's id leaves rowIndexById", () => {
    const rowsBefore = [makeRow("real-a"), makeRow("ghost"), makeRow("real-b")];
    const { virtualizer, scrollToIndex } = makeMockVirtualizer();
    const containerRef = createRef<HTMLDivElement | null>();

    const { result, rerender } = renderRovingFocus({
      rows: rowsBefore,
      rowIndexById: indexMap(rowsBefore),
      useVirtualization: true,
      virtualizer,
      containerRef,
    });

    // Step 1 — stash "ghost". No DOM element is registered for it under
    // jsdom virtualization, so requestFocus falls through to the pending
    // ref path.
    act(() => {
      result.current.requestFocus("ghost");
    });

    // Step 2 — collapse: "ghost" is no longer in the visible rows. The
    // focused-row-disappears effect should now drop the pending stash.
    const rowsAfter = [makeRow("real-a"), makeRow("real-b")];
    rerender({
      rows: rowsAfter,
      rowIndexById: indexMap(rowsAfter),
      useVirtualization: true,
      virtualizer,
      containerRef,
    });

    // Step 3 — observe via behavior: a brand-new element registered at the
    // same "ghost" id (different ancestor chain, unrelated content) MUST
    // NOT receive .focus(). If the pending stash is still set, the
    // registerRowRef path would call focus() and the assertion below
    // would fail.
    const newEl = document.createElement("div");
    const focusSpy = vi.spyOn(newEl, "focus");
    act(() => {
      result.current.registerRowRef("ghost", newEl);
    });
    expect(focusSpy).not.toHaveBeenCalled();
    // Cleanup unrelated side effects of the rerender — virtualizer may
    // have been called for the focused row, but not for "ghost".
    expect(scrollToIndex.mock.calls.every((c) => c[0] !== 1)).toBe(true);
  });
});

describe("useRovingFocus — F-perf API contract", () => {
  // Divergent rows / rowIndexById pair: rows places "target" at index 0,
  // but rowIndexById names it index 7. The hook's scroll-into-view effect
  // must use rowIndexById.get (D6 — required, no findIndex fallback). If
  // it ever falls back to rows.findIndex, scrollToIndex would receive 0
  // instead of 7 and this test would catch it.
  it("scroll-into-view consults rowIndexById, not rows.findIndex", () => {
    const rows = [makeRow("target"), makeRow("other")];
    const divergent = new Map<string, number>([
      ["target", 7],
      ["other", 9],
    ]);
    const { virtualizer, scrollToIndex } = makeMockVirtualizer();
    const containerRef = createRef<HTMLDivElement | null>();

    const { result } = renderRovingFocus({
      rows,
      rowIndexById: divergent,
      useVirtualization: true,
      virtualizer,
      containerRef,
    });

    // The initial render already called scrollToIndex once for the
    // default-focused row ("target", picked by initialFocus). Assert the
    // call used the Map's index, not the rows[] array index.
    expect(scrollToIndex).toHaveBeenCalledWith(7, { align: "auto" });

    // Move focus to "other" — same contract for the next call.
    act(() => {
      result.current.setFocusedRowId("other");
    });
    expect(scrollToIndex).toHaveBeenLastCalledWith(9, { align: "auto" });
  });
});

describe("useRovingFocus — requestFocus reference stability", () => {
  // React.memo on TreeNode depends on requestFocus identity staying
  // stable across renders with stable rows. The hook holds requestFocus
  // behind useCallback with no deps; this test pins that invariant so a
  // future refactor that adds rows or rowIndexById to the deps would be
  // caught.
  it("requestFocus identity is stable across rerenders with the same rows", () => {
    const rows = [makeRow("a"), makeRow("b")];
    const map = indexMap(rows);
    const { virtualizer } = makeMockVirtualizer();
    const containerRef = createRef<HTMLDivElement | null>();
    const props: HookProps = {
      rows,
      rowIndexById: map,
      useVirtualization: true,
      virtualizer,
      containerRef,
    };
    const { result, rerender } = renderRovingFocus(props);
    const first = result.current.requestFocus;
    rerender(props);
    rerender(props);
    expect(result.current.requestFocus).toBe(first);
  });
});
