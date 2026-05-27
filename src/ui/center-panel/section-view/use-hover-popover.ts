// Hover-popover lifecycle. Owns show / hide timers, Escape-to-dismiss,
// scroll-to-dismiss, and hover-bridge cancel semantics so every popover
// surface in the section view shares one tested implementation. Per
// the test-each-path-once rule, lifecycle tests live ONLY on this hook
// (under `vi.useFakeTimers`); consumers' tests pin only consumer-specific
// behavior (citation kind branching, defined-term excerpt rendering).
//
// Section-view owns the single hook instance and provides the handle via
// SectionHoverContext so the citation popover and the defined-term
// popover share state — "one popover at a time" is a structural
// invariant, not a timer-non-overlap hope.
//
// The hook is generic over the payload `T` the consumer wants to
// associate with the open popover — section-view stores a discriminated
// union {kind: "citation" | "definedTerm", anchorElement, …}. Anchor
// element (not rect) lets the popover compute a fresh `getBoundingClientRect`
// at render time, so a reflow between hover-and-open doesn't strand the
// popover at a stale position.
//
// Position helper `computeHoverPosition` is exported as a pure function
// + `usePopoverPosition` wraps it in a measure-and-flip useLayoutEffect
// so consumers don't re-implement the right-edge clamp / bottom-edge
// flip logic.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Popover max-width used for the viewport-clamp calculation. Matches
 *  the inline `maxWidth: 360` style on both popovers plus 8px of
 *  right-margin breathing room. */
const POPOVER_WIDTH_PX = 368;

/** Default hover-bridge gap (px) between the anchor rect and the
 *  popover. Matches the existing 6px in section-view.tsx. */
const ANCHOR_GAP_PX = 6;

/** Minimum distance from viewport edges. Keeps the popover from kissing
 *  the chrome border at either side or vertical extreme. */
const VIEWPORT_MARGIN_PX = 8;

export const POPOVER_SHOW_DELAY_MS = 400;
export const POPOVER_HIDE_DELAY_MS = 200;

/**
 * Compute the fixed-position coordinates for a hover popover anchored
 * to the given element rect.
 *
 * Horizontal: right-edge clamp keeps the popover fully visible at narrow
 * viewport widths — the Electron minimum is 960px and a 3-panel layout
 * can leave the center panel ~356px wide, which without clamping pushes
 * the popover off the right edge.
 *
 * Vertical: try below the anchor (the natural position). If the popover
 * height would push it past the bottom edge AND there's room above the
 * anchor, flip up. `height` is 0 on the first render (the popover is
 * not yet mounted); the measure-and-reposition cycle in
 * `usePopoverPosition` re-runs with the real height in a useLayoutEffect
 * that fires before the browser paints, so the user never sees the
 * unmeasured position.
 *
 * Returns coords in fixed-position space, ready to drop onto a
 * style object as `top` / `left`.
 */
export function computeHoverPosition(
  anchorRect: DOMRect,
  opts: { gap?: number; width?: number; height?: number } = {},
): { top: number; left: number } {
  const gap = opts.gap ?? ANCHOR_GAP_PX;
  const width = opts.width ?? POPOVER_WIDTH_PX;
  const height = opts.height ?? 0;
  const viewportWidth = typeof window === "undefined" ? width : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight;

  // Vertical: prefer below the anchor; flip up only when (a) the natural
  // position would overflow the bottom margin AND (b) there's room above.
  // Falling back to natural-below when there's no room either way keeps
  // the popover visible (clamped by Math.max) — better partially in-view
  // than off-screen.
  const naturalTop = anchorRect.bottom + gap;
  const wouldOverflowBelow = naturalTop + height > viewportHeight - VIEWPORT_MARGIN_PX;
  const flipAboveTop = anchorRect.top - gap - height;
  const fitsAbove = flipAboveTop >= VIEWPORT_MARGIN_PX;
  const top = Math.max(
    VIEWPORT_MARGIN_PX,
    wouldOverflowBelow && fitsAbove ? flipAboveTop : naturalTop,
  );

  // Horizontal: clamp left so the popover fits inside the viewport. The
  // 8px floor matches the existing `Math.max(8, anchorRect.left)`.
  const maxLeft = Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width);
  const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN_PX, anchorRect.left));
  return { top, left };
}

export interface UseHoverPopoverOptions {
  /** Milliseconds the anchor must be hovered before the popover opens. */
  showDelayMs?: number;
  /** Milliseconds after the cursor leaves both the anchor and the
   *  popover before the popover closes. The window allows the cursor
   *  to traverse the visual gap between anchor and popover via the
   *  hover-bridge `::after` pseudo-element + `onPopoverEnter`. */
  hideDelayMs?: number;
}

export interface HoverPopoverHandle<T> {
  /** Current payload, or null when closed. */
  state: T | null;
  /** Start the show timer. If a hide is pending, cancels it. */
  scheduleOpen(payload: T): void;
  /** Open immediately. For keyboard focus / click / programmatic
   *  triggers where the hover-delay reads as latency. */
  openNow(payload: T): void;
  /** Open with showDelayMs if no popover is currently showing, else
   *  swap immediately. Models "intent to open" being already established —
   *  hovering from cite A to cite B should switch instantly because the
   *  user already proved they want a popover to be visible. */
  showOrSnap(payload: T): void;
  /** Start the hide timer. Cancels any pending show. */
  scheduleClose(): void;
  /** Close immediately + clear timers. */
  closeNow(): void;
  /** Cancel any pending hide (cursor crossed the hover-bridge into
   *  the popover). */
  cancelClose(): void;
}

/**
 * Hover popover state machine. Encapsulates the four lifecycle
 * concerns that previously lived inline in `section-view.tsx`:
 *
 *   • Show / hide timers (configurable; default to the values used in
 *     section-view today so behavior is unchanged for the citation
 *     popover consumer).
 *   • Escape key → close immediately. Listener mounted for the hook's
 *     lifetime so Escape works during the pending-show window too, not
 *     just after the popover has rendered. Single listener per section
 *     is cheap.
 *   • Window scroll → close immediately (the anchor element's rect at
 *     hover time becomes stale when the user scrolls). Capture phase
 *     so scrolls in inner containers (the section body itself) are
 *     caught even though they don't bubble through normal phase.
 *   • Hover bridge → `cancelClose()` lets the popover stay open when
 *     the cursor crosses the 6px gap into it; `scheduleClose()` on
 *     popover mouseleave re-arms the hide.
 *
 * Both timers and listeners clean up on unmount.
 */
export function useHoverPopover<T>(opts: UseHoverPopoverOptions = {}): HoverPopoverHandle<T> {
  const showDelayMs = opts.showDelayMs ?? POPOVER_SHOW_DELAY_MS;
  const hideDelayMs = opts.hideDelayMs ?? POPOVER_HIDE_DELAY_MS;

  const [state, setState] = useState<T | null>(null);
  // Mirror state into a ref so showOrSnap (whose callback identity must
  // stay stable) can read the latest state without a closure over a
  // stale render.
  const stateRef = useRef<T | null>(null);
  stateRef.current = state;
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShow = useCallback(() => {
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);
  const clearHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(
    (payload: T) => {
      clearShow();
      clearHide();
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        setState(payload);
      }, showDelayMs);
    },
    [showDelayMs, clearShow, clearHide],
  );

  const openNow = useCallback(
    (payload: T) => {
      clearShow();
      clearHide();
      setState(payload);
    },
    [clearShow, clearHide],
  );

  const showOrSnap = useCallback(
    (payload: T) => {
      if (stateRef.current !== null) {
        // A popover is already showing — intent-to-open is established,
        // swap content immediately. Matches VS Code / GitHub tooltip
        // semantics on cross-anchor hover.
        clearShow();
        clearHide();
        setState(payload);
      } else {
        clearShow();
        clearHide();
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          setState(payload);
        }, showDelayMs);
      }
    },
    [showDelayMs, clearShow, clearHide],
  );

  const scheduleClose = useCallback(() => {
    clearShow();
    clearHide();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setState(null);
    }, hideDelayMs);
  }, [hideDelayMs, clearShow, clearHide]);

  const closeNow = useCallback(() => {
    clearShow();
    clearHide();
    setState(null);
  }, [clearShow, clearHide]);

  const cancelClose = useCallback(() => {
    clearHide();
  }, [clearHide]);

  // Escape — always mounted. One listener per section is negligible vs
  // the simplicity of "Escape always works, including during the show
  // delay before the popover renders." Previously the listener was
  // gated by `state !== null`, which meant pressing Escape mid-hover
  // (before the 400ms show delay completed) was a silent no-op.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        clearShow();
        clearHide();
        setState(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clearShow, clearHide]);

  // Scroll — always mounted, capture-phase. Scroll events don't bubble
  // through the normal phase, and the popover anchors to an ancestor
  // scroller, not the window directly; capturing at the window catches
  // both. The listener is a no-op when closed (setState(null) on null
  // is idempotent in React) so the always-on cost is just dispatch
  // overhead.
  useEffect(() => {
    function onScroll() {
      clearShow();
      clearHide();
      setState(null);
    }
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [clearShow, clearHide]);

  useEffect(
    () => () => {
      clearShow();
      clearHide();
    },
    [clearShow, clearHide],
  );

  return { state, scheduleOpen, openNow, showOrSnap, scheduleClose, closeNow, cancelClose };
}

/**
 * Position a fixed-position popover relative to its anchor element,
 * with a measure-and-flip step that re-runs when the anchor changes.
 *
 * The popover renders once at the natural-below position (height = 0
 * fallback), then this useLayoutEffect measures the real height and
 * re-positions — flipping above the anchor if the natural position
 * would overflow the bottom edge. useLayoutEffect fires synchronously
 * before paint, so the user never sees the unmeasured position.
 *
 * Re-runs only when `anchorElement` changes — popover content changes
 * inside one popover instance don't reposition (the popover's CSS
 * caps the excerpt height, so content swaps don't change overall
 * popover height).
 */
export function usePopoverPosition(
  anchorElement: HTMLElement | null,
  popoverRef: React.RefObject<HTMLElement | null>,
): { top: number; left: number } {
  const [pos, setPos] = useState<{ top: number; left: number }>(() => {
    if (!anchorElement) return { top: 0, left: 0 };
    return computeHoverPosition(anchorElement.getBoundingClientRect());
  });
  useLayoutEffect(() => {
    if (!anchorElement) return;
    const el = popoverRef.current;
    const height = el ? el.offsetHeight : 0;
    const rect = anchorElement.getBoundingClientRect();
    setPos(computeHoverPosition(rect, { height }));
  }, [anchorElement, popoverRef]);
  return pos;
}
