// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DefinedTerm } from "@/ui/center-panel/section-view/defined-term";
import { testDefinitionView } from "./fixtures";

describe("DefinedTerm — inline highlight", () => {
  it("renders the surface form with the .lc-deftrm hook", () => {
    render(<DefinedTerm raw="Person" definition={testDefinitionView("Person")} onJump={vi.fn()} />);
    const span = document.querySelector(".lc-deftrm");
    expect(span).not.toBeNull();
    expect(span?.textContent).toContain("Person");
    expect(span?.getAttribute("data-term")).toBe("Person");
  });

  it("renders highlight without tooltip wiring when definition is missing", () => {
    // Loader returned no entry for this def_id — body[] referenced an
    // id the loader couldn't project. Renderer renders the highlight
    // gracefully but doesn't fire hover handlers.
    render(<DefinedTerm raw="Vessel" definition={undefined} onJump={vi.fn()} />);
    const span = document.querySelector(".lc-deftrm") as HTMLSpanElement;
    expect(span).not.toBeNull();
    // No hover-trigger event handler bound when no tooltip data exists.
    span.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
