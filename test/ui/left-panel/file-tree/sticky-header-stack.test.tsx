// @vitest-environment jsdom
import type { Virtualizer } from "@tanstack/react-virtual";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import type { Row } from "@/corpus-nav";
import { StickyHeaderStack } from "@/ui/left-panel/file-tree/sticky-header-stack";

// Pure prop-driven RTL test (D8). No FileTree, no real virtualizer, no
// actual scrolling. We're pinning the AT contract (aria-hidden +
// role=presentation + no treeitems) and the split click contract:
//   - chevron region → onCollapse (VSCode-style)
//   - rest of row   → onStickyClick + scrollToIndex

interface RowInit {
  id: string;
  depth: number;
  code?: string;
}

function makeRow({ id, depth, code }: RowInit): Row {
  const node: CorpusTreeNode = { id, code: code ?? id, name: "", kind: "section" };
  return {
    id,
    depth,
    node,
    ref: null,
    hasKids: true,
    isExpanded: true,
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

function mockVirtualizer(): {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollToIndex: ReturnType<typeof vi.fn>;
} {
  const scrollToIndex = vi.fn();
  return {
    virtualizer: { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>,
    scrollToIndex,
  };
}

const ancestors: readonly Row[] = [
  makeRow({ id: "code", depth: 0, code: "Port Code" }),
  makeRow({ id: "ch-1", depth: 1, code: "ARTICLE 1" }),
  makeRow({ id: "art-1", depth: 2, code: "§ 1" }),
];

describe("StickyHeaderStack — AT semantics (D3)", () => {
  it("wrapper carries aria-hidden=true", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={vi.fn()}
      />,
    );
    const wrapper = container.querySelector(".lc-tree-sticky-stack");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
  });

  it("each sticky row carries role=presentation", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll(".lc-tree-sticky-row");
    expect(rows.length).toBe(3);
    rows.forEach((row) => {
      expect(row).toHaveAttribute("role", "presentation");
    });
  });

  it("renders NO role=treeitem (sticky copies invisible to AT)", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole("treeitem")).toEqual([]);
  });

  it("empty ancestors → renders nothing (no wrapper)", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const { container } = render(
      <StickyHeaderStack
        ancestors={[]}
        rowIndexById={new Map()}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={vi.fn()}
      />,
    );
    expect(container.querySelector(".lc-tree-sticky-stack")).toBeNull();
  });
});

describe("StickyHeaderStack — click semantics (scroll path)", () => {
  it("clicking a sticky row (non-chevron) calls onStickyClick with that ancestor id", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const onStickyClick = vi.fn();
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={onStickyClick}
      />,
    );
    const rows = container.querySelectorAll(".lc-tree-sticky-row");
    // Click the row wrapper itself (target == the .lc-tree-sticky-row div,
    // no .lc-tree-chevron ancestor) → scroll path, not collapse path.
    fireEvent.click(rows[1] as Element); // ch-1
    expect(onStickyClick).toHaveBeenCalledTimes(1);
    expect(onStickyClick).toHaveBeenCalledWith("ch-1");
  });

  it("non-chevron click calls virtualizer.scrollToIndex with align:start", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const { virtualizer, scrollToIndex } = mockVirtualizer();
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll(".lc-tree-sticky-row");
    fireEvent.click(rows[2] as Element); // art-1 at row index 2
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" });
  });

  // D15: after scrollToIndex(align:start), follow with
  // scrollBy(-destStickyHeight) so the clicked row lands flush below the
  // now-smaller sticky stack. destStickyHeight = clickedRow.depth × 24.
  it("destination-depth scroll: non-chevron click on depth-D row scrolls container by -D×24", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    // Mount a real container div so containerRef.current is non-null.
    const containerDiv = document.createElement("div");
    Object.defineProperty(containerRef, "current", { value: containerDiv, writable: true });
    const scrollBy = vi.fn();
    containerDiv.scrollBy = scrollBy as unknown as typeof containerDiv.scrollBy;
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll(".lc-tree-sticky-row");
    // Click art-1 (depth=2). Expected: scrollBy({top: -48}).
    fireEvent.click(rows[2] as Element);
    expect(scrollBy).toHaveBeenCalledWith({ top: -48 });
    // Click code (depth=0). Expected: scrollBy with top ≈ 0. Use a value
    // comparison rather than .toHaveBeenCalledWith because JavaScript's
    // `-0` shows up here (`-(0 * 24)`) and toEqual/toHaveBeenCalledWith
    // treats `-0 !== 0` via Object.is.
    scrollBy.mockClear();
    fireEvent.click(rows[0] as Element);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    const call = scrollBy.mock.calls[0]?.[0] as { top: number };
    expect(call.top === 0).toBe(true);
  });
});

describe("StickyHeaderStack — chevron-click collapse path", () => {
  it("clicking the chevron region calls onCollapse with the ancestor id", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const onCollapse = vi.fn();
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={onCollapse}
        onStickyClick={vi.fn()}
      />,
    );
    // Each sticky row renders a .lc-tree-chevron span via TreeRowContent.
    // Order matches `ancestors`: code, ch-1, art-1.
    const chevrons = container.querySelectorAll(".lc-tree-sticky-row .lc-tree-chevron");
    expect(chevrons.length).toBe(3);
    fireEvent.click(chevrons[1] as Element); // ch-1's chevron
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onCollapse).toHaveBeenCalledWith("ch-1");
  });

  it("clicking the chevron region does NOT trigger the scroll path", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const { virtualizer, scrollToIndex } = mockVirtualizer();
    const onStickyClick = vi.fn();
    const containerDiv = document.createElement("div");
    Object.defineProperty(containerRef, "current", { value: containerDiv, writable: true });
    const scrollBy = vi.fn();
    containerDiv.scrollBy = scrollBy as unknown as typeof containerDiv.scrollBy;
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={virtualizer}
        containerRef={containerRef}
        onCollapse={vi.fn()}
        onStickyClick={onStickyClick}
      />,
    );
    const chevrons = container.querySelectorAll(".lc-tree-sticky-row .lc-tree-chevron");
    fireEvent.click(chevrons[2] as Element); // art-1's chevron
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(onStickyClick).not.toHaveBeenCalled();
  });

  it("click on an SVG inside the chevron still routes to onCollapse (closest match)", () => {
    const containerRef = createRef<HTMLDivElement | null>();
    const onCollapse = vi.fn();
    const { container } = render(
      <StickyHeaderStack
        ancestors={ancestors}
        rowIndexById={indexMap(ancestors)}
        virtualizer={mockVirtualizer().virtualizer}
        containerRef={containerRef}
        onCollapse={onCollapse}
        onStickyClick={vi.fn()}
      />,
    );
    const svg = container.querySelector(".lc-tree-sticky-row .lc-tree-chevron svg");
    expect(svg).not.toBeNull();
    fireEvent.click(svg as Element);
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onCollapse).toHaveBeenCalledWith("code"); // first sticky row
  });
});
