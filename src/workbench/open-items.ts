// Workbench state. Pure functions over an `OpenItemsState` shape the UI
// binds to. The `kind` discriminator on `OpenItem` is present from day
// one so a future chat-tabs feature adds a `kind: "chat"` case as an
// additive variant rather than a state rewrite. Today only
// `kind: "section"` is produced at runtime; the chat case is exercised
// by tests that validate coexistence semantics.
//
// Persistence interop also lives here: `fromPersisted` / `toPersisted`
// translate between the workbench's `OpenItem` (carrying branded
// `CorpusRef`s) and the persistence wire shape (raw string fields). Refs
// that fail validation on read are dropped silently — the caller reflects
// the reduced state and the user re-clicks if needed.

import type { CorpusRef } from "@/corpus/refs";
import { parse as parseRef, equals as refsEqual } from "@/corpus/refs";
import type { PersistedOpenItems } from "@/persistence";

export type OpenItem = { kind: "section"; ref: CorpusRef } | { kind: "chat"; chatId: string };

export interface OpenItemsState {
  readonly items: readonly OpenItem[];
  /** Index into `items`, or `null` when nothing is active. */
  readonly activeIndex: number | null;
}

export function emptyOpenItems(): OpenItemsState {
  return { items: [], activeIndex: null };
}

/**
 * Open a section ref. If it's already present, switch to that index;
 * otherwise append + activate.
 */
export function openItem(state: OpenItemsState, ref: CorpusRef): OpenItemsState {
  const existingIdx = findSectionIndex(state.items, ref);
  if (existingIdx >= 0) {
    if (state.activeIndex === existingIdx) return state;
    return { items: state.items, activeIndex: existingIdx };
  }
  const items = [...state.items, { kind: "section" as const, ref }];
  return { items, activeIndex: items.length - 1 };
}

/**
 * Append a section ref without changing `activeIndex`. If the ref is
 * already in the list, returns state unchanged. Used by Cmd/Ctrl+click
 * and Cmd/Ctrl+Enter to "open in background".
 */
export function openItemWithoutSwitching(state: OpenItemsState, ref: CorpusRef): OpenItemsState {
  if (findSectionIndex(state.items, ref) >= 0) return state;
  const items = [...state.items, { kind: "section" as const, ref }];
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

// ─── Persistence interop ────────────────────────────────────────────────────

export function fromPersisted(persisted: PersistedOpenItems): OpenItemsState {
  const items: OpenItem[] = [];
  const surviving: number[] = [];
  for (let i = 0; i < persisted.items.length; i++) {
    const p = persisted.items[i];
    if (!p) continue;
    try {
      items.push({ kind: "section", ref: parseRef(p.ref) });
      surviving.push(i);
    } catch {
      // Drop invalid persisted ref — caller falls back to empty/default state.
    }
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
    if (it.kind !== "section") continue; // chat persistence is feat/ai-agent's problem
    items.push({
      kind: "section",
      ref: { module: it.ref.module, section: it.ref.section },
    });
    survivingOriginalIdx.push(i);
  }
  let active: number | null = null;
  if (state.activeIndex !== null) {
    const newIdx = survivingOriginalIdx.indexOf(state.activeIndex);
    active = newIdx >= 0 ? newIdx : null;
  }
  return { items, activeIndex: active };
}
