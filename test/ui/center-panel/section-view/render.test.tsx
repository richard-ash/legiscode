// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import {
  bodyCitation,
  bodyDefinedTerm,
  bodyParaBreak,
  bodyText,
  buildCorpusSectionView,
  citationInternal,
  testDefId,
  testDefinitionView,
} from "./fixtures";

describe("SectionView — top-level render", () => {
  it("renders the section number, title, and parents kicker", () => {
    const view = buildCorpusSectionView({
      section: { id: "1.1", title: "Definitions" },
    });
    render(
      <SectionView
        view={view}
        parentsLabel="Port Code · ARTICLE 1"
        error={null}
        navigate={vi.fn()}
      />,
    );
    expect(screen.getByText("§ 1.1")).toBeInTheDocument();
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Port Code · ARTICLE 1")).toBeInTheDocument();
  });

  it("iterates body[] segments into <p> chunks split on paragraph_break", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "First paragraph.\nSecond paragraph.\nThird paragraph.",
        body: [
          bodyText("First paragraph."),
          bodyParaBreak(),
          bodyText("Second paragraph."),
          bodyParaBreak(),
          bodyText("Third paragraph."),
        ],
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(screen.getByText("First paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Third paragraph.")).toBeInTheDocument();
    // Three paragraphs → three <p> elements with .lc-para.
    expect(document.querySelectorAll("p.lc-para")).toHaveLength(3);
  });

  it("emits citation and defined-term markup inline within paragraphs", () => {
    const view = buildCorpusSectionView({
      section: {
        text: "see § 1.01 ('Person')",
        citations: [citationInternal("§ 1.01", "1.01")],
        defined_terms: ["Person"],
        body: [
          bodyText("see "),
          bodyCitation("§ 1.01", 0),
          bodyText(" ('"),
          bodyDefinedTerm("Person"),
          bodyText("')"),
        ],
      },
      definitions: {
        [testDefId("Person")]: testDefinitionView("Person"),
      },
    });
    render(<SectionView view={view} parentsLabel="" error={null} navigate={vi.fn()} />);
    // Both annotations land inside the section view.
    expect(document.querySelector(".lc-cite")).not.toBeNull();
    expect(document.querySelector(".lc-deftrm")).not.toBeNull();
  });

  it("renders the placeholder when view is null and no error", () => {
    render(<SectionView view={null} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(screen.getByText("No section selected")).toBeInTheDocument();
  });
});
