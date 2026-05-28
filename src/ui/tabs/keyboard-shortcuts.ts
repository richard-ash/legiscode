// Window-level keyboard shortcuts for the tab strip. Every handler runs
// through `shouldHandleGlobalShortcut` so palette typing, file-tree
// typeahead, and future input surfaces can't be hijacked by ⌘W / ⌘1-9 /
// ⌘pgup-pgdn / ⌘shift+T.
//
// Wrap mode for ⌘pgup/⌘pgdn matches the in-tablist Left/Right arrow nav
// — both paths share semantics so users can't observe a divergence.
// Plan: `## Accessibility & responsive` line "resolves the test plan
// line 31 open question."

import { useEffect, useRef } from "react";
import type { OpenItemsState } from "@/workbench/open-items";
import { setActiveIndex } from "@/workbench/open-items";
import { shouldHandleGlobalShortcut } from "./should-handle-shortcut";

export interface TabKeyboardShortcutsParams {
  openItems: OpenItemsState;
  setOpenItems: (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => void;
  /** Close the active tab. Wraps the use-tabs `close(index)` so the
   *  recently-closed buffer push lands in the same render. */
  closeActive: () => void;
  /** Close every tab (⌘K W chord). */
  closeAll: () => void;
  /** Reopen the head of the recently-closed buffer. */
  reopenLast: () => void;
}

/** VS Code's pending-chord window — long enough for slow keystrokes,
 *  short enough that the second key feels like part of the same gesture. */
const CHORD_TIMEOUT_MS = 1500;

/**
 * Install window-level keydown handlers for the tab strip's global
 * shortcuts. Effect-style: returns no value; cleans up on unmount.
 */
export function useTabKeyboardShortcuts({
  openItems,
  setOpenItems,
  closeActive,
  closeAll,
  reopenLast,
}: TabKeyboardShortcutsParams): void {
  // Pending chord state. When the user has pressed ⌘K (the prefix),
  // `pendingChord` holds the timeout id for the auto-cancel window. The
  // next keypress either resolves the chord (⌘W → closeAll) or cancels
  // it. State lives in a ref so the keydown closure doesn't need to be
  // re-bound every render. Per T2 lock.
  const pendingChordRef = useRef<{ timeoutId: number } | null>(null);

  useEffect(() => {
    function clearPending() {
      const pending = pendingChordRef.current;
      if (pending !== null) {
        window.clearTimeout(pending.timeoutId);
        pendingChordRef.current = null;
      }
    }

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Ignore bare modifier keydowns. A real ⌘W press fires keydown
      // "Meta" (metaKey already true) THEN keydown "w"; same shape for
      // Control/Shift/Alt. Without this guard the leading "Meta" event
      // enters the chord-resolution lane below, clears the armed ⌘K
      // chord, and the trailing "w" resolves as close-active — so ⌘K ⌘W
      // closes one tab instead of all. jsdom's fireEvent never emits the
      // standalone modifier keydown, which is why only the Electron E2E
      // surfaced this.
      if (e.key === "Meta" || e.key === "Control" || e.key === "Shift" || e.key === "Alt") {
        return;
      }
      // An armed chord is cancelled by any key that isn't its modified
      // second leg. Without this, an unmodified keypress slips past the
      // `!mod` early-return below and leaves the chord armed — a later
      // ⌘W within the window would then resolve as closeAll instead of
      // closeActive, silently closing every tab.
      if (pendingChordRef.current !== null && !mod) {
        clearPending();
        return;
      }
      if (!mod) return;
      if (!shouldHandleGlobalShortcut(e)) {
        // Typing in palette / input — drop any pending chord so the next
        // ⌘W after the user dismisses the input doesn't accidentally
        // close all tabs.
        clearPending();
        return;
      }

      // Chord resolution lane — runs before single-key handlers so the
      // second leg of ⌘K W doesn't double-fire ⌘W's close-active path.
      if (pendingChordRef.current !== null) {
        clearPending();
        if (!e.shiftKey && !e.altKey && (e.key === "w" || e.key === "W")) {
          e.preventDefault();
          closeAll();
          return;
        }
        // Any other modified key cancels the chord and re-enters the
        // normal handler lane (the same keystroke can still do its own
        // thing — e.g. ⌘K → ⌘P should still open the palette).
      }

      // ⌘K — arm the chord. Stand-alone ⌘K has no binding today, so
      // arming on press is safe; the auto-cancel timer fires the chord
      // off if the user doesn't follow up within CHORD_TIMEOUT_MS.
      if (!e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        clearPending();
        const timeoutId = window.setTimeout(() => {
          pendingChordRef.current = null;
        }, CHORD_TIMEOUT_MS);
        pendingChordRef.current = { timeoutId };
        return;
      }

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
    return () => {
      window.removeEventListener("keydown", onKey);
      // Cleanup on unmount/re-bind — a pending chord across an unmount
      // would leave a dangling timeout that fires into a stale ref.
      const pending = pendingChordRef.current;
      if (pending !== null) {
        window.clearTimeout(pending.timeoutId);
        pendingChordRef.current = null;
      }
    };
  }, [openItems, setOpenItems, closeActive, closeAll, reopenLast]);
}
