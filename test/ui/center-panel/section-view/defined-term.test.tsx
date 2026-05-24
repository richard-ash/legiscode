// @vitest-environment jsdom
//
// Consumer-specific tests for DefinedTerm. Hover lifecycle (timers,
// scroll-dismiss, Escape) lives on useHoverPopover; we test only the
// branches DefinedTerm itself owns:
//
//   - graceful-degrade renders plain <span> (no .lc-deftrm, no italic)
//     when no in-scope definer reached the wire shape — the §37.3
//     "Department" case
//   - inline highlight is a real <button> with aria-haspopup when
//     a definition is projected
//   - hover (after the show delay) opens the rich popover with the
//     term, excerpt, and a Go to § <definer> action
//   - the action button fires onJump with the definer section id
//   - the integrated SectionView path dispatches navigate({section}, "primary")

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefinedTerm } from "@/ui/center-panel/section-view/defined-term";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { POPOVER_SHOW_DELAY_MS } from "@/ui/center-panel/section-view/use-hover-popover";
import {
  bodyDefinedTerm,
  buildCorpusSectionView,
  testDefId,
  testDefinitionView,
} from "./fixtures";

describe("DefinedTerm — graceful degrade", () => {
  it("renders the term as plain <span> without .lc-deftrm when no definition is projected", () => {
    // §37.3 "Department" case: no in-scope definer means the build
    // pipeline doesn't attach a def_id. The renderer drops the italic +
    // dashed-underline so the term reads as inline prose. Decorating
    // the word would be a claim the data can't back up.
    render(<DefinedTerm raw="Department" definition={undefined} onJump={vi.fn()} />);
    expect(document.querySelector(".lc-deftrm")).toBeNull();
    expect(document.querySelector("button[data-term]")).toBeNull();
    const span = document.querySelector("span[data-term]") as HTMLElement | null;
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("Department");
  });
});

describe("DefinedTerm — inline highlight + hover popover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the term as a <button> with .lc-deftrm + aria-haspopup", () => {
    render(<DefinedTerm raw="Person" definition={testDefinitionView("Person")} onJump={vi.fn()} />);
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Person");
    expect(btn.getAttribute("aria-haspopup")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("data-term")).toBe("Person");
  });

  it("hover opens the popover with term header, excerpt body, and definer action", () => {
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
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    fireEvent.mouseEnter(btn);
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS);
    });
    const popover = screen.getByRole("tooltip");
    expect(popover.getAttribute("data-popover-kind")).toBe("defined-term");
    expect(popover.querySelector(".lc-popover-raw")?.textContent).toBe("Person");
    expect(popover).toHaveTextContent('"Person" means a natural person.');
    expect(screen.getByRole("button", { name: /Go to § 1\.1/ })).toBeInTheDocument();
  });

  it("clicking the action button fires onJump with the definer section id", () => {
    const onJump = vi.fn();
    render(
      <DefinedTerm
        raw="Person"
        definition={testDefinitionView("Person", { first_use_section: "5.05" })}
        onJump={onJump}
      />,
    );
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    fireEvent.mouseEnter(btn);
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS);
    });
    fireEvent.click(screen.getByRole("button", { name: /Go to § 5\.05/ }));
    expect(onJump).toHaveBeenCalledWith("5.05");
  });

  it("Enter on the focused term navigates to the definer without waiting for hover", () => {
    const onJump = vi.fn();
    render(
      <DefinedTerm
        raw="Person"
        definition={testDefinitionView("Person", { first_use_section: "1.2" })}
        onJump={onJump}
      />,
    );
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    btn.focus();
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith("1.2");
  });
});

describe("DefinedTerm — inside SectionView (integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clicking the popover action dispatches navigate({section}, 'primary') preserving the module", () => {
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
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    fireEvent.mouseEnter(btn);
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS);
    });
    fireEvent.click(screen.getByRole("button", { name: /Go to § 1\.1/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item, intent] = navigate.mock.calls[0] ?? [];
    expect(item.kind).toBe("section");
    expect(item.ref.module).toBe("sf-port");
    expect(item.ref.section).toBe("1.1");
    expect(intent).toBe("primary");
  });

  it("graceful-degrade inside SectionView: missing def_id renders inline prose, no popover", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "Department",
        defined_terms: ["Department"],
        body: [bodyDefinedTerm("Department")],
      },
      // Empty definitions map — no def_id projected by the loader (the
      // §37.3 case: no in-scope definer, term dropped from the map).
      definitions: {},
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(document.querySelector(".lc-deftrm")).toBeNull();
    // Term still appears in the prose as plain text.
    expect(screen.getByText("Department")).toBeInTheDocument();
  });
});
