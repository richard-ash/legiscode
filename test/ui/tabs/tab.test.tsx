// @vitest-environment jsdom
/// <reference lib="dom" />

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeStateWithRefs, refA, refB, TabHost } from "./helpers";

describe("Tab — per-tab markup", () => {
  it("includes the section icon span with data-kind=section (icon-color CSS selector hook)", () => {
    render(<TabHost initial={makeStateWithRefs([refA])} />);
    const tab = screen.getByRole("tab");
    expect(tab).toHaveAttribute("data-kind", "section");
    expect(tab.querySelector(".lc-tab-ico")).not.toBeNull();
  });

  it("uses U+00B7 MIDDLE DOT (not em-dash) as the title separator", () => {
    render(<TabHost initial={makeStateWithRefs([refA])} />);
    const tab = screen.getByRole("tab");
    // refA = 10.04.020 "Sales tax" — verify the middle dot specifically.
    expect(tab.textContent).toContain("·");
    expect(tab.textContent).not.toContain("—");
  });

  it("active tab carries .is-active class + aria-selected=true", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    // refB is active (idx 1, last opened).
    expect(tabs[1]?.className).toContain("is-active");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]?.className).not.toContain("is-active");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
  });

  it("native `title` attr carries the full title for native hover tooltip on truncation", () => {
    render(<TabHost initial={makeStateWithRefs([refA])} />);
    const tab = screen.getByRole("tab");
    // The title attribute is the full unellipsized text.
    expect(tab.getAttribute("title")).toMatch(/Sales tax/);
  });

  it("close button on the active tab is keyboard-reachable (tabIndex=0)", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    // refB is active (idx 1, last opened).
    const activeCloseBtn = tabs[1]?.querySelector(".lc-tab-close");
    expect(activeCloseBtn).not.toBeNull();
    expect(activeCloseBtn?.getAttribute("tabindex")).toBe("0");
  });

  it("close button on inactive tabs is removed from the tab order (codex review #4)", () => {
    // Inactive tabs' close buttons sit at opacity:0 — without the
    // roving tabIndex, keyboard users would Tab onto invisible
    // controls and focus would appear to vanish.
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    const inactiveCloseBtn = tabs[0]?.querySelector(".lc-tab-close");
    expect(inactiveCloseBtn).not.toBeNull();
    expect(inactiveCloseBtn?.getAttribute("tabindex")).toBe("-1");
  });
});
