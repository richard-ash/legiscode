// Layer 5 — file-tree container. Binds Layer 3 (corpus-nav primitives)
// and Layer 4 (workbench openItems) to React. Implements the WAI-ARIA
// tree role with roving tabindex, Cmd/Ctrl-click for "open without
// switching", and typeahead jumps.
//
// Composition:
//   useCorpusTree           — expansion state + visible rows
//   useTypeahead            — printable-key buffer with timeout decay
//   useTreeVirtualizer      — @tanstack/react-virtual + JSDOM guard
//   useRovingFocus          — focused-row state + the 3 focus effects
//
// What stays inline here: the click dispatcher, the keyboard switch
// (typeahead path + keyboardAction dispatch), and the active/open
// derivation. Render pass: empty / virtualized / direct branches.

import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { type CorpusRef, equals as refsEqual, hash as refHash } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import { collapse, expand, keyboardAction, prefixMatch, type Row, toggle } from "@/corpus-nav";
import { activeSectionRef, type OpenItemsState } from "@/workbench";
import { TreeNode } from "./tree-node";
import { useCorpusTree } from "./use-corpus-tree";
import { useRovingFocus } from "./use-roving-focus";
import { useTreeVirtualizer } from "./use-tree-virtualizer";
import { useTypeahead } from "./use-typeahead";

export interface FileTreeProps {
  tree: readonly CorpusTreeNode[];
  openItems: OpenItemsState;
  onActivate: (ref: CorpusRef) => void;
  onOpenWithoutSwitching: (ref: CorpusRef) => void;
}

export function FileTree({ tree, openItems, onActivate, onOpenWithoutSwitching }: FileTreeProps) {
  const { setExpansion, rows } = useCorpusTree(tree);
  // Pull stable functions out of useTypeahead. The hook returns a fresh
  // object literal each render, so depending on `typeahead` itself in any
  // useCallback would flip identity per render. The individual callbacks
  // ARE stable, so dep on them.
  const { appendChar: typeaheadAppendChar, reset: resetTypeahead } = useTypeahead();

  const containerRef = useRef<HTMLDivElement>(null);
  const { virtualizer, useVirtualization } = useTreeVirtualizer(rows, containerRef);
  const { focusedRowId, setFocusedRowId, registerRowRef, requestFocus } = useRovingFocus({
    rows,
    openItems,
    containerRef,
    virtualizer,
    useVirtualization,
  });

  // Latest `rows` accessible to event handlers without invalidating their
  // identity. Without this, onClickRow's `rows` dep would flip the
  // callback every expansion, which defeats React.memo on TreeNode for
  // the most common interaction (clicking parents to expand/collapse).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Stable click dispatcher. Reads the latest rows through `rowsRef` so
  // the callback identity does not flip when expansion changes — that
  // keeps React.memo on TreeNode effective for focus-only renders.
  const onClickRow = useCallback(
    (rowId: string, e: MouseEvent<HTMLDivElement>) => {
      const row = rowsRef.current.find((r) => r.id === rowId);
      if (!row) return;
      const openMod = e.metaKey || e.ctrlKey;
      if (row.hasKids) {
        setExpansion((prev) => toggle(prev, row.id));
      } else if (row.ref !== null) {
        if (openMod) onOpenWithoutSwitching(row.ref);
        else onActivate(row.ref);
      }
      setFocusedRowId(row.id);
      resetTypeahead();
    },
    [setExpansion, setFocusedRowId, onActivate, onOpenWithoutSwitching, resetTypeahead],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Typeahead path — printable single chars without modifiers, but
      // not Space/Enter (those drive activation/toggle via keyboardAction).
      if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const buffer = typeaheadAppendChar(e.key);
        const predicate = prefixMatch(buffer);
        const focusedIdx = rows.findIndex((r) => r.id === focusedRowId);
        const startAt = focusedIdx + 1;
        // For an extending buffer (length > 1), include the currently focused
        // row in the search so the user's existing match continues to satisfy
        // the longer prefix.
        const probe = buffer.length > 1 ? Math.max(focusedIdx, 0) : startAt;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[(probe + i) % rows.length];
          if (row && predicate(row.node)) {
            setFocusedRowId(row.id);
            requestFocus(row.id);
            break;
          }
        }
        e.preventDefault();
        return;
      }

      const action = keyboardAction(e, { rows, focusedRowId });
      switch (action.type) {
        case "none":
          return;
        case "focus":
          setFocusedRowId(action.rowId);
          requestFocus(action.rowId);
          break;
        case "toggle-expand":
          setExpansion((prev) => toggle(prev, action.rowId));
          break;
        case "expand":
          setExpansion((prev) => expand(prev, action.rowId));
          break;
        case "collapse":
          setExpansion((prev) => collapse(prev, action.rowId));
          break;
        case "activate":
          onActivate(action.ref);
          break;
        case "open-without-switch":
          onOpenWithoutSwitching(action.ref);
          break;
      }
      e.preventDefault();
    },
    [
      rows,
      focusedRowId,
      setExpansion,
      setFocusedRowId,
      onActivate,
      onOpenWithoutSwitching,
      typeaheadAppendChar,
      requestFocus,
    ],
  );

  // Precompute the active ref + the open-row id lookup once per render
  // rather than per-row inside the map below.
  const { activeRef, openSectionIds } = useMemo(() => {
    const active = activeSectionRef(openItems);
    const openIds = new Set<string>();
    for (const item of openItems.items) {
      if (item.kind === "section") openIds.add(refHash(item.ref));
    }
    return { activeRef: active, openSectionIds: openIds };
  }, [openItems]);

  // Drop the typeahead buffer when focus leaves the tree subtree; without
  // this, returning to the tree within timeoutMs reuses the stale prefix
  // (e.g. user typed "Co" → clicked the palette → returned and pressed
  // "mm" expecting fresh input → typeahead jumps to "Comm" not "mm"). Hook
  // sits above the empty-state early return to satisfy Rules of Hooks.
  const onBlurContainer = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const next = e.relatedTarget;
      if (next instanceof Node && e.currentTarget.contains(next)) return;
      resetTypeahead();
    },
    [resetTypeahead],
  );

  if (rows.length === 0) {
    // Intentional empty state — keep the tree role + label so assistive
    // tech still announces the region; the centre panel surfaces the
    // matching "Select a section" caption.
    return (
      <div
        role="tree"
        aria-multiselectable="false"
        aria-label="Corpus structure"
        className="lc-tree lc-scroll lc-tree-empty"
      >
        <div className="lc-tree-empty-caption">No sections to display</div>
      </div>
    );
  }

  const treeAttrs = {
    role: "tree" as const,
    "aria-multiselectable": "false" as const,
    "aria-label": "Corpus structure",
    className: "lc-tree lc-scroll",
    onKeyDown,
    onBlur: onBlurContainer,
  };

  if (useVirtualization) {
    const virtualItems = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    return (
      <div ref={containerRef} {...treeAttrs}>
        <div style={{ height: totalSize, width: "100%", position: "relative" }}>
          {virtualItems.map((vItem) => {
            const row = rows[vItem.index];
            if (!row) return null;
            return renderRow({
              row,
              activeRef,
              openSectionIds,
              focusedRowId,
              onClickRow,
              registerRowRef,
              style: {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vItem.start}px)`,
              },
            });
          })}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} {...treeAttrs}>
      {rows.map((row) =>
        renderRow({
          row,
          activeRef,
          openSectionIds,
          focusedRowId,
          onClickRow,
          registerRowRef,
        }),
      )}
    </div>
  );
}

interface RenderRowArgs {
  row: Row;
  activeRef: CorpusRef | null;
  openSectionIds: ReadonlySet<string>;
  focusedRowId: string | null;
  onClickRow: (rowId: string, e: MouseEvent<HTMLDivElement>) => void;
  registerRowRef: (rowId: string, el: HTMLDivElement | null) => void;
  style?: CSSProperties;
}

function renderRow(args: RenderRowArgs) {
  const { row, activeRef, openSectionIds, focusedRowId } = args;
  const isActive = isActiveRow(row, activeRef);
  const isOpen = !isActive && isOpenRowFromIds(row, openSectionIds);
  return (
    <TreeNode
      key={row.id}
      row={row}
      isFocused={row.id === focusedRowId}
      isActive={isActive}
      isOpen={isOpen}
      onClickRow={args.onClickRow}
      registerRowRef={args.registerRowRef}
      style={args.style}
    />
  );
}

function isActiveRow(row: Row, activeRef: CorpusRef | null): boolean {
  if (!activeRef || row.ref === null) return false;
  return refsEqual(row.ref, activeRef);
}

function isOpenRowFromIds(row: Row, openIds: ReadonlySet<string>): boolean {
  if (row.ref === null) return false;
  return openIds.has(refHash(row.ref));
}
