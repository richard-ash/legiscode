import { describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import {
  __resetVisibleRowsCache,
  defaultExpansion,
  keyboardAction,
  type Row,
  visibleRows,
} from "@/corpus-nav";

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
        ],
      },
    ],
  },
];

function makeRows(): readonly Row[] {
  __resetVisibleRowsCache();
  return visibleRows(tree, defaultExpansion(tree));
}

describe("keyboard-actions", () => {
  it("returns none when rows are empty", () => {
    expect(keyboardAction({ key: "ArrowDown" }, { rows: [], focusedRowId: null })).toEqual({
      type: "none",
    });
  });

  it("ArrowDown with no focus → focus first row", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowDown" }, { rows, focusedRowId: null });
    expect(action).toEqual({ type: "focus", rowId: "sf-port" });
  });

  it("ArrowDown moves focus to the next visible row", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowDown" }, { rows, focusedRowId: "sf-port::ART1" });
    expect(action).toEqual({ type: "focus", rowId: "sf-port::1.1" });
  });

  it("ArrowDown does not wrap past the last row", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowDown" }, { rows, focusedRowId: "sf-port::1.2" });
    expect(action).toEqual({ type: "none" });
  });

  it("ArrowUp moves focus backward", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowUp" }, { rows, focusedRowId: "sf-port::1.2" });
    expect(action).toEqual({ type: "focus", rowId: "sf-port::1.1" });
  });

  it("ArrowUp does not wrap past the first row", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowUp" }, { rows, focusedRowId: "sf-port" });
    expect(action).toEqual({ type: "none" });
  });

  it("Home jumps to first row; End jumps to last row", () => {
    const rows = makeRows();
    expect(keyboardAction({ key: "Home" }, { rows, focusedRowId: "sf-port::1.2" })).toEqual({
      type: "focus",
      rowId: "sf-port",
    });
    expect(keyboardAction({ key: "End" }, { rows, focusedRowId: "sf-port" })).toEqual({
      type: "focus",
      rowId: "sf-port::1.2",
    });
  });

  it("Right on collapsed parent → expand", () => {
    // Collapse everything: rows = top-level only.
    const rows = visibleRows(tree, new Set());
    const action = keyboardAction({ key: "ArrowRight" }, { rows, focusedRowId: "sf-port" });
    expect(action).toEqual({ type: "expand", rowId: "sf-port" });
  });

  it("Right on expanded parent → focus first child", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowRight" }, { rows, focusedRowId: "sf-port" });
    expect(action).toEqual({ type: "focus", rowId: "sf-port::ART1" });
  });

  it("Right on leaf → none", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowRight" }, { rows, focusedRowId: "sf-port::1.1" });
    expect(action).toEqual({ type: "none" });
  });

  it("Left on expanded parent → collapse", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowLeft" }, { rows, focusedRowId: "sf-port::ART1" });
    expect(action).toEqual({ type: "collapse", rowId: "sf-port::ART1" });
  });

  it("Left on leaf → focus parent", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowLeft" }, { rows, focusedRowId: "sf-port::1.1" });
    expect(action).toEqual({ type: "focus", rowId: "sf-port::ART1" });
  });

  it("Left on root with no parent → none", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "ArrowLeft" }, { rows, focusedRowId: "sf-port" });
    // sf-port is expanded at default, so Left collapses it.
    expect(action).toEqual({ type: "collapse", rowId: "sf-port" });
    // After collapsing, Left again → no parent → none.
    const collapsedRows = visibleRows(tree, new Set());
    const action2 = keyboardAction(
      { key: "ArrowLeft" },
      { rows: collapsedRows, focusedRowId: "sf-port" },
    );
    expect(action2).toEqual({ type: "none" });
  });

  it("Enter on parent toggles expand", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "Enter" }, { rows, focusedRowId: "sf-port::ART1" });
    expect(action).toEqual({ type: "toggle-expand", rowId: "sf-port::ART1" });
  });

  it("Enter on section activates", () => {
    const rows = makeRows();
    const action = keyboardAction({ key: "Enter" }, { rows, focusedRowId: "sf-port::1.1" });
    expect(action.type).toBe("activate");
    if (action.type === "activate") {
      expect(action.ref.section).toBe("1.1");
    }
  });

  it("Cmd+Enter on section opens without switching", () => {
    const rows = makeRows();
    const action = keyboardAction(
      { key: "Enter", metaKey: true },
      { rows, focusedRowId: "sf-port::1.1" },
    );
    expect(action.type).toBe("open-without-switch");
    if (action.type === "open-without-switch") {
      expect(action.ref.section).toBe("1.1");
    }
  });

  it("Ctrl+Enter on section opens without switching (cross-platform)", () => {
    const rows = makeRows();
    const action = keyboardAction(
      { key: "Enter", ctrlKey: true },
      { rows, focusedRowId: "sf-port::1.1" },
    );
    expect(action.type).toBe("open-without-switch");
  });

  it("Cmd+Enter on parent → none (modifier ignored on non-leaves; explicit > clever)", () => {
    const rows = makeRows();
    const action = keyboardAction(
      { key: "Enter", metaKey: true },
      { rows, focusedRowId: "sf-port::ART1" },
    );
    expect(action).toEqual({ type: "none" });
  });

  it("Space behaves like Enter (parent toggles, leaf activates)", () => {
    const rows = makeRows();
    expect(keyboardAction({ key: " " }, { rows, focusedRowId: "sf-port::ART1" })).toEqual({
      type: "toggle-expand",
      rowId: "sf-port::ART1",
    });
    expect(keyboardAction({ key: " " }, { rows, focusedRowId: "sf-port::1.1" }).type).toBe(
      "activate",
    );
  });

  it("Unrecognized keys → none", () => {
    const rows = makeRows();
    expect(keyboardAction({ key: "Tab" }, { rows, focusedRowId: "sf-port" })).toEqual({
      type: "none",
    });
  });
});
