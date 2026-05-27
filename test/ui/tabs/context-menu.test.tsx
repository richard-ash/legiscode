// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OpenItemsState } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

// Suppress noisy console output from useSortable in jsdom (no real DnD).
const _suppressConsole = vi.spyOn(console, "warn").mockImplementation(() => {});

describe("TabStrip — right-click bulk-close menu", () => {
  it("right-clicking a tab opens a popover with the bulk-close rows", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[1]!);
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    // Middle tab: Close + Close Others + Close to the Right + Close All.
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.querySelector(".lc-menu-row-label")?.textContent ?? "",
    );
    expect(labels).toEqual(["Close", "Close Others", "Close to the Right", "Close All Tabs"]);
  });

  it("rightmost tab omits 'Close to the Right' (S2 lock — omit, don't disable)", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[2]!); // rightmost
    const menu = await screen.findByRole("menu");
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.querySelector(".lc-menu-row-label")?.textContent ?? "",
    );
    expect(labels).toEqual(["Close", "Close Others", "Close All Tabs"]);
  });

  it("single-tab strip omits 'Close Others' and 'Close to the Right'", async () => {
    render(<TabHost initial={makeStateWithRefs([refA])} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[0]!);
    const menu = await screen.findByRole("menu");
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.querySelector(".lc-menu-row-label")?.textContent ?? "",
    );
    expect(labels).toEqual(["Close", "Close All Tabs"]);
  });

  it("clicking 'Close Others' drops every tab except the right-clicked one", async () => {
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[0]!);
    const closeOthers = await screen.findByRole("menuitem", { name: /Close Others/ });
    await user.click(closeOthers);
    const last = states.at(-1);
    expect(last?.items).toHaveLength(1);
    expect(last?.activeIndex).toBe(0);
  });

  it("clicking 'Close to the Right' drops the tabs to the right of the right-clicked tab", async () => {
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[0]!); // anchor refA
    const closeRight = await screen.findByRole("menuitem", { name: /Close to the Right/ });
    await user.click(closeRight);
    const last = states.at(-1);
    expect(last?.items).toHaveLength(1);
    // Active was on refC (idx 2) → clamps to fromIndex (0) since refC dropped.
    expect(last?.activeIndex).toBe(0);
  });

  it("clicking 'Close All Tabs' empties the strip", async () => {
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[1]!);
    const closeAllRow = await screen.findByRole("menuitem", { name: /Close All Tabs/ });
    await user.click(closeAllRow);
    const last = states.at(-1);
    expect(last?.items).toEqual([]);
    expect(last?.activeIndex).toBeNull();
  });

  it("Escape closes the popover", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[0]!);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking outside the popover closes it without dispatching a row action", async () => {
    const states: OpenItemsState[] = [];
    render(<TabHost initial={makeStateWithRefs([refA, refB])} onState={(s) => states.push(s)} />);
    const stateCountBeforeOpen = states.length;
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[0]!);
    await screen.findByRole("menu");
    // Click an empty region — body.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    // No new state mutations from a row dispatch.
    expect(states.length).toBe(stateCountBeforeOpen);
  });

  it("arrow keys navigate rows via the roving tabindex", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[1]!);
    const menu = await screen.findByRole("menu");
    const rows = menu.querySelectorAll('[role="menuitem"]');
    // Initial focus lands on row 0 (Close).
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
    // End → last row.
    fireEvent.keyDown(rows[0]!, { key: "End" });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });

  it("Shift+F10 opens the menu without a mouse (WCAG 2.1.1 keyboard parity)", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    tabs[1]?.focus();
    fireEvent.keyDown(tabs[1]!, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("ContextMenu key opens the menu (WCAG 2.1.1 keyboard parity)", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    tabs[1]?.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("clicking 'Close' on the right-clicked tab drops just that tab (menu's single-tab close path)", async () => {
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[1]!); // anchor refB
    const menu = await screen.findByRole("menu");
    // Direct lookup — accessible-name regex matching is brittle when
    // multiple rows start with "Close" (Close, Close Others, Close All).
    const closeRow = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.querySelector(".lc-menu-row-label")?.textContent === "Close",
    ) as HTMLElement | undefined;
    if (!closeRow) throw new Error("Close row not found");
    await user.click(closeRow);
    const last = states.at(-1);
    // refB dropped; refA + refC remain.
    expect(last?.items).toHaveLength(2);
  });

  it("popover auto-closes when the right-clicked tab is closed via another path (⌘W)", async () => {
    // Open the popover on refC (idx 2, also active). Fire ⌘W which closes
    // the active tab — index 2 vanishes, so the popover anchored to that
    // index must clean itself up rather than stranding a stale anchor.
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[2]!);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // Simulate the index disappearing — close the tab the menu pointed at.
    // The strip's existing test helper does not expose ⌘W; close-X click
    // on refC is the equivalent observable mutation.
    const closeBtn = tabs[2]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeBtn);
    // Two tabs remain; the popover must be gone (its index 2 no longer exists).
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Enter activates the focused row (keyboard equivalent of click)", async () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[1]!); // anchor refB
    const menu = await screen.findByRole("menu");
    const rows = menu.querySelectorAll('[role="menuitem"]');
    // Arrow to "Close All Tabs" (last row) then Enter.
    fireEvent.keyDown(rows[0]!, { key: "End" });
    const last = document.activeElement as HTMLElement;
    fireEvent.keyDown(last, { key: "Enter" });
    expect(states.at(-1)?.items).toEqual([]);
  });

  it("Space activates the focused row (keyboard equivalent of click)", async () => {
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[0]!); // anchor refA
    const menu = await screen.findByRole("menu");
    const rows = menu.querySelectorAll('[role="menuitem"]');
    // First row is "Close"; Space should fire it.
    fireEvent.keyDown(rows[0]!, { key: " " });
    expect(states.at(-1)?.items).toHaveLength(2);
  });

  it("Close Others targets the anchored tab even after a left tab closes (identity, not index)", async () => {
    // Regression: the menu used to capture the tab's INDEX. Anchor the
    // middle tab (refB), then close refA via its close-X while the menu
    // is open. With index-keying the stale index would slide onto refC
    // and Close Others would keep the WRONG tab. Identity-keying must
    // keep refB — the tab the user actually right-clicked.
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    const tabs = screen.getAllByRole("tab");
    fireEvent.contextMenu(tabs[1]!); // anchor refB (index 1)
    await screen.findByRole("menu");
    // Close refA (index 0, left of the anchor) via its close-X.
    const closeA = tabs[0]?.querySelector(".lc-tab-close") as HTMLElement;
    fireEvent.click(closeA);
    // Menu stays open (refB still present). Dispatch Close Others.
    const menu = await screen.findByRole("menu");
    const closeOthers = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.querySelector(".lc-menu-row-label")?.textContent === "Close Others",
    ) as HTMLElement | undefined;
    if (!closeOthers) throw new Error("Close Others row not found");
    await user.click(closeOthers);
    const last = states.at(-1);
    expect(last?.items).toHaveLength(1);
    // The survivor must be refB (10.04.040), not refC.
    const survivor = last?.items[0];
    expect(survivor?.kind === "section" && survivor.ref.section).toBe("10.04.040");
  });
});
