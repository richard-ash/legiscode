// @vitest-environment jsdom
/// <reference lib="dom" />

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeStateWithRefs, refA, refB, refC, TabHost } from "./helpers";

// Real drag behavior is exercised in Playwright E2E; jsdom can't fake
// pointer-capture / coordinate events meaningfully. These are smoke
// checks that the @dnd-kit primitives are wired so the strip doesn't
// crash on mount and exposes the expected DOM hooks.

describe("TabStrip — drag-reorder wiring smoke", () => {
  it("renders without crashing when @dnd-kit DndContext mounts", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB, refC])} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("tab elements expose @dnd-kit's draggable hooks (aria-roledescription is set)", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    const tabs = screen.getAllByRole("tab");
    // @dnd-kit applies aria-roledescription="sortable" to participating items.
    expect(tabs[0]?.getAttribute("aria-roledescription")).toBe("sortable");
  });

  it("@dnd-kit announcer lives in the DOM so screen-reader hears reorder", () => {
    render(<TabHost initial={makeStateWithRefs([refA, refB])} />);
    // DndContext injects an aria-live region for keyboard drag announcements.
    const live = document.querySelector("[aria-live]");
    expect(live).not.toBeNull();
  });
});
