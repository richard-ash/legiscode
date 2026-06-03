// Workbench state. Pure functions over an `OpenItemsState` shape the UI
// binds to. The `kind` discriminator on `OpenItem` is present from day
// one so a future chat-tabs feature (#13) adds a `kind: "chat"` case as
// an additive variant rather than a state rewrite. Today only
// `kind: "section"` is produced at runtime; the chat case is exercised
// by tests that validate coexistence semantics.
//
// Persistence interop also lives here: `fromPersisted` / `toPersisted`
// translate between the workbench's `OpenItem` (carrying branded
// `CorpusRef`s) and the persistence wire shape (raw string fields). Refs
// that fail validation on read are dropped silently — the caller reflects
// the reduced state and the user re-clicks if needed.
//
// The `recentlyClosed` buffer lives in the use-tabs hook (sibling
// useState) rather than on `OpenItemsState` so persistence stays
// focused on the canonical "what's open right now" shape.

import type { CorpusRef } from "@/corpus/refs";
import { parse as parseRef, hash as refHash, equals as refsEqual } from "@/corpus/refs";
import type { PersistedOpenItems } from "@/persistence";

/** Which pane of the Settings surface a settings tab shows. A union of
 *  one today; Theme / Font / Profile extend it additively in v1.1 without
 *  breaking persisted tabs. Named `SettingsPane` (not `SettingsSection`)
 *  so `section` only ever means a corpus section. The field on
 *  OpenItem.kind="settings" stays `section:` to preserve the persistence
 *  wire format; only the type name changes. */
export type SettingsPane = "shortcuts";

export type OpenItem =
  | { kind: "section"; ref: CorpusRef }
  | { kind: "chat"; chatId: string }
  | { kind: "settings"; section: SettingsPane }
  | { kind: "bill"; billId: string };

/**
 * Stable identity key for an OpenItem — used by sibling state (history,
 * scroll position) to associate per-item data without storing it on
 * OpenItemsState itself.
 *
 * Limitation accepted for v1: two tabs pointing at the same section share
 * one identity, so they share history. A stable per-tab UUID would lift
 * this but adds a parallel array through every state mutation; v1.1 work.
 */
export function itemIdentity(item: OpenItem): string {
  switch (item.kind) {
    case "section":
      return `section::${refHash(item.ref)}`;
    case "chat":
      return `chat::${item.chatId}`;
    case "settings":
      return `settings::${item.section}`;
    case "bill":
      return `bill::${item.billId}`;
  }
}

/** True when `a` and `b` refer to the same tab content (same identity). */
export function itemsEqual(a: OpenItem, b: OpenItem): boolean {
  return itemIdentity(a) === itemIdentity(b);
}

export interface OpenItemsState {
  readonly items: readonly OpenItem[];
  /** Index into `items`, or `null` when nothing is active. */
  readonly activeIndex: number | null;
}

export function emptyOpenItems(): OpenItemsState {
  return { items: [], activeIndex: null };
}

function toOpenItem(target: OpenItem | CorpusRef): OpenItem {
  return "kind" in target ? target : { kind: "section", ref: target };
}

/**
 * Open a section ref or OpenItem. If an item with the same identity is
 * already present, switch to that index; otherwise append + activate.
 *
 * Section call sites pass a `CorpusRef` (legacy ergonomic). Chat call
 * sites pass a fully-constructed OpenItem.
 */
export function openItem(state: OpenItemsState, ref: CorpusRef): OpenItemsState;
export function openItem(state: OpenItemsState, item: OpenItem): OpenItemsState;
export function openItem(state: OpenItemsState, target: OpenItem | CorpusRef): OpenItemsState {
  const item = toOpenItem(target);
  const existingIdx = findItemIndex(state.items, item);
  if (existingIdx >= 0) {
    if (state.activeIndex === existingIdx) return state;
    return { items: state.items, activeIndex: existingIdx };
  }
  const items = [...state.items, item];
  return { items, activeIndex: items.length - 1 };
}

/**
 * Append a section ref or OpenItem without changing `activeIndex`. If an
 * item with the same identity is already in the list, returns state
 * unchanged. Used by Cmd/Ctrl+click and Cmd/Ctrl+Enter to "open in
 * background".
 */
export function openItemWithoutSwitching(state: OpenItemsState, ref: CorpusRef): OpenItemsState;
export function openItemWithoutSwitching(state: OpenItemsState, item: OpenItem): OpenItemsState;
export function openItemWithoutSwitching(
  state: OpenItemsState,
  target: OpenItem | CorpusRef,
): OpenItemsState {
  const item = toOpenItem(target);
  if (findItemIndex(state.items, item) >= 0) return state;
  const items = [...state.items, item];
  return { items, activeIndex: state.activeIndex };
}

/**
 * Close the item at `index`. Active-index fall-back: prefer the right
 * neighbor; if absent, fall back to the left; if neither, `null`.
 * Closing a non-active item shifts `activeIndex` down only when the
 * closed index is below the active one.
 */
export function closeItem(state: OpenItemsState, index: number): OpenItemsState {
  if (index < 0 || index >= state.items.length) return state;
  const items = state.items.slice(0, index).concat(state.items.slice(index + 1));
  let active = state.activeIndex;
  if (active !== null) {
    if (index === active) {
      if (items.length === 0) active = null;
      else if (index < items.length) active = index;
      else active = items.length - 1;
    } else if (index < active) {
      active = active - 1;
    }
  }
  return { items, activeIndex: active };
}

/**
 * Close every tab except the one at `keepIndex`. activeIndex is remapped
 * to `keepIndex`'s new position (always 0) since the surviving tab
 * becomes the only thing visible. Out-of-range `keepIndex` returns
 * state unchanged.
 *
 * The hook-side wrapper (`useTabs.closeOthers`) bookkeeps the
 * recently-closed buffer; this pure mutator only owns the items + active
 * remap.
 */
export function closeOthers(state: OpenItemsState, keepIndex: number): OpenItemsState {
  if (keepIndex < 0 || keepIndex >= state.items.length) return state;
  const kept = state.items[keepIndex];
  if (!kept) return state;
  if (state.items.length === 1 && state.activeIndex === 0) return state;
  return { items: [kept], activeIndex: 0 };
}

/**
 * Close every tab to the right of `fromIndex`, keeping `fromIndex` and
 * everything to its left. activeIndex is preserved when it points at a
 * surviving tab, otherwise clamped to `fromIndex` (the rightmost
 * survivor). Out-of-range `fromIndex` and "nothing to the right"
 * (already rightmost) return state unchanged.
 */
export function closeToRight(state: OpenItemsState, fromIndex: number): OpenItemsState {
  if (fromIndex < 0 || fromIndex >= state.items.length) return state;
  if (fromIndex === state.items.length - 1) return state;
  const items = state.items.slice(0, fromIndex + 1);
  let active = state.activeIndex;
  if (active !== null && active > fromIndex) active = fromIndex;
  return { items, activeIndex: active };
}

/**
 * Close every tab. Equivalent to `emptyOpenItems()` but spelled as a
 * sibling mutator so the hook-side wrapper can compose it with the
 * recently-closed buffer push uniformly.
 */
export function closeAll(_state: OpenItemsState): OpenItemsState {
  return emptyOpenItems();
}

/**
 * Move the tab at `from` to position `to`. Out-of-range / `from === to`
 * return state unchanged. `activeIndex` is remapped so the currently
 * active tab stays active wherever it lands — mirrors `closeItem`'s
 * activeIndex bookkeeping.
 */
export function reorderItems(state: OpenItemsState, from: number, to: number): OpenItemsState {
  const len = state.items.length;
  if (from < 0 || from >= len) return state;
  if (to < 0 || to >= len) return state;
  if (from === to) return state;
  const next = state.items.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return state;
  next.splice(to, 0, moved);
  let active = state.activeIndex;
  if (active !== null) {
    if (active === from) {
      active = to;
    } else if (from < active && to >= active) {
      active = active - 1;
    } else if (from > active && to <= active) {
      active = active + 1;
    }
  }
  return { items: next, activeIndex: active };
}

export function setActiveIndex(state: OpenItemsState, index: number | null): OpenItemsState {
  if (index === null) {
    if (state.activeIndex === null) return state;
    return { items: state.items, activeIndex: null };
  }
  if (index < 0 || index >= state.items.length) return state;
  if (state.activeIndex === index) return state;
  return { items: state.items, activeIndex: index };
}

/**
 * Drop section items whose refs no longer exist in the loaded corpus
 * (e.g. the user upgraded and the cited section was renumbered). Non-
 * section kinds are passed through unchanged. `activeIndex` is remapped
 * to the survivor occupying the original active slot, or `null` if that
 * slot was dropped.
 */
export function validateAgainstCorpus(
  state: OpenItemsState,
  isValidRef: (ref: CorpusRef) => boolean,
): OpenItemsState {
  interface Survivor {
    readonly item: OpenItem;
    readonly originalIdx: number;
  }
  const surviving: Survivor[] = [];
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    if (!it) continue;
    if (it.kind === "section") {
      if (isValidRef(it.ref)) surviving.push({ item: it, originalIdx: i });
    } else {
      surviving.push({ item: it, originalIdx: i });
    }
  }
  const items = surviving.map((s) => s.item);
  let active: number | null = null;
  if (state.activeIndex !== null) {
    const newIdx = surviving.findIndex((s) => s.originalIdx === state.activeIndex);
    active = newIdx >= 0 ? newIdx : null;
  }
  if (items.length === state.items.length && active === state.activeIndex) {
    return state;
  }
  return { items, activeIndex: active };
}

/**
 * Drop items from a recently-closed buffer whose targets no longer exist
 * in the loaded corpus. Used by the use-tabs hook on cold-start so a
 * ⌘shift+T reopen can't resurrect a section the corpus upgrade removed.
 *
 * Section items run through `isValidRef`; non-section items (external
 * citations, future chat tabs) don't depend on corpus state and always
 * survive. Pure helper — the LIFO buffer itself lives in the hook.
 */
export function validateRecentlyClosed(
  buffer: readonly OpenItem[],
  isValidRef: (ref: CorpusRef) => boolean,
): readonly OpenItem[] {
  const out: OpenItem[] = [];
  let changed = false;
  for (const item of buffer) {
    if (item.kind === "section") {
      if (isValidRef(item.ref)) out.push(item);
      else changed = true;
    } else {
      out.push(item);
    }
  }
  return changed ? out : buffer;
}

export function activeItem(state: OpenItemsState): OpenItem | null {
  if (state.activeIndex === null) return null;
  return state.items[state.activeIndex] ?? null;
}

/**
 * The branded ref of the active item, or null when nothing is active or the
 * active item is not a section. Centralizes the unwrap that file-tree.tsx and
 * use-roving-focus.ts both need so they cannot drift when a third `OpenItem`
 * variant is added.
 */
export function activeSectionRef(state: OpenItemsState): CorpusRef | null {
  const item = activeItem(state);
  if (!item || item.kind !== "section") return null;
  return item.ref;
}

export function findSectionIndex(items: readonly OpenItem[], ref: CorpusRef): number {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "section" && refsEqual(it.ref, ref)) return i;
  }
  return -1;
}

export function findItemIndex(items: readonly OpenItem[], target: OpenItem): number {
  const id = itemIdentity(target);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && itemIdentity(it) === id) return i;
  }
  return -1;
}

// ─── Persistence interop ────────────────────────────────────────────────────

export function fromPersisted(
  persisted: PersistedOpenItems,
  isKnownBill: (billId: string) => boolean = () => true,
): OpenItemsState {
  const items: OpenItem[] = [];
  const surviving: number[] = [];
  for (let i = 0; i < persisted.items.length; i++) {
    const p = persisted.items[i];
    if (!p) continue;
    if (p.kind === "section") {
      try {
        items.push({ kind: "section", ref: parseRef(p.ref) });
        surviving.push(i);
      } catch {
        // Drop invalid persisted ref — section was renumbered or schema drift.
      }
    } else if (p.kind === "settings") {
      items.push({ kind: "settings", section: p.section });
      surviving.push(i);
    } else if (p.kind === "bill") {
      // Drop bills that no longer appear in the corpus (advanced through
      // committee + signed → no longer pending). Tabs go away cleanly the
      // next time the user launches the app.
      if (isKnownBill(p.billId)) {
        items.push({ kind: "bill", billId: p.billId });
        surviving.push(i);
      }
    }
    // Unknown kinds drop here AND at the schema layer (item-wise
    // tolerant parsing in storage.ts).
  }
  let active: number | null = null;
  if (persisted.activeIndex !== null) {
    const newIdx = surviving.indexOf(persisted.activeIndex);
    active = newIdx >= 0 ? newIdx : null;
  }
  return { items, activeIndex: active };
}

export function toPersisted(state: OpenItemsState): PersistedOpenItems {
  const items: PersistedOpenItems["items"] = [];
  const survivingOriginalIdx: number[] = [];
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    if (!it) continue;
    if (it.kind === "section") {
      items.push({
        kind: "section",
        ref: { module: it.ref.module, section: it.ref.section },
      });
    } else if (it.kind === "settings") {
      items.push({ kind: "settings", section: it.section });
    } else if (it.kind === "bill") {
      items.push({ kind: "bill", billId: it.billId });
    } else {
      // Other kinds are not persisted.
      continue;
    }
    survivingOriginalIdx.push(i);
  }
  let active: number | null = null;
  if (state.activeIndex !== null) {
    const newIdx = survivingOriginalIdx.indexOf(state.activeIndex);
    active = newIdx >= 0 ? newIdx : null;
  }
  return { items, activeIndex: active };
}
