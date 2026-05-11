// @vitest-environment jsdom
/// <reference lib="dom" />

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as corpusRefParse } from "@/corpus/refs";
import { useTabs } from "@/ui/tabs/use-tabs";
import {
  emptyOpenItems,
  type OpenItemsState,
  openItem,
  closeItem as workbenchCloseItem,
} from "@/workbench/open-items";

const refA = corpusRefParse({ module: "m", section: "a" });
const refB = corpusRefParse({ module: "m", section: "b" });
const refC = corpusRefParse({ module: "m", section: "c" });

function makeStateWithRefs(refs = [refA, refB, refC]) {
  let state: OpenItemsState = emptyOpenItems();
  for (const r of refs) state = openItem(state, r);
  return state;
}

interface HostHandle {
  getState: () => OpenItemsState;
  setState: (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => void;
}

function makeHost(initial = makeStateWithRefs()): HostHandle {
  let state = initial;
  return {
    getState: () => state,
    setState: (update) => {
      state = typeof update === "function" ? update(state) : update;
    },
  };
}

describe("useTabs — recentlyClosed buffer mutation", () => {
  it("close() pushes the closed ref onto the head of the buffer (LIFO)", () => {
    const host = makeHost();
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.close(0));
    // host state mutated; mirror back to the hook via rerender.
    rerender({ openItems: host.getState() });
    expect(host.getState().items).toHaveLength(2);
    expect(result.current.recentlyClosed).toHaveLength(1);
  });

  it("LIFO cap drops the oldest entry past 10", () => {
    const host = makeHost();
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    // Mock-push 12 distinct refs directly via the hook's close() — easier
    // to drive than constructing 12 sections.
    for (let i = 0; i < 12; i++) {
      const ref = corpusRefParse({ module: "m", section: `s${i}` });
      act(() => {
        host.setState((prev) => openItem(prev, ref));
      });
      rerender({ openItems: host.getState() });
      // Close head (the just-opened ref).
      act(() => result.current.close(host.getState().activeIndex ?? 0));
      rerender({ openItems: host.getState() });
    }
    expect(result.current.recentlyClosed.length).toBeLessThanOrEqual(10);
  });

  it("no dedup on push — same ref closed twice appears twice in the buffer", () => {
    const host = makeHost(makeStateWithRefs([refA]));
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.close(0));
    rerender({ openItems: host.getState() });
    // Reopen the same ref then close again.
    act(() => host.setState((prev) => openItem(prev, refA)));
    rerender({ openItems: host.getState() });
    act(() => result.current.close(host.getState().activeIndex ?? 0));
    rerender({ openItems: host.getState() });
    expect(result.current.recentlyClosed).toHaveLength(2);
  });

  it("dedup on pop — buffer head pointing at a currently-open ref is skipped", () => {
    const host = makeHost(makeStateWithRefs([refA, refB]));
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    // Close A (push onto buffer), then reopen A manually (not through the hook).
    act(() => result.current.close(0));
    rerender({ openItems: host.getState() });
    act(() => host.setState((prev) => openItem(prev, refA)));
    rerender({ openItems: host.getState() });
    // Buffer head is refA but refA is already open. reopenLast must
    // recurse past it (and empty the buffer in this single-entry case).
    act(() => result.current.reopenLast());
    rerender({ openItems: host.getState() });
    expect(result.current.recentlyClosed).toHaveLength(0);
  });
});

describe("useTabs — reopenLast", () => {
  it("empty buffer → no-op", () => {
    const host = makeHost();
    const { result } = renderHook(() =>
      useTabs({ openItems: host.getState(), setOpenItems: host.setState }),
    );
    act(() => result.current.reopenLast());
    expect(result.current.recentlyClosed).toHaveLength(0);
  });

  it("basic — pop head + append + activate", () => {
    const host = makeHost(makeStateWithRefs([refA, refB]));
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    // Close refA (index 0). Now buffer = [refA], items = [refB].
    act(() => result.current.close(0));
    rerender({ openItems: host.getState() });
    expect(host.getState().items).toHaveLength(1);
    act(() => result.current.reopenLast());
    rerender({ openItems: host.getState() });
    expect(host.getState().items).toHaveLength(2);
    expect(result.current.recentlyClosed).toHaveLength(0);
  });

  it("recurse-on-stale — skips stale entries to land on the first non-open ref", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC]));
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    // Close C, then close B. Buffer = [refB, refC]. Items = [refA].
    act(() => result.current.close(2));
    rerender({ openItems: host.getState() });
    act(() => result.current.close(1));
    rerender({ openItems: host.getState() });
    // Manually open refB so it's a stale entry at buffer head.
    act(() => host.setState((prev) => openItem(prev, refB)));
    rerender({ openItems: host.getState() });
    // reopenLast should skip refB (stale) and land on refC.
    act(() => result.current.reopenLast());
    rerender({ openItems: host.getState() });
    const sections = host
      .getState()
      .items.map((i) => (i.kind === "section" ? i.ref.section : i.kind));
    expect(sections).toContain("c");
    expect(result.current.recentlyClosed).toHaveLength(0);
  });
});

describe("useTabs — scroll position", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saveScroll(ref, y) is debounced ~100ms before commit", () => {
    const host = makeHost();
    const { result } = renderHook(() =>
      useTabs({ openItems: host.getState(), setOpenItems: host.setState }),
    );
    act(() => result.current.saveScroll(refA, 250));
    // Synchronous read before the debounce expires returns 0 (default).
    expect(result.current.getScroll(refA)).toBe(0);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.getScroll(refA)).toBe(250);
  });

  it("saveScroll re-call within debounce window collapses to the last value", () => {
    const host = makeHost();
    const { result } = renderHook(() =>
      useTabs({ openItems: host.getState(), setOpenItems: host.setState }),
    );
    act(() => result.current.saveScroll(refA, 100));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => result.current.saveScroll(refA, 400));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.getScroll(refA)).toBe(400);
  });

  it("getScroll for a never-saved ref returns 0", () => {
    const host = makeHost();
    const { result } = renderHook(() =>
      useTabs({ openItems: host.getState(), setOpenItems: host.setState }),
    );
    expect(result.current.getScroll(refB)).toBe(0);
  });
});

describe("useTabs — useRestoreScroll (codex review #3 — scroll restoration wiring)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the saved scrollTop for activeRef when sectionKey flips", () => {
    const host = makeHost();
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.scrollTop = 50; // prior tab's scroll bleed-in

    const { result, rerender } = renderHook(
      ({ activeRef, sectionKey }: { activeRef: typeof refA; sectionKey: string | null }) => {
        const tabs = useTabs({
          openItems: host.getState(),
          setOpenItems: host.setState,
        });
        tabs.useRestoreScroll(activeRef, container, sectionKey);
        return tabs;
      },
      { initialProps: { activeRef: refA, sectionKey: null as string | null } },
    );

    act(() => result.current.saveScroll(refA, 400));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // sectionKey transitions to a value → useLayoutEffect runs → restore.
    rerender({ activeRef: refA, sectionKey: "m::a" });
    expect(container.scrollTop).toBe(400);
    document.body.removeChild(container);
  });

  it("flushes the pending debounced save before reading (outgoing tab's scroll preserved)", () => {
    const host = makeHost();
    const container = document.createElement("div");
    document.body.appendChild(container);

    const { result, rerender } = renderHook(
      ({ activeRef, sectionKey }: { activeRef: typeof refA; sectionKey: string | null }) => {
        const tabs = useTabs({
          openItems: host.getState(),
          setOpenItems: host.setState,
        });
        tabs.useRestoreScroll(activeRef, container, sectionKey);
        return tabs;
      },
      { initialProps: { activeRef: refA, sectionKey: "m::a" } },
    );

    // Pending save for A — debounce not yet elapsed.
    act(() => result.current.saveScroll(refA, 300));
    act(() => {
      vi.advanceTimersByTime(20);
    });
    // Switch tabs: sectionKey changes → restore flushes A's pending save first.
    rerender({ activeRef: refB, sectionKey: "m::b" });
    expect(result.current.getScroll(refA)).toBe(300);
    document.body.removeChild(container);
  });
});

// Sanity: the workbench reducer we wrap behaves as expected — keeps the
// hook tests honest if closeItem's contract ever changes.
describe("useTabs / workbench contract", () => {
  it("close(index) mirrors closeItem(state, index) on the canonical state", () => {
    const host = makeHost(makeStateWithRefs([refA, refB]));
    const { result, rerender } = renderHook(
      ({ openItems }) => useTabs({ openItems, setOpenItems: host.setState }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.close(0));
    rerender({ openItems: host.getState() });
    const direct = workbenchCloseItem(makeStateWithRefs([refA, refB]), 0);
    expect(host.getState().items).toHaveLength(direct.items.length);
    expect(host.getState().activeIndex).toBe(direct.activeIndex);
  });
});
