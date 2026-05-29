// The single catalog of every keyboard shortcut in the app. This is the
// source of truth for IDENTITY + DESCRIPTION (what exists, its label,
// scope, display keys, search keywords) — NOT for matching semantics,
// which differ by site. Display labels everywhere (settings page, tab
// context menu, titlebar, palette) draw from here so they can't drift
// from the keys the handlers actually fire on.
//
// `matchEvent` is a shared helper for the uniform majority of handlers;
// chords (⌘K W) and the palette toggle (⌘P) keep bespoke dispatch but
// still carry a catalog id so their displayed labels stay in lockstep.
// Same split VS Code draws: a declarative keybinding catalog plus
// separately-dispatched commands.
//
// Pure data + pure helpers only — no React, no DOM. The hook that wires
// a catalog entry to a window/region listener lives in `./use-shortcut`.

import { IS_MAC } from "@/ui/platform";

export type ShortcutMod = "cmd" | "alt" | "shift";

export type ShortcutScope =
  | "global"
  | "palette"
  | "file-tree"
  | "section-view"
  | "activity-bar"
  | "tabs";

/** Page-level grouping. Commands are user-invoked actions (and the
 *  rebinding target in v1.1); in-view navigation is widget-intrinsic
 *  arrow/Enter movement that would drown the real shortcuts if mixed in. */
export type ShortcutGroup = "commands" | "in-view";

/** A single modifier+key chord leg. `key` is a `KeyboardEvent.key` value
 *  — letters lowercase ("p", "w"), named keys verbatim ("ArrowLeft",
 *  "PageUp", "Enter", "Escape", ","). The sentinel "A–Z" marks a
 *  printable-typeahead pseudo-binding that is never event-matched. */
export interface KeySpec {
  readonly mods?: readonly ShortcutMod[];
  readonly key: string;
}

/** An ordered key sequence (e.g. ⌘K then W). Rendered space-joined. */
export interface Chord {
  readonly chord: readonly KeySpec[];
}

/** Single binding, a set of equivalent/related bindings (rendered
 *  " or "-joined, e.g. ↑ or ↓), or an ordered chord. */
export type ShortcutDisplay = KeySpec | readonly KeySpec[] | Chord;

export interface Shortcut {
  /** Stable id, `<scope-or-family>.<verb>` — React key + v1.1 rebinding
   *  storage key. */
  readonly id: string;
  readonly label: string;
  readonly scope: ShortcutScope;
  readonly group: ShortcutGroup;
  /** Search aliases so "cmd p", "sidebar", "close" all find the right row
   *  even when the glyph itself is unsearchable. */
  readonly keywords: readonly string[];
  readonly display: ShortcutDisplay;
}

// Modifier-bearing display helpers — keep the cmd alias single-sourced.
const CMD = ["cmd"] as const;
const CMD_ALT = ["cmd", "alt"] as const;
const CMD_SHIFT = ["cmd", "shift"] as const;

export const SHORTCUTS = [
  // ─── Commands ──────────────────────────────────────────────────────────
  {
    id: "global.open-palette",
    label: "Open command palette",
    scope: "global",
    group: "commands",
    keywords: ["command", "palette", "search", "go to section", "find"],
    display: { mods: CMD, key: "p" },
  },
  {
    id: "global.open-settings",
    label: "Open Settings",
    scope: "global",
    group: "commands",
    keywords: ["settings", "preferences", "keyboard shortcuts", "options"],
    display: { mods: CMD, key: "," },
  },
  {
    id: "global.toggle-left-panel",
    label: "Toggle left panel",
    scope: "global",
    group: "commands",
    keywords: ["sidebar", "structure", "file tree", "explorer", "left"],
    display: { mods: CMD, key: "b" },
  },
  {
    id: "global.toggle-right-panel",
    label: "Toggle right panel",
    scope: "global",
    group: "commands",
    keywords: ["sidebar", "aux", "right panel", "right"],
    display: { mods: CMD_ALT, key: "b" },
  },
  {
    id: "global.prev-tab",
    label: "Previous tab",
    scope: "global",
    group: "commands",
    keywords: ["tab", "switch", "previous", "back"],
    display: { mods: CMD_ALT, key: "ArrowLeft" },
  },
  {
    id: "global.next-tab",
    label: "Next tab",
    scope: "global",
    group: "commands",
    keywords: ["tab", "switch", "next", "forward"],
    display: { mods: CMD_ALT, key: "ArrowRight" },
  },
  {
    id: "tabs.close-active",
    label: "Close active tab",
    scope: "tabs",
    group: "commands",
    keywords: ["close", "tab"],
    display: { mods: CMD, key: "w" },
  },
  {
    id: "tabs.close-all",
    label: "Close all tabs",
    scope: "tabs",
    group: "commands",
    keywords: ["close all", "tabs", "clear"],
    display: { chord: [{ mods: CMD, key: "k" }, { key: "w" }] },
  },
  {
    id: "tabs.reopen-closed",
    label: "Reopen last closed tab",
    scope: "tabs",
    group: "commands",
    keywords: ["reopen", "restore", "undo close", "tab"],
    display: { mods: CMD_SHIFT, key: "t" },
  },
  {
    id: "tabs.cycle-prev",
    label: "Cycle to previous tab",
    scope: "tabs",
    group: "commands",
    keywords: ["cycle", "previous", "page up", "tab"],
    display: { mods: CMD, key: "PageUp" },
  },
  {
    id: "tabs.cycle-next",
    label: "Cycle to next tab",
    scope: "tabs",
    group: "commands",
    keywords: ["cycle", "next", "page down", "tab"],
    display: { mods: CMD, key: "PageDown" },
  },
  // ⌘1–⌘9 — nine granular entries (one per digit) for the v1.1 rebinding
  // model. Spelled out as literals so `as const` keeps each id in the
  // `ShortcutId` union. The settings page collapses them into one
  // "⌘1–⌘9" row at render time.
  {
    id: "tabs.jump-to-1",
    label: "Jump to tab 1",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "1"],
    display: { mods: CMD, key: "1" },
  },
  {
    id: "tabs.jump-to-2",
    label: "Jump to tab 2",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "2"],
    display: { mods: CMD, key: "2" },
  },
  {
    id: "tabs.jump-to-3",
    label: "Jump to tab 3",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "3"],
    display: { mods: CMD, key: "3" },
  },
  {
    id: "tabs.jump-to-4",
    label: "Jump to tab 4",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "4"],
    display: { mods: CMD, key: "4" },
  },
  {
    id: "tabs.jump-to-5",
    label: "Jump to tab 5",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "5"],
    display: { mods: CMD, key: "5" },
  },
  {
    id: "tabs.jump-to-6",
    label: "Jump to tab 6",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "6"],
    display: { mods: CMD, key: "6" },
  },
  {
    id: "tabs.jump-to-7",
    label: "Jump to tab 7",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "7"],
    display: { mods: CMD, key: "7" },
  },
  {
    id: "tabs.jump-to-8",
    label: "Jump to tab 8",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "8"],
    display: { mods: CMD, key: "8" },
  },
  {
    id: "tabs.jump-to-9",
    label: "Jump to last tab",
    scope: "tabs",
    group: "commands",
    keywords: ["jump", "tab", "9", "last"],
    display: { mods: CMD, key: "9" },
  },
  // ─── In-view navigation ────────────────────────────────────────────────
  {
    id: "palette.move",
    label: "Move selection",
    scope: "palette",
    group: "in-view",
    keywords: ["up", "down", "navigate", "palette"],
    display: [{ key: "ArrowUp" }, { key: "ArrowDown" }],
  },
  {
    id: "palette.activate",
    label: "Open selection",
    scope: "palette",
    group: "in-view",
    keywords: ["enter", "open", "go", "palette"],
    display: { key: "Enter" },
  },
  {
    id: "palette.activate-background",
    label: "Open in a background tab",
    scope: "palette",
    group: "in-view",
    keywords: ["background", "new tab", "palette"],
    display: { mods: CMD, key: "Enter" },
  },
  {
    id: "palette.dismiss",
    label: "Dismiss palette",
    scope: "palette",
    group: "in-view",
    keywords: ["escape", "close", "dismiss", "palette"],
    display: { key: "Escape" },
  },
  {
    id: "file-tree.move",
    label: "Move selection",
    scope: "file-tree",
    group: "in-view",
    keywords: ["up", "down", "navigate", "file tree"],
    display: [{ key: "ArrowUp" }, { key: "ArrowDown" }],
  },
  {
    id: "file-tree.collapse-expand",
    label: "Collapse or expand",
    scope: "file-tree",
    group: "in-view",
    keywords: ["collapse", "expand", "left", "right", "file tree"],
    display: [{ key: "ArrowLeft" }, { key: "ArrowRight" }],
  },
  {
    id: "file-tree.open",
    label: "Open item",
    scope: "file-tree",
    group: "in-view",
    keywords: ["enter", "open", "activate", "file tree"],
    display: { key: "Enter" },
  },
  {
    id: "file-tree.open-background",
    label: "Open in a background tab",
    scope: "file-tree",
    group: "in-view",
    keywords: ["background", "new tab", "file tree"],
    display: { mods: CMD, key: "Enter" },
  },
  {
    id: "file-tree.typeahead",
    label: "Type to jump to an item",
    scope: "file-tree",
    group: "in-view",
    keywords: ["typeahead", "type to find", "jump", "file tree"],
    display: { key: "A–Z" },
  },
  {
    id: "section-view.open-citation",
    label: "Open the focused citation",
    scope: "section-view",
    group: "in-view",
    keywords: ["citation", "enter", "open", "link"],
    display: { key: "Enter" },
  },
  {
    id: "section-view.toggle-term",
    label: "Open the focused defined term",
    scope: "section-view",
    group: "in-view",
    keywords: ["defined term", "definition", "enter", "popover"],
    display: { key: "Enter" },
  },
  {
    id: "section-view.close-popover",
    label: "Close the definition popover",
    scope: "section-view",
    group: "in-view",
    keywords: ["escape", "close", "popover", "definition"],
    display: { key: "Escape" },
  },
  {
    id: "activity-bar.move",
    label: "Move between sections",
    scope: "activity-bar",
    group: "in-view",
    keywords: ["up", "down", "navigate", "activity bar"],
    display: [{ key: "ArrowUp" }, { key: "ArrowDown" }],
  },
  {
    id: "activity-bar.activate",
    label: "Activate the section",
    scope: "activity-bar",
    group: "in-view",
    keywords: ["enter", "space", "activate", "activity bar"],
    display: [{ key: "Enter" }, { key: " " }],
  },
  {
    id: "tabs.activate",
    label: "Activate the focused tab",
    scope: "tabs",
    group: "in-view",
    keywords: ["enter", "activate", "tab"],
    display: { key: "Enter" },
  },
  {
    id: "tabs.move-focus",
    label: "Move focus between tabs",
    scope: "tabs",
    group: "in-view",
    keywords: ["left", "right", "focus", "tab"],
    display: [{ key: "ArrowLeft" }, { key: "ArrowRight" }],
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const BY_ID: ReadonlyMap<string, Shortcut> = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Throwing lookup — `id` is a literal union, so a miss is a programmer
 *  error (a deleted entry still referenced by a handler), not user input. */
export function getShortcut(id: ShortcutId): Shortcut {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`[shortcuts] unknown shortcut id: ${id}`);
  return found;
}

/** Single-press accessor for bespoke handlers that match one key spec.
 *  Throws if the entry's display is an alias array or a chord — so changing
 *  a catalog entry's shape fails loudly here instead of silently feeding a
 *  malformed spec to `matchEvent` and quietly disabling the shortcut. */
export function getKeySpec(id: ShortcutId): KeySpec {
  const { display } = getShortcut(id);
  if (isChord(display) || Array.isArray(display)) {
    throw new Error(`[shortcuts] ${id} display is not a single key spec`);
  }
  // The guard above rules out the chord and array members; the cast only
  // satisfies TS, which won't narrow a readonly array out of the union.
  return display as KeySpec;
}

/** Chord accessor for the stateful pending-key handler. Throws if the
 *  entry's display is a single spec or alias array, for the same fail-loud
 *  reason as `getKeySpec`. */
export function getChord(id: ShortcutId): Chord {
  const { display } = getShortcut(id);
  if (!isChord(display)) {
    throw new Error(`[shortcuts] ${id} display is not a chord`);
  }
  return display;
}

/** Human-readable group headers for `scope`. */
export const SCOPE_LABELS: Record<ShortcutScope, string> = {
  global: "Global",
  palette: "Command palette",
  "file-tree": "File tree",
  "section-view": "Section view",
  "activity-bar": "Activity bar",
  tabs: "Tabs",
};

export const GROUP_LABELS: Record<ShortcutGroup, string> = {
  commands: "Commands",
  "in-view": "In-view navigation",
};

// ─── Event matching ───────────────────────────────────────────────────────

/** Minimal slice of `KeyboardEvent` the matcher reads — keeps tests free
 *  of jsdom and lets pure dispatchers pass a plain object. A real
 *  `KeyboardEvent` (DOM or React synthetic) satisfies it structurally. */
export interface KeyEventLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

function keysEqual(a: string, b: string): boolean {
  if (a.length === 1 && b.length === 1) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * EXACT-modifier match of one event against one key spec. "cmd" maps to
 * `metaKey || ctrlKey` so the same spec works on macOS (⌘) and
 * Windows/Linux (Ctrl). Exact means a modifier NOT in the spec must be
 * absent on the event — ⌘W does not match ⌘⇧W. This is the deliberate
 * tightening over the old per-site handlers, whose tolerant edges
 * (⌘PageUp-with-shift, ⌘⇧T-with-alt) fired on extra modifiers.
 */
export function matchEvent(event: KeyEventLike, spec: KeySpec): boolean {
  const wantCmd = spec.mods?.includes("cmd") ?? false;
  const wantAlt = spec.mods?.includes("alt") ?? false;
  const wantShift = spec.mods?.includes("shift") ?? false;
  const hasCmd = event.metaKey === true || event.ctrlKey === true;
  if (hasCmd !== wantCmd) return false;
  if ((event.altKey === true) !== wantAlt) return false;
  if ((event.shiftKey === true) !== wantShift) return false;
  return keysEqual(event.key, spec.key);
}

/** Match an event against any single-press binding of a shortcut. Chords
 *  always return false — they need a stateful pending-key handler, not a
 *  single-event match. */
export function matchShortcut(event: KeyEventLike, shortcut: Shortcut): boolean {
  const d = shortcut.display;
  if (isChord(d)) return false;
  if (Array.isArray(d)) return d.some((spec) => matchEvent(event, spec));
  return matchEvent(event, d as KeySpec);
}

// ─── Display formatting ───────────────────────────────────────────────────

const MAC_MOD_GLYPH: Record<ShortcutMod, string> = { cmd: "⌘", alt: "⌥", shift: "⇧" };
const OTHER_MOD_LABEL: Record<ShortcutMod, string> = { cmd: "Ctrl", alt: "Alt", shift: "Shift" };
// Glyph rendering order mirrors the existing chrome strings (⌘ first).
const MOD_ORDER: readonly ShortcutMod[] = ["cmd", "alt", "shift"];

const MAC_KEY_GLYPH: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Enter: "↵",
  Escape: "Esc",
  " ": "Space",
};

const OTHER_KEY_LABEL: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Esc",
  " ": "Space",
};

function keyLabel(key: string, mac: boolean): string {
  const table = mac ? MAC_KEY_GLYPH : OTHER_KEY_LABEL;
  if (key in table) return table[key] as string;
  // Single letters render uppercase; everything else (commas, "A–Z",
  // "PageUp" on non-mac) renders verbatim.
  return key.length === 1 ? key.toUpperCase() : key;
}

function formatSpec(spec: KeySpec, mac: boolean): string {
  const mods = (spec.mods ?? []).slice().sort(sortMods);
  const key = keyLabel(spec.key, mac);
  if (mac) return mods.map((m) => MAC_MOD_GLYPH[m]).join("") + key;
  const parts = mods.map((m) => OTHER_MOD_LABEL[m]);
  parts.push(key);
  return parts.join("+");
}

function sortMods(a: ShortcutMod, b: ShortcutMod): number {
  return MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b);
}

function isChord(d: ShortcutDisplay): d is Chord {
  return typeof d === "object" && d !== null && "chord" in d;
}

/**
 * Render a shortcut's display for the current platform. Single specs →
 * "⌘P" / "Ctrl+P"; alias arrays → " or "-joined ("↑ or ↓"); chords →
 * space-joined ("⌘K W"). Reads `IS_MAC` once at module load — no
 * prop-threading, matching the rest of the renderer.
 */
export function formatBinding(display: ShortcutDisplay, mac: boolean = IS_MAC): string {
  if (isChord(display)) return display.chord.map((spec) => formatSpec(spec, mac)).join(" ");
  if (Array.isArray(display)) return display.map((spec) => formatSpec(spec, mac)).join(" or ");
  return formatSpec(display as KeySpec, mac);
}

/** Convenience: format a shortcut by id (the common display-label path). */
export function formatShortcut(id: ShortcutId, mac: boolean = IS_MAC): string {
  return formatBinding(getShortcut(id).display, mac);
}
