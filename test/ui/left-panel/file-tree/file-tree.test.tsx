// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseRef } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import { __resetVisibleRowsCache } from "@/corpus-nav";
import { FileTree } from "@/ui/left-panel/file-tree/file-tree";
import {
  emptyOpenItems,
  type OpenItemsState,
  openItem,
  openItemWithoutSwitching,
} from "@/workbench";

const tree: CorpusTreeNode[] = [
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
          {
            id: "sf-port::1.2",
            code: "§ 1.2",
            name: "Commission",
            kind: "section",
            ref: { moduleId: "sf-port", sectionId: "1.2" },
          },
          {
            id: "sf-port::1.3",
            code: "§ 1.3",
            name: "Powers",
            kind: "section",
            ref: { moduleId: "sf-port", sectionId: "1.3" },
          },
        ],
      },
    ],
  },
];

afterEach(() => {
  __resetVisibleRowsCache();
});

function setup(
  openItems: OpenItemsState = emptyOpenItems(),
  overrides?: Partial<{
    onActivate: (ref: ReturnType<typeof parseRef>) => void;
    onOpenWithoutSwitching: (ref: ReturnType<typeof parseRef>) => void;
  }>,
) {
  const onActivate = overrides?.onActivate ?? vi.fn();
  const onOpenWithoutSwitching = overrides?.onOpenWithoutSwitching ?? vi.fn();
  render(
    <FileTree
      tree={tree}
      openItems={openItems}
      onActivate={onActivate}
      onOpenWithoutSwitching={onOpenWithoutSwitching}
    />,
  );
  return { onActivate, onOpenWithoutSwitching };
}

describe("FileTree — render", () => {
  it("renders the tree with role=tree and aria-multiselectable=false", () => {
    setup();
    const tree = screen.getByRole("tree");
    expect(tree).toHaveAttribute("aria-multiselectable", "false");
  });

  it("renders top-level + chapter + sections with default-expansion (depth ≤ 1)", () => {
    setup();
    expect(screen.getByText("Port Code")).toBeInTheDocument();
    expect(screen.getByText("ARTICLE 1")).toBeInTheDocument();
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
  });

  it("renders the empty-state caption when the tree is empty", () => {
    render(
      <FileTree
        tree={[]}
        openItems={emptyOpenItems()}
        onActivate={vi.fn()}
        onOpenWithoutSwitching={vi.fn()}
      />,
    );
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(screen.getByText("No sections to display")).toBeInTheDocument();
  });

  it("active row has is-active + aria-selected; non-active openItems get data-open", () => {
    const refA = parseRef({ module: "sf-port", section: "1.1" });
    const refB = parseRef({ module: "sf-port", section: "1.2" });
    let state = openItem(emptyOpenItems(), refA); // active = 1.1
    state = openItemWithoutSwitching(state, refB); // 1.2 is open, not active
    setup(state);
    const activeRow = screen.getByTestId("tree-row-sf-port::1.1");
    expect(activeRow).toHaveClass("is-active");
    expect(activeRow).toHaveAttribute("aria-selected", "true");
    const openRow = screen.getByTestId("tree-row-sf-port::1.2");
    expect(openRow).not.toHaveClass("is-active");
    expect(openRow).toHaveAttribute("data-open", "true");
  });

  it("aria-expanded is true for expanded parents and unset for sections", () => {
    setup();
    expect(screen.getByTestId("tree-row-sf-port")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tree-row-sf-port::1.1")).not.toHaveAttribute("aria-expanded");
  });

  it("aria-level mirrors the row depth (1-based)", () => {
    setup();
    expect(screen.getByTestId("tree-row-sf-port")).toHaveAttribute("aria-level", "1");
    expect(screen.getByTestId("tree-row-sf-port::ART1")).toHaveAttribute("aria-level", "2");
    expect(screen.getByTestId("tree-row-sf-port::1.1")).toHaveAttribute("aria-level", "3");
  });

  it("aria-posinset / aria-setsize use sibling-set scope, not flat-list index", () => {
    setup();
    // Top-level code: 1 of 1.
    const port = screen.getByTestId("tree-row-sf-port");
    expect(port).toHaveAttribute("aria-posinset", "1");
    expect(port).toHaveAttribute("aria-setsize", "1");
    // Chapter under sf-port: 1 of 1.
    const art1 = screen.getByTestId("tree-row-sf-port::ART1");
    expect(art1).toHaveAttribute("aria-posinset", "1");
    expect(art1).toHaveAttribute("aria-setsize", "1");
    // Three sections under ART1 — pos 1/3, 2/3, 3/3 — NOT 3/4, 4/4, 5/4.
    expect(screen.getByTestId("tree-row-sf-port::1.1")).toHaveAttribute("aria-posinset", "1");
    expect(screen.getByTestId("tree-row-sf-port::1.1")).toHaveAttribute("aria-setsize", "3");
    expect(screen.getByTestId("tree-row-sf-port::1.2")).toHaveAttribute("aria-posinset", "2");
    expect(screen.getByTestId("tree-row-sf-port::1.2")).toHaveAttribute("aria-setsize", "3");
    expect(screen.getByTestId("tree-row-sf-port::1.3")).toHaveAttribute("aria-posinset", "3");
    expect(screen.getByTestId("tree-row-sf-port::1.3")).toHaveAttribute("aria-setsize", "3");
  });
});

describe("FileTree — roving tabindex", () => {
  it("only one row carries tabIndex=0 (the focused row)", () => {
    setup();
    const rows = screen.getAllByRole("treeitem");
    const tabZero = rows.filter((r) => r.getAttribute("tabindex") === "0");
    const tabMinusOne = rows.filter((r) => r.getAttribute("tabindex") === "-1");
    expect(tabZero).toHaveLength(1);
    expect(tabMinusOne.length).toBeGreaterThan(0);
  });

  it("focuses the active row by default when openItems carries an active ref", () => {
    const refA = parseRef({ module: "sf-port", section: "1.2" });
    const state = openItem(emptyOpenItems(), refA);
    setup(state);
    const focused = screen.getByTestId("tree-row-sf-port::1.2");
    expect(focused).toHaveAttribute("tabindex", "0");
  });
});

describe("FileTree — click semantics", () => {
  it("clicking a section row calls onActivate with the branded ref", () => {
    const onActivate = vi.fn();
    setup(emptyOpenItems(), { onActivate });
    fireEvent.click(screen.getByTestId("tree-row-sf-port::1.1"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    const ref = onActivate.mock.calls[0]?.[0];
    expect(ref?.module).toBe("sf-port");
    expect(ref?.section).toBe("1.1");
  });

  it("Cmd+click calls onOpenWithoutSwitching instead of onActivate", () => {
    const onActivate = vi.fn();
    const onOpenWithoutSwitching = vi.fn();
    setup(emptyOpenItems(), { onActivate, onOpenWithoutSwitching });
    fireEvent.click(screen.getByTestId("tree-row-sf-port::1.1"), { metaKey: true });
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpenWithoutSwitching).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+click calls onOpenWithoutSwitching (cross-platform)", () => {
    const onActivate = vi.fn();
    const onOpenWithoutSwitching = vi.fn();
    setup(emptyOpenItems(), { onActivate, onOpenWithoutSwitching });
    fireEvent.click(screen.getByTestId("tree-row-sf-port::1.1"), { ctrlKey: true });
    expect(onOpenWithoutSwitching).toHaveBeenCalledTimes(1);
  });

  it("clicking a parent row toggles its expand state (no onActivate)", () => {
    const onActivate = vi.fn();
    setup(emptyOpenItems(), { onActivate });
    const article = screen.getByTestId("tree-row-sf-port::ART1");
    expect(article).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(article);
    expect(article).toHaveAttribute("aria-expanded", "false");
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("FileTree — keyboard navigation", () => {
  it("ArrowDown moves focus", () => {
    setup();
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    // After one ArrowDown from the default focus (first row sf-port), focus moves to ART1.
    const art1 = screen.getByTestId("tree-row-sf-port::ART1");
    expect(art1).toHaveAttribute("tabindex", "0");
  });

  it("Enter on a section calls onActivate", () => {
    const onActivate = vi.fn();
    setup(emptyOpenItems(), { onActivate });
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]?.section).toBe("1.1");
  });

  it("Cmd+Enter on a section calls onOpenWithoutSwitching", () => {
    const onActivate = vi.fn();
    const onOpenWithoutSwitching = vi.fn();
    setup(emptyOpenItems(), { onActivate, onOpenWithoutSwitching });
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter", metaKey: true });
    expect(onActivate).not.toHaveBeenCalled();
    expect(onOpenWithoutSwitching).toHaveBeenCalledTimes(1);
  });

  it("ArrowLeft on an expanded parent collapses it", () => {
    setup();
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // → ART1
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByTestId("tree-row-sf-port::ART1")).toHaveAttribute("aria-expanded", "false");
  });

  it("typeahead jumps focus to the next prefix-match row", () => {
    setup();
    const tree = screen.getByRole("tree");
    // From default focus on first row, type "c" — should jump to a row whose
    // tokens start with "c". "Port Code" wins (token "code" starts with "c").
    fireEvent.keyDown(tree, { key: "c" });
    const focused = within(tree)
      .getAllByRole("treeitem")
      .find((r) => r.getAttribute("tabindex") === "0");
    // The first c-prefix match starting from focused+1 with wrap.
    // From row 0 (sf-port itself), next-with-wrap finds Commission's name token "commission".
    expect(focused?.getAttribute("data-row-id")).toBe("sf-port::1.2");
  });
});
