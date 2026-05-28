// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OpenItemsState } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

// Suppress noisy console output from useSortable in jsdom (no real DnD).
const _suppressConsole = vi.spyOn(console, "warn").mockImplementation(() => {});

describe("modifier-click on the close X", () => {
  it("plain click closes just the clicked tab", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    const closeBtn = tabs[1]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn);
    const last = states.at(-1);
    expect(last?.items).toHaveLength(2);
    // refB was at idx 1; closing shifts active C from 2 → 1.
    expect(last?.activeIndex).toBe(1);
  });

  it("Cmd-click (metaKey) on the close X dispatches Close Others", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    const closeBtn = tabs[1]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn, { metaKey: true });
    const last = states.at(-1);
    expect(last?.items).toHaveLength(1);
    expect(last?.activeIndex).toBe(0);
  });

  it("Ctrl-click on the close X also dispatches Close Others (X7 — cross-platform parity)", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    const closeBtn = tabs[1]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn, { ctrlKey: true });
    const last = states.at(-1);
    expect(last?.items).toHaveLength(1);
  });

  it("Alt-click dispatches Close to the Right", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    const closeBtn = tabs[0]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn, { altKey: true });
    const last = states.at(-1);
    expect(last?.items).toHaveLength(1);
    expect(last?.activeIndex).toBe(0);
  });

  it("Cmd+Alt-click resolves to Close Others (modifier precedence)", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    const closeBtn = tabs[1]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn, { metaKey: true, altKey: true });
    const last = states.at(-1);
    // Close Others on idx 1 → [B] survives.
    expect(last?.items).toHaveLength(1);
  });

  it("modifier-click on the close X does not first activate the inactive tab", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    // refA at idx 0 is inactive (refC active at idx 2). Cmd-click its X.
    const closeBtn = tabs[0]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn, { metaKey: true });
    // No intermediate render should show "still 3 tabs but active flipped
    // to idx 0" — the close-X stopPropagation must hold under modifier
    // clicks too. The terminal state after closeOthers(0) is items.length
    // === 1 with the survivor at idx 0; that's correct, not a leak.
    for (const s of states) {
      if (s.items.length === 3) expect(s.activeIndex).not.toBe(0);
    }
  });
});
