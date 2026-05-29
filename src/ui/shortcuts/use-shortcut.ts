// Window-level binding for a single catalog shortcut. The "useShortcut"
// refactor pattern (one of three — alongside the window-matcher in
// tabs/keyboard-shortcuts.ts and the pure dispatcher in corpus-nav):
// component declares the catalog id, the hook owns event matching +
// preventDefault + the global typing-surface guard so each callsite
// shrinks to one line.
//
// Global only. ⌘P deliberately bypasses the guard (it is the palette's
// own toggle) and stays a bespoke handler; chords need the stateful
// pending-key handler in keyboard-shortcuts.ts. Both still carry a
// catalog id so their displayed labels can't drift.

import { useEffect } from "react";
import { shouldHandleGlobalShortcut } from "@/ui/tabs/should-handle-shortcut";
import { getShortcut, matchShortcut, type ShortcutId } from "./registry";

/**
 * Fire `callback` when the catalog shortcut `id` is pressed at the window
 * level, gated by `shouldHandleGlobalShortcut` so palette typing and
 * input focus never get hijacked. preventDefault runs on match.
 */
export function useShortcut(id: ShortcutId, callback: () => void): void {
  useEffect(() => {
    const shortcut = getShortcut(id);
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut(e, shortcut)) return;
      if (!shouldHandleGlobalShortcut(e)) return;
      e.preventDefault();
      callback();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, callback]);
}
