// Wraps @tanstack/react-virtual for the file tree. Two outputs the
// container actually consumes: the virtualizer instance (for scroll +
// getVirtualItems + getTotalSize) and a `useVirtualization` flag that
// gates the rendering branch. The flag is true above the
// JSDOM_GUARD_ROW_COUNT — see file-tree.tsx for why the threshold
// exists at all.

import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";
import type { Row } from "@/corpus-nav";

/**
 * Row count below which we render every row directly. JSDOM-guard, not
 * a perf threshold: jsdom reports zero layout, so a virtualized tree
 * under jsdom would render no rows and break unit tests. Real corpora
 * (SF Municipal: ~12k rows expanded) always cross this; test fixtures
 * never do.
 */
export const JSDOM_GUARD_ROW_COUNT = 200;

/**
 * Single source of truth for tree row height. Mirrors
 * `.lc-tree-row { height: 24px }` in globals.css. Three call-sites
 * depend on this exact value being equal across files (file-tree.tsx
 * for translateY math, sticky-header-stack.tsx for destination-depth
 * scroll math, this file for the virtualizer's size estimate). The
 * virtualizer measures actual heights at runtime; the constant only
 * seeds the initial estimate.
 */
export const TREE_ROW_HEIGHT_PX = 24;

export interface UseTreeVirtualizerOptions {
  /** Height in px of any content pinned to the top of the scroll
   *  container (today: the sticky ancestor stack). Threads through
   *  to `useVirtualizer({ scrollMargin })` so `scrollToIndex` with
   *  `align: "auto"` lands focused rows below the pinned content,
   *  not behind it. Defaults to 0.
   *
   *  PAIRED WITH translateY MATH:
   *
   *      visible viewport
   *      ┌─────────────────────┐
   *      │ sticky stack (sM)   │ ← scrollMargin "reserves" this band
   *      ├─────────────────────┤   from the virtualizer's geometry
   *      │ row vItem.start=0   │
   *      │ row vItem.start=24  │   render math:
   *      │ row vItem.start=48  │     translateY(vItem.start - sM)
   *      └─────────────────────┘
   *
   *  Without the subtraction, every row sits `sM` pixels lower than it
   *  should and the entire list visually shifts down by the sticky
   *  stack's height. The container must apply both changes in the same
   *  frame; partial application is a bug. */
  scrollMargin?: number;
}

export interface UseTreeVirtualizerResult {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** True when row count crosses the JSDOM guard — caller renders the
   * virtualized branch; false means render every row directly. */
  useVirtualization: boolean;
}

export function useTreeVirtualizer(
  rows: readonly Row[],
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseTreeVirtualizerOptions = {},
): UseTreeVirtualizerResult {
  const scrollMargin = options.scrollMargin ?? 0;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => TREE_ROW_HEIGHT_PX,
    overscan: 8,
    scrollMargin,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  return {
    virtualizer,
    useVirtualization: rows.length > JSDOM_GUARD_ROW_COUNT,
  };
}
