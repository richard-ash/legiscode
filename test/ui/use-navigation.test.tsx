// @vitest-environment jsdom
/// <reference lib="dom" />

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parse as corpusRefParse } from "@/corpus/refs";
import { useNavigation } from "@/ui/use-navigation";
import { emptyOpenItems, type OpenItem, type OpenItemsState } from "@/workbench";

const refA = corpusRefParse({ module: "sf-port", section: "1.1" });
const refB = corpusRefParse({ module: "sf-port", section: "1.2" });
const refC = corpusRefParse({ module: "sf-port", section: "1.3" });
const itemA: OpenItem = { kind: "section", ref: refA };
const itemB: OpenItem = { kind: "section", ref: refB };
const itemC: OpenItem = { kind: "section", ref: refC };

interface Host {
  getState: () => OpenItemsState;
  setState: (update: (prev: OpenItemsState) => OpenItemsState) => void;
}

function makeHost(initial: OpenItemsState = emptyOpenItems()): Host {
  let state = initial;
  return {
    getState: () => state,
    setState: (update) => {
      state = update(state);
    },
  };
}

function renderUseNavigation(host: Host = makeHost()) {
  return renderHook(({ openItems }) => useNavigation({ openItems, setOpenItems: host.setState }), {
    initialProps: { openItems: host.getState() },
  });
}

describe("useNavigation — navigate", () => {
  it("primary intent on a fresh item opens + activates a new tab", () => {
    const host = makeHost();
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemA, "primary"));
    rerender({ openItems: host.getState() });
    expect(host.getState()).toEqual({ items: [itemA], activeIndex: 0 });
  });

  it("primary intent on an already-open item activates that tab", () => {
    const host = makeHost({ items: [itemA, itemB], activeIndex: 1 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemA, "primary"));
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(0);
    expect(host.getState().items).toEqual([itemA, itemB]);
  });

  it("background intent appends a tab without switching", () => {
    const host = makeHost({ items: [itemA], activeIndex: 0 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemB, "background"));
    rerender({ openItems: host.getState() });
    expect(host.getState()).toEqual({ items: [itemA, itemB], activeIndex: 0 });
  });

  it("background intent is a no-op when the item is already open", () => {
    const host = makeHost({ items: [itemA, itemB], activeIndex: 0 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemB, "background"));
    rerender({ openItems: host.getState() });
    expect(host.getState()).toEqual({ items: [itemA, itemB], activeIndex: 0 });
  });
});

describe("useNavigation — pendingScroll", () => {
  it("primary nav with subsection sets pendingScroll for the destination", () => {
    const host = makeHost();
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemA, "primary", { subsection: "(a)" }));
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).toEqual({
      subsection: "(a)",
      targetSectionKey: "sf-port::1.1",
    });
  });

  it("background nav does not set pendingScroll", () => {
    const host = makeHost({ items: [itemA], activeIndex: 0 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemB, "background", { subsection: "(a)" }));
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).toBeNull();
  });

  it("primary nav without subsection clears stale pendingScroll", () => {
    const host = makeHost();
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemA, "primary", { subsection: "(a)" }));
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).not.toBeNull();
    act(() => result.current.navigate(itemB, "primary"));
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).toBeNull();
  });

  it("consumePendingScroll clears the pending target", () => {
    const host = makeHost();
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.navigate(itemA, "primary", { subsection: "(a)" }));
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).not.toBeNull();
    act(() => result.current.consumePendingScroll());
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).toBeNull();
  });

  it("requestScroll sets the pending target without changing tabs", () => {
    const host = makeHost({ items: [itemA], activeIndex: 0 });
    const { result, rerender } = renderUseNavigation(host);
    act(() =>
      result.current.requestScroll({ subsection: "(b)", targetSectionKey: "sf-port::1.1" }),
    );
    rerender({ openItems: host.getState() });
    expect(result.current.pendingScroll).toEqual({
      subsection: "(b)",
      targetSectionKey: "sf-port::1.1",
    });
    expect(host.getState().activeIndex).toBe(0);
  });
});

describe("useNavigation — prevTab / nextTab", () => {
  it("nextTab moves to the next tab", () => {
    const host = makeHost({ items: [itemA, itemB, itemC], activeIndex: 0 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.nextTab());
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(1);
  });

  it("prevTab moves to the previous tab", () => {
    const host = makeHost({ items: [itemA, itemB, itemC], activeIndex: 2 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.prevTab());
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(1);
  });

  it("nextTab wraps from the last tab to the first", () => {
    const host = makeHost({ items: [itemA, itemB, itemC], activeIndex: 2 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.nextTab());
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(0);
  });

  it("prevTab wraps from the first tab to the last", () => {
    const host = makeHost({ items: [itemA, itemB, itemC], activeIndex: 0 });
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.prevTab());
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(2);
  });

  it("prevTab / nextTab no-op when there are no tabs", () => {
    const host = makeHost();
    const { result, rerender } = renderUseNavigation(host);
    act(() => result.current.nextTab());
    rerender({ openItems: host.getState() });
    expect(host.getState()).toEqual(emptyOpenItems());
  });
});

describe("useNavigation — ⌘⌥← / ⌘⌥→ keyboard", () => {
  it("⌘⌥→ switches to the next tab", () => {
    const host = makeHost({ items: [itemA, itemB, itemC], activeIndex: 0 });
    const { rerender } = renderUseNavigation(host);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, altKey: true }),
      );
    });
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(1);
  });

  it("⌘⌥← switches to the previous tab", () => {
    const host = makeHost({ items: [itemA, itemB, itemC], activeIndex: 2 });
    const { rerender } = renderUseNavigation(host);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, altKey: true }),
      );
    });
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(1);
  });

  it("arrow keys without ⌥ are ignored", () => {
    const host = makeHost({ items: [itemA, itemB], activeIndex: 0 });
    const { rerender } = renderUseNavigation(host);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, altKey: false }),
      );
    });
    rerender({ openItems: host.getState() });
    expect(host.getState().activeIndex).toBe(0);
  });
});
