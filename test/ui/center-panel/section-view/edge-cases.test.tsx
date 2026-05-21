// @vitest-environment jsdom
//
// Edge cases the production parser may surface: empty body, no parents,
// unicode punctuation, format spans wrapping inline annotations, and
// subsection labels at paragraph starts.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import {
  bodyCitation,
  bodyDefinedTerm,
  bodyFormat,
  bodyParaBreak,
  bodySubsectionLabel,
  bodyText,
  buildCorpusSectionView,
  citationInternal,
} from "./fixtures";

describe("SectionView — edge cases", () => {
  it("empty body[] renders no paragraphs (D-DELTA-1: schema is the gate, not the renderer)", () => {
    const view = buildCorpusSectionView({
      section: { text: "", body: [] },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(document.querySelectorAll("p.lc-para")).toHaveLength(0);
    // Header still renders.
    expect(document.querySelector(".lc-section-id")).not.toBeNull();
  });

  it("empty parents kicker when parentsLabel is the empty string", () => {
    const view = buildCorpusSectionView();
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    // `.lc-doc-title` exists but contains nothing — render shouldn't crash.
    expect(document.querySelector(".lc-doc-title")?.textContent).toBe("");
  });

  it("preserves unicode + punctuation inside text segments", () => {
    const text = '—§ 1.01(a) ‘word’ — "smart quotes" — 你好 — émojí 🎉';
    const view = buildCorpusSectionView({
      section: { text, body: [bodyText(text)] },
    });
    const { container } = render(
      <SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />,
    );
    expect(container.textContent).toContain("你好");
    expect(container.textContent).toContain("🎉");
    expect(container.textContent).toContain("‘word’");
  });

  it("subsection_label segment renders with the .lc-subsection-label hook", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "(a) text-after-label",
        body: [bodySubsectionLabel("(a)"), bodyText(" text-after-label")],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    const label = document.querySelector(".lc-subsection-label");
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe("(a)");
  });

  it("format(bold) wraps inline annotations without splitting them (CQ2)", () => {
    // Per src/types/section.ts:53-99, format wraps INSIDE primary
    // annotations: format(bold) > citation > text. Renderer must hand
    // children through to <strong> so the link stays intact.
    const view = buildCorpusSectionView({
      section: {
        text: "§ 1.01",
        citations: [citationInternal("§ 1.01", "1.01")],
        body: [bodyFormat("bold", [bodyCitation("§ 1.01", 0)])],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    // <strong> wraps the citation; the citation still emits its data attrs.
    const strong = document.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.querySelector("span.lc-cite")?.getAttribute("data-cite-kind")).toBe("internal");
  });

  it("citation with out-of-range citation_index renders raw text gracefully", () => {
    // Should never happen in production (schema rejects), but the
    // renderer's defensive guard returns the raw string instead of
    // crashing on a malformed in-memory object.
    const view = buildCorpusSectionView({
      section: {
        text: "§ 1.01",
        citations: [], // empty — index 0 is out of range
        body: [bodyCitation("§ 1.01", 0)],
      },
    });
    const { container } = render(
      <SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />,
    );
    expect(container.textContent).toContain("§ 1.01");
    expect(document.querySelector("span.lc-cite")).toBeNull();
  });

  it("consecutive paragraph_break segments collapse rather than rendering empty <p>", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "first\n\nsecond",
        body: [bodyText("first"), bodyParaBreak(), bodyParaBreak(), bodyText("second")],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(document.querySelectorAll("p.lc-para")).toHaveLength(2);
  });

  it("citation/defined_term overlap rendering: both are independent siblings, no crash", () => {
    // Per CQ2 the parser already resolved overlap precedence; the
    // renderer just iterates. This case asserts a sequence of citation
    // followed by defined_term in the same paragraph renders both.
    const view = buildCorpusSectionView({
      section: {
        text: "§ 1.01 Person",
        citations: [citationInternal("§ 1.01", "1.01")],
        defined_terms: ["Person"],
        body: [bodyCitation("§ 1.01", 0), bodyText(" "), bodyDefinedTerm("Person")],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(document.querySelector("span.lc-cite")).not.toBeNull();
    expect(document.querySelector(".lc-deftrm")).not.toBeNull();
  });
});
