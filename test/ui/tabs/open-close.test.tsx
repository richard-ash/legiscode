// @vitest-environment jsdom
/// <reference lib="dom" />

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parse as corpusRefParse } from "@/corpus/refs";
import type { OpenItemsState } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

describe("TabStrip — open + close interactions", () => {
  it("renders one tab per open item with title from the corpus tree", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("10.04.020");
    expect(tabs[1]).toHaveTextContent("10.04.040");
  });

  it("clicking an inactive tab switches active (state mutation observable)", async () => {
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(<TabHost initial={makeStateWithRefs([refA, refB])} onState={(s) => states.push(s)} />);
    // Initially refB (idx 1) is active because openItem activates on append.
    await user.click(screen.getByRole("tab", { name: /Sales tax/ }));
    const last = states.at(-1);
    expect(last?.activeIndex).toBe(0);
  });

  it("clicking the close X removes the tab without activating", async () => {
    const user = userEvent.setup();
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    const tabs = screen.getAllByRole("tab");
    const firstTabClose = tabs[0]?.querySelector(".lc-tab-close");
    if (!firstTabClose) throw new Error("close button missing");
    await user.click(firstTabClose as HTMLElement);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("close-X stopPropagation: clicking X on an inactive tab does not switch active first", async () => {
    const user = userEvent.setup();
    const states: OpenItemsState[] = [];
    render(
      <TabHost initial={makeStateWithRefs([refA, refB, refC])} onState={(s) => states.push(s)} />,
    );
    // refC is active (last opened). Close the X on refA (inactive, idx 0).
    const tabs = screen.getAllByRole("tab");
    const refACloseBtn = tabs[0]?.querySelector(".lc-tab-close");
    if (!refACloseBtn) throw new Error("close button missing");
    await user.click(refACloseBtn as HTMLElement);
    const last = states.at(-1);
    // refA was at idx 0; closing it shifts active from idx 2 → idx 1.
    expect(last?.items).toHaveLength(2);
    expect(last?.activeIndex).toBe(1);
    // States history must NOT show an intermediate switch to refA.
    for (const s of states) {
      expect(s.activeIndex).not.toBe(0);
    }
  });

  it("aria-label on the close button names the section being closed", () => {
    render(<TabHost initial={makeStateWithRefs([refA])} />);
    const closeBtn = screen.getByRole("button", { name: /^Close §/ });
    expect(closeBtn).toBeInTheDocument();
  });
});

describe("TabStrip — empty state contract", () => {
  it("renders nothing when openItems is empty (App-level surface owns empty UI)", () => {
    render(<TabHost initial={makeStateWithRefs([])} />);
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

// Suppress noisy console output from useSortable in jsdom (no real DnD).
const _suppressConsole = vi.spyOn(console, "warn").mockImplementation(() => {});

describe("TabStrip — buildTitle fallback paths", () => {
  it("falls back to `§ <section>` when the corpus tree has no matching leaf", () => {
    // Open a section the TabHost's TITLE_MAP doesn't know — TabStrip's
    // buildTitle hits the "no node" branch and renders just the section id.
    const unknownRef = corpusRefParse({ module: "m", section: "99.99.999" });
    const initial = makeStateWithRefs([unknownRef]);
    render(<TabHost initial={initial} />);
    const tab = screen.getByRole("tab");
    expect(tab.textContent).toContain("99.99.999");
    // No tree node → no "·" separator + label suffix.
    expect(tab.textContent).not.toContain("·");
  });
});
