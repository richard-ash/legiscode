// @vitest-environment jsdom
/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStorageBackend,
  listOwnedKeys,
  readOpenItems,
  readTheme,
  removeOpenItems,
  writeOpenItems,
  writeTheme,
  type PersistedOpenItems,
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

  it("returns null + warns when the persisted shape doesn't match the schema", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({ items: [{ kind: "chat" }], activeIndex: 0 }),
    );
    expect(readOpenItems()).toBeNull();
    expect(warn).toHaveBeenCalled();
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
    expect(result?.items[0]?.ref.section).toBe("1.1");
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
