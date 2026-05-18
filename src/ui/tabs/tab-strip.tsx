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
} from "react";
import type { CorpusRef } from "@/corpus/refs";
import { hash as refHash } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import type { OpenItem, OpenItemsState } from "@/workbench/open-items";
import { reorderItems, setActiveIndex } from "@/workbench/open-items";
import { Tab, tabSortableId } from "./tab";

export interface TabStripProps {
  openItems: OpenItemsState;
  setOpenItems: (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => void;
  titleMap: ReadonlyMap<string, CorpusTreeNode>;
  closeAt: (index: number) => void;
}

const MIDDLE_DOT = "·";

export function TabStrip({ openItems, setOpenItems, titleMap, closeAt }: TabStripProps) {
  const listRef = useRef<HTMLDivElement>(null);
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

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
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
                onClose={closeAt}
                onAuxClose={closeAt}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function buildTitle(item: OpenItem, titleMap: ReadonlyMap<string, CorpusTreeNode>): string {
  if (item.kind !== "section") return "Untitled";
  const ref: CorpusRef = item.ref;
  const node = titleMap.get(refHash(ref));
  if (!node) return `§ ${ref.section}`;
  return `§ ${node.code} ${MIDDLE_DOT} ${node.name}`;
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
