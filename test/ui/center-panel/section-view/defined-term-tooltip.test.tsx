// @vitest-environment jsdom
//
// D-DELTA-2 lock — tooltip renders synchronously from the `definitions`
// prop. No IPC, no async lookup. The multi-section case asserts the
// renderer doesn't flatten data the way the original per-hover lookup
// would have (codex's data-loss catch).

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DefinedTerm } from "@/ui/center-panel/section-view/defined-term";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { bodyDefinedTerm, bodyText, buildCorpusSectionView } from "./fixtures";

describe("DefinedTerm — synchronous hover tooltip", () => {
  it("hover renders the tooltip with all defining sections (no IPC)", () => {
    render(
      <DefinedTerm
        term="Person"
        definitions={[{ defined_in_section: "1.1" }, { defined_in_section: "1.2" }]}
        onJump={vi.fn()}
      />,
    );
    const span = document.querySelector(".lc-deftrm") as HTMLSpanElement;
    fireEvent.mouseEnter(span);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toBeInTheDocument();
    // Both defining sections are listed — no flattening.
    expect(screen.getByRole("button", { name: /§ 1\.1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /§ 1\.2/ })).toBeInTheDocument();
  });

  it("mouse leave hides the tooltip", () => {
    render(
      <DefinedTerm term="Person" definitions={[{ defined_in_section: "1.1" }]} onJump={vi.fn()} />,
    );
    const span = document.querySelector(".lc-deftrm") as HTMLSpanElement;
    fireEvent.mouseEnter(span);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(span);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("clicking a tooltip jump-link fires onJump with that section id", () => {
    const onJump = vi.fn();
    render(
      <DefinedTerm term="Person" definitions={[{ defined_in_section: "5.05" }]} onJump={onJump} />,
    );
    fireEvent.mouseEnter(document.querySelector(".lc-deftrm") as HTMLSpanElement);
    fireEvent.click(screen.getByRole("button", { name: /§ 5\.05/ }));
    expect(onJump).toHaveBeenCalledWith("5.05");
  });

  it("inside SectionView: tooltip jump fires onActivate(new ref) with module preserved", () => {
    const onActivate = vi.fn();
    const view = buildCorpusSectionView({
      moduleId: "sf-port",
      section: {
        text: "Person",
        defined_terms: ["Person"],
        body: [bodyDefinedTerm("Person")],
      },
      definitions: { Person: [{ defined_in_section: "1.1" }] },
    });
    render(<SectionView view={view} parentsLabel="" error={null} onActivate={onActivate} />);
    fireEvent.mouseEnter(document.querySelector(".lc-deftrm") as HTMLSpanElement);
    fireEvent.click(screen.getByRole("button", { name: /§ 1\.1/ }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    const ref = onActivate.mock.calls[0]?.[0];
    expect(ref.module).toBe("sf-port");
    expect(ref.section).toBe("1.1");
  });

  it("no tooltip rendering when the term has no definitions entry", () => {
    // Loader's join skips terms missing from definitions.json — the
    // renderer renders the highlight anyway and the hover handler is
    // never bound, so even a synthetic mouseenter does nothing.
    const view = buildCorpusSectionView({
      section: {
        text: "Vessel",
        defined_terms: ["Vessel"],
        body: [bodyText(""), bodyDefinedTerm("Vessel")],
      },
      // Empty definitions — terms not pre-resolved.
      definitions: {},
    });
    render(<SectionView view={view} parentsLabel="" error={null} onActivate={vi.fn()} />);
    fireEvent.mouseEnter(document.querySelector(".lc-deftrm") as HTMLSpanElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
