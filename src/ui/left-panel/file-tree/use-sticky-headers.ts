// VSCode-style sticky ancestor headers under virtualization. Walks the
// virtualizer's currently-rendered items to find the actually-visible
// topmost row, then climbs that row's ancestor chain through the flat
// `rows` list. The ancestor list drives `<StickyHeaderStack/>`'s render.
//
// Why this isn't `virtualItems[0]`: @tanstack/react-virtual's
// `overscan: 8` config keeps ~8 rows above the viewport mounted so scroll
// reconciliation can paint them ahead of the user reaching them. The first
// rendered item therefore lags the visible viewport by up to overscan
// rows. A correct topmost-row pick must skip the off-screen overscan
// items and find the first item whose bottom edge crosses the visible
// region.
//
// The visible region's top edge is `scrollOffset + stickyStackHeight` —
// not just `scrollOffset` — because the sticky stack itself occludes
// the upper N px of the scroll container. Computing topmost relative to
// the bottom of the sticky stack means the row that "would be topmost
// if the sticky stack vanished" doesn't briefly become topmost during a
// boundary scroll, which would oscillate the sticky stack height.

import type { Virtualizer } from "@tanstack/react-virtual";
import { useMemo } from "react";
import type { Row } from "@/corpus-nav";

export interface UseStickyHeadersOptions {
  rows: readonly Row[];
  /** Reverse index `row.id → position in rows`. Used to anchor the
   *  ancestor walk in O(1). Required for the same reason rowIndexById is
   *  required elsewhere — eliminates a findIndex regression path. */
  rowIndexById: ReadonlyMap<string, number>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  useVirtualization: boolean;
  /** Current sticky stack height in px (typically `ancestors.length × 24`).
   *  Used as part of the topmost-row threshold so the calculation
   *  accounts for the stack itself occluding the viewport top edge. */
  stickyStackHeight: number;
}

const EMPTY_ANCESTORS: readonly Row[] = Object.freeze([]);

export function useStickyHeaders({
  rows,
  rowIndexById,
  virtualizer,
  useVirtualization,
  stickyStackHeight,
}: UseStickyHeadersOptions): readonly Row[] {
  // Topmost-row pick runs every render. It's cheap — at overscan=8 we walk
  // ~10-20 virtualItems max — and uncached because virtualizer's scroll
  // state changes on every render. The expensive piece (the ancestor
  // walk) lives behind the useMemo below.
  let topmostRowId: string | null = null;
  if (useVirtualization) {
    const virtualItems = virtualizer.getVirtualItems();
    const scrollOffset = virtualizer.scrollOffset ?? 0;
    const threshold = scrollOffset + stickyStackHeight;
    for (const item of virtualItems) {
      if (item.end > threshold) {
        topmostRowId = rows[item.index]?.id ?? null;
        break;
      }
    }
  }

  // Memoized on [topmostRowId, rows]. Sub-row scrolling within the
  // same topmost row hits the cache; the ancestor array reference stays
  // stable across the entire 24px scroll window for a given top row.
  // StickyHeaderStack is not React.memo'd today — the stable ancestors
  // reference still pays off because React's reconciler diffs the
  // rendered subtree against the previous one and bails out when
  // children are referentially equal.
  return useMemo(() => {
    if (topmostRowId === null) return EMPTY_ANCESTORS;
    return computeAncestors(rows, rowIndexById, topmostRowId);
  }, [topmostRowId, rows, rowIndexById]);
}

// Walk back through `rows` from the topmost row, collecting one row per
// strictly-lower depth level. visibleRows() guarantees ancestors precede
// descendants in the flat list and that depth strictly decreases at each
// parent, so a single linear sweep is sufficient — no tree traversal.
function computeAncestors(
  rows: readonly Row[],
  rowIndexById: ReadonlyMap<string, number>,
  topmostRowId: string,
): readonly Row[] {
  const idx = rowIndexById.get(topmostRowId);
  if (idx === undefined) return EMPTY_ANCESTORS;
  const topmost = rows[idx];
  if (!topmost) return EMPTY_ANCESTORS;
  if (topmost.depth === 0) return EMPTY_ANCESTORS;
  const stack: Row[] = [];
  let targetDepth = topmost.depth - 1;
  for (let i = idx - 1; i >= 0 && targetDepth >= 0; i--) {
    const row = rows[i];
    if (row && row.depth === targetDepth) {
      stack.push(row);
      targetDepth--;
    }
  }
  // Reverse to root-down order so the rendered stack reads naturally
  // from the user's perspective (outermost ancestor on top).
  return stack.reverse();
}
