// Per-tab chrome. Memoized so a single-tab activation doesn't redraw the
// whole strip (P3). Bound to @dnd-kit's `useSortable` for accessible
// reorder — KeyboardSensor handles Space-grab / arrow-move / Space-drop /
// Escape-cancel with aria-live announcements out of the box.
//
// Per-state visual rules live in CSS (.lc-tab + .is-active + hover). The
// component only emits the structural markup plus `data-kind` for the
// future per-kind icon-color selectors.

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, memo, useCallback } from "react";
import { Icons } from "@/ui/icons";
import { itemIdentity, type OpenItem } from "@/workbench/open-items";

export interface TabProps {
  item: OpenItem;
  index: number;
  isActive: boolean;
  title: string;
  /** Full title surfaced via native `title` attr for truncated text. */
  fullTitle: string;
  onActivate: (index: number) => void;
  onClose: (index: number) => void;
  /** Middle-click — close without activate. (Same dispatch shape as
   *  `onClose`; named separately so a future divergence stays local.) */
  onAuxClose: (index: number) => void;
  /** Open the right-click bulk-close menu anchored to this tab. Called
   *  with the tab DOM node so the popover can position against it. Fires
   *  on right-click (contextmenu), Shift+F10, and the dedicated
   *  ContextMenu key — per X6 (WCAG 2.1.1) keyboard parity for the
   *  context menu. */
  onContextMenuOpen: (index: number, anchor: HTMLElement) => void;
}

function TabImpl({
  item,
  index,
  isActive,
  title,
  fullTitle,
  onActivate,
  onClose,
  onAuxClose,
  onContextMenuOpen,
}: TabProps) {
  const id = tabSortableId(item);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    pointerEvents: isDragging ? "none" : undefined,
  };

  const onClick = useCallback(() => {
    onActivate(index);
  }, [index, onActivate]);

  const onMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // Middle-click anywhere on the tab closes it.
      if (e.button === 1) {
        e.preventDefault();
        onAuxClose(index);
      }
    },
    [index, onAuxClose],
  );

  const onCloseClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClose(index);
    },
    [index, onClose],
  );

  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      // The default browser context menu would expose Inspect / Reload in
      // Electron — wrong shape entirely. preventDefault + dispatch to the
      // strip-owned popover slot.
      onContextMenuOpen(index, e.currentTarget);
    },
    [index, onContextMenuOpen],
  );

  // Enter activates the focused tab. (Space is reserved for @dnd-kit's
  // KeyboardSensor grab — pressing Space on a focused tab initiates
  // drag-reorder, not activation.) Arrow / Home / End navigation lives
  // on the tablist parent so this handler stays narrow.
  //
  // Shift+F10 and the dedicated ContextMenu key open the right-click
  // menu without a mouse (WCAG 2.1.1; X6 lock). preventDefault on
  // Shift+F10 swallows the platform's default menu trigger so the
  // popover doesn't double-fire.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onActivate(index);
        return;
      }
      if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
        e.preventDefault();
        onContextMenuOpen(index, e.currentTarget);
      }
    },
    [index, onActivate, onContextMenuOpen],
  );

  const kind = item.kind;

  // Spread @dnd-kit attributes/listeners FIRST so the explicit
  // role="tab" + roving tabIndex below win — @dnd-kit defaults to
  // role="button" + tabIndex=0, which break the ARIA tablist contract.
  return (
    <div
      {...attributes}
      {...listeners}
      ref={setNodeRef}
      role="tab"
      id={`tab-${id}`}
      tabIndex={isActive ? 0 : -1}
      aria-selected={isActive}
      aria-controls={`tabpanel-${id}`}
      data-kind={kind}
      data-index={index}
      className={`lc-tab${isActive ? " is-active" : ""}`}
      style={style}
      title={fullTitle}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
    >
      <span className="lc-tab-ico" aria-hidden="true">
        <Icons.Section size={13} />
      </span>
      <span>{title}</span>
      <button
        type="button"
        aria-label={`Close ${fullTitle}`}
        className="lc-tab-close"
        // Inactive tabs' close buttons sit at opacity:0; without the
        // roving tabIndex they'd still be keyboard-focusable, so Tab
        // would land on invisible buttons and break the tablist
        // contract. Match the parent tab's roving index.
        tabIndex={isActive ? 0 : -1}
        onClick={onCloseClick}
        // Don't initiate a drag from the close button.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Icons.Close size={10} />
      </button>
    </div>
  );
}

export const Tab = memo(TabImpl);

/** Stable sortable id from an OpenItem. Uses the centralized identity
 *  helper so a new OpenItem variant only requires one edit. */
export function tabSortableId(item: OpenItem): string {
  return itemIdentity(item);
}
