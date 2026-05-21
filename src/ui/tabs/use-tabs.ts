// Tab UI orchestration hook. Owns the pieces of tab state that don't
// belong on the canonical `OpenItemsState`:
//
//   • `recentlyClosed` — LIFO buffer of OpenItems closed during this
//     session, consumed by ⌘shift+T. Capped at 10, deduped on pop so an
//     item that's currently open never resurrects from a stale buffer
//     entry. External-citation items participate alongside sections; the
//     dedup key is `itemIdentity`. Plan A5 + T8.
//   • `sectionScroll` — per-section vertical scroll offsets so switching
//     tabs restores the user's read position. CQ8 (~100ms debounce, restore
//     after section state updates via useLayoutEffect).
//
// `close()` wraps `closeItem` so the buffer write and the items mutation
// land in the same render via React 18 batching. `reopenLast()` recurses
// past stale entries (items that are already open) so a single ⌘shift+T
// always lands on a fresh tab.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CorpusRef, hash as refHash } from "@/corpus/refs";
import type { NavigationIntent } from "@/workbench/navigate";
import {
  closeItem,
  itemIdentity,
  type OpenItem,
  type OpenItemsState,
  validateRecentlyClosed,
} from "@/workbench/open-items";

const RECENTLY_CLOSED_CAP = 10;
const SCROLL_DEBOUNCE_MS = 100;

export interface UseTabsParams {
  openItems: OpenItemsState;
  setOpenItems: (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => void;
  /** Predicate used to drop stale entries from `recentlyClosed` (e.g. on
   *  cold-start after a corpus upgrade that renumbered sections). */
  isValidRef?: (ref: CorpusRef) => boolean;
  /** Tab-dispatch primitive. Used by `reopenLast` so reopens go through
   *  the same navigate seam as every other tab open (per C5: reopen
   *  starts a fresh history, matching browser ⌘shift+T). */
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
}

export interface UseTabsResult {
  /** Current LIFO buffer of recently-closed items (newest first). */
  readonly recentlyClosed: readonly OpenItem[];
  /** Close the tab at `index`. Pushes its OpenItem onto `recentlyClosed`. */
  close: (index: number) => void;
  /** Pop the head of `recentlyClosed` and reopen it. No-op if empty. */
  reopenLast: () => void;
  /** Capture vertical scroll for the active section. Debounced. */
  saveScroll: (ref: CorpusRef, scrollY: number) => void;
  /** Read scroll offset for a ref, or 0 if unknown. */
  getScroll: (ref: CorpusRef) => number;
  /** Hook for `<SectionView>` host to set up scroll restoration after
   *  the body has rendered (useLayoutEffect timing — CQ8 / codex F12). */
  useRestoreScroll: (
    activeRef: CorpusRef | null,
    scrollContainer: HTMLElement | null,
    /** Key that flips when the section body finishes rendering — e.g.
     *  the section's `moduleId::sectionId` string. */
    sectionKey: string | null,
  ) => void;
}

export function useTabs({
  openItems,
  setOpenItems,
  isValidRef,
  navigate,
}: UseTabsParams): UseTabsResult {
  const [recentlyClosed, setRecentlyClosed] = useState<readonly OpenItem[]>([]);
  const scrollMapRef = useRef<Map<string, number>>(new Map());
  const scrollDebounceRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<{ key: string; y: number } | null>(null);

  // On cold-start, drop any recently-closed entries that no longer
  // resolve against the corpus. The hook is constructed before corpus
  // load resolves, so the predicate may flip — re-validate when it
  // changes identity.
  useEffect(() => {
    if (!isValidRef) return;
    setRecentlyClosed((prev) => {
      const next = validateRecentlyClosed(prev, isValidRef);
      return next === prev ? prev : next.slice();
    });
  }, [isValidRef]);

  const close = useCallback(
    (index: number) => {
      setOpenItems((prev) => {
        const target = prev.items[index];
        if (target) {
          // React 18 batches these into the same render; the closeItem
          // result and recentlyClosed push commit together. External-
          // citation tabs participate alongside sections (T8) — the buffer
          // holds the full OpenItem so reopen restores the same kind.
          setRecentlyClosed((buf) => {
            // No dedup on push — the same item can be opened, closed,
            // reopened, closed again; that's two distinct recent-closes.
            // Dedup happens on pop (reopenLast).
            const next = [target, ...buf];
            return next.length > RECENTLY_CLOSED_CAP ? next.slice(0, RECENTLY_CLOSED_CAP) : next;
          });
        }
        return closeItem(prev, index);
      });
    },
    [setOpenItems],
  );

  const reopenLast = useCallback(() => {
    // Pop + dedup loop: skip any buffer head whose identity is already
    // open (Chrome semantic — the user's intent is "give me back something
    // I closed," not "duplicate something I already have"). Reopens route
    // through `navigate(item, "primary")` so the reopened tab starts a
    // fresh navigation history (C5 — matches browser ⌘shift+T).
    setRecentlyClosed((buf) => {
      if (buf.length === 0) return buf;
      let i = 0;
      while (i < buf.length) {
        const candidate = buf[i];
        if (!candidate) {
          i++;
          continue;
        }
        const alreadyOpen = isItemOpen(openItems, candidate);
        if (!alreadyOpen) {
          navigate(candidate, "primary");
          return buf.slice(i + 1);
        }
        i++;
      }
      // All entries were stale — buffer empties.
      return [];
    });
  }, [openItems, navigate]);

  const saveScroll = useCallback((ref: CorpusRef, scrollY: number) => {
    const key = refHash(ref);
    pendingScrollRef.current = { key, y: scrollY };
    if (scrollDebounceRef.current !== null) {
      window.clearTimeout(scrollDebounceRef.current);
    }
    scrollDebounceRef.current = window.setTimeout(() => {
      const pending = pendingScrollRef.current;
      if (pending) scrollMapRef.current.set(pending.key, pending.y);
      pendingScrollRef.current = null;
      scrollDebounceRef.current = null;
    }, SCROLL_DEBOUNCE_MS);
  }, []);

  const getScroll = useCallback((ref: CorpusRef): number => {
    return scrollMapRef.current.get(refHash(ref)) ?? 0;
  }, []);

  // Flush pending debounced scroll on unmount.
  useEffect(() => {
    return () => {
      if (scrollDebounceRef.current !== null) {
        window.clearTimeout(scrollDebounceRef.current);
        scrollDebounceRef.current = null;
      }
    };
  }, []);

  // CQ8 / codex F12 — restore scroll after the section body finishes
  // rendering (sectionKey flip), not on every activeRef change. Without
  // the sectionKey gate the scrollTop write would land while the DOM
  // still shows the previous section's content. scrollContainer is in
  // deps so the effect re-fires once the callback ref hands us the
  // mounted element on cold start. Flushing the pending debounced save
  // first prevents losing the outgoing section's scroll position when
  // the user switches tabs within the 100ms debounce window.
  const useRestoreScroll: UseTabsResult["useRestoreScroll"] = (
    activeRef,
    scrollContainer,
    sectionKey,
  ) => {
    // biome-ignore lint/correctness/useExhaustiveDependencies: sectionKey + scrollContainer are the deliberate triggers; activeRef is read for the map lookup but should not re-fire restore on its own
    useLayoutEffect(() => {
      if (!activeRef || !scrollContainer || !sectionKey) return;
      const pending = pendingScrollRef.current;
      if (pending) {
        scrollMapRef.current.set(pending.key, pending.y);
        if (scrollDebounceRef.current !== null) {
          window.clearTimeout(scrollDebounceRef.current);
          scrollDebounceRef.current = null;
        }
        pendingScrollRef.current = null;
      }
      const y = scrollMapRef.current.get(refHash(activeRef)) ?? 0;
      scrollContainer.scrollTop = y;
    }, [sectionKey, scrollContainer]);
  };

  return { recentlyClosed, close, reopenLast, saveScroll, getScroll, useRestoreScroll };
}

function isItemOpen(state: OpenItemsState, target: OpenItem): boolean {
  const id = itemIdentity(target);
  for (const item of state.items) {
    if (itemIdentity(item) === id) return true;
  }
  return false;
}
