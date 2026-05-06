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
import { Icons } from "@/ui/icons";

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
  const node = row.node;
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
      style={{ ...style, paddingLeft: 10 + row.depth * 12 }}
      onClick={(e) => onClickRow(row.id, e)}
    >
      <span
        className={`lc-tree-chevron ${row.hasKids ? "" : "is-leaf"} ${row.isExpanded ? "is-open" : ""}`}
        aria-hidden
      >
        <Icons.Chevron size={10} />
      </span>
      <span className="lc-tree-ico" aria-hidden>
        {row.hasKids ? (
          row.isExpanded ? (
            <Icons.FolderOpen size={14} color={isActive ? "var(--blue)" : "var(--overlay1)"} />
          ) : (
            <Icons.Folder size={14} color="var(--overlay1)" />
          )
        ) : (
          <Icons.Section size={13} color={isActive ? "var(--blue)" : "var(--overlay0)"} />
        )}
      </span>
      <span className="lc-tree-label">
        <code>{node.code}</code>
        {node.name}
      </span>
    </div>
  );
}

export const TreeNode = memo(TreeNodeImpl);
