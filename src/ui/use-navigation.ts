// React hook over the navigation primitives. Owns:
//   - the navigate() entry point used by citation clicks and the
//     command palette,
//   - the pendingScroll state that pairs subsection scrolls with the
//     target section so the SectionView layout effect only scrolls
//     once the right tab has loaded, and
//   - the ⌘⌥← / ⌘⌥→ keyboard shortcuts for switching between tabs.
//
// VS Code tab model: ⌘-click opens a new foreground tab; ⌘⌥← / ⌘⌥→
// moves between tabs (wrapping at boundaries). There is no per-tab
// history — to revisit a section you bring its tab forward.

import { useCallback, useEffect, useState } from "react";
import { getShortcut, matchShortcut } from "@/ui/shortcuts/registry";
import { shouldHandleGlobalShortcut } from "@/ui/tabs/should-handle-shortcut";
import { findItemIndex, type OpenItem, type OpenItemsState } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";

export interface UseNavigationParams {
  openItems: OpenItemsState;
  setOpenItems: (update: (prev: OpenItemsState) => OpenItemsState) => void;
}

export interface NavigateOptions {
  readonly subsection?: string;
}

/** A subsection scroll target pending consumption by the SectionView
 *  layer. Pairs the label with the section key it belongs to, so the
 *  consumer can wait for that section to actually finish loading
 *  before trying to scroll — otherwise the layout effect would fire
 *  against the previous section's DOM and miss. */
export interface PendingScroll {
  readonly subsection: string;
  /** "moduleId::sectionId" — matches App.tsx's sectionKey shape. */
  readonly targetSectionKey: string;
}

export interface UseNavigationResult {
  /** Navigate to `item` per intent. */
  navigate: (item: OpenItem, intent: NavigationIntent, options?: NavigateOptions) => void;
  /** Switch the active tab to the previous one in the strip (wraps at start). */
  prevTab: () => void;
  /** Switch the active tab to the next one (wraps at end). */
  nextTab: () => void;
  /** Subsection scroll target pending consumption, or null. Set by
   *  navigate() when the step carries a subsection. The
   *  `targetSectionKey` field gates the consumer so it only scrolls
   *  after the matching section's body has rendered. */
  pendingScroll: PendingScroll | null;
  /** Request a subsection scroll within the active tab without opening
   *  a new one. Used by the dispatcher for `kind: "scroll-only"`
   *  resolution results. */
  requestScroll: (target: PendingScroll) => void;
  /** Clear the pending scroll target. Called by the consumer after it
   *  has tried to scroll (success or miss). */
  consumePendingScroll: () => void;
}

export function useNavigation({
  openItems,
  setOpenItems,
}: UseNavigationParams): UseNavigationResult {
  // Subsection scroll target carried by the current nav step. Cleared
  // by the consumer (App's pending-scroll layout effect) after it tries
  // to scroll. Null when no jump is pending. The targetSectionKey
  // lets the consumer wait for the right section to finish loading
  // before scrolling — otherwise the effect would fire against the
  // previous section's DOM (during the IPC roundtrip window between
  // navigate() and setSection()) and miss the anchor.
  const [pendingScroll, setPendingScroll] = useState<PendingScroll | null>(null);
  const consumePendingScroll = useCallback(() => {
    setPendingScroll(null);
  }, []);
  const requestScroll = useCallback((target: PendingScroll) => {
    setPendingScroll(target);
  }, []);

  const navigate = useCallback(
    (item: OpenItem, intent: NavigationIntent, options?: NavigateOptions) => {
      // primary targets the active view; background opens a new tab
      // without switching, so it doesn't fire the current-view subsection
      // scroll. Only section items can carry a subsection scroll target.
      if (intent !== "background" && item.kind === "section") {
        const targetSectionKey = `${item.ref.module}::${item.ref.section}`;
        setPendingScroll(
          options?.subsection ? { subsection: options.subsection, targetSectionKey } : null,
        );
      } else if (intent !== "background") {
        // primary into a non-section item: clear any stale pending scroll.
        setPendingScroll(null);
      }
      setOpenItems((prev) => {
        const existingIdx = findItemIndex(prev.items, item);

        if (intent === "background") {
          if (existingIdx >= 0) return prev;
          return { items: [...prev.items, item], activeIndex: prev.activeIndex };
        }

        // primary: if already open, activate that tab; otherwise append + activate.
        if (existingIdx >= 0) {
          if (prev.activeIndex === existingIdx) return prev;
          return { items: prev.items, activeIndex: existingIdx };
        }
        return { items: [...prev.items, item], activeIndex: prev.items.length };
      });
    },
    [setOpenItems],
  );

  const prevTab = useCallback(() => {
    setOpenItems((prev) => {
      if (prev.items.length === 0 || prev.activeIndex === null) return prev;
      const nextIndex = (prev.activeIndex - 1 + prev.items.length) % prev.items.length;
      if (nextIndex === prev.activeIndex) return prev;
      return { items: prev.items, activeIndex: nextIndex };
    });
  }, [setOpenItems]);

  const nextTab = useCallback(() => {
    setOpenItems((prev) => {
      if (prev.items.length === 0 || prev.activeIndex === null) return prev;
      const nextIndex = (prev.activeIndex + 1) % prev.items.length;
      if (nextIndex === prev.activeIndex) return prev;
      return { items: prev.items, activeIndex: nextIndex };
    });
  }, [setOpenItems]);

  // Global keyboard listener for ⌘⌥← / ⌘⌥→ (and Ctrl+Alt on non-Mac).
  // Key specs come from the catalog; guarded by shouldHandleGlobalShortcut
  // so palette typing / input focus don't get hijacked.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const isPrev = matchShortcut(e, getShortcut("global.prev-tab"));
      const isNext = matchShortcut(e, getShortcut("global.next-tab"));
      if (!isPrev && !isNext) return;
      if (!shouldHandleGlobalShortcut(e)) return;
      e.preventDefault();
      if (isPrev) prevTab();
      else nextTab();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prevTab, nextTab]);

  return {
    navigate,
    prevTab,
    nextTab,
    pendingScroll,
    requestScroll,
    consumePendingScroll,
  };
}
