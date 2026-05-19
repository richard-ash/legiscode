// VSCode-style sticky ancestor headers. Rendered inside the scrolling
// container above the virtualizer's height-spacer, with `position:
// sticky; top: 0` (D1). The browser handles all pinning math against
// the nearest scrolling ancestor — no getBoundingClientRect probes, no
// panel-resize subscriptions, no manual scroll listeners.
//
// AT semantics (D3 belt-and-suspenders):
//   - Wrapper carries aria-hidden="true" so the entire stack is
//     skipped by screen readers.
//   - Each sticky row carries role="presentation" so even if a future
//     change drops the wrapper aria-hidden, the sticky copies still
//     don't double-announce the real treeitem rows.
//   - Real treeitems remain the only AT navigation target.
//
// Click semantics — matches VSCode's sticky scroll model:
//   - Click on the CHEVRON region of a sticky row → collapse that
//     ancestor (onCollapse). The row itself stays visible: collapsing
//     shrinks the rows list, browser clamps scrollTop, and the topmost-
//     row pick re-computes. The ancestor either remains pinned (if
//     still above the new viewport top) or becomes a regular row at
//     the top of the visible band.
//   - Click anywhere ELSE on a sticky row → scrolls the real row into
//     view and focuses it (onStickyClick). Reading-context preserving:
//     the ancestor's expansion state is untouched.
//
// The earlier design (D2) routed every sticky click to the scroll path
// because the existing onClickRow handler would have collapsed the
// ancestor unconditionally — wrong for label clicks. Splitting by
// click target gives the user both behaviors and matches the mental
// model from VSCode / Finder column headers.
//
// After scrollToIndex(align:"start") in the scroll path, the row's top
// edge aligns to the scroll container's top — which is occluded by the
// new (smaller) sticky stack. We follow with scrollBy(-destHeight) so
// the clicked row lands flush against the bottom of the new stack
// (D15). Destination height = clickedRow.depth × 24px, because the
// clicked row becomes the new topmost row and its ancestors fill
// depths 0..D-1.

import type { Virtualizer } from "@tanstack/react-virtual";
import { type MouseEvent, type RefObject, useCallback } from "react";
import type { Row } from "@/corpus-nav";
import { rowPaddingLeft, TreeRowContent } from "./tree-row-content";
import { TREE_ROW_HEIGHT_PX } from "./use-tree-virtualizer";

export interface StickyHeaderStackProps {
  ancestors: readonly Row[];
  rowIndexById: ReadonlyMap<string, number>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Fired when the user clicks the chevron region of a sticky row.
   *  Container collapses the ancestor; the row remains in `rows`
   *  because tree-model `collapse` only hides descendants. */
  onCollapse: (ancestorId: string) => void;
  /** Called after the scroll math completes. The container component
   *  typically wires this to `requestFocus(ancestorId)` so the real row
   *  picks up roving focus (via pendingFocusRowRef if the real row was
   *  virtualized out at click time — the existing useRovingFocus
   *  mechanism handles the next-mount claim). */
  onStickyClick: (ancestorId: string) => void;
}

export function StickyHeaderStack({
  ancestors,
  rowIndexById,
  virtualizer,
  containerRef,
  onCollapse,
  onStickyClick,
}: StickyHeaderStackProps) {
  const handleClick = useCallback(
    (clickedRow: Row, event: MouseEvent<HTMLDivElement>) => {
      // Chevron-click → collapse the ancestor. Target may be the
      // chevron span itself, the SVG inside, or any nested path —
      // `closest` handles every case.
      const target = event.target;
      if (target instanceof Element && target.closest(".lc-tree-chevron")) {
        onCollapse(clickedRow.id);
        return;
      }
      const idx = rowIndexById.get(clickedRow.id);
      if (idx === undefined) return;
      const destStickyHeight = clickedRow.depth * TREE_ROW_HEIGHT_PX;
      virtualizer.scrollToIndex(idx, { align: "start" });
      containerRef.current?.scrollBy({ top: -destStickyHeight });
      onStickyClick(clickedRow.id);
    },
    [rowIndexById, virtualizer, containerRef, onCollapse, onStickyClick],
  );

  if (ancestors.length === 0) return null;

  return (
    <div className="lc-tree-sticky-stack" aria-hidden="true">
      {ancestors.map((row) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: sticky rows are aria-hidden presentation copies; the real treeitem rows beneath own keyboard handling
        // biome-ignore lint/a11y/noStaticElementInteractions: same — role=presentation reflects the AT-invisible nature of these copies, and the click handler is the documented UX for sticky-header navigation
        <div
          key={row.id}
          role="presentation"
          className="lc-tree-row lc-tree-sticky-row"
          style={{ paddingLeft: rowPaddingLeft(row) }}
          onClick={(e) => handleClick(row, e)}
        >
          <TreeRowContent row={row} isActive={false} />
        </div>
      ))}
    </div>
  );
}
