// @vitest-environment jsdom
//
// Breadcrumb clickability contract. Each parent with a non-null
// `sectionId` is a real <button> that dispatches
// `navigate({kind:"section", ref}, "primary")` using the first
// contained section the loader pre-computed in the ancestor index.
// Module-root (sectionId === null) renders as plain text — no module
// overview view exists to navigate to.
//
// The same `Crumb` component renders inside both the chrome
// strip and the in-section kicker; this file pins the contract once
// at the kicker, where the integration with SectionView lives.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { buildCorpusSectionView } from "./fixtures";

describe("Breadcrumb parents — clickability in section-view kicker", () => {
  it("renders chapter/article ancestor as a <button> and module-root as plain text", () => {
    const view = buildCorpusSectionView({
      parents: [
        { code: "Administrative Code", name: "Administrative Code", sectionId: null },
        { code: "Chapter 37", name: "Residential Rent…", sectionId: "37.1" },
      ],
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    // Module-root is plain text — not in the button accessible tree.
    expect(screen.queryByRole("button", { name: "Administrative Code" })).toBeNull();
    expect(screen.getByText("Administrative Code")).toBeInTheDocument();
    // Chapter ancestor exposes the full name as aria-label even though
    // the visible text is the shorter code.
    expect(screen.getByRole("button", { name: "Residential Rent…" })).toBeInTheDocument();
  });

  it("clicking a chapter parent dispatches navigate({section, ref}, 'primary')", () => {
    const navigate = vi.fn();
    const view = buildCorpusSectionView({
      moduleId: "sf-admin",
      parents: [
        { code: "Administrative Code", name: "Administrative Code", sectionId: null },
        { code: "Chapter 37", name: "Residential Rent…", sectionId: "37.1" },
      ],
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Residential Rent…" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item, intent] = navigate.mock.calls[0] ?? [];
    expect(item.kind).toBe("section");
    expect(item.ref.module).toBe("sf-admin");
    expect(item.ref.section).toBe("37.1");
    expect(intent).toBe("primary");
  });

  it("module-root parent click does nothing (it's not a button)", () => {
    const navigate = vi.fn();
    const view = buildCorpusSectionView({
      parents: [{ code: "Administrative Code", name: "Administrative Code", sectionId: null }],
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={navigate} />);
    fireEvent.click(screen.getByText("Administrative Code"));
    expect(navigate).not.toHaveBeenCalled();
  });
});
