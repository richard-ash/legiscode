// Shared guard for window-level keydown handlers. Returns false when the
// active element is somewhere the shortcut should NOT fire — inside a
// dialog (the command palette), inside a typing surface (input / textarea
// / contenteditable). Every `cmd/ctrl + key` handler in the renderer
// passes the event through this guard so palette typing, tree filter
// boxes, etc. don't get hijacked by ⌘1 / ⌘W / ⌘B / ⌘P.
//
// Plan A2. Closes F-palette in TODOS.md without doing #10's full
// command-registry rewrite.

/**
 * `true` if the global shortcut should be allowed to fire for this event.
 * `false` if the active element captures typing — leave the event alone.
 */
export function shouldHandleGlobalShortcut(_e: KeyboardEvent): boolean {
  const target = typeof document === "undefined" ? null : document.activeElement;
  if (!target) return true;
  if (target.closest("[role=dialog]")) return false;
  if (target instanceof HTMLInputElement) return false;
  if (target instanceof HTMLTextAreaElement) return false;
  const el = target as HTMLElement;
  if (typeof el.isContentEditable === "boolean" && el.isContentEditable) return false;
  return true;
}
