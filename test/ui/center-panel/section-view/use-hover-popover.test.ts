// @vitest-environment jsdom
//
// Hover-popover lifecycle (D5 extraction). Per the test-each-path-once
// rule, lifecycle behavior lives ONLY here; consumers (citation
// popover in section-view, defined-term button) test only their
// consumer-specific concerns. Covers show/hide timing, snap-on-switch,
// Escape (including during the pending-show window), scroll dismiss,
// hover-bridge cancel, and the right-edge clamp + bottom-edge flip.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeHoverPosition,
  POPOVER_HIDE_DELAY_MS,
  POPOVER_SHOW_DELAY_MS,
  useHoverPopover,
} from "@/ui/center-panel/section-view/use-hover-popover";

describe("useHoverPopover — show / hide timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scheduleOpen waits showDelayMs before setting state", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    expect(result.current.state).toBeNull();
    act(() => {
      result.current.scheduleOpen({ id: "a" });
    });
    // Right before the delay completes, still closed.
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS - 1);
    });
    expect(result.current.state).toBeNull();
    // After the delay completes, open.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toEqual({ id: "a" });
  });

  it("scheduleClose waits hideDelayMs before clearing", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "b" });
    });
    expect(result.current.state).toEqual({ id: "b" });
    act(() => {
      result.current.scheduleClose();
    });
    expect(result.current.state).toEqual({ id: "b" });
    act(() => {
      vi.advanceTimersByTime(POPOVER_HIDE_DELAY_MS);
    });
    expect(result.current.state).toBeNull();
  });

  it("cancelClose stops a pending hide (hover-bridge behavior)", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "c" });
      result.current.scheduleClose();
      result.current.cancelClose();
    });
    act(() => {
      vi.advanceTimersByTime(POPOVER_HIDE_DELAY_MS * 2);
    });
    expect(result.current.state).toEqual({ id: "c" });
  });

  it("openNow cancels a pending close", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "d1" });
      result.current.scheduleClose();
      result.current.openNow({ id: "d2" });
    });
    act(() => {
      vi.advanceTimersByTime(POPOVER_HIDE_DELAY_MS * 2);
    });
    expect(result.current.state).toEqual({ id: "d2" });
  });
});

describe("useHoverPopover — showOrSnap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The intent-to-open delay (400ms) applies to the FIRST popover the
  // user wants to see. Once any popover is showing, subsequent hovers
  // should swap content immediately — moving the cursor from cite A
  // to cite B shouldn't make the user wait another 400ms.
  it("waits showDelayMs on the first call (state is null)", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.showOrSnap({ id: "first" });
    });
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS - 1);
    });
    expect(result.current.state).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toEqual({ id: "first" });
  });

  it("snaps immediately when a popover is already showing (state is not null)", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "first" });
    });
    expect(result.current.state).toEqual({ id: "first" });
    act(() => {
      result.current.showOrSnap({ id: "second" });
    });
    // No timer advance — should already have swapped.
    expect(result.current.state).toEqual({ id: "second" });
  });

  it("cancels a pending close when snapping to a new payload", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "first" });
      result.current.scheduleClose();
      result.current.showOrSnap({ id: "second" });
    });
    act(() => {
      vi.advanceTimersByTime(POPOVER_HIDE_DELAY_MS * 2);
    });
    expect(result.current.state).toEqual({ id: "second" });
  });
});

describe("useHoverPopover — Escape and scroll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Escape closes an open popover immediately", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "e" });
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.state).toBeNull();
  });

  it("Escape during the pending-show window cancels the open (listener mounted always)", () => {
    // Previously the Escape listener was gated by `state !== null`,
    // so pressing Escape mid-hover (before the 400ms show delay
    // completed) was a silent no-op. With the always-mounted
    // listener, Escape cancels the pending show too.
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.scheduleOpen({ id: "pending" });
    });
    // Escape fires before the show delay completes.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    // Advance past the original show delay — nothing should open.
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS * 2);
    });
    expect(result.current.state).toBeNull();
  });

  it("window scroll closes an open popover immediately (capture-phase)", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "s" });
    });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.state).toBeNull();
  });

  it("Escape after close is a safe no-op (state stays null)", () => {
    const { result } = renderHook(() => useHoverPopover<{ id: string }>());
    act(() => {
      result.current.openNow({ id: "l" });
      result.current.closeNow();
    });
    expect(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    }).not.toThrow();
    expect(result.current.state).toBeNull();
  });
});

describe("computeHoverPosition — right-edge clamp", () => {
  it("uses anchor.left when the popover fits in the viewport", () => {
    const rect = makeRect({ left: 50, bottom: 100 });
    // Force a wide viewport so no clamp is required.
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    expect(computeHoverPosition(rect)).toEqual({ top: 106, left: 50 });
  });

  it("clamps the left coord so the popover fits at narrow viewport widths", () => {
    const rect = makeRect({ left: 700, bottom: 100 });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const { left } = computeHoverPosition(rect);
    // innerWidth - 368 = 432; clamp pulls the popover left.
    expect(left).toBe(432);
  });

  it("respects the 8px left-floor when the anchor sits at the viewport edge", () => {
    const rect = makeRect({ left: 0, bottom: 100 });
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    expect(computeHoverPosition(rect).left).toBe(8);
  });
});

describe("computeHoverPosition — vertical flip", () => {
  // The popover naturally opens below the anchor with a 6px gap. If
  // the popover's measured height would push it past the bottom edge,
  // flip above the anchor — but only when there's room above. Falling
  // back to natural-below when neither side fits keeps the popover at
  // least partially visible.

  it("uses natural below-anchor position when there's room", () => {
    const rect = makeRect({ left: 50, top: 100, bottom: 120 });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    expect(computeHoverPosition(rect, { height: 150 }).top).toBe(126);
  });

  it("flips above the anchor when below would overflow and above fits", () => {
    // Anchor near the bottom of an 800px viewport, 200px popover height
    // would land at top=706+200=906, past the 800-8=792 limit.
    const rect = makeRect({ left: 50, top: 700, bottom: 720 });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    // Flipped: top = anchor.top - gap - height = 700 - 6 - 200 = 494.
    expect(computeHoverPosition(rect, { height: 200 }).top).toBe(494);
  });

  it("falls back to natural below when neither below nor above fits, clamped to 8px floor", () => {
    // Tiny viewport that can't contain the popover either way.
    const rect = makeRect({ left: 50, top: 50, bottom: 70 });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 200, configurable: true });
    // Below overflows: 76 + 300 = 376 > 192. Above doesn't fit either:
    // 50 - 6 - 300 = -256 < 8. Falls back to natural-below clamped to
    // the 8px floor… but natural-below is 76, well above 8, so 76 wins.
    expect(computeHoverPosition(rect, { height: 300 }).top).toBe(76);
  });
});

function makeRect(opts: { left: number; bottom: number; top?: number }): DOMRect {
  const top = opts.top ?? opts.bottom - 20;
  return {
    top,
    bottom: opts.bottom,
    left: opts.left,
    right: opts.left + 100,
    width: 100,
    height: opts.bottom - top,
    x: opts.left,
    y: top,
    toJSON: () => ({}),
  };
}
