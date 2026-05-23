// @vitest-environment jsdom
//
// L2b cutover — tooltip renders synchronously from the `definition` prop.
// Per-occurrence build-time resolution means each occurrence has exactly
// ONE canonical Definition (not a list of definers); the tooltip shows
// the excerpt and a single "go to definer" link.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DefinedTerm } from "@/ui/center-panel/section-view/defined-term";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import {
  bodyDefinedTerm,
  bodyText,
  buildCorpusSectionView,
  testDefId,
  testDefinitionView,
} from "./fixtures";

describe("DefinedTerm — synchronous hover tooltip", () => {
  it("hover renders the tooltip with the canonical excerpt and definer link", () => {
    render(
      <DefinedTerm
        raw="Person"
        definition={testDefinitionView("Person", {
          excerpt: '"Person" means a natural person.',
          first_use_section: "1.1",
        })}
        onJump={vi.fn()}
      />,
    );
    const span = document.querySelector(".lc-deftrm") as HTMLSpanElement;
    fireEvent.mouseEnter(span);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent('"Person" means a natural person.');
    expect(screen.getByRole("button", { name: /§ 1\.1/ })).toBeInTheDocument();
  });

  it("mouse leave hides the tooltip", () => {
    render(
      <DefinedTerm
        raw="Person"
        definition={testDefinitionView("Person", { first_use_section: "1.1" })}
        onJump={vi.fn()}
      />,
    );
    const span = document.querySelector(".lc-deftrm") as HTMLSpanElement;
    fireEvent.mouseEnter(span);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(span);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("clicking the definer link fires onJump with first_use_section", () => {
    const onJump = vi.fn();
    render(
      <DefinedTerm
        raw="Person"
        definition={testDefinitionView("Person", { first_use_section: "5.05" })}
        onJump={onJump}
      />,
    );
    fireEvent.mouseEnter(document.querySelector(".lc-deftrm") as HTMLSpanElement);
    fireEvent.click(screen.getByRole("button", { name: /§ 5\.05/ }));
    expect(onJump).toHaveBeenCalledWith("5.05");
  });

  it("inside SectionView: tooltip jump fires navigate({section}, 'primary') with module preserved", () => {
    const navigate = vi.fn();
    const view = buildCorpusSectionView({
      moduleId: "sf-port",
      section: {
        text: "Person",
        defined_terms: ["Person"],
        body: [bodyDefinedTerm("Person")],
      },
      definitions: {
        [testDefId("Person")]: testDefinitionView("Person", { first_use_section: "1.1" }),
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={navigate} />);
    fireEvent.mouseEnter(document.querySelector(".lc-deftrm") as HTMLSpanElement);
    fireEvent.click(screen.getByRole("button", { name: /§ 1\.1/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item, intent] = navigate.mock.calls[0] ?? [];
    expect(item.kind).toBe("section");
    expect(item.ref.module).toBe("sf-port");
    expect(item.ref.section).toBe("1.1");
    expect(intent).toBe("primary");
  });

  it("no tooltip when the def_id has no projected Definition", () => {
    // Loader's join skips def_ids missing from the module index — the
    // renderer renders the highlight anyway and the hover handler is
    // never bound, so even a synthetic mouseenter does nothing.
    const view = buildCorpusSectionView({
      section: {
        text: "Vessel",
        defined_terms: ["Vessel"],
        body: [bodyText(""), bodyDefinedTerm("Vessel")],
      },
      // Empty definitions — def_id not projected.
      definitions: {},
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    fireEvent.mouseEnter(document.querySelector(".lc-deftrm") as HTMLSpanElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
