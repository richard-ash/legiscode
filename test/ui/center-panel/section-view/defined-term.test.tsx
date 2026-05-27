// @vitest-environment jsdom
//
// Consumer-specific tests for DefinedTerm. Hover lifecycle (timers,
// scroll-dismiss, Escape) lives on useHoverPopover; we test only the
// branches DefinedTerm itself owns:
//
//   - graceful-degrade renders plain <span> (no .lc-deftrm, no italic)
//     when no in-scope definer reached the wire shape — the §37.3
//     "Department" case
//   - inline highlight is a real <button> with aria-haspopup when a
//     definition is projected
//   - aria-label is dropped when raw matches the canonical term (no
//     redundant SR announcement) and set when they diverge
//   - hover (after the show delay) opens the rich popover with the
//     term, excerpt, and a Go to § <definer> action — popover lives
//     on SectionView (so it renders at lc-doc-inner level, not nested
//     inside a `<p>`)
//   - clicking the action button + pressing Enter both fire onJump
//     with the definer section id
//   - the integrated SectionView path dispatches navigate({section}, "primary")

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefinedTerm } from "@/ui/center-panel/section-view/defined-term";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { POPOVER_SHOW_DELAY_MS } from "@/ui/center-panel/section-view/use-hover-popover";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";
import { bodyDefinedTerm, buildCorpusSectionView, testDefId, testDefinitionView } from "./fixtures";

type NavigateFn = (item: OpenItem, intent: NavigationIntent) => void;

describe("DefinedTerm — graceful degrade", () => {
  it("renders the term as plain <span> without .lc-deftrm when no definition is projected", () => {
    // §37.3 "Department" case: no in-scope definer means the build
    // pipeline doesn't attach a def_id. The renderer drops the italic +
    // dashed-underline so the term reads as inline prose. Decorating
    // the word would be a claim the data can't back up.
    render(<DefinedTerm raw="Department" definition={undefined} onJump={vi.fn()} />);
    expect(document.querySelector(".lc-deftrm")).toBeNull();
    expect(document.querySelector("button[data-term]")).toBeNull();
    // Inert variant should NOT carry the dead data-term hook either.
    expect(document.querySelector("[data-term]")).toBeNull();
    expect(screen.getByText("Department")).toBeInTheDocument();
  });
});

describe("DefinedTerm — inline highlight (standalone, no popover wiring)", () => {
  it("renders the term as a <button> with .lc-deftrm + aria-haspopup", () => {
    render(<DefinedTerm raw="Person" definition={testDefinitionView("Person")} onJump={vi.fn()} />);
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Person");
    expect(btn.getAttribute("aria-haspopup")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("data-term")).toBe("Person");
  });

  it("omits aria-label when raw matches the canonical term (no redundant SR announcement)", () => {
    render(<DefinedTerm raw="Person" definition={testDefinitionView("Person")} onJump={vi.fn()} />);
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    // Button text "Person" is the accessible name; aria-label would
    // duplicate (and on some SRs override pronunciation of) it.
    expect(btn.getAttribute("aria-label")).toBeNull();
  });

  it("sets aria-label when raw diverges from the canonical term (inflected forms)", () => {
    render(
      <DefinedTerm raw="vessels" definition={testDefinitionView("Vessel")} onJump={vi.fn()} />,
    );
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Vessel");
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

  it("plain click navigates immediately (no modifier required)", () => {
    const onJump = vi.fn();
    render(
      <DefinedTerm
        raw="Person"
        definition={testDefinitionView("Person", { first_use_section: "5.05" })}
        onJump={onJump}
      />,
    );
    fireEvent.click(document.querySelector("button.lc-deftrm") as HTMLButtonElement);
    expect(onJump).toHaveBeenCalledWith("5.05");
  });
});

describe("DefinedTerm — inside SectionView (popover wiring + integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderInSectionView(
    opts: {
      moduleId?: string;
      term?: string;
      excerpt?: string;
      definer?: string;
      navigate?: NavigateFn;
    } = {},
  ) {
    const term = opts.term ?? "Person";
    const definer = opts.definer ?? "1.1";
    const navigate: NavigateFn = opts.navigate ?? vi.fn();
    const view = buildCorpusSectionView({
      moduleId: opts.moduleId ?? "sf-port",
      section: {
        text: term,
        defined_terms: [term],
        body: [bodyDefinedTerm(term)],
      },
      definitions: {
        [testDefId(term)]: testDefinitionView(term, {
          excerpt: opts.excerpt ?? `"${term}" means a thing.`,
          first_use_section: definer,
        }),
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={navigate} />);
    return { navigate };
  }

  it("hover opens the popover with term header, excerpt body, and definer action", () => {
    renderInSectionView({
      term: "Person",
      excerpt: '"Person" means a natural person.',
      definer: "1.1",
    });
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

  it("popover renders at lc-doc-inner level (outside the <p>) — no <div> in <p>", () => {
    // Regression: the previous implementation rendered the popover
    // inline with the trigger button, which placed a <div> inside the
    // <p> that contained the button — invalid HTML. With the unified
    // hover state the popover renders at the lc-doc-inner sibling
    // level instead.
    renderInSectionView();
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    fireEvent.mouseEnter(btn);
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS);
    });
    const popover = document.querySelector(".lc-popover[data-popover-kind='defined-term']");
    expect(popover).not.toBeNull();
    // Popover's ancestor chain should NOT include a <p>.
    let cursor: HTMLElement | null = popover as HTMLElement;
    while (cursor && cursor !== document.body) {
      expect(cursor.tagName.toLowerCase()).not.toBe("p");
      cursor = cursor.parentElement;
    }
  });

  it("aria-expanded flips to true on this button only while its popover is open", () => {
    renderInSectionView();
    const btn = document.querySelector("button.lc-deftrm") as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.mouseEnter(btn);
    act(() => {
      vi.advanceTimersByTime(POPOVER_SHOW_DELAY_MS);
    });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking the popover action dispatches navigate({section}, 'primary') preserving the module", () => {
    const navigate = vi.fn();
    renderInSectionView({ moduleId: "sf-port", definer: "1.1", navigate });
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
    expect(screen.getByText("Department")).toBeInTheDocument();
  });
});
