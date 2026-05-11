// Window-level keyboard shortcuts for the tab strip. Every handler runs
// through `shouldHandleGlobalShortcut` so palette typing, file-tree
// typeahead, and future input surfaces can't be hijacked by ⌘W / ⌘1-9 /
// ⌘pgup-pgdn / ⌘shift+T.
//
// Wrap mode for ⌘pgup/⌘pgdn matches the in-tablist Left/Right arrow nav
// — both paths share semantics so users can't observe a divergence.
// Plan: `## Accessibility & responsive` line "resolves the test plan
// line 31 open question."

import { useEffect } from "react";
import type { OpenItemsState } from "@/workbench/open-items";
import { setActiveIndex } from "@/workbench/open-items";
import { shouldHandleGlobalShortcut } from "./should-handle-shortcut";

export interface TabKeyboardShortcutsParams {
  openItems: OpenItemsState;
  setOpenItems: (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => void;
  /** Close the active tab. Wraps the use-tabs `close(index)` so the
   *  recently-closed buffer push lands in the same render. */
  closeActive: () => void;
  /** Reopen the head of the recently-closed buffer. */
  reopenLast: () => void;
}

/**
 * Install window-level keydown handlers for the tab strip's global
 * shortcuts. Effect-style: returns no value; cleans up on unmount.
 */
export function useTabKeyboardShortcuts({
  openItems,
  setOpenItems,
  closeActive,
  reopenLast,
}: TabKeyboardShortcutsParams): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (!shouldHandleGlobalShortcut(e)) return;

      // ⌘shift+T — reopen most recently closed.
      if (e.shiftKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        reopenLast();
        return;
      }

      // ⌘W — close active.
      if (!e.shiftKey && !e.altKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        closeActive();
        return;
      }

      // ⌘1..⌘9 — jump to tab by index (1-based; 9 jumps to last per VS Code).
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const digit = Number.parseInt(e.key, 10);
        const len = openItems.items.length;
        if (len === 0) return;
        e.preventDefault();
        const target = digit === 9 ? len - 1 : Math.min(digit - 1, len - 1);
        setOpenItems((prev) => setActiveIndex(prev, target));
        return;
      }

      // ⌘PageDown / ⌘PageUp — wrap.
      if (e.key === "PageDown" || e.key === "PageUp") {
        const len = openItems.items.length;
        if (len === 0) return;
        e.preventDefault();
        setOpenItems((prev) => {
          if (prev.activeIndex === null) return setActiveIndex(prev, 0);
          const delta = e.key === "PageDown" ? 1 : -1;
          const next = (prev.activeIndex + delta + len) % len;
          return setActiveIndex(prev, next);
        });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openItems, setOpenItems, closeActive, reopenLast]);
}
