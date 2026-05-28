// @vitest-environment jsdom
/// <reference lib="dom" />

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as corpusRefParse } from "@/corpus/refs";
import { useTabs } from "@/ui/tabs/use-tabs";
import type { NavigationIntent } from "@/workbench/navigate";
import {
  emptyOpenItems,
  type OpenItem,
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

/** Test stand-in for the useNavigation `navigate` primitive. Routes
 *  section items through `openItem` on the host's state — sufficient to
 *  exercise `reopenLast`, which only ever issues `navigate(item, "primary")`. */
function makeFakeNavigate(host: HostHandle) {
  return (item: OpenItem, _intent: NavigationIntent) => {
    if (item.kind === "section") {
      host.setState((prev) => openItem(prev, item.ref));
      return;
    }
    // chat tabs aren't produced today; the production navigate will route
    // them when feat/ai-agent lands.
  };
}

describe("useTabs — recentlyClosed buffer mutation", () => {
  it("close() pushes the closed ref onto the head of the buffer (LIFO)", () => {
    const host = makeHost();
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
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
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
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
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
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
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
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
      useTabs({
        openItems: host.getState(),
        setOpenItems: host.setState,
        navigate: makeFakeNavigate(host),
      }),
    );
    act(() => result.current.reopenLast());
    expect(result.current.recentlyClosed).toHaveLength(0);
  });

  it("basic — pop head + append + activate", () => {
    const host = makeHost(makeStateWithRefs([refA, refB]));
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
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
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
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

describe("useTabs — bulk-close wrappers", () => {
  function refSection(item: OpenItem): string {
    return item.kind === "section" ? item.ref.section : item.kind;
  }

  it("closeOthers(keep) drops the rest; pushes the dropped active first, then others in order", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC])); // active = C (idx 2)
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeOthers(0)); // keep refA, drop B + C
    rerender({ openItems: host.getState() });
    expect(host.getState().items.map(refSection)).toEqual(["a"]);
    expect(host.getState().activeIndex).toBe(0);
    // Active (C) goes to head; then remaining dropped (B) in display order.
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["c", "b"]);
  });

  it("closeOthers(activeIdx) — active is kept; dropped tabs land in display order", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC])); // active = C
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeOthers(2)); // keep C
    rerender({ openItems: host.getState() });
    expect(host.getState().items.map(refSection)).toEqual(["c"]);
    // Active wasn't dropped → no head bias; A and B land in display order.
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["a", "b"]);
  });

  it("closeToRight(idx) drops items right of idx; active head-bias when active was to the right", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC])); // active = C
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeToRight(0)); // keep A; drop B + C
    rerender({ openItems: host.getState() });
    expect(host.getState().items.map(refSection)).toEqual(["a"]);
    // C was active and gets dropped → head; then B in display order.
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["c", "b"]);
  });

  it("closeAll empties the strip; buffer = active first, then remaining in display order", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC])); // active = C
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeAll());
    rerender({ openItems: host.getState() });
    expect(host.getState().items).toEqual([]);
    expect(host.getState().activeIndex).toBeNull();
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["c", "a", "b"]);
  });

  it("closeAll honors the 10-item buffer cap and surfaces the active tab at the head", () => {
    const refs = Array.from({ length: 15 }, (_, i) =>
      corpusRefParse({ module: "m", section: `s${i}` }),
    );
    const host = makeHost(makeStateWithRefs(refs));
    // Force active to idx 7 deterministically.
    host.setState((prev) => ({ ...prev, activeIndex: 7 }));
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeAll());
    rerender({ openItems: host.getState() });
    expect(result.current.recentlyClosed).toHaveLength(10);
    // Head = the active tab (s7) — reverse-active-recency.
    expect(refSection(result.current.recentlyClosed[0]!)).toBe("s7");
  });

  it("closeAll pre-pends to an existing buffer; bulk items lead, prior buffer trails (capped)", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC]));
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    // Seed the buffer with a single prior close.
    act(() => result.current.close(0)); // close refA
    rerender({ openItems: host.getState() });
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["a"]);
    // Now closeAll on [B, C*] — bulk pushes C (active) then B, then refA from prior.
    act(() => result.current.closeAll());
    rerender({ openItems: host.getState() });
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["c", "b", "a"]);
  });

  it("closeOthers is a no-op when the only tab is already the kept one", () => {
    const host = makeHost(makeStateWithRefs([refA]));
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeOthers(0));
    rerender({ openItems: host.getState() });
    expect(host.getState().items.map(refSection)).toEqual(["a"]);
    expect(result.current.recentlyClosed).toEqual([]);
  });

  it("closeToRight is a no-op when the rightmost is already the anchor", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC])); // active = C
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeToRight(2));
    rerender({ openItems: host.getState() });
    expect(host.getState().items.map(refSection)).toEqual(["a", "b", "c"]);
    expect(result.current.recentlyClosed).toEqual([]);
  });

  it("closeAll is a no-op when the strip is already empty (early-return path)", () => {
    const host = makeHost(makeStateWithRefs([])); // empty
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeAll());
    rerender({ openItems: host.getState() });
    expect(host.getState().items).toEqual([]);
    // No items dropped → no buffer push (the early-return short-circuits
    // before `mergeBulkClosed` runs).
    expect(result.current.recentlyClosed).toEqual([]);
  });

  it("bulk-close with activeIndex null pushes dropped items in display order (no head bias)", () => {
    const host = makeHost(makeStateWithRefs([refA, refB, refC]));
    // Force activeIndex null so collectClosedForBulk skips the head-bias branch.
    host.setState((prev) => ({ ...prev, activeIndex: null }));
    const { result, rerender } = renderHook(
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.closeAll());
    rerender({ openItems: host.getState() });
    expect(host.getState().items).toEqual([]);
    // No active tab → ordering is pure display order, no reverse-active-recency.
    expect(result.current.recentlyClosed.map(refSection)).toEqual(["a", "b", "c"]);
  });
});

// external-citation OpenItem variant was removed in
// feat/citation-resolution; popover handles cross-module-not-installed
// cites without opening a separate tab. The buffer participation tests
// for that variant came out with it.

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
      useTabs({
        openItems: host.getState(),
        setOpenItems: host.setState,
        navigate: makeFakeNavigate(host),
      }),
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
      useTabs({
        openItems: host.getState(),
        setOpenItems: host.setState,
        navigate: makeFakeNavigate(host),
      }),
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
      useTabs({
        openItems: host.getState(),
        setOpenItems: host.setState,
        navigate: makeFakeNavigate(host),
      }),
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
          navigate: makeFakeNavigate(host),
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
          navigate: makeFakeNavigate(host),
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
      ({ openItems }) =>
        useTabs({ openItems, setOpenItems: host.setState, navigate: makeFakeNavigate(host) }),
      { initialProps: { openItems: host.getState() } },
    );
    act(() => result.current.close(0));
    rerender({ openItems: host.getState() });
    const direct = workbenchCloseItem(makeStateWithRefs([refA, refB]), 0);
    expect(host.getState().items).toHaveLength(direct.items.length);
    expect(host.getState().activeIndex).toBe(direct.activeIndex);
  });
});
