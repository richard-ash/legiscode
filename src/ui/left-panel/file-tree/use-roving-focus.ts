// Roving-tabindex focus management for the file tree. The WAI-ARIA tree
// spec requires exactly one row to carry tabIndex=0 at any time so the
// region participates in the page's tab order without trapping focus.
// Moving focus *between* rows happens imperatively, not through tab —
// arrow keys, Home/End, typeahead, click — and that imperative driving
// is what this hook owns.
//
// The pending-focus pattern (`pendingFocusRowRef`) handles the
// virtualized case: keyboard nav can target a row that is not currently
// in the DOM. We remember the request and `registerRowRef` consumes it
// on the next mount, calling .focus() then.

import type { Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { equals as refsEqual } from "@/corpus/refs";
import type { Row } from "@/corpus-nav";
import { activeSectionRef, type OpenItemsState } from "@/workbench";

export interface UseRovingFocusOptions {
  rows: readonly Row[];
  /** Reverse index `row.id → position in rows`. REQUIRED; used for
   * the pending-focus visibility check and the scroll-into-view
   * index lookup so neither path falls back to a per-render
   * `findIndex` scan. */
  rowIndexById: ReadonlyMap<string, number>;
  openItems: OpenItemsState;
  containerRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  useVirtualization: boolean;
}

export interface UseRovingFocusResult {
  focusedRowId: string | null;
  setFocusedRowId: (id: string | null) => void;
  /** TreeNode passes (id, el | null) on mount/unmount; consumes pending
   *  focus requests for virtualized-out rows. Stable identity. */
  registerRowRef: (id: string, el: HTMLDivElement | null) => void;
  /** Imperative focus request from the keyboard handler / typeahead.
   *  Focuses the row's element if mounted; otherwise schedules focus
   *  for the next mount under virtualization. */
  requestFocus: (id: string) => void;
}

export function useRovingFocus({
  rows,
  rowIndexById,
  openItems,
  containerRef,
  virtualizer,
  useVirtualization,
}: UseRovingFocusOptions): UseRovingFocusResult {
  const [focusedRowId, setFocusedRowId] = useState<string | null>(() =>
    initialFocus(rows, openItems),
  );

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFocusRowRef = useRef<string | null>(null);
  const useVirtualizationRef = useRef(useVirtualization);
  useVirtualizationRef.current = useVirtualization;

  // Two responsibilities, both keyed to visible-row changes:
  // (1) Keep focusedRowId in sync with the visible row set — if the
  //     focused row disappears (collapse, filter), fall back to the
  //     active row or the first row.
  // (2) F-pendingFocus: drop the stash if its target id is no longer in
  //     the visible set. Without this, a stash set by keyboard nav into a
  //     virtualized-out row — then orphaned when the user collapsed the
  //     parent before the row mounted — would steal focus when an
  //     unrelated row at the same id remounts later in a different
  //     ancestor chain (rare but possible across collapse/expand cycles).
  useEffect(() => {
    if (focusedRowId !== null && !rowIndexById.has(focusedRowId)) {
      const next = initialFocus(rows, openItems);
      if (next !== focusedRowId) setFocusedRowId(next);
    }
    const pending = pendingFocusRowRef.current;
    if (pending !== null && !rowIndexById.has(pending)) {
      pendingFocusRowRef.current = null;
    }
  }, [rows, openItems, focusedRowId, rowIndexById]);

  // Scroll the focused row into view when virtualizing — keeps the row's
  // DOM node mounted so roving tabindex stays reachable. `align: "auto"`
  // is a no-op when the row is already in the visible window.
  useEffect(() => {
    if (!useVirtualization) return;
    if (focusedRowId === null) return;
    const idx = rowIndexById.get(focusedRowId) ?? -1;
    if (idx < 0) return;
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [focusedRowId, rowIndexById, useVirtualization, virtualizer]);

  // Drive focus to the focused row's element when focus is already
  // somewhere in the tree. Skip when focus is elsewhere (palette, search
  // box) so we don't steal it on incidental state updates.
  const focusedRowIdRef = useRef(focusedRowId);
  useEffect(() => {
    const prev = focusedRowIdRef.current;
    focusedRowIdRef.current = focusedRowId;
    if (focusedRowId === null) return;
    if (focusedRowId === prev) return;
    const rowEl = rowRefs.current.get(focusedRowId);
    const active = document.activeElement;
    const focusIsInTree =
      (active instanceof HTMLElement && containerRef.current?.contains(active)) === true;
    if (!focusIsInTree) return;
    if (rowEl) {
      rowEl.focus();
    } else if (useVirtualization) {
      pendingFocusRowRef.current = focusedRowId;
    }
  }, [focusedRowId, useVirtualization, containerRef]);

  // Stable across renders — TreeNode is React.memo'd and changing this
  // identity would invalidate every row.
  const registerRowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      rowRefs.current.set(id, el);
      if (pendingFocusRowRef.current === id) {
        pendingFocusRowRef.current = null;
        el.focus();
      }
    } else {
      rowRefs.current.delete(id);
    }
  }, []);

  // Stable focus-by-id for the keyboard / typeahead path. Uses the
  // virtualization flag through a ref so identity does not flip when
  // the row count crosses the JSDOM guard at runtime.
  const requestFocus = useCallback((id: string) => {
    const el = rowRefs.current.get(id);
    if (el) el.focus();
    else if (useVirtualizationRef.current) pendingFocusRowRef.current = id;
  }, []);

  return { focusedRowId, setFocusedRowId, registerRowRef, requestFocus };
}

function initialFocus(rows: readonly Row[], openItems: OpenItemsState): string | null {
  const activeRef = activeSectionRef(openItems);
  if (activeRef !== null) {
    for (const row of rows) {
      if (row.ref !== null && refsEqual(row.ref, activeRef)) return row.id;
    }
  }
  return rows[0]?.id ?? null;
}
