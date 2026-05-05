// Phase-1 structure tree (D2). Renders the chrome.jsx Tree pattern against
// real corpus data — code → chapter → section. No pending-amendment dots,
// no PendingOrdsPanel drawer (those are feat/ordinance-ingestion). Active
// section highlights via `is-active`; click to navigate.
//
// Replaced wholesale by feat/file-tree (Phase 2) which adds the search-box
// wiring, pending dots, ordinances-mode panel, and chapter-roll-up indicators.
// Don't add features here — extend the wire shape in CorpusTreeNode instead.

import { type ReactNode, useState } from "react";
import type { CorpusTreeNode } from "../../../electron/ipc/contract";
import { Icons } from "@/ui/icons";

export interface StructureTreeProps {
  nodes: readonly CorpusTreeNode[];
  active: { moduleId: string; sectionId: string } | null;
  onSelect: (ref: { moduleId: string; sectionId: string }) => void;
}

export function StructureTree({ nodes, active, onSelect }: StructureTreeProps) {
  return (
    <div className="lc-tree lc-scroll" role="tree">
      {nodes.map((n) => (
        <TreeRow key={n.id} node={n} depth={0} active={active} onSelect={onSelect} />
      ))}
    </div>
  );
}

interface RowProps {
  node: CorpusTreeNode;
  depth: number;
  active: StructureTreeProps["active"];
  onSelect: StructureTreeProps["onSelect"];
}

function TreeRow({ node, depth, active, onSelect }: RowProps): ReactNode {
  const hasKids = !!(node.kids && node.kids.length > 0);
  // Phase-1 stub: auto-expand the top two levels (codes + chapters) so first
  // launch matches the populated mockup state. feat/file-tree (Phase 2) wires
  // up persisted expand/collapse state via the search-box flow.
  const [open, setOpen] = useState(depth <= 1);

  const isActiveSection =
    node.kind === "section" &&
    node.ref &&
    active &&
    active.moduleId === node.ref.moduleId &&
    active.sectionId === node.ref.sectionId;

  const onClick = () => {
    if (hasKids) {
      setOpen((o) => !o);
    } else if (node.kind === "section" && node.ref) {
      onSelect(node.ref);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={hasKids ? open : undefined}
        aria-selected={isActiveSection ? true : undefined}
        tabIndex={0}
        className={`lc-tree-row ${isActiveSection ? "is-active" : ""}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span
          className={`lc-tree-chevron ${hasKids ? "" : "is-leaf"} ${open ? "is-open" : ""}`}
          aria-hidden
        >
          <Icons.Chevron size={10} />
        </span>
        <span className="lc-tree-ico" aria-hidden>
          {hasKids ? (
            open ? (
              <Icons.FolderOpen
                size={14}
                color={isActiveSection ? "var(--blue)" : "var(--overlay1)"}
              />
            ) : (
              <Icons.Folder size={14} color="var(--overlay1)" />
            )
          ) : (
            <Icons.Section size={13} color={isActiveSection ? "var(--blue)" : "var(--overlay0)"} />
          )}
        </span>
        <span className="lc-tree-label">
          <code>{node.code}</code>
          {node.name}
        </span>
      </div>
      {hasKids && open
        ? node.kids?.map((k) => (
            <TreeRow key={k.id} node={k} depth={depth + 1} active={active} onSelect={onSelect} />
          ))
        : null}
    </>
  );
}
