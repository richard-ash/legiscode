// Tab UI orchestration hook. Owns the pieces of tab state that don't
// belong on the canonical `OpenItemsState`:
//
//   • `recentlyClosed` — LIFO buffer of refs closed during this session,
//     consumed by ⌘shift+T. Capped at 10, deduped on pop so a ref that's
//     currently open never resurrects from a stale buffer entry. Plan A5.
//   • `sectionScroll` — per-section vertical scroll offsets so switching
//     tabs restores the user's read position. CQ8 (~100ms debounce, restore
//     after section state updates via useLayoutEffect).
//
// `close()` wraps `closeItem` so the buffer write and the items mutation
// land in the same render via React 18 batching. `reopenLast()` recurses
// past stale entries (refs that are already open) so a single ⌘shift+T
// always lands on a fresh section.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CorpusRef, hash as refHash } from "@/corpus/refs";
import {
  closeItem,
  type OpenItemsState,
  openItem,
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
}

export interface UseTabsResult {
  /** Current LIFO buffer of recently-closed refs (newest first). */
  readonly recentlyClosed: readonly CorpusRef[];
  /** Close the tab at `index`. Pushes its ref onto `recentlyClosed`. */
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

export function useTabs({ openItems, setOpenItems, isValidRef }: UseTabsParams): UseTabsResult {
  const [recentlyClosed, setRecentlyClosed] = useState<readonly CorpusRef[]>([]);
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
        if (target && target.kind === "section") {
          // React 18 batches these into the same render; the closeItem
          // result and recentlyClosed push commit together.
          const ref = target.ref;
          setRecentlyClosed((buf) => {
            // No dedup on push — the same section can be opened, closed,
            // reopened, closed again; that's two distinct recent-closes.
            // Dedup happens on pop (reopenLast).
            const next = [ref, ...buf];
            return next.length > RECENTLY_CLOSED_CAP ? next.slice(0, RECENTLY_CLOSED_CAP) : next;
          });
        }
        return closeItem(prev, index);
      });
    },
    [setOpenItems],
  );

  const reopenLast = useCallback(() => {
    // Pop + dedup loop: skip any buffer head whose ref is already open
    // (Chrome semantic — the user's intent is "give me back something I
    // closed," not "duplicate something I already have").
    setRecentlyClosed((buf) => {
      if (buf.length === 0) return buf;
      // Walk the buffer from the head; pick the first ref not currently
      // open. Drop everything skipped on the way (stale buffer entries
      // would otherwise pile up at the head forever).
      let i = 0;
      while (i < buf.length) {
        const candidate = buf[i];
        if (!candidate) {
          i++;
          continue;
        }
        const alreadyOpen = isRefOpen(openItems, candidate);
        if (!alreadyOpen) {
          // Reopen + drop the head through this position.
          setOpenItems((prev) => openItem(prev, candidate));
          return buf.slice(i + 1);
        }
        i++;
      }
      // All entries were stale — buffer empties.
      return [];
    });
  }, [openItems, setOpenItems]);

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

function isRefOpen(state: OpenItemsState, ref: CorpusRef): boolean {
  for (const item of state.items) {
    if (item.kind === "section" && refHash(item.ref) === refHash(ref)) return true;
  }
  return false;
}
