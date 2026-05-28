import { describe, expect, it } from "vitest";
import {
  formatBinding,
  formatShortcut,
  getShortcut,
  type KeySpec,
  matchEvent,
  matchShortcut,
  SCOPE_LABELS,
  type ShortcutScope,
  SHORTCUTS,
} from "@/ui/shortcuts/registry";

const SCOPES: readonly ShortcutScope[] = [
  "global",
  "palette",
  "file-tree",
  "section-view",
  "activity-bar",
  "tabs",
];

function specsOf(display: (typeof SHORTCUTS)[number]["display"]): readonly KeySpec[] {
  if (typeof display === "object" && display !== null && "chord" in display) return display.chord;
  if (Array.isArray(display)) return display;
  return [display as KeySpec];
}

describe("shortcut catalog — data invariants", () => {
  it("every id is unique", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has at least one binding with a non-empty key", () => {
    for (const s of SHORTCUTS) {
      const specs = specsOf(s.display);
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(typeof spec.key).toBe("string");
        expect(spec.key.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("every scope is in the enum and has a label", () => {
    for (const s of SHORTCUTS) {
      expect(SCOPES).toContain(s.scope);
    }
    for (const scope of SCOPES) {
      expect(SCOPE_LABELS[scope]).toBeTruthy();
    }
  });

  it("ships nine granular ⌘1–⌘9 jump entries", () => {
    const jump = SHORTCUTS.filter((s) => s.id.startsWith("tabs.jump-to-"));
    expect(jump).toHaveLength(9);
    expect(jump.map((s) => s.id)).toContain("tabs.jump-to-9");
  });

  it("includes the ⌘K W close-all chord", () => {
    const closeAll = getShortcut("tabs.close-all");
    expect(formatBinding(closeAll.display, true)).toBe("⌘K W");
  });
});

describe("formatBinding", () => {
  it("formats single specs on macOS", () => {
    expect(formatShortcut("global.open-palette", true)).toBe("⌘P");
    expect(formatShortcut("global.prev-tab", true)).toBe("⌘⌥←");
    expect(formatShortcut("tabs.reopen-closed", true)).toBe("⌘⇧T");
    expect(formatShortcut("tabs.jump-to-1", true)).toBe("⌘1");
    expect(formatShortcut("global.open-settings", true)).toBe("⌘,");
    expect(formatShortcut("tabs.cycle-prev", true)).toBe("⌘PgUp");
  });

  it("formats single specs on non-mac with named keys", () => {
    expect(formatShortcut("global.open-palette", false)).toBe("Ctrl+P");
    expect(formatShortcut("global.prev-tab", false)).toBe("Ctrl+Alt+Left");
    expect(formatShortcut("tabs.reopen-closed", false)).toBe("Ctrl+Shift+T");
    expect(formatShortcut("tabs.cycle-prev", false)).toBe("Ctrl+PageUp");
  });

  it("joins alias arrays with ' or '", () => {
    expect(formatShortcut("palette.move", true)).toBe("↑ or ↓");
    expect(formatShortcut("file-tree.collapse-expand", true)).toBe("← or →");
    expect(formatShortcut("activity-bar.activate", true)).toBe("↵ or Space");
  });
});

describe("matchEvent — exact modifier matching", () => {
  const cmdW: KeySpec = { mods: ["cmd"], key: "w" };

  it("matches ⌘W via metaKey (mac) and ctrlKey (win/linux)", () => {
    expect(matchEvent({ key: "w", metaKey: true }, cmdW)).toBe(true);
    expect(matchEvent({ key: "W", ctrlKey: true }, cmdW)).toBe(true);
  });

  it("rejects extra modifiers (⌘⇧W does not match ⌘W)", () => {
    expect(matchEvent({ key: "w", metaKey: true, shiftKey: true }, cmdW)).toBe(false);
    expect(matchEvent({ key: "w", metaKey: true, altKey: true }, cmdW)).toBe(false);
  });

  it("requires the cmd modifier when the spec demands it", () => {
    expect(matchEvent({ key: "w" }, cmdW)).toBe(false);
  });

  it("requires a bare spec to have no modifiers", () => {
    const enter: KeySpec = { key: "Enter" };
    expect(matchEvent({ key: "Enter" }, enter)).toBe(true);
    expect(matchEvent({ key: "Enter", metaKey: true }, enter)).toBe(false);
  });
});

describe("matchShortcut", () => {
  it("matches any binding of an alias array", () => {
    const move = getShortcut("palette.move");
    expect(matchShortcut({ key: "ArrowUp" }, move)).toBe(true);
    expect(matchShortcut({ key: "ArrowDown" }, move)).toBe(true);
    expect(matchShortcut({ key: "ArrowLeft" }, move)).toBe(false);
  });

  it("never single-event-matches a chord", () => {
    const closeAll = getShortcut("tabs.close-all");
    expect(matchShortcut({ key: "k", metaKey: true }, closeAll)).toBe(false);
  });
});
