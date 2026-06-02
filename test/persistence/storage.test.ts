// @vitest-environment jsdom
/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStorageBackend,
  listOwnedKeys,
  type PersistedOpenItems,
  readActivityPaneState,
  readOpenItems,
  readTheme,
  removeOpenItems,
  writeActivityPaneState,
  writeOpenItems,
  writeTheme,
} from "@/persistence";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("persistence/storage — backend access", () => {
  it("getStorageBackend returns window.localStorage when available", () => {
    expect(getStorageBackend()).toBe(window.localStorage);
  });
});

describe("persistence/storage — theme", () => {
  it("returns null when nothing is stored", () => {
    expect(readTheme()).toBeNull();
  });

  it("round-trips dark and light", () => {
    writeTheme("light");
    expect(readTheme()).toBe("light");
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
  });

  it("returns null + warns on unrecognized values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("legiscode.theme", "neon");
    expect(readTheme()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("writeTheme swallows quota failures silently", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeTheme("light")).not.toThrow();
    setItem.mockRestore();
  });
});

describe("persistence/storage — openItems", () => {
  const sample: PersistedOpenItems = {
    items: [
      { kind: "section", ref: { module: "sf-port", section: "1.1" } },
      { kind: "section", ref: { module: "sf-fire", section: "101" } },
    ],
    activeIndex: 1,
  };

  it("returns null when nothing is stored and no legacy key exists", () => {
    expect(readOpenItems()).toBeNull();
  });

  it("round-trips an items array + activeIndex", () => {
    writeOpenItems(sample);
    expect(readOpenItems()).toEqual(sample);
  });

  it("supports an empty items array with activeIndex=null", () => {
    const empty: PersistedOpenItems = { items: [], activeIndex: null };
    writeOpenItems(empty);
    expect(readOpenItems()).toEqual(empty);
  });

  it("returns null + warns on corrupt JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("legiscode.openItems", "{not valid json");
    expect(readOpenItems()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("drops items with unknown kinds individually (item-wise tolerant parse)", () => {
    // Pre-C1: a single unknown-kind item caused the whole payload to be
    // rejected via zod's discriminatedUnion failure, leaving the user with
    // no tabs on next launch. Post-C1: unknown items drop one-at-a-time;
    // valid items survive. activeIndex is remapped through the survivor
    // map so the user's active tab tracks the surviving item rather than
    // pointing past the end of the compacted list.
    localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [
          { kind: "section", ref: { module: "sf-port", section: "1.1" } },
          { kind: "chat", chatId: "future" }, // unknown / non-persisted variant
          { kind: "section", ref: { module: "sf-port", section: "1.2" } },
        ],
        activeIndex: 2,
      }),
    );
    const result = readOpenItems();
    expect(result?.items).toEqual([
      { kind: "section", ref: { module: "sf-port", section: "1.1" } },
      { kind: "section", ref: { module: "sf-port", section: "1.2" } },
    ]);
    // Original activeIndex=2 pointed at the third item, which survives at
    // position 1 in the compacted list.
    expect(result?.activeIndex).toBe(1);
  });

  it("remaps activeIndex to nearest at-or-before survivor when the active item is dropped", () => {
    // The active tab itself is the future-kind item. Remapping picks the
    // surviving item just before it so the session opens on a tab near
    // where the user left off rather than at the wrong end.
    localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [
          { kind: "section", ref: { module: "sf-port", section: "1.1" } },
          { kind: "chat", chatId: "future" }, // the active one — gets dropped
          { kind: "section", ref: { module: "sf-port", section: "1.2" } },
        ],
        activeIndex: 1,
      }),
    );
    const result = readOpenItems();
    expect(result?.items).toHaveLength(2);
    // The dropped active was at original index 1; the nearest surviving
    // index at-or-before 1 is original index 0, which maps to position 0
    // in the compacted list.
    expect(result?.activeIndex).toBe(0);
  });

  it("returns null + warns when the persisted shape's wrapper is malformed", () => {
    // The wrapper schema (items: array, activeIndex: int|null) still does
    // whole-payload validation — only the items[] inner element is tolerant.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({ items: "not an array", activeIndex: 0 }),
    );
    expect(readOpenItems()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("drops legacy external-citation items from a persisted payload (post-refoundation)", () => {
    // Pre-refoundation builds wrote { kind: "external-citation", url, label }
    // entries to localStorage. After feat/citation-resolution the kind no
    // longer exists in the schema; the per-item tolerant parser silently
    // drops these so the user's other tabs survive intact.
    localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [
          {
            kind: "external-citation",
            url: "https://leginfo.legislature.ca.gov/foo",
            label: "Cal. Veh. Code § 22358",
          },
        ],
        activeIndex: 0,
      }),
    );
    // No items survive the per-item drop, so activeIndex collapses to
    // null — there is no tab to point at.
    expect(readOpenItems()).toEqual({ items: [], activeIndex: null });
  });

  it("drops a persisted tab whose kind is no longer in the schema (e.g. legacy diff)", () => {
    // Legacy diff-tab payloads stored before the inline-overlay rewrite
    // drop cleanly through the tolerant per-item parse.
    localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [
          { kind: "section", ref: { module: "sf-port", section: "1.1" } },
          {
            kind: "diff",
            file_no: "260217",
            module_id: "sf-port",
            section_id: "1.1",
          },
        ],
        activeIndex: 1,
      }),
    );
    const result = readOpenItems();
    expect(result?.items).toEqual([
      { kind: "section", ref: { module: "sf-port", section: "1.1" } },
    ]);
    // Active fell back to the surviving section tab.
    expect(result?.activeIndex).toBe(0);
  });

  it("removeOpenItems clears the key", () => {
    writeOpenItems(sample);
    expect(readOpenItems()).not.toBeNull();
    removeOpenItems();
    expect(readOpenItems()).toBeNull();
  });

  it("writeOpenItems swallows quota failures silently", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeOpenItems(sample)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("persistence/storage — legacy migration (REGRESSION — IRON RULE)", () => {
  it("migrates legiscode.activeSection into a one-element openItems array", () => {
    localStorage.setItem(
      "legiscode.activeSection",
      JSON.stringify({ moduleId: "sf-port", sectionId: "1.1" }),
    );
    expect(localStorage.getItem("legiscode.activeSection")).not.toBeNull();
    const result = readOpenItems();
    expect(result).toEqual({
      items: [{ kind: "section", ref: { module: "sf-port", section: "1.1" } }],
      activeIndex: 0,
    });
    // Legacy key is deleted after a successful migration
    expect(localStorage.getItem("legiscode.activeSection")).toBeNull();
    // New key is written
    expect(localStorage.getItem("legiscode.openItems")).not.toBeNull();
  });

  it("new openItems wins when both keys are present, and legacy is dropped on next read", () => {
    const newValue: PersistedOpenItems = {
      items: [{ kind: "section", ref: { module: "sf-fire", section: "201" } }],
      activeIndex: 0,
    };
    localStorage.setItem("legiscode.openItems", JSON.stringify(newValue));
    localStorage.setItem(
      "legiscode.activeSection",
      JSON.stringify({ moduleId: "sf-port", sectionId: "1.1" }),
    );
    expect(readOpenItems()).toEqual(newValue);
  });

  it("returns null when the legacy value is corrupt and leaves it in place", () => {
    localStorage.setItem("legiscode.activeSection", "{not json");
    expect(readOpenItems()).toBeNull();
    expect(localStorage.getItem("legiscode.activeSection")).toBe("{not json");
  });

  it("returns null when the legacy shape lacks required fields", () => {
    localStorage.setItem("legiscode.activeSection", JSON.stringify({ moduleId: "sf-port" }));
    expect(readOpenItems()).toBeNull();
  });

  it("falls through to migration when the new key holds corrupt JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("legiscode.openItems", "{broken");
    localStorage.setItem(
      "legiscode.activeSection",
      JSON.stringify({ moduleId: "sf-port", sectionId: "1.1" }),
    );
    const result = readOpenItems();
    const first = result?.items[0];
    expect(first?.kind).toBe("section");
    if (first?.kind === "section") {
      expect(first.ref.section).toBe("1.1");
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe("persistence/storage — listOwnedKeys", () => {
  it("returns only the legiscode.* keys", () => {
    writeTheme("dark");
    writeOpenItems({ items: [], activeIndex: null });
    localStorage.setItem("unrelated.key", "value");
    const keys = [...listOwnedKeys()].sort();
    expect(keys).toEqual(["legiscode.openItems", "legiscode.theme"]);
  });

  it("returns an empty array when no legiscode keys are present", () => {
    localStorage.setItem("unrelated.key", "value");
    expect(listOwnedKeys()).toEqual([]);
  });
});

describe("persistence/storage — activityPane", () => {
  it("returns null when nothing is stored", () => {
    expect(readActivityPaneState()).toBeNull();
  });

  it("round-trips height + collapsed", () => {
    writeActivityPaneState({ height: 0.45, collapsed: false });
    expect(readActivityPaneState()).toEqual({ height: 0.45, collapsed: false });
    writeActivityPaneState({ height: 0.6, collapsed: true });
    expect(readActivityPaneState()).toEqual({ height: 0.6, collapsed: true });
  });

  it("rejects out-of-range height + warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(
      "legiscode.activityPane",
      JSON.stringify({ height: 0.05, collapsed: false }),
    );
    expect(readActivityPaneState()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("rejects corrupt JSON + warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("legiscode.activityPane", "{not json");
    expect(readActivityPaneState()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
