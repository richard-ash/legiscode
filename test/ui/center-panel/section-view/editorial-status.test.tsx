// @vitest-environment jsdom
//
// D5 lock — editorial-status chip + redirect link for the 4 status states.
// Active sections show no chip; reserved/repealed/redesignated do.
// Redesignated also surfaces a `redirect_to` link that fires navigate().

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { buildCorpusSectionView } from "./fixtures";

describe("SectionView — editorial status (D5)", () => {
  it("renders no status chip for active sections", () => {
    const view = buildCorpusSectionView({
      section: { editorial_status: "active" },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(document.querySelector(".lc-status-chip")).toBeNull();
  });

  it("reserved: renders a status chip labeled 'reserved'", () => {
    const view = buildCorpusSectionView({
      section: { editorial_status: "reserved" },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const chip = document.querySelector(".lc-status-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("reserved");
    expect(chip?.getAttribute("data-status")).toBe("reserved");
  });

  it("repealed: renders a status chip labeled 'repealed'", () => {
    const view = buildCorpusSectionView({
      section: { editorial_status: "repealed" },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const chip = document.querySelector(".lc-status-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("repealed");
  });

  it("redesignated + redirect_to: renders the See § X.X redirect link", () => {
    const view = buildCorpusSectionView({
      section: { editorial_status: "redesignated", redirect_to: "2.05" },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: /See § 2\.05/ })).toBeInTheDocument();
  });

  it("redesignated link click fires navigate({section}, 'primary') with the redirect ref", () => {
    const navigate = vi.fn();
    const view = buildCorpusSectionView({
      moduleId: "sf-port",
      section: { editorial_status: "redesignated", redirect_to: "2.05" },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: /See § 2\.05/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item, intent] = navigate.mock.calls[0] ?? [];
    expect(item.kind).toBe("section");
    expect(item.ref.module).toBe("sf-port");
    expect(item.ref.section).toBe("2.05");
    expect(intent).toBe("primary");
  });
});
