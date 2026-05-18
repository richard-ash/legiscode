// Single tree row. Pure presentation; the container owns focus,
// expansion, and click semantics. `tabIndex` is driven by the
// container's roving-tabindex (only one row at a time carries 0).
// `data-open` is set for openItems entries that aren't currently active
// — reserved for a tab-strip styling slot, still inert today.
//
// React.memo + stable callbacks keep this row inert when other rows'
// state changes — load-bearing under virtualization where per-click
// reconciliation would otherwise touch every visible row.

import { type CSSProperties, type MouseEvent, memo } from "react";
import type { Row } from "@/corpus-nav";
import { rowPaddingLeft, TreeRowContent } from "./tree-row-content";

export interface TreeNodeProps {
  row: Row;
  isFocused: boolean;
  isActive: boolean;
  isOpen: boolean;
  /** Stable container-level dispatcher; receives row id + the click event. */
  onClickRow: (rowId: string, e: MouseEvent<HTMLDivElement>) => void;
  /** Stable container-level ref registrar; receives row id + the DOM node (or null on unmount). */
  registerRowRef: (rowId: string, el: HTMLDivElement | null) => void;
  /** Optional absolute-position style applied by the virtualizer wrapper. */
  style?: CSSProperties;
}

function TreeNodeImpl({
  row,
  isFocused,
  isActive,
  isOpen,
  onClickRow,
  registerRowRef,
  style,
}: TreeNodeProps) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: tree row keyboard handling lives on the container per the WAI-ARIA roving-tabindex pattern
    <div
      ref={(el) => registerRowRef(row.id, el)}
      role="treeitem"
      aria-selected={isActive ? true : undefined}
      aria-expanded={row.hasKids ? row.isExpanded : undefined}
      aria-level={row.depth + 1}
      aria-posinset={row.siblingPos}
      aria-setsize={row.siblingSize}
      tabIndex={isFocused ? 0 : -1}
      data-open={isOpen ? true : undefined}
      data-row-id={row.id}
      data-testid={`tree-row-${row.id}`}
      className={`lc-tree-row ${isActive ? "is-active" : ""}`}
      style={{ ...style, paddingLeft: rowPaddingLeft(row) }}
      onClick={(e) => onClickRow(row.id, e)}
    >
      <TreeRowContent row={row} isActive={isActive} />
    </div>
  );
}

export const TreeNode = memo(TreeNodeImpl);
