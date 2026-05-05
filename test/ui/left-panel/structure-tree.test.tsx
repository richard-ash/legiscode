// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CorpusTreeNode } from "../../../electron/ipc/contract";
import { StructureTree } from "../../../src/ui/left-panel/structure-tree";

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

describe("StructureTree (D2 — minimum-viable Phase 1)", () => {
  it("renders top-level codes open by default with sections beneath", () => {
    render(<StructureTree nodes={tree} active={null} onSelect={() => {}} />);
    expect(screen.getByText("Port Code")).toBeInTheDocument();
    expect(screen.getByText("ARTICLE 1")).toBeInTheDocument();
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
  });

  it("clicking a section row invokes onSelect with the ref", async () => {
    const onSelect = vi.fn();
    render(<StructureTree nodes={tree} active={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("Definitions"));
    expect(onSelect).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
  });

  it("active section has aria-selected=true and is-active class", () => {
    render(
      <StructureTree
        nodes={tree}
        active={{ moduleId: "sf-port", sectionId: "1.2" }}
        onSelect={() => {}}
      />,
    );
    const row = screen.getByText("Commission").closest('[role="treeitem"]');
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveClass("is-active");
  });

  it("does NOT render pending-amendment dots in Phase 1 (D2)", () => {
    render(<StructureTree nodes={tree} active={null} onSelect={() => {}} />);
    expect(document.querySelector(".lc-tree-pending-dot")).toBeNull();
  });
});
