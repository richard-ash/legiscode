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
 * Estimated row height in px. Mirrors `.lc-tree-row { height: 24px }`
 * in globals.css — keep in sync. The virtualizer measures actual heights
 * at runtime; this only seeds the initial total-size estimate.
 */
const ROW_HEIGHT_PX = 24;

export interface UseTreeVirtualizerResult {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** True when row count crosses the JSDOM guard — caller renders the
   * virtualized branch; false means render every row directly. */
  useVirtualization: boolean;
}

export function useTreeVirtualizer(
  rows: readonly Row[],
  containerRef: RefObject<HTMLDivElement | null>,
): UseTreeVirtualizerResult {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  return {
    virtualizer,
    useVirtualization: rows.length > JSDOM_GUARD_ROW_COUNT,
  };
}
