// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DefinedTerm } from "@/ui/center-panel/section-view/defined-term";

describe("DefinedTerm — inline highlight", () => {
  it("renders the term with the .lc-deftrm hook", () => {
    render(<DefinedTerm term="Person" definitions={[]} onJump={vi.fn()} />);
    const span = document.querySelector(".lc-deftrm");
    expect(span).not.toBeNull();
    expect(span?.textContent).toContain("Person");
    expect(span?.getAttribute("data-term")).toBe("Person");
  });

  it("renders highlight without tooltip wiring when definitions are missing", () => {
    // Loader returned no entry for this term — schema didn't guarantee
    // body[] terms map to definitions.json. Renderer renders the
    // highlight gracefully but doesn't fire hover handlers.
    render(<DefinedTerm term="Vessel" definitions={undefined} onJump={vi.fn()} />);
    const span = document.querySelector(".lc-deftrm") as HTMLSpanElement;
    expect(span).not.toBeNull();
    // No hover-trigger event handler bound when no tooltip data exists.
    // Hover-trigger doesn't fire — assert tooltip stays absent on mouseover.
    span.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
