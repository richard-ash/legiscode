// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import type { Row } from "@/corpus-nav";
import { rowPaddingLeft, TreeRowContent } from "@/ui/left-panel/file-tree/tree-row-content";

function makeRow(overrides: Partial<Row> & Pick<Row, "id" | "depth">): Row {
  const node: CorpusTreeNode = {
    id: overrides.id,
    code: overrides.id,
    name: "",
    kind: "section",
    ...(overrides.node ?? {}),
  } as CorpusTreeNode;
  return {
    id: overrides.id,
    depth: overrides.depth,
    node,
    ref: overrides.ref ?? null,
    hasKids: overrides.hasKids ?? false,
    isExpanded: overrides.isExpanded ?? false,
    siblingPos: overrides.siblingPos ?? 1,
    siblingSize: overrides.siblingSize ?? 1,
  };
}

describe("rowPaddingLeft", () => {
  // Pin the magic constant so a future "fix the indent" change has to
  // touch this test — single source of truth contract.
  it("returns 10 + depth * 12", () => {
    expect(rowPaddingLeft(makeRow({ id: "a", depth: 0 }))).toBe(10);
    expect(rowPaddingLeft(makeRow({ id: "b", depth: 1 }))).toBe(22);
    expect(rowPaddingLeft(makeRow({ id: "c", depth: 5 }))).toBe(70);
  });
});

describe("TreeRowContent", () => {
  it("renders chevron, icon, label code, and label name", () => {
    const row = makeRow({
      id: "sf-port::1.1",
      depth: 2,
      node: {
        id: "sf-port::1.1",
        code: "§ 1.1",
        name: "Definitions",
        kind: "section",
        ref: { moduleId: "sf-port", sectionId: "1.1" },
      } as CorpusTreeNode,
      ref: null,
    });
    const { container } = render(<TreeRowContent row={row} isActive={false} />);
    expect(container.querySelector(".lc-tree-chevron")).not.toBeNull();
    expect(container.querySelector(".lc-tree-ico")).not.toBeNull();
    const label = container.querySelector(".lc-tree-label");
    expect(label).not.toBeNull();
    expect(label?.querySelector("code")?.textContent).toBe("§ 1.1");
    expect(screen.getByText("Definitions")).toBeInTheDocument();
  });

  it("chevron carries is-leaf when row has no kids; is-open when expanded parent", () => {
    const leaf = makeRow({ id: "leaf", depth: 0, hasKids: false });
    const { container: leafBox } = render(<TreeRowContent row={leaf} isActive={false} />);
    expect(leafBox.querySelector(".lc-tree-chevron.is-leaf")).not.toBeNull();
    expect(leafBox.querySelector(".lc-tree-chevron.is-open")).toBeNull();

    const openParent = makeRow({ id: "open", depth: 0, hasKids: true, isExpanded: true });
    const { container: openBox } = render(<TreeRowContent row={openParent} isActive={false} />);
    expect(openBox.querySelector(".lc-tree-chevron.is-open")).not.toBeNull();
    expect(openBox.querySelector(".lc-tree-chevron.is-leaf")).toBeNull();
  });

  it("renders no role=treeitem (the wrapping consumer owns AT semantics)", () => {
    const row = makeRow({ id: "x", depth: 0 });
    render(<TreeRowContent row={row} isActive={false} />);
    expect(screen.queryByRole("treeitem")).toBeNull();
  });
});
