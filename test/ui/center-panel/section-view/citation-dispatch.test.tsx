// @vitest-environment jsdom
//
// Covers two seams in SectionView:
//   1. Subsection id emission — first-occurrence-wins (D7/D14), preserved
//      across paragraph_break splits and format-wrapped children.
//   2. Delegated citation click — VS Code semantics: plain click is text
//      selection only (no callback), ⌘/Ctrl-click fires
//      `onCitationActivate(citation, "primary")` with intent "primary".

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parse as parseRef } from "@/corpus/refs";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import {
  bodyCitation,
  bodyFormat,
  bodyParaBreak,
  bodySubsectionLabel,
  bodyText,
  buildCorpusSectionView,
  citationCrossModule,
  citationInternal,
} from "./fixtures";

describe("SectionView — subsection ids (D7/D14)", () => {
  it("emits id='lc-sub-(a)' on the first occurrence only; duplicates render plain", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "(a) first (a) again",
        body: [
          bodySubsectionLabel("(a)"),
          bodyText(" first "),
          bodySubsectionLabel("(a)"),
          bodyText(" again"),
        ],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const labels = document.querySelectorAll(".lc-subsection-label");
    expect(labels).toHaveLength(2);
    expect(labels[0]?.getAttribute("id")).toBe("lc-sub-(a)");
    expect(labels[1]?.getAttribute("id")).toBeNull();
  });

  it("distinct labels each get their own id", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "(a) (b) (c)",
        body: [
          bodySubsectionLabel("(a)"),
          bodyText(" "),
          bodySubsectionLabel("(b)"),
          bodyText(" "),
          bodySubsectionLabel("(c)"),
        ],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(document.getElementById("lc-sub-(a)")).not.toBeNull();
    expect(document.getElementById("lc-sub-(b)")).not.toBeNull();
    expect(document.getElementById("lc-sub-(c)")).not.toBeNull();
  });

  it("first-occurrence applies across paragraph_break splits", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "(a) one\n\n(a) two",
        body: [
          bodySubsectionLabel("(a)"),
          bodyText(" one"),
          bodyParaBreak(),
          bodySubsectionLabel("(a)"),
          bodyText(" two"),
        ],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const labels = document.querySelectorAll(".lc-subsection-label");
    expect(labels).toHaveLength(2);
    expect(labels[0]?.getAttribute("id")).toBe("lc-sub-(a)");
    expect(labels[1]?.getAttribute("id")).toBeNull();
  });

  it("first-occurrence respects format-wrapped subsection labels (recurses into children)", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "(a) inside list (a) outside",
        body: [
          bodyFormat("list", [bodyFormat("listItem", [bodySubsectionLabel("(a)")])]),
          bodyText(" "),
          bodySubsectionLabel("(a)"),
        ],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const labels = document.querySelectorAll(".lc-subsection-label");
    expect(labels).toHaveLength(2);
    expect(labels[0]?.getAttribute("id")).toBe("lc-sub-(a)");
    expect(labels[1]?.getAttribute("id")).toBeNull();
  });
});

describe("SectionView — delegated citation click (VS Code semantics)", () => {
  it("plain click does NOT fire onCitationActivate (text selection only)", () => {
    const internal = citationInternal("§ 1.01", "1.01");
    const view = buildCorpusSectionView({
      section: {
        text: "see § 1.01",
        citations: [internal],
        body: [bodyText("see "), bodyCitation("§ 1.01", 0)],
      },
    });
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement | null;
    expect(link).not.toBeNull();
    fireEvent.click(link!);
    expect(onCitationActivate).not.toHaveBeenCalled();
  });

  it("⌘-click fires intent='primary'; Ctrl-click also fires 'primary'", () => {
    const internal = citationInternal("§ 1.01", "1.01");
    const view = buildCorpusSectionView({
      section: {
        text: "see § 1.01",
        citations: [internal],
        body: [bodyCitation("§ 1.01", 0)],
      },
    });
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement;
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(onCitationActivate).toHaveBeenCalledTimes(2);
    expect(onCitationActivate).toHaveBeenNthCalledWith(1, internal, "primary");
    expect(onCitationActivate).toHaveBeenNthCalledWith(2, internal, "primary");
  });

  it("⌘-click on a child node inside the citation still resolves to the citation (closest walk)", () => {
    const internal = citationInternal("§ 1.01", "1.01");
    const view = buildCorpusSectionView({
      section: {
        text: "§ 1.01",
        citations: [internal],
        body: [bodyFormat("bold", [bodyCitation("§ 1.01", 0)])],
      },
    });
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const span = document.querySelector("span.lc-cite") as HTMLSpanElement;
    const childTarget = span.firstChild as Node;
    fireEvent.click(childTarget, { metaKey: true });
    expect(onCitationActivate).toHaveBeenCalledTimes(1);
    expect(onCitationActivate).toHaveBeenCalledWith(internal, "primary");
  });

  it("⌘-click outside any [data-cite-kind] citation is a no-op", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "plain text only",
        body: [bodyText("plain text only")],
      },
    });
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const body = document.querySelector(".lc-section-body") as HTMLElement;
    fireEvent.click(body, { metaKey: true });
    expect(onCitationActivate).not.toHaveBeenCalled();
  });

  it("data-citation-index resolves to the right Citation when multiple citations coexist", () => {
    const first = citationInternal("§ 1.01", "1.01");
    const second = citationCrossModule("CVC § 21", "ca-vehicle", "21");
    const view = buildCorpusSectionView({
      section: {
        text: "see § 1.01 and CVC § 21",
        citations: [first, second],
        body: [
          bodyText("see "),
          bodyCitation("§ 1.01", 0),
          bodyText(" and "),
          bodyCitation("CVC § 21", 1),
        ],
      },
    });
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const links = document.querySelectorAll<HTMLSpanElement>("span.lc-cite");
    expect(links).toHaveLength(2);
    fireEvent.click(links[1]!, { metaKey: true });
    fireEvent.click(links[0]!, { metaKey: true });
    expect(onCitationActivate).toHaveBeenNthCalledWith(1, second, "primary");
    expect(onCitationActivate).toHaveBeenNthCalledWith(2, first, "primary");
  });

  it("missing onCitationActivate prop: ⌘-click is a safe no-op", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "§ 1.01",
        citations: [citationInternal("§ 1.01", "1.01")],
        body: [bodyCitation("§ 1.01", 0)],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement;
    expect(() => fireEvent.click(link, { metaKey: true })).not.toThrow();
  });
});

describe("SectionView — hover popover lifecycle", () => {
  // The hover popover is shown after a 400ms delay on mouseover and must
  // be dismissed as part of the ⌘-click dispatch — otherwise the cursor
  // stays inside the cite span (it doesn't move on navigation), mouseout
  // never fires, and the popover lingers over the freshly-opened tab.
  // Regression for the "stuck popover" report in the 2026-05-20 review.

  function renderWithHover() {
    vi.useFakeTimers();
    const internal = citationInternal("§ 1.01", "1.01");
    const view = buildCorpusSectionView({
      section: {
        text: "see § 1.01",
        citations: [internal],
        body: [bodyCitation("§ 1.01", 0)],
      },
    });
    const onCitationActivate = vi.fn();
    const resolveCitation = vi.fn(() => ({ kind: "scroll-only", subsection: "(a)" }) as const);
    const utils = render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
        resolveCitation={resolveCitation}
      />,
    );
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement;
    fireEvent.mouseOver(link);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    return { ...utils, link, onCitationActivate, internal };
  }

  it("⌘-click on a cite dismisses an already-visible hover popover", () => {
    const { link, onCitationActivate, internal } = renderWithHover();
    expect(document.querySelector(".lc-cite-popover")).not.toBeNull();
    fireEvent.click(link, { metaKey: true });
    expect(onCitationActivate).toHaveBeenCalledWith(internal, "primary");
    expect(document.querySelector(".lc-cite-popover")).toBeNull();
    vi.useRealTimers();
  });

  it("plain click (no modifier) does not dismiss the hover popover", () => {
    const { link } = renderWithHover();
    fireEvent.click(link);
    expect(document.querySelector(".lc-cite-popover")).not.toBeNull();
    vi.useRealTimers();
  });

  // The popover sits 6px below the cite span. When the user moves their
  // cursor across the gap toward the popover, mouseout fires on the cite
  // and arms a 200ms hide timer. Without a hover bridge on the popover
  // itself the timer fires while the cursor is over the popover and the
  // user loses access to the excerpt and "Go to definition →" button.
  it("keeps the popover open when the cursor moves from the cite into the popover", () => {
    const { link } = renderWithHover();
    const popover = document.querySelector(".lc-cite-popover") as HTMLElement;
    expect(popover).not.toBeNull();
    // Cursor leaves the cite heading toward the popover.
    fireEvent.mouseOut(link, { relatedTarget: popover });
    // Cursor enters the popover within the hide-delay window.
    fireEvent.mouseEnter(popover);
    // Advance well past the 200ms hide delay; popover must still be up.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".lc-cite-popover")).not.toBeNull();
    vi.useRealTimers();
  });

  it("dismisses the popover after the hide delay when the cursor leaves it", () => {
    const { link } = renderWithHover();
    const popover = document.querySelector(".lc-cite-popover") as HTMLElement;
    fireEvent.mouseOut(link, { relatedTarget: popover });
    fireEvent.mouseEnter(popover);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".lc-cite-popover")).not.toBeNull();
    // Cursor leaves the popover. Hide timer re-arms.
    fireEvent.mouseLeave(popover);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".lc-cite-popover")).toBeNull();
    vi.useRealTimers();
  });

  // The popover anchors to a getBoundingClientRect snapshot of the cite
  // taken on hover. Once the page scrolls, the snapshot is stale and the
  // popover floats over unrelated content. Dismiss on any scroll so the
  // user can re-hover to get a fresh anchor.
  it("dismisses the popover when the page scrolls", () => {
    renderWithHover();
    expect(document.querySelector(".lc-cite-popover")).not.toBeNull();
    fireEvent.scroll(window);
    expect(document.querySelector(".lc-cite-popover")).toBeNull();
    vi.useRealTimers();
  });
});

describe("SectionView — popover preview wiring", () => {
  // Verifies the App → SectionView → CitationPopover boundary: when a
  // navigable resolution lands on a ref present in the corpus, the
  // popover renders the resolved title and pre-baked excerpt. Pre-baking
  // (in electron/corpus-loader.ts) is what keeps this synchronous —
  // matches the DefinedTerm tooltip pattern (no IPC on hover).

  it("passes resolvedTitle and bodyExcerpt from getCitationPreview into the popover", () => {
    vi.useFakeTimers();
    const internal = citationInternal("§ 10.04.040", "10.04.040");
    const view = buildCorpusSectionView({
      section: {
        text: "see § 10.04.040",
        citations: [internal],
        body: [bodyCitation("§ 10.04.040", 0)],
      },
    });
    const resolveCitation = vi.fn(() => ({
      kind: "navigate-section" as const,
      ref: parseRef({ module: "sf-port", section: "10.04.040" }),
    }));
    const getCitationPreview = vi.fn(() => ({
      title: "§ 10.04.040 — Prima Facie Limits",
      excerpt: "Notwithstanding any other provision of this Chapter…",
    }));
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={vi.fn()}
        resolveCitation={resolveCitation}
        getCitationPreview={getCitationPreview}
      />,
    );
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement;
    fireEvent.mouseOver(link);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector(".lc-cite-popover-title")?.textContent).toBe(
      "§ 10.04.040 — Prima Facie Limits",
    );
    expect(document.querySelector(".lc-cite-popover-excerpt")?.textContent).toContain(
      "Notwithstanding",
    );
    vi.useRealTimers();
  });

  it("prefers the subsection-keyed excerpt when the cite carries target.subsection", () => {
    vi.useFakeTimers();
    const cite = citationInternal("Subsection (a)", "133");
    cite.target = { ...cite.target, subsection: "(a)" } as typeof cite.target;
    const view = buildCorpusSectionView({
      section: {
        text: "see Subsection (a)",
        citations: [cite],
        body: [bodyCitation("Subsection (a)", 0)],
      },
    });
    const resolveCitation = vi.fn(() => ({
      kind: "navigate-section" as const,
      ref: parseRef({ module: "sf-planning", section: "133" }),
      subsection: "(a)",
    }));
    const getCitationPreview = vi.fn(
      (_ref, subsection?: string): { title: string; excerpt?: string } => ({
        title: "§ 133 — SIDE YARDS",
        excerpt:
          subsection === "(a)"
            ? "Minimum side yards shall be provided as follows:"
            : "(See Interpretations related to this Section.)",
      }),
    );
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={vi.fn()}
        resolveCitation={resolveCitation}
        getCitationPreview={getCitationPreview}
      />,
    );
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement;
    fireEvent.mouseOver(link);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(getCitationPreview).toHaveBeenCalledWith(expect.anything(), "(a)");
    expect(document.querySelector(".lc-cite-popover-excerpt")?.textContent).toBe(
      "Minimum side yards shall be provided as follows:",
    );
    vi.useRealTimers();
  });

  it("renders 'Go to definition →' inside the popover; clicking it dispatches and dismisses", () => {
    vi.useFakeTimers();
    const internal = citationInternal("§ 1.01", "1.01");
    const view = buildCorpusSectionView({
      section: {
        text: "see § 1.01",
        citations: [internal],
        body: [bodyCitation("§ 1.01", 0)],
      },
    });
    const onCitationActivate = vi.fn();
    const resolveCitation = vi.fn(() => ({
      kind: "navigate-section" as const,
      ref: parseRef({ module: "sf-port", section: "1.01" }),
    }));
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
        resolveCitation={resolveCitation}
      />,
    );
    const link = document.querySelector("span.lc-cite") as HTMLSpanElement;
    fireEvent.mouseOver(link);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const goto = document.querySelector(".lc-cite-popover-action") as HTMLButtonElement;
    expect(goto).not.toBeNull();
    fireEvent.click(goto);
    expect(onCitationActivate).toHaveBeenCalledWith(internal, "primary");
    expect(document.querySelector(".lc-cite-popover")).toBeNull();
    vi.useRealTimers();
  });
});
