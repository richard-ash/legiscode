// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OpenItemsState } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, TabHost } from "./helpers";

describe("TabStrip — middle-click close", () => {
  it("mouseDown with button=1 (middle) closes the tab", () => {
    const states: OpenItemsState[] = [];
    render(<TabHost initial={makeStateWithRefs([refA, refB])} onState={(s) => states.push(s)} />);
    const tabs = screen.getAllByRole("tab");
    if (!tabs[0]) throw new Error("no tabs");
    fireEvent.mouseDown(tabs[0], { button: 1 });
    expect(states.at(-1)?.items).toHaveLength(1);
  });
});
