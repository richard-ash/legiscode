// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OpenItemsState } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

describe("TabStrip — tablist arrow / Home / End nav", () => {
  it("ArrowRight wraps at end", () => {
    const states: OpenItemsState[] = [];
    render(<TabHost initial={makeStateWithRefs([refA, refB])} onState={(s) => states.push(s)} />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    // refB was active (idx 1); ArrowRight wraps to 0.
    expect(states.at(-1)?.activeIndex).toBe(0);
  });

  it("ArrowLeft wraps at start", () => {
    const states: OpenItemsState[] = [];
    render(<TabHost initial={makeStateWithRefs([refA, refB])} onState={(s) => states.push(s)} />);
    // First, switch to refA so we're at idx 0; then ArrowLeft should wrap to idx 1.
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" }); // 1 → 0
    fireEvent.keyDown(list, { key: "ArrowLeft" }); // 0 → 1 (wrap)
    expect(states.at(-1)?.activeIndex).toBe(1);
  });

  it("Home → first tab, End → last tab", () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "Home" });
    expect(states.at(-1)?.activeIndex).toBe(0);
    fireEvent.keyDown(list, { key: "End" });
    expect(states.at(-1)?.activeIndex).toBe(2);
  });

  it("active tab carries tabIndex=0; inactive tabs carry tabIndex=-1 (roving)", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    // refB is active (idx 1) because openItem activates on append.
    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(tabs[1]).toHaveAttribute("tabindex", "0");
  });

  it("aria-orientation horizontal + aria-label set on the tablist", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
    expect(list).toHaveAttribute("aria-label", "Open sections");
  });
});
