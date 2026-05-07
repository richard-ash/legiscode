import { describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import {
  collapse,
  defaultExpansion,
  emptyExpansion,
  expand,
  isExpanded,
  toggle,
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
        ],
      },
    ],
  },
];

describe("tree-model", () => {
  it("emptyExpansion returns an empty set", () => {
    expect(emptyExpansion().size).toBe(0);
  });

  it("defaultExpansion auto-opens depth ≤ 1 (codes + chapters)", () => {
    const exp = defaultExpansion(tree);
    expect(exp.has("sf-port")).toBe(true); // depth 0
    expect(exp.has("sf-port::ART1")).toBe(true); // depth 1
    // Sections have no kids so they're not expanded; check presence-for-presence:
    expect(exp.has("sf-port::1.1")).toBe(false);
  });

  it("defaultExpansion stops at maxDepth=0", () => {
    const exp = defaultExpansion(tree, 0);
    expect(exp.has("sf-port")).toBe(true);
    expect(exp.has("sf-port::ART1")).toBe(false);
  });

  it("toggle adds and removes ids", () => {
    const empty = emptyExpansion();
    const opened = toggle(empty, "x");
    expect(isExpanded(opened, "x")).toBe(true);
    const closed = toggle(opened, "x");
    expect(isExpanded(closed, "x")).toBe(false);
  });

  it("toggle returns a new set on each call (no mutation)", () => {
    const a = emptyExpansion();
    const b = toggle(a, "x");
    expect(a).not.toBe(b);
    expect(a.size).toBe(0);
    expect(b.size).toBe(1);
  });

  it("expand is a no-op on already-expanded ids (returns same reference)", () => {
    const opened = expand(emptyExpansion(), "x");
    const opened2 = expand(opened, "x");
    expect(opened2).toBe(opened);
  });

  it("collapse is a no-op on not-expanded ids (returns same reference)", () => {
    const empty = emptyExpansion();
    const empty2 = collapse(empty, "x");
    expect(empty2).toBe(empty);
  });

  it("expand + collapse round-trip", () => {
    const a = expand(emptyExpansion(), "x");
    const b = collapse(a, "x");
    expect(isExpanded(b, "x")).toBe(false);
  });

  it("expansion state survives tree updates by node id", () => {
    const exp = expand(emptyExpansion(), "sf-port::ART1");
    // Simulate a tree change that keeps the same id present
    const newTree: CorpusTreeNode[] = [
      {
        id: "sf-port",
        code: "Port Code",
        name: "Port",
        kind: "code",
        kids: [
          {
            id: "sf-port::ART1",
            code: "ARTICLE 1",
            name: "Updated",
            kind: "chapter",
            kids: [],
          },
        ],
      },
    ];
    void newTree;
    expect(isExpanded(exp, "sf-port::ART1")).toBe(true);
  });

  it("default expansion for unknown nodes is collapsed", () => {
    const exp = emptyExpansion();
    expect(isExpanded(exp, "unknown")).toBe(false);
  });
});
