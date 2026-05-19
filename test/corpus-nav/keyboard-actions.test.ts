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

function indexMap(rows: readonly Row[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  rows.forEach((r, i) => {
    m.set(r.id, i);
  });
  return m;
}

function makeSetup(): { rows: readonly Row[]; rowIndexById: ReadonlyMap<string, number> } {
  __resetVisibleRowsCache();
  const rows = visibleRows(tree, defaultExpansion(tree));
  return { rows, rowIndexById: indexMap(rows) };
}

function makeCollapsedSetup(): {
  rows: readonly Row[];
  rowIndexById: ReadonlyMap<string, number>;
} {
  const rows = visibleRows(tree, new Set());
  return { rows, rowIndexById: indexMap(rows) };
}

describe("keyboard-actions", () => {
  it("returns none when rows are empty", () => {
    expect(
      keyboardAction(
        { key: "ArrowDown" },
        { rows: [], rowIndexById: new Map(), focusedRowId: null },
      ),
    ).toEqual({ type: "none" });
  });

  it("ArrowDown with no focus → focus first row", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction({ key: "ArrowDown" }, { rows, rowIndexById, focusedRowId: null });
    expect(action).toEqual({ type: "focus", rowId: "sf-port" });
  });

  it("ArrowDown moves focus to the next visible row", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowDown" },
      { rows, rowIndexById, focusedRowId: "sf-port::ART1" },
    );
    expect(action).toEqual({ type: "focus", rowId: "sf-port::1.1" });
  });

  it("ArrowDown does not wrap past the last row", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowDown" },
      { rows, rowIndexById, focusedRowId: "sf-port::1.2" },
    );
    expect(action).toEqual({ type: "none" });
  });

  it("ArrowUp moves focus backward", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowUp" },
      { rows, rowIndexById, focusedRowId: "sf-port::1.2" },
    );
    expect(action).toEqual({ type: "focus", rowId: "sf-port::1.1" });
  });

  it("ArrowUp does not wrap past the first row", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowUp" },
      { rows, rowIndexById, focusedRowId: "sf-port" },
    );
    expect(action).toEqual({ type: "none" });
  });

  it("Home jumps to first row; End jumps to last row", () => {
    const { rows, rowIndexById } = makeSetup();
    expect(
      keyboardAction({ key: "Home" }, { rows, rowIndexById, focusedRowId: "sf-port::1.2" }),
    ).toEqual({ type: "focus", rowId: "sf-port" });
    expect(keyboardAction({ key: "End" }, { rows, rowIndexById, focusedRowId: "sf-port" })).toEqual(
      { type: "focus", rowId: "sf-port::1.2" },
    );
  });

  it("Right on collapsed parent → expand", () => {
    // Collapse everything: rows = top-level only.
    const { rows, rowIndexById } = makeCollapsedSetup();
    const action = keyboardAction(
      { key: "ArrowRight" },
      { rows, rowIndexById, focusedRowId: "sf-port" },
    );
    expect(action).toEqual({ type: "expand", rowId: "sf-port" });
  });

  it("Right on expanded parent → focus first child", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowRight" },
      { rows, rowIndexById, focusedRowId: "sf-port" },
    );
    expect(action).toEqual({ type: "focus", rowId: "sf-port::ART1" });
  });

  it("Right on leaf → none", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowRight" },
      { rows, rowIndexById, focusedRowId: "sf-port::1.1" },
    );
    expect(action).toEqual({ type: "none" });
  });

  it("Left on expanded parent → collapse", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowLeft" },
      { rows, rowIndexById, focusedRowId: "sf-port::ART1" },
    );
    expect(action).toEqual({ type: "collapse", rowId: "sf-port::ART1" });
  });

  it("Left on leaf → focus parent", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowLeft" },
      { rows, rowIndexById, focusedRowId: "sf-port::1.1" },
    );
    expect(action).toEqual({ type: "focus", rowId: "sf-port::ART1" });
  });

  it("Left on root with no parent → none", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "ArrowLeft" },
      { rows, rowIndexById, focusedRowId: "sf-port" },
    );
    // sf-port is expanded at default, so Left collapses it.
    expect(action).toEqual({ type: "collapse", rowId: "sf-port" });
    // After collapsing, Left again → no parent → none.
    const collapsed = makeCollapsedSetup();
    const action2 = keyboardAction(
      { key: "ArrowLeft" },
      { rows: collapsed.rows, rowIndexById: collapsed.rowIndexById, focusedRowId: "sf-port" },
    );
    expect(action2).toEqual({ type: "none" });
  });

  it("Enter on parent toggles expand", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "Enter" },
      { rows, rowIndexById, focusedRowId: "sf-port::ART1" },
    );
    expect(action).toEqual({ type: "toggle-expand", rowId: "sf-port::ART1" });
  });

  it("Enter on section activates", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "Enter" },
      { rows, rowIndexById, focusedRowId: "sf-port::1.1" },
    );
    expect(action.type).toBe("activate");
    if (action.type === "activate") {
      expect(action.ref.section).toBe("1.1");
    }
  });

  it("Cmd+Enter on section opens without switching", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "Enter", metaKey: true },
      { rows, rowIndexById, focusedRowId: "sf-port::1.1" },
    );
    expect(action.type).toBe("open-without-switch");
    if (action.type === "open-without-switch") {
      expect(action.ref.section).toBe("1.1");
    }
  });

  it("Ctrl+Enter on section opens without switching (cross-platform)", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "Enter", ctrlKey: true },
      { rows, rowIndexById, focusedRowId: "sf-port::1.1" },
    );
    expect(action.type).toBe("open-without-switch");
  });

  it("Cmd+Enter on parent → none (modifier ignored on non-leaves; explicit > clever)", () => {
    const { rows, rowIndexById } = makeSetup();
    const action = keyboardAction(
      { key: "Enter", metaKey: true },
      { rows, rowIndexById, focusedRowId: "sf-port::ART1" },
    );
    expect(action).toEqual({ type: "none" });
  });

  it("Space behaves like Enter (parent toggles, leaf activates)", () => {
    const { rows, rowIndexById } = makeSetup();
    expect(
      keyboardAction({ key: " " }, { rows, rowIndexById, focusedRowId: "sf-port::ART1" }),
    ).toEqual({ type: "toggle-expand", rowId: "sf-port::ART1" });
    expect(
      keyboardAction({ key: " " }, { rows, rowIndexById, focusedRowId: "sf-port::1.1" }).type,
    ).toBe("activate");
  });

  it("Unrecognized keys → none", () => {
    const { rows, rowIndexById } = makeSetup();
    expect(keyboardAction({ key: "Tab" }, { rows, rowIndexById, focusedRowId: "sf-port" })).toEqual(
      { type: "none" },
    );
  });

  // F-perf D6 invariant: focusedIndex() must consult rowIndexById.get and
  // not fall back to rows.findIndex. We assert it by feeding a divergent
  // pair — rowIndexById names the focused row at a position that doesn't
  // exist in `rows`. A findIndex-based dispatcher would still find the
  // row at array index 0 and return ArrowDown's neighbour; a Map-based
  // dispatcher reads index 99, looks past the end of `rows`, and bails
  // out with `none`. The latter is the contract.
  it("focusedIndex consults rowIndexById, not rows.findIndex", () => {
    const { rows } = makeSetup();
    const divergent = new Map<string, number>([["sf-port", 99]]);
    const action = keyboardAction(
      { key: "ArrowDown" },
      { rows, rowIndexById: divergent, focusedRowId: "sf-port" },
    );
    expect(action).toEqual({ type: "none" });
  });
});
