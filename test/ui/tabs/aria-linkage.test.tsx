// @vitest-environment jsdom
/// <reference lib="dom" />

// Regression guard for the tab <-> tabpanel ARIA relationship. Tab builds
// its `id` / `aria-controls` from itemIdentity (via tabSortableId);
// TabContent builds the panel's `id` / `aria-labelledby` independently.
// They previously diverged (itemIdentity prefixes `section::` while
// TabContent used `section:`), so aria-controls and aria-labelledby
// pointed at ids that didn't exist — the relationship was severed for
// assistive tech. Prefix-only assertions elsewhere couldn't catch it, so
// this test renders BOTH sides for the same item and resolves the ids.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabContent } from "@/ui/tabs/tab-content";
import { buildCorpusSectionView } from "../center-panel/section-view/fixtures";
import { makeStateWithRefs, refA, TabHost } from "./helpers";

// useSortable warns in jsdom (no real DnD layout).
const _suppressConsole = vi.spyOn(console, "warn").mockImplementation(() => {});

describe("tab <-> tabpanel ARIA linkage", () => {
  it("tab.aria-controls resolves to the panel id, and panel.aria-labelledby to the tab id", () => {
    const { container: stripContainer } = render(<TabHost initial={makeStateWithRefs([refA])} />);
    const tab = within(stripContainer).getByRole("tab");
    const ariaControls = tab.getAttribute("aria-controls");
    const tabId = tab.id;
    expect(ariaControls).toBeTruthy();
    expect(tabId).toBeTruthy();

    const { container: panelContainer } = render(
      <TabContent
        item={{ kind: "section", ref: refA }}
        section={buildCorpusSectionView()}
        sectionError={null}
        parentsLabel=""
        navigate={() => {}}
      />,
    );
    const panel = panelContainer.querySelector('[role="tabpanel"]') as HTMLElement | null;
    if (!panel) throw new Error("TabContent did not render a role=tabpanel element");

    // The tab's aria-controls must name the panel's real id, and the
    // panel's aria-labelledby must name the tab's real id. Both directions.
    expect(panel.id).toBe(ariaControls);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabId);
  });
});
