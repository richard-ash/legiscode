// Horizontal tab strip — DndContext + SortableContext + scroll + active-
// into-view. Renders nothing when `items` is empty (the App-level empty
// state owns that viewport). Arrow / Home / End nav lives here on the
// tablist; cmd/ctrl shortcuts live in `keyboard-shortcuts.ts`.

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CorpusRef } from "@/corpus/refs";
import { hash as refHash } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import { Icons } from "@/ui/icons";
import { formatShortcut } from "@/ui/shortcuts/registry";
import { itemIdentity, type OpenItem, type OpenItemsState } from "@/workbench/open-items";
import { reorderItems, setActiveIndex } from "@/workbench/open-items";
import { Tab, type TabCloseMode, tabSortableId } from "./tab";
import { OverflowMenu, type OverflowMenuRow, TabPopover, type TabMenuRow } from "./tab-popover";

export interface TabStripProps {
  openItems: OpenItemsState;
  setOpenItems: (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => void;
  titleMap: ReadonlyMap<string, CorpusTreeNode>;
  closeAt: (index: number) => void;
  /** Close every tab except the one at `keepIndex`. Bulk-close menu rows
   *  call into these wrappers so the hook-side recently-closed buffer
   *  bookkeeping (reverse-active-recency push + cap) stays in one place. */
  closeOthers: (keepIndex: number) => void;
  /** Close every tab to the right of `fromIndex`. */
  closeToRight: (fromIndex: number) => void;
  /** Close every tab. */
  closeAll: () => void;
}

/**
 * Open popover slot — single source of truth for "which popover is on
 * screen right now" (A1 lock). Mutex between the right-click menu
 * (commit 3) and the future overflow chevron menu (commit 5) falls out
 * for free; a new openMenu setter atomically replaces the old one and
 * unmounts the previous popover.
 */
type OpenMenuState =
  | { kind: "context"; anchorEl: HTMLElement; identity: string }
  | { kind: "overflow"; anchorEl: HTMLElement }
  | null;

const MIDDLE_DOT = "·";

export function TabStrip({
  openItems,
  setOpenItems,
  titleMap,
  closeAt,
  closeOthers,
  closeToRight,
  closeAll,
}: TabStripProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenuState>(null);
  // Tracks whether .lc-tabs is overflowing (scrollWidth > clientWidth).
  // Drives whether the chevron renders at all. Re-evaluated by a
  // ResizeObserver on the scroller and a useEffect on items.length so
  // tab open/close flips the chevron without waiting for a layout pass.
  const [hasOverflow, setHasOverflow] = useState(false);
  const { items, activeIndex } = openItems;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sortableIds = useMemo(() => items.map((it) => tabSortableId(it)), [items]);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const fromId = String(active.id);
      const toId = String(over.id);
      const from = sortableIds.indexOf(fromId);
      const to = sortableIds.indexOf(toId);
      if (from < 0 || to < 0) return;
      setOpenItems((prev) => reorderItems(prev, from, to));
    },
    [sortableIds, setOpenItems],
  );

  const onActivate = useCallback(
    (index: number) => {
      setOpenItems((prev) => setActiveIndex(prev, index));
    },
    [setOpenItems],
  );

  const onContextMenuOpen = useCallback(
    (index: number, anchorEl: HTMLElement) => {
      // Key the menu on the tab's identity, not its index (X9 lock — same
      // as the overflow menu). A captured index goes stale if a tab to the
      // left closes while the menu is open, which would silently retarget
      // Close Others / Close to the Right at the wrong tab.
      const it = items[index];
      if (!it) return;
      setOpenMenu({ kind: "context", anchorEl, identity: itemIdentity(it) });
    },
    [items],
  );

  // Router for the extended `onClose(index, mode?)` signature emitted by
  // Tab (plain click / middle-click / Cmd-Alt-click). 'self' takes the
  // single-tab path; 'others' / 'right' route to the bulk-close hook
  // wrappers so buffer bookkeeping stays in one place.
  const onTabClose = useCallback(
    (index: number, mode: TabCloseMode = "self") => {
      switch (mode) {
        case "others":
          closeOthers(index);
          return;
        case "right":
          closeToRight(index);
          return;
        default:
          closeAt(index);
      }
    },
    [closeAt, closeOthers, closeToRight],
  );

  // Auto-close the open context menu when the targeted tab disappears
  // from the strip (e.g. user dispatched Close on it via the menu, or
  // closed it via ⌘W while the menu was up). Without this the popover
  // would either anchor to a stale DOM node or stay open with no valid
  // index to dispatch against.
  useEffect(() => {
    if (!openMenu) return;
    if (
      openMenu.kind === "context" &&
      !items.some((it) => itemIdentity(it) === openMenu.identity)
    ) {
      setOpenMenu(null);
    }
    // Overflow menu auto-closes when the strip empties.
    if (openMenu.kind === "overflow" && items.length === 0) {
      setOpenMenu(null);
    }
  }, [items, openMenu]);

  // Detect strip overflow via ResizeObserver on the scroller plus a
  // best-effort items.length fallback (the ResizeObserver fires when
  // either the scroller's clientWidth changes — panel resize — or the
  // scrollWidth changes via a child mutation; on some browsers child
  // mutations don't trigger an RO callback, so the length effect
  // re-checks). Defer one rAF on initial mount so the scroller has its
  // final width before the comparison runs.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      const overflow = list.scrollWidth - list.clientWidth > 1;
      setHasOverflow(overflow);
    };
    const raf = window.requestAnimationFrame(update);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      ro.observe(list);
    }
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, []);
  // Re-evaluate overflow when items add/remove. RO fires on size change
  // but children-added isn't size on every engine, so this is the safety
  // net. items.length is the deliberate trigger — read from listRef
  // inside, but the effect must re-fire on count change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: items.length is the deliberate trigger; nothing else inside reads it
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setHasOverflow(list.scrollWidth - list.clientWidth > 1);
  }, [items.length]);

  const onMenuClose = useCallback(() => {
    setOpenMenu(null);
  }, []);

  const onMenuAction = useCallback(
    (rowId: string) => {
      if (!openMenu || openMenu.kind !== "context") return;
      // Resolve the anchored tab's identity to a live index at dispatch
      // time — the index can shift if another tab closed while the menu
      // was open.
      const idx = items.findIndex((it) => itemIdentity(it) === openMenu.identity);
      setOpenMenu(null);
      if (idx < 0) return;
      switch (rowId) {
        case "close":
          closeAt(idx);
          return;
        case "close-others":
          closeOthers(idx);
          return;
        case "close-to-right":
          closeToRight(idx);
          return;
        case "close-all":
          closeAll();
          return;
      }
    },
    [openMenu, items, closeAt, closeOthers, closeToRight, closeAll],
  );

  // Build the menu row list — omit (don't disable) rows that don't
  // apply to the right-clicked tab per S2 lock + feedback_no_placeholder_ui.
  const menuRows = useMemo<readonly TabMenuRow[]>(() => {
    if (!openMenu || openMenu.kind !== "context") return [];
    const idx = items.findIndex((it) => itemIdentity(it) === openMenu.identity);
    if (idx < 0) return [];
    const total = items.length;
    const isOnly = total === 1;
    const isRightmost = idx === total - 1;
    const rows: TabMenuRow[] = [
      { id: "close", label: "Close", shortcut: formatShortcut("tabs.close-active") },
    ];
    if (!isOnly) rows.push({ id: "close-others", label: "Close Others" });
    if (!isOnly && !isRightmost) rows.push({ id: "close-to-right", label: "Close to the Right" });
    rows.push({
      id: "close-all",
      label: "Close All Tabs",
      shortcut: formatShortcut("tabs.close-all"),
    });
    return rows;
  }, [openMenu, items]);

  // Overflow rows: every open item, keyed by itemIdentity (X9 lock —
  // row actions key on identity, not captured index, so a row close
  // while the menu is open doesn't strand the remaining rows on stale
  // indexes).
  const overflowRows = useMemo<readonly OverflowMenuRow[]>(() => {
    return items.map((it, idx) => ({
      id: itemIdentity(it),
      label: buildTitle(it, titleMap),
      isActive: idx === activeIndex,
    }));
  }, [items, titleMap, activeIndex]);

  const onChevronClick = useCallback(() => {
    setOpenMenu((prev) => {
      if (prev?.kind === "overflow") return null;
      const anchor = chevronRef.current;
      if (!anchor) return prev;
      return { kind: "overflow", anchorEl: anchor };
    });
  }, []);

  const onOverflowActivate = useCallback(
    (rowId: string) => {
      setOpenMenu(null);
      const idx = items.findIndex((it) => itemIdentity(it) === rowId);
      if (idx < 0) return;
      // X10 lock — setActiveIndex only; the existing useLayoutEffect at
      // tab-strip.tsx scrolls the activated tab into view, no separate
      // scroll call required.
      setOpenItems((prev) => setActiveIndex(prev, idx));
    },
    [items, setOpenItems],
  );

  const onOverflowCloseRow = useCallback(
    (rowId: string) => {
      const idx = items.findIndex((it) => itemIdentity(it) === rowId);
      if (idx < 0) return;
      closeAt(idx);
    },
    [items, closeAt],
  );

  // Bare arrow keys / Home / End within the tablist. No modifier guard —
  // they only fire when a tab has focus (the tablist's tabIndex roving
  // pattern); typing surfaces won't capture these.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (items.length === 0) return;
      const cur = activeIndex ?? 0;
      let next: number | null = null;
      switch (e.key) {
        case "ArrowRight":
          next = (cur + 1) % items.length;
          break;
        case "ArrowLeft":
          next = (cur - 1 + items.length) % items.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = items.length - 1;
          break;
      }
      if (next === null) return;
      e.preventDefault();
      setOpenItems((prev) => setActiveIndex(prev, next));
    },
    [items.length, activeIndex, setOpenItems],
  );

  // CQ9 — scroll the active tab into view whenever activeIndex changes.
  // Covers keyboard activation (⌘1-9, ⌘pgup/pgdn, arrow nav) AND
  // cold-start hydration when the persisted active tab is off-screen
  // after overflow.
  useLayoutEffect(() => {
    if (activeIndex === null) return;
    const list = listRef.current;
    if (!list) return;
    const node = list.querySelector<HTMLDivElement>(`[role="tab"][data-index="${activeIndex}"]`);
    if (!node) return;
    // JSDOM doesn't implement scrollIntoView; the test environment exercises
    // the surrounding logic via DOM queries, not the scroll itself.
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeIndex]);

  // Focus restoration — when the active index changes via keyboard, the
  // roving tabindex needs the new active tab to actually receive focus.
  // Only steal focus when focus already lives inside the tablist, so a
  // file-tree click that switches tabs doesn't yank focus.
  useEffect(() => {
    if (activeIndex === null) return;
    const list = listRef.current;
    if (!list) return;
    if (!list.contains(document.activeElement)) return;
    const node = list.querySelector<HTMLDivElement>(`[role="tab"][data-index="${activeIndex}"]`);
    if (node && document.activeElement !== node) node.focus();
  }, [activeIndex]);

  if (items.length === 0) return null;

  const overflowMenuOpen = openMenu?.kind === "overflow";

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="lc-tabs-row">
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          <div
            ref={listRef}
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Open sections"
            className="lc-tabs"
            onKeyDown={onKeyDown}
          >
            {items.map((it, idx) => {
              const isActive = idx === activeIndex;
              const fullTitle = buildTitle(it, titleMap);
              return (
                <Tab
                  key={tabSortableId(it)}
                  item={it}
                  index={idx}
                  isActive={isActive}
                  title={fullTitle}
                  fullTitle={fullTitle}
                  onActivate={onActivate}
                  onClose={onTabClose}
                  onContextMenuOpen={onContextMenuOpen}
                />
              );
            })}
          </div>
        </SortableContext>
        {hasOverflow ? (
          <button
            ref={chevronRef}
            type="button"
            className="lc-tabs-chevron"
            // D1 lock — interpolated count replaces the omitted "Open
            // tabs · N" header row; screen readers still hear the count.
            aria-label={`Show all ${items.length} open tabs`}
            aria-haspopup="menu"
            aria-expanded={overflowMenuOpen}
            onClick={onChevronClick}
          >
            <Icons.ChevronDown size={13} />
          </button>
        ) : null}
      </div>
      {openMenu && openMenu.kind === "context" ? (
        <TabPopover
          anchorElement={openMenu.anchorEl}
          rows={menuRows}
          onAction={onMenuAction}
          onClose={onMenuClose}
        />
      ) : null}
      {openMenu && openMenu.kind === "overflow" ? (
        <OverflowMenu
          anchorElement={openMenu.anchorEl}
          rows={overflowRows}
          ariaLabel={`Open tabs (${items.length})`}
          onActivate={onOverflowActivate}
          onCloseRow={onOverflowCloseRow}
          onClose={onMenuClose}
        />
      ) : null}
    </DndContext>
  );
}

function buildTitle(item: OpenItem, titleMap: ReadonlyMap<string, CorpusTreeNode>): string {
  if (item.kind === "settings") return "Settings";
  if (item.kind !== "section") return "Untitled";
  const ref: CorpusRef = item.ref;
  const node = titleMap.get(refHash(ref));
  if (!node) return `§ ${ref.section}`;
  return `${node.code} ${MIDDLE_DOT} ${node.name}`;
}

/** Build a lookup map from refHash → CorpusTreeNode for section leaves.
 *  Threaded into TabStrip so title lookup is O(1) per tab on render. */
export function buildTitleMap(tree: readonly CorpusTreeNode[]): Map<string, CorpusTreeNode> {
  const out = new Map<string, CorpusTreeNode>();
  const stack: CorpusTreeNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === "section" && node.ref) {
      const key = `${node.ref.moduleId}::${node.ref.sectionId}`;
      out.set(key, node);
    }
    if (node.kids) for (const k of node.kids) stack.push(k);
  }
  return out;
}
