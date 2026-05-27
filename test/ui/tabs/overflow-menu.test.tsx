// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

// Suppress noisy console output from useSortable in jsdom (no real DnD).
const _suppressConsole = vi.spyOn(console, "warn").mockImplementation(() => {});

// Per-file MockResizeObserver with a `trigger()` helper that fires the
// callback for the most recently observed element. Global test/setup.ts
// stubs a no-op ResizeObserver to keep app-shell mounts happy; this
// override lets us deterministically toggle overflow state on demand
// (T3 lock — per-file MockResizeObserver, not a global mutation).
let triggerRO: () => void = () => {};
class MockResizeObserver {
  constructor(private cb: ResizeObserverCallback) {
    triggerRO = () => {
      this.cb(
        [{ target: document.createElement("div") } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    };
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: per-file stub
  (globalThis as any).ResizeObserver = MockResizeObserver;
});
afterEach(() => {
  triggerRO = () => {};
});

/** Pretend the strip has overflowed by widening scrollWidth on every
 *  .lc-tabs element rendered into the document. jsdom returns 0 for
 *  scrollWidth/clientWidth without manual help. */
function forceOverflow(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLDivElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return this.className?.includes?.("lc-tabs") ? scrollWidth : 0;
    },
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.className?.includes?.("lc-tabs") ? clientWidth : 0;
    },
  });
}

function restoreSizes() {
  // Restore prototype getters — leaving the override in place would
  // poison sibling test files that share the same JSDOM instance.
  Object.defineProperty(HTMLDivElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return 0;
    },
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 0;
    },
  });
}

describe("TabStrip — overflow chevron + menu", () => {
  beforeEach(() => forceOverflow(1000, 300));
  afterEach(restoreSizes);

  it("chevron does not render when the strip fits its container", async () => {
    restoreSizes(); // override: strip fits (scrollWidth === clientWidth === 0)
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    // Force the items.length effect to settle.
    triggerRO();
    expect(screen.queryByRole("button", { name: /Show all .* open tabs/ })).toBeNull();
  });

  it("chevron renders and announces the open-tab count when overflowing (D1 lock)", async () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    expect(chevron).toBeInTheDocument();
  });

  it("clicking the chevron opens an overflow menu with one row per open tab", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
  });

  it("clicking a row activates that tab and dismisses the menu", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const rows = await screen.findAllByRole("menuitem");
    // Initial active is refC (idx 2); click refA's row.
    await user.click(rows[0]!);
    expect(screen.queryByRole("menu")).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("clicking a row's close button drops that tab without leaving the menu open", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const rows = await screen.findAllByRole("menuitem");
    const closeRowBtn = rows[0]?.querySelector(".lc-overflow-row-close") as HTMLElement;
    await user.click(closeRowBtn);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("active row gets the • marker (and inactive rows reserve the same gutter)", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const rows = await screen.findAllByRole("menuitem");
    const markers = rows.map((r) => r.querySelector(".lc-overflow-row-marker")?.textContent ?? "");
    // refC is initially active (idx 2 — last-opened); its row shows •.
    expect(markers[2]).toBe("•");
    expect(markers[0]).toBe("");
    expect(markers[1]).toBe("");
  });

  it("Escape closes the overflow menu", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking the chevron a second time toggles the menu closed", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // Second click on the chevron — onChevronClick toggles to null.
    await user.click(chevron);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("chevron sets aria-expanded=true while the menu is open and false when closed", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    await user.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("initial focus lands on the active row (so the user sees 'where they are')", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const rows = await screen.findAllByRole("menuitem");
    // refC is active (idx 2 = last opened); focus should land on its row.
    expect(document.activeElement).toBe(rows[2]);
  });

  it("ArrowDown/ArrowUp/Home/End navigate via the roving tabindex", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const rows = await screen.findAllByRole("menuitem");
    // Initial focus is on the active row (refC, idx 2). Home → idx 0.
    fireEvent.keyDown(rows[2]!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
  });

  it("Enter on a focused row activates that tab and dismisses the menu", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    triggerRO();
    const chevron = await screen.findByRole("button", { name: /Show all 3 open tabs/ });
    await user.click(chevron);
    const rows = await screen.findAllByRole("menuitem");
    // Move focus to row 0 (refA) then Enter.
    fireEvent.keyDown(rows[2]!, { key: "Home" });
    fireEvent.keyDown(rows[0]!, { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });
});
