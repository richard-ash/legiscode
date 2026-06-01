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
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type CorpusRef, hash as refHash, equals as refsEqual } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import { collapse, expand, keyboardAction, prefixMatch, type Row, toggle } from "@/corpus-nav";
import { shouldHandleGlobalShortcut } from "@/ui/tabs/should-handle-shortcut";
import { activeSectionRef, type OpenItem, type OpenItemsState } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";
import { StickyHeaderStack } from "./sticky-header-stack";
import { TreeNode } from "./tree-node";
import { useCorpusTree } from "./use-corpus-tree";
import { useRovingFocus } from "./use-roving-focus";
import { useStickyHeaders } from "./use-sticky-headers";
import { TREE_ROW_HEIGHT_PX, useTreeVirtualizer } from "./use-tree-virtualizer";
import { useTypeahead } from "./use-typeahead";

// D16 (uniform-height assumption) lets us derive sticky stack height
// as `ancestors.length × TREE_ROW_HEIGHT_PX` without measureElement /
// IntersectionObserver feedback machinery. Constant lives in
// use-tree-virtualizer.ts as the single source of truth.

export interface FileTreeProps {
  tree: readonly CorpusTreeNode[];
  openItems: OpenItemsState;
  /** Tab-dispatch primitive. Plain click / Enter → "primary"; Cmd/Ctrl
   *  click + Cmd/Ctrl+Enter → "background" (open without switching). */
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
}

export function FileTree({ tree, openItems, navigate }: FileTreeProps) {
  const { setExpansion, rows, rowIndexById } = useCorpusTree(tree);
  // Pull stable functions out of useTypeahead. The hook returns a fresh
  // object literal each render, so depending on `typeahead` itself in any
  // useCallback would flip identity per render. The individual callbacks
  // ARE stable, so dep on them.
  const { appendChar: typeaheadAppendChar, reset: resetTypeahead } = useTypeahead();

  const containerRef = useRef<HTMLDivElement>(null);
  // Sticky stack height threads two ways:
  //   - into useTreeVirtualizer as `scrollMargin` so scrollToIndex
  //     calculates positions relative to the visible band BELOW the
  //     sticky stack
  //   - into useStickyHeaders so its topmost-row pick uses the same
  //     threshold the virtualizer is using
  // Initial value 0 (no sticky stack yet known on the first render).
  // The post-ancestors useEffect below settles the value in one frame;
  // D16 trusts React batching to absorb the height + scrollMargin
  // update together.
  const [stickyStackHeight, setStickyStackHeight] = useState(0);
  const { virtualizer, useVirtualization } = useTreeVirtualizer(rows, containerRef, {
    scrollMargin: stickyStackHeight,
  });
  const ancestors = useStickyHeaders({
    rows,
    rowIndexById,
    virtualizer,
    useVirtualization,
    stickyStackHeight,
  });
  useEffect(() => {
    const next = ancestors.length * TREE_ROW_HEIGHT_PX;
    if (next !== stickyStackHeight) setStickyStackHeight(next);
  }, [ancestors.length, stickyStackHeight]);
  const { focusedRowId, setFocusedRowId, registerRowRef, requestFocus } = useRovingFocus({
    rows,
    rowIndexById,
    openItems,
    containerRef,
    virtualizer,
    useVirtualization,
  });

  // Latest `rows` + `rowIndexById` accessible to event handlers without
  // invalidating their identity. Without these refs, onClickRow's deps
  // would flip every expansion, defeating React.memo on TreeNode for
  // the most common interaction (clicking parents to expand/collapse).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rowIndexByIdRef = useRef(rowIndexById);
  rowIndexByIdRef.current = rowIndexById;

  // Stable click dispatcher. Reads the latest rows + lookup map through
  // refs so the callback identity does not flip when expansion changes
  // — that keeps React.memo on TreeNode effective for focus-only
  // renders. O(1) row lookup via rowIndexById matches the F-perf
  // pattern applied across keyboard nav.
  const onClickRow = useCallback(
    (rowId: string, e: MouseEvent<HTMLDivElement>) => {
      const idx = rowIndexByIdRef.current.get(rowId);
      const row = idx === undefined ? undefined : rowsRef.current[idx];
      if (!row) return;
      const openMod = e.metaKey || e.ctrlKey;
      const intent = openMod ? "background" : "primary";
      if (row.hasKids) {
        setExpansion((prev) => toggle(prev, row.id));
      } else if (row.ref !== null) {
        navigate({ kind: "section", ref: row.ref }, intent);
      }
      setFocusedRowId(row.id);
      resetTypeahead();
    },
    [setExpansion, setFocusedRowId, navigate, resetTypeahead],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Guard typeahead + cmd/ctrl actions when focus is captured by a
      // text-entry surface or a dialog (e.g. command palette opened atop
      // the tree). The tree itself isn't a typing surface, but the shared
      // guard keeps the contract consistent across every keydown handler.
      if (!shouldHandleGlobalShortcut(e.nativeEvent)) return;
      // Typeahead path — printable single chars without modifiers, but
      // not Space/Enter (those drive activation/toggle via keyboardAction).
      if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const buffer = typeaheadAppendChar(e.key);
        const predicate = prefixMatch(buffer);
        // F-perf D17 scope honesty: the focused-row lookup is O(1) via
        // rowIndexById, but the forward-scan for the next prefix match
        // remains O(n) by design — a Map keyed by id can't accelerate a
        // predicate sweep over node fields. Deferred to a separate perf
        // pass if real corpus usage shows headroom loss.
        const focusedIdx = focusedRowId === null ? -1 : (rowIndexById.get(focusedRowId) ?? -1);
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

      const action = keyboardAction(e, { rows, rowIndexById, focusedRowId });
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
          navigate({ kind: "section", ref: action.ref }, "primary");
          break;
        case "open-without-switch":
          navigate({ kind: "section", ref: action.ref }, "background");
          break;
      }
      e.preventDefault();
    },
    [
      rows,
      rowIndexById,
      focusedRowId,
      setExpansion,
      setFocusedRowId,
      navigate,
      typeaheadAppendChar,
      requestFocus,
    ],
  );

  // Precompute the active ref + the open-row id lookup once per render
  // rather than per-row inside the map below.
  const { activeRef, openSectionIds } = useMemo(() => {
    const active = activeSectionRef(openItems);
    const openSec = new Set<string>();
    for (const item of openItems.items) {
      if (item.kind === "section") openSec.add(refHash(item.ref));
    }
    return {
      activeRef: active,
      openSectionIds: openSec,
    };
  }, [openItems]);

  // Tree-follows-active-tab: when the active tab changes (citation click,
  // ⌘⌥←/→, palette nav), expand the ancestor chain so the active section
  // is in the visible rows, then scroll the virtualizer to it. The
  // ancestor walk is cheap (single tree traversal). Scroll uses
  // `align: "center"` so a deeply nested target settles in the middle of
  // the viewport.
  //
  // Re-fire guard: the dep array includes rowIndexById, which is derived
  // from expansion state — so a user collapse of a sticky-header chevron
  // would re-fire the effect and immediately re-expand the ancestor. Gate
  // the body on "activeRef differs from what we last revealed" via a ref;
  // manual collapses are then sticky until the active section actually
  // changes. (D15 split-click contract.)
  const lastRevealedRef = useRef<CorpusRef | null>(null);
  useEffect(() => {
    if (!activeRef) return;
    if (lastRevealedRef.current && refsEqual(lastRevealedRef.current, activeRef)) return;
    const ancestorIds = findAncestorIdsForRef(tree, activeRef);
    if (ancestorIds.length > 0) {
      setExpansion((prev) => {
        let next = prev;
        let mutated = false;
        for (const id of ancestorIds) {
          if (!next.has(id)) {
            if (!mutated) {
              next = new Set(prev);
              mutated = true;
            }
            (next as Set<string>).add(id);
          }
        }
        return mutated ? next : prev;
      });
    }
    // CorpusTreeNode section ids are bare refHash ("module::section"),
    // not "section::<hash>" — that prefix belongs to OpenItem identity,
    // not tree node id. With the prefix this lookup was a never-hit, so
    // the scroll-to-index silently never fired for any active section.
    const targetId = refHash(activeRef);
    const idx = rowIndexById.get(targetId);
    if (idx !== undefined) {
      // Mark revealed only once the target row is in `rows` (idx is
      // defined). If activeRef sits inside a collapsed ancestor on this
      // pass, idx is undefined until setExpansion settles and
      // rowIndexById rebuilds — leaving the ref unset lets the next pass
      // see the deeper row and only then mark. Otherwise the second pass
      // early-returns and the active section expands but never scrolls
      // into view. The scroll itself is optional (jsdom virtualizer has
      // no scrollToIndex); the user-visible promise is locatability.
      if (virtualizer.scrollToIndex) {
        virtualizer.scrollToIndex(idx, { align: "center" });
      }
      lastRevealedRef.current = activeRef;
    }
  }, [activeRef, tree, rowIndexById, setExpansion, virtualizer]);

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
    // Render-math coordinate system (D14):
    //
    //   container scroll position ──┐
    //                               ▼
    //   ┌─ visible viewport ──────────────────┐
    //   │   sticky stack (height = sM)        │ ← position: sticky; top: 0
    //   ├─────────────────────────────────────┤
    //   │   row N    (translateY: start − sM) │
    //   │   row N+1  (translateY: start − sM) │   useVirtualizer sees
    //   │   row N+2  (translateY: start − sM) │   scrollMargin = sM and
    //   └─────────────────────────────────────┘   adjusts geometry. Render
    //                                             must mirror with the
    //                                             matching subtraction or
    //                                             rows shift down by sM.
    return (
      <div ref={containerRef} {...treeAttrs}>
        <StickyHeaderStack
          ancestors={ancestors}
          rowIndexById={rowIndexById}
          virtualizer={virtualizer}
          containerRef={containerRef}
          onCollapse={(ancestorId) => {
            setExpansion((prev) => collapse(prev, ancestorId));
            setFocusedRowId(ancestorId);
            // The chevron span is aria-hidden + has no tabindex, so the
            // click never lands DOM focus inside the tree. Without this,
            // setFocusedRowId updates React state but useRovingFocus's
            // "drive focus" effect skips work (focusIsInTree=false), and
            // the user has to click into the tree before keyboard nav
            // resumes. Matches the onStickyClick path below.
            requestFocus(ancestorId);
          }}
          onStickyClick={(ancestorId) => {
            setFocusedRowId(ancestorId);
            requestFocus(ancestorId);
          }}
        />
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
                transform: `translateY(${vItem.start - stickyStackHeight}px)`,
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

/** Walk the tree and collect the chain of chapter/code node IDs that must
 *  be expanded to make the section at `ref` visible. Returns [] when the
 *  section is not present in this tree (e.g. activeRef belongs to a
 *  module not in the current jurisdiction snapshot). */
function findAncestorIdsForRef(tree: readonly CorpusTreeNode[], ref: CorpusRef): readonly string[] {
  function walk(nodes: readonly CorpusTreeNode[], chain: string[]): string[] | null {
    for (const node of nodes) {
      if (
        node.kind === "section" &&
        node.ref &&
        node.ref.moduleId === ref.module &&
        node.ref.sectionId === ref.section
      ) {
        return chain;
      }
      if (node.kids && node.kids.length > 0) {
        const found = walk(node.kids, [...chain, node.id]);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(tree, []) ?? [];
}
