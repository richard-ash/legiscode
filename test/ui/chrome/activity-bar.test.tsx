// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityBar, type ActivityMode } from "../../../src/ui/chrome/activity-bar";

interface ActivityBarHandle {
  setBadge(id: ActivityMode, count: number | null): void;
}

describe("ActivityBar", () => {
  it("renders only modes with shipping features (today: structure)", () => {
    render(<ActivityBar active="structure" onChange={() => {}} />);
    // Structure ships in Phase 1; nothing else. Adding a mode here without
    // the backing feature shipping is the regression this test guards.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Structure" })).toBeInTheDocument();
  });

  it("does not render any badge until setBadge has published a count", () => {
    render(<ActivityBar active="structure" onChange={() => {}} />);
    // Locks the no-fake-counts contract — the rail must start with nothing
    // numeric on it and only show counts once a real subsystem has reported.
    expect(document.querySelector(".lc-badge")).toBeNull();
  });
});

describe("ActivityBar — a11y (C14)", () => {
  it("exposes role=tablist with vertical orientation", () => {
    render(<ActivityBar active="structure" onChange={() => {}} />);
    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-orientation", "vertical");
  });

  it("active tab carries tabIndex=0 and aria-selected=true", () => {
    render(<ActivityBar active="structure" onChange={() => {}} />);
    const structureTab = screen.getByRole("tab", { name: "Structure" });
    expect(structureTab).toHaveAttribute("tabindex", "0");
    expect(structureTab).toHaveAttribute("aria-selected", "true");
  });
});

describe("ActivityBar — setBadge handle", () => {
  it("setBadge('structure', N) renders the count; setBadge('structure', null) clears it", () => {
    render(<ActivityBar active="structure" onChange={() => {}} />);
    const handle = (window as unknown as { __legiscode_activityBar?: ActivityBarHandle })
      .__legiscode_activityBar;
    expect(handle).toBeDefined();
    act(() => handle?.setBadge("structure", 7));
    expect(screen.getByText("7")).toBeInTheDocument();
    act(() => handle?.setBadge("structure", null));
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });
});
