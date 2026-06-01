// Generic vertical (horizontal-axis) splitter. Sits between a top and a
// bottom pane and reports the bottom pane's share of the container as a
// fraction in [min, max]. The container owns the flex distribution; this
// component just emits position changes via `onChange`.
//
// ARIA: role="separator" + aria-orientation="horizontal" because the
// separator itself is a horizontal bar (the axis being adjusted is
// vertical). aria-valuenow reflects the bottom pane's percentage. Arrow
// keys nudge by 5%; Home/End jump to min/max.
//
// Drag: a pointermove on `document` while the splitter holds capture
// keeps tracking even when the cursor leaves the strip. `min` / `max`
// clamp the report so the container's flex layout never goes negative.

import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef } from "react";

export interface SplitterProps {
  /** Current bottom-pane share, in [min, max]. */
  value: number;
  /** Reported during drag (every pointermove) and on arrow-key nudges. */
  onChange: (next: number) => void;
  /** Fires once when a drag ends — the caller debounces persistence on
   *  this signal so localStorage writes don't thrash during the drag. */
  onCommit?: (final: number) => void;
  /** Minimum bottom-pane share. Default 0.2. */
  min?: number;
  /** Maximum bottom-pane share. Default 0.8. */
  max?: number;
  /** Arrow-key nudge increment. Default 0.05 (5%). */
  step?: number;
  /** Accessible label for the separator. */
  ariaLabel: string;
  /** Element id this separator controls (the bottom pane), exposed via
   *  aria-controls so assistive tech can announce the relationship. */
  ariaControls?: string;
}

export function Splitter({
  value,
  onChange,
  onCommit,
  min = 0.2,
  max = 0.8,
  step = 0.05,
  ariaLabel,
  ariaControls,
}: SplitterProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Refs over render-time values so the document-level pointermove handler
  // installed on pointerdown sees the latest props without re-installing.
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  const minRef = useRef(min);
  const maxRef = useRef(max);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;
  minRef.current = min;
  maxRef.current = max;

  const clamp = useCallback((n: number) => {
    if (n < minRef.current) return minRef.current;
    if (n > maxRef.current) return maxRef.current;
    return n;
  }, []);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    // Only primary button initiates a drag. Right-click / middle-click
    // fall through to the browser's defaults.
    if (e.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const parent = root.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.height <= 0) return;
    e.preventDefault();
    root.setPointerCapture(e.pointerId);
    root.dataset.dragging = "true";

    let lastNext = -1;
    const onMove = (ev: globalThis.PointerEvent) => {
      // Convert pointer Y → bottom-pane fraction. The separator sits
      // between the two panes; bottomShare = (parentBottom - pointerY) /
      // parentHeight. Clamped to [min, max] so the layout never collapses
      // a pane to zero (collapse is a separate explicit affordance).
      const share = (rect.bottom - ev.clientY) / rect.height;
      const next = clampWith(share, minRef.current, maxRef.current);
      if (next === lastNext) return;
      lastNext = next;
      onChangeRef.current(next);
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      try {
        root.releasePointerCapture(ev.pointerId);
      } catch {
        // Already released — ignore.
      }
      delete root.dataset.dragging;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (lastNext >= 0) onCommitRef.current?.(lastNext);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Up arrow grows the TOP pane → shrinks the bottom; Down arrow
      // grows the bottom. Home/End jump to min/max. Step defaults to 5%.
      let next = value;
      switch (e.key) {
        case "ArrowUp":
        case "ArrowLeft":
          next = clamp(value - step);
          break;
        case "ArrowDown":
        case "ArrowRight":
          next = clamp(value + step);
          break;
        case "Home":
          next = minRef.current;
          break;
        case "End":
          next = maxRef.current;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (next !== value) {
        onChange(next);
        onCommit?.(next);
      }
    },
    [value, step, clamp, onChange, onCommit],
  );

  const percent = Math.round(value * 100);
  return (
    // biome-ignore lint/a11y/useSemanticElements: the separator must be focusable + drag-capturing + carry aria-valuenow; <hr> is presentation-only and doesn't accept the interactivity contract this component owns.
    <div
      ref={rootRef}
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      aria-valuenow={percent}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      tabIndex={0}
      className="lc-splitter"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

function clampWith(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// Optional helper for callers that want to debounce-persist `onCommit`
// independent of `onChange`. Lets `useEffect` cleanup in tests run
// without leaking timers.
export function useDebounced<T>(value: T, ms: number, sink: (v: T) => void) {
  useEffect(() => {
    const handle = setTimeout(() => sink(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms, sink]);
}
