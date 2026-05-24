// @vitest-environment jsdom
//
// Targets the CitationPopover leaf component directly per
// `feedback_test_each_path_once`: header icon, resolved title + excerpt
// rendering, and the "Go to definition →" footer action that the
// SectionView wires to the same dispatch as ⌘-click. Tests at the leaf
// keep the SectionView interaction suite focused on the interaction
// itself (hover → show, click → dismiss) without re-asserting layout.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResolutionResult } from "@/citations/resolver";
import { parse as parseRef } from "@/corpus/refs";
import { CitationPopover } from "@/ui/center-panel/section-view/citation-popover";

/** Stand-in anchor element used by every test in this file. Position
 *  calc reads `getBoundingClientRect()` off this; jsdom returns zeros,
 *  which is fine for the assertions below (we're checking content +
 *  footer wiring, not pixel positions). */
function makeAnchor(): HTMLElement {
  const span = document.createElement("span");
  document.body.appendChild(span);
  return span;
}

function navigateSection(): ResolutionResult {
  return { kind: "navigate-section", ref: parseRef({ module: "sf-port", section: "1.1" }) };
}

describe("CitationPopover — header + body", () => {
  it("renders the 🔗 icon and raw cite in the header", () => {
    render(
      <CitationPopover
        resolution={navigateSection()}
        rawCite="§ 1.01"
        anchorElement={makeAnchor()}
      />,
    );
    const header = document.querySelector(".lc-popover-header");
    expect(header?.textContent).toContain("🔗");
    expect(header?.textContent).toContain("§ 1.01");
  });

  it("renders resolvedTitle and bodyExcerpt when provided", () => {
    render(
      <CitationPopover
        resolution={navigateSection()}
        rawCite="§ 10.04.040"
        anchorElement={makeAnchor()}
        resolvedTitle="§ 10.04.040 — Prima Facie Limits"
        bodyExcerpt="Notwithstanding any other provision of this Chapter, the Traffic Engineer may establish a prima facie speed limit lower than that otherwise applicable upon finding that…"
      />,
    );
    expect(screen.getByText("§ 10.04.040 — Prima Facie Limits")).toBeTruthy();
    expect(screen.getByText(/Notwithstanding any other provision of this Chapter/)).toBeTruthy();
  });

  it("omits the excerpt block when bodyExcerpt is undefined", () => {
    render(
      <CitationPopover
        resolution={navigateSection()}
        rawCite="§ 1.01"
        anchorElement={makeAnchor()}
        resolvedTitle="§ 1.01 — Definitions"
      />,
    );
    expect(screen.queryByText(/Notwithstanding/)).toBeNull();
    expect(document.querySelector(".lc-popover-excerpt")).toBeNull();
  });
});

describe("CitationPopover — footer action", () => {
  it("renders 'Go to definition →' for navigate-section when onActivate is provided", () => {
    const onActivate = vi.fn();
    render(
      <CitationPopover
        resolution={navigateSection()}
        rawCite="§ 1.01"
        anchorElement={makeAnchor()}
        onActivate={onActivate}
      />,
    );
    const button = screen.getByRole("button", { name: /Go to definition/ });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("renders 'Go to definition →' for navigate-structural when onActivate is provided", () => {
    const onActivate = vi.fn();
    const resolution: ResolutionResult = {
      kind: "navigate-structural",
      ref: parseRef({ module: "sf-port", section: "1.1" }),
      level: "chapter",
      number: "37",
    };
    render(
      <CitationPopover
        resolution={resolution}
        rawCite="Chapter 37"
        anchorElement={makeAnchor()}
        onActivate={onActivate}
      />,
    );
    expect(screen.getByRole("button", { name: /Go to definition/ })).toBeTruthy();
  });

  it("omits the action button when onActivate is undefined (hint-only footer)", () => {
    render(
      <CitationPopover
        resolution={navigateSection()}
        rawCite="§ 1.01"
        anchorElement={makeAnchor()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Go to definition/ })).toBeNull();
    // Hint string is platform-aware ("⌘" on Mac, "Ctrl" elsewhere) so
    // match the suffix rather than the modifier glyph.
    expect(screen.getByText(/-click to open$/)).toBeTruthy();
  });

  it("omits the action button on navigate-appendix (v1.1 viewer not implemented)", () => {
    const onActivate = vi.fn();
    const resolution: ResolutionResult = {
      kind: "navigate-appendix",
      module: "sf-port",
      appendixId: "A",
    };
    render(
      <CitationPopover
        resolution={resolution}
        rawCite="Appendix A"
        anchorElement={makeAnchor()}
        onActivate={onActivate}
      />,
    );
    expect(screen.queryByRole("button", { name: /Go to definition/ })).toBeNull();
  });

  it("renders no footer at all for module-not-installed", () => {
    const resolution: ResolutionResult = {
      kind: "module-not-installed",
      moduleId: "ca-vehicle",
      displayName: "California Vehicle Code",
      label: "CVC § 515",
    };
    render(
      <CitationPopover
        resolution={resolution}
        rawCite="CVC § 515"
        anchorElement={makeAnchor()}
        onActivate={vi.fn()}
      />,
    );
    expect(document.querySelector(".lc-popover-footer")).toBeNull();
  });

  it("returns null for unresolvable resolutions", () => {
    const { container } = render(
      <CitationPopover
        resolution={{ kind: "unresolvable", reason: "section-not-found" }}
        rawCite="§ unknown"
        anchorElement={makeAnchor()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
