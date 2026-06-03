// Tab popover surface — backs both the right-click bulk-close menu
// (commit 3) and the overflow list (commit 5). Two modes share one
// component so positioning, dismiss semantics, ARIA shape, and roving
// keyboard nav stay consistent.
//
// Positioning reuses `usePopoverPosition` from
// `@/ui/center-panel/section-view/use-hover-popover` (right-edge clamp,
// bottom-flip, viewport margins). The hover-bridge / show-delay
// machinery in `useHoverPopover` is not reused: this popover is opened
// by a deliberate trigger (right-click, chevron click, Shift+F10), not
// hover.
//
// Focus model is roving tabindex (X5 lock), not a focus trap. The user
// can Tab away to other chrome; Escape returns focus to the originating
// anchor element so they're not stranded if they cancel.
//
// `useDismissOnOutsideOrEscape` is intentionally NOT extracted yet —
// rule of three; SettingsDropdown's variant has dialog-defer branches
// that haven't reconciled with this surface.

import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePopoverPosition } from "@/ui/center-panel/section-view/use-hover-popover";
import { Icons } from "@/ui/icons";

export interface TabMenuRow {
  /** Stable identity used as the React key + as the row's key for the
   *  parent's `onAction(rowId)` dispatch. */
  id: string;
  /** Visible label. */
  label: string;
  /** Optional shortcut text rendered right-aligned (e.g. "⌘W"). */
  shortcut?: string;
}

export interface TabPopoverProps {
  /** DOM element the popover anchors to (the right-clicked tab, or the
   *  chevron button). */
  anchorElement: HTMLElement | null;
  /** Rows to render. The parent decides which to include (e.g. omit
   *  "Close Others" when there's only one tab) per S2 — omit, don't
   *  disable. */
  rows: readonly TabMenuRow[];
  /** Optional ARIA label for the popover surface. */
  ariaLabel?: string;
  /** Fired when a row is activated by click, Enter, or Space. */
  onAction: (rowId: string) => void;
  /** Fired when the popover wants to close — Escape, outside click,
   *  or the parent's own state slot turning it off. */
  onClose: () => void;
}

export function TabPopover({ anchorElement, rows, ariaLabel, onAction, onClose }: TabPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { top, left } = usePopoverPosition(anchorElement, popoverRef);
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Clamp focus when the row set shrinks (overflow menu row close
  // shortens the list).
  useEffect(() => {
    if (focusedIdx >= rows.length && rows.length > 0) setFocusedIdx(rows.length - 1);
  }, [rows.length, focusedIdx]);

  // Initial focus: the first row gets focus when the popover mounts so
  // keyboard users land in a useful spot without an extra Tab. Roving
  // tabindex keeps subsequent arrow nav cheap.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const firstRow = el.querySelector<HTMLElement>('[role="menuitem"][data-row-idx="0"]');
    firstRow?.focus();
  }, []);

  // Outside-click dismiss. mousedown (not click) so the dismiss fires
  // before the underlying click handler — right-clicking a different
  // tab while the menu is open should close + re-anchor, not double-
  // fire. Capture phase so a click on the originating anchor doesn't
  // re-open instantly.
  useEffect(() => {
    function onMouseDown(e: globalThis.MouseEvent) {
      const el = popoverRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (target && el.contains(target)) return;
      // Click on the anchor itself — let the anchor's own handler
      // re-anchor; don't fight it.
      if (target && anchorElement?.contains(target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [anchorElement, onClose]);

  // Escape dismiss. Returns focus to the anchor so the user isn't
  // stranded on `body`. document-level (not window) so the listener
  // catches Escape even when focus has rotated to the popover itself.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        anchorElement?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anchorElement, onClose]);

  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, idx: number, rowId: string) => {
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (rows.length === 0) return;
          const next = (idx + 1) % rows.length;
          setFocusedIdx(next);
          focusRowAt(popoverRef.current, next);
          return;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (rows.length === 0) return;
          const next = (idx - 1 + rows.length) % rows.length;
          setFocusedIdx(next);
          focusRowAt(popoverRef.current, next);
          return;
        }
        case "Home": {
          e.preventDefault();
          if (rows.length === 0) return;
          setFocusedIdx(0);
          focusRowAt(popoverRef.current, 0);
          return;
        }
        case "End": {
          e.preventDefault();
          if (rows.length === 0) return;
          const last = rows.length - 1;
          setFocusedIdx(last);
          focusRowAt(popoverRef.current, last);
          return;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          onAction(rowId);
          return;
        }
      }
    },
    [rows.length, onAction],
  );

  const style: CSSProperties = { top, left };

  return (
    <div
      ref={popoverRef}
      className="lc-menu-popover"
      role="menu"
      aria-label={ariaLabel}
      style={style}
    >
      {rows.map((row, idx) => (
        <div
          key={row.id}
          role="menuitem"
          tabIndex={idx === focusedIdx ? 0 : -1}
          data-row-idx={idx}
          className="lc-menu-row"
          onClick={(e) => {
            e.stopPropagation();
            onAction(row.id);
          }}
          onKeyDown={(e) => onRowKeyDown(e, idx, row.id)}
          onFocus={() => setFocusedIdx(idx)}
        >
          <span className="lc-menu-row-label">{row.label}</span>
          {row.shortcut ? (
            <span className="lc-menu-row-shortcut">{row.shortcut}</span>
          ) : (
            // Empty span keeps the label column from stretching when
            // the row has no shortcut (blank column, not "—").
            <span className="lc-menu-row-shortcut" aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
}

function focusRowAt(root: HTMLElement | null, idx: number): void {
  if (!root) return;
  const el = root.querySelector<HTMLElement>(`[role="menuitem"][data-row-idx="${idx}"]`);
  el?.focus();
}

// ── Overflow menu ────────────────────────────────────────────────────

export interface OverflowMenuRow {
  /** Stable identity for the row's per-item state (`itemIdentity`
   *  from open-items.ts). Row actions key on identity, not captured
   *  index, so the menu stays consistent across row × closures. */
  id: string;
  /** Label rendered in the row (`§ 10.04.020 · Sales Tax Definitions`). */
  label: string;
  /** True when this row corresponds to the strip's active tab — gets
   *  the • marker treatment. */
  isActive: boolean;
}

export interface OverflowMenuProps {
  anchorElement: HTMLElement | null;
  /** Rows in open-order — mirror the strip, not MRU. */
  rows: readonly OverflowMenuRow[];
  /** ARIA label including the open-tab count — replaces the omitted
   *  "Open tabs · N" header for screen readers. */
  ariaLabel: string;
  /** Activate the row identified by `id`. */
  onActivate: (id: string) => void;
  /** Close the row identified by `id` without first activating it. */
  onCloseRow: (id: string) => void;
  /** Fired on Escape / outside click / parent's own state turn-off. */
  onClose: () => void;
}

/**
 * Overflow list mode — a popover variant that renders open tabs with
 * always-visible per-row close buttons. Sibling to TabPopover; both
 * share the menu/menuitem ARIA shape, dismiss semantics, and roving
 * tabindex, but the row markup diverges enough to keep two render
 * functions instead of branching one.
 *
 * Per X10 lock: clicking a row dispatches `onActivate(id)` only —
 * TabStrip's existing useLayoutEffect handles scrolling the activated
 * row into view; no separate scroll call here.
 */
export function OverflowMenu({
  anchorElement,
  rows,
  ariaLabel,
  onActivate,
  onCloseRow,
  onClose,
}: OverflowMenuProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { top, left } = usePopoverPosition(anchorElement, popoverRef);
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Clamp focus when rows shrink (per-row close shortens the list).
  useEffect(() => {
    if (focusedIdx >= rows.length && rows.length > 0) setFocusedIdx(rows.length - 1);
  }, [rows.length, focusedIdx]);

  // Initial focus: land on the active row if there is one (so the
  // user sees "where they are"); otherwise the first row. Mount-only
  // — re-running this effect when `rows` mutates would yank focus back
  // every time a row closes mid-interaction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate mount-only initial-focus pass; subsequent rows changes shouldn't yank focus
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const activeIdx = rows.findIndex((r) => r.isActive);
    const target = activeIdx >= 0 ? activeIdx : 0;
    setFocusedIdx(target);
    focusRowAt(el, target);
  }, []);

  useEffect(() => {
    function onMouseDown(e: globalThis.MouseEvent) {
      const el = popoverRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (target && el.contains(target)) return;
      if (target && anchorElement?.contains(target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [anchorElement, onClose]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        anchorElement?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anchorElement, onClose]);

  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, idx: number, rowId: string) => {
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (rows.length === 0) return;
          const next = (idx + 1) % rows.length;
          setFocusedIdx(next);
          focusRowAt(popoverRef.current, next);
          return;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (rows.length === 0) return;
          const next = (idx - 1 + rows.length) % rows.length;
          setFocusedIdx(next);
          focusRowAt(popoverRef.current, next);
          return;
        }
        case "Home": {
          e.preventDefault();
          if (rows.length === 0) return;
          setFocusedIdx(0);
          focusRowAt(popoverRef.current, 0);
          return;
        }
        case "End": {
          e.preventDefault();
          if (rows.length === 0) return;
          const last = rows.length - 1;
          setFocusedIdx(last);
          focusRowAt(popoverRef.current, last);
          return;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          onActivate(rowId);
          return;
        }
      }
    },
    [rows.length, onActivate],
  );

  const style: CSSProperties = { top, left };

  return (
    <div
      ref={popoverRef}
      className="lc-menu-popover"
      role="menu"
      aria-label={ariaLabel}
      style={style}
    >
      {rows.map((row, idx) => (
        <div
          key={row.id}
          role="menuitem"
          tabIndex={idx === focusedIdx ? 0 : -1}
          data-row-idx={idx}
          data-row-id={row.id}
          className={`lc-menu-row lc-overflow-row${row.isActive ? " is-active" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onActivate(row.id);
          }}
          onKeyDown={(e) => onRowKeyDown(e, idx, row.id)}
          onFocus={() => setFocusedIdx(idx)}
        >
          <span className="lc-overflow-row-marker" aria-hidden="true">
            {row.isActive ? "•" : ""}
          </span>
          <span className="lc-overflow-row-title">{row.label}</span>
          <button
            type="button"
            aria-label={`Close ${row.label}`}
            className="lc-overflow-row-close"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onCloseRow(row.id);
            }}
          >
            <Icons.Close size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
