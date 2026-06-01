// Shared visual primitive for a single tree row's inner content. Two
// consumers compose it (D5):
//   TreeNode             — wraps with role=treeitem + ref + onClick +
//                          focus state for AT navigation.
//   StickyHeaderStack    — wraps with role=presentation +
//                          sticky-click dispatcher; pinned copies of
//                          ancestor rows under virtualization.
//
// Both wrappers carry the row's depth-padding via `rowPaddingLeft(row)`,
// so the magic `10 + row.depth * 12` lives in exactly one place. Future
// DESIGN.md changes to chevron / icon / label visuals propagate to both
// consumers automatically.

import type { Row } from "@/corpus-nav";
import { Icons } from "@/ui/icons";

export interface TreeRowContentProps {
  row: Row;
  /** Active row drives the chevron + icon color variants and the label
   *  treatment downstream via CSS on the outer wrapper. */
  isActive: boolean;
}

/** Single source of truth for tree-row depth indent. Both treeitem and
 *  sticky-row wrappers apply this on their outer `style.paddingLeft`. */
export function rowPaddingLeft(row: Row): number {
  return 10 + row.depth * 12;
}

export function TreeRowContent({ row, isActive }: TreeRowContentProps) {
  const node = row.node;
  const leafIcon = <Icons.Section size={13} color={isActive ? "var(--blue)" : "var(--overlay0)"} />;
  return (
    <>
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
          leafIcon
        )}
      </span>
      <span className="lc-tree-label">
        {node.code ? <code>{node.code}</code> : null}
        {node.name}
      </span>
    </>
  );
}
