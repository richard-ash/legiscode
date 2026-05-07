// Pure (event, state) → action translator for tree keyboard nav. The
// container component (file-tree.tsx) wires the result to expansion-state
// mutators, focus updates, and workbench dispatch. The translation is
// intentionally pure so unit tests don't need jsdom or React.
//
// Behaviour follows the WAI-ARIA tree-spec MUST set with two additions:
// Cmd/Ctrl+Enter activates "open without switching" instead of plain
// activate; and printable single-character keys are routed to typeahead
// via use-typeahead.ts (the container splits typeahead off from this
// dispatch before calling here).

import type { CorpusRef } from "@/corpus/refs";
import type { Row } from "./visible-rows";

export type Action =
  | { type: "none" }
  | { type: "focus"; rowId: string }
  | { type: "toggle-expand"; rowId: string }
  | { type: "expand"; rowId: string }
  | { type: "collapse"; rowId: string }
  | { type: "activate"; ref: CorpusRef }
  | { type: "open-without-switch"; ref: CorpusRef };

export interface KeyboardState {
  rows: readonly Row[];
  focusedRowId: string | null;
}

interface KeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const NONE: Action = { type: "none" };

export function keyboardAction(event: KeyEvent, state: KeyboardState): Action {
  if (state.rows.length === 0) return NONE;
  const focusedIdx = focusedIndex(state);
  const focused = focusedIdx >= 0 ? state.rows[focusedIdx] : undefined;
  const openModifier = event.metaKey === true || event.ctrlKey === true;

  switch (event.key) {
    case "ArrowDown": {
      if (focusedIdx < 0) return focusFirst(state);
      const nextRow = state.rows[focusedIdx + 1];
      if (!nextRow) return NONE;
      return { type: "focus", rowId: nextRow.id };
    }
    case "ArrowUp": {
      if (focusedIdx <= 0) return NONE;
      const prevRow = state.rows[focusedIdx - 1];
      if (!prevRow) return NONE;
      return { type: "focus", rowId: prevRow.id };
    }
    case "Home":
      return focusFirst(state);
    case "End": {
      const last = state.rows[state.rows.length - 1];
      if (!last) return NONE;
      return { type: "focus", rowId: last.id };
    }
    case "ArrowRight": {
      if (!focused) return NONE;
      if (!focused.hasKids) return NONE;
      if (!focused.isExpanded) return { type: "expand", rowId: focused.id };
      // Already expanded — descend to first child (next row at greater depth).
      const child = state.rows[focusedIdx + 1];
      if (!child || child.depth <= focused.depth) return NONE;
      return { type: "focus", rowId: child.id };
    }
    case "ArrowLeft": {
      if (!focused) return NONE;
      if (focused.hasKids && focused.isExpanded) {
        return { type: "collapse", rowId: focused.id };
      }
      // Walk back to the parent (first prior row whose depth is one less).
      for (let i = focusedIdx - 1; i >= 0; i--) {
        const candidate = state.rows[i];
        if (candidate && candidate.depth === focused.depth - 1) {
          return { type: "focus", rowId: candidate.id };
        }
      }
      return NONE;
    }
    case "Enter":
    case " ": {
      if (!focused) return NONE;
      if (focused.hasKids) {
        if (openModifier) return NONE; // explicit > clever
        return { type: "toggle-expand", rowId: focused.id };
      }
      if (focused.ref === null) return NONE;
      return openModifier
        ? { type: "open-without-switch", ref: focused.ref }
        : { type: "activate", ref: focused.ref };
    }
    default:
      return NONE;
  }
}

function focusedIndex(state: KeyboardState): number {
  if (state.focusedRowId === null) return -1;
  for (let i = 0; i < state.rows.length; i++) {
    if (state.rows[i]?.id === state.focusedRowId) return i;
  }
  return -1;
}

function focusFirst(state: KeyboardState): Action {
  const first = state.rows[0];
  if (!first) return NONE;
  return { type: "focus", rowId: first.id };
}
