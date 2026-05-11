// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OpenItemsState } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

describe("TabStrip — overflow + scroll-into-view", () => {
  it("strip uses overflow-x:auto + scrollbar-width:none (visual via class)", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("lc-tabs");
  });

  it("scrollIntoView fires on the active tab whenever activeIndex changes (CQ9)", () => {
    const calls: string[] = [];
    // Capture scrollIntoView before each render so the spy attaches to every node.
    const origDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: function (_arg: unknown) {
        // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
        const idx = (this as any).getAttribute?.("data-index");
        if (idx != null) calls.push(String(idx));
      },
    });
    try {
      const states: OpenItemsState[] = [];
      render(
        <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
      );
      // Initial render: refC is active (idx 2) — useLayoutEffect fires.
      expect(calls).toContain("2");
      // Switch to refA via tablist nav (Home).
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "Home" });
      expect(calls).toContain("0");
    } finally {
      if (origDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", origDescriptor);
      } else {
        (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = undefined;
      }
    }
    // Suppress vi unused warning.
    vi.clearAllMocks();
  });
});
