// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CorpusSectionView } from "../../../electron/ipc/contract";
import { SectionView } from "../../../src/ui/center-panel/section-view";

const view: CorpusSectionView = {
  moduleId: "sf-port",
  section: {
    kind: "section",
    id: "1.1",
    title: "Definitions",
    text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    citations: [],
    defined_terms: [],
    hierarchy: ["Port Code", "ARTICLE 1"],
    editorial_status: "active",
    body: [],
  },
  parents: [
    { code: "Port Code", name: "Port Code" },
    { code: "ARTICLE 1", name: "" },
  ],
  prev: null,
  next: null,
};

describe("SectionView", () => {
  it("renders the section number, title, and parents kicker", () => {
    render(<SectionView view={view} parentsLabel="Port Code · ARTICLE 1" />);
    expect(screen.getByText("§ 1.1")).toBeInTheDocument();
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Port Code · ARTICLE 1")).toBeInTheDocument();
  });

  it("splits text into paragraphs on blank lines", () => {
    render(<SectionView view={view} parentsLabel="" />);
    expect(screen.getByText("First paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Third paragraph.")).toBeInTheDocument();
  });

  it("shows editorial status when not 'active'", () => {
    const reserved: CorpusSectionView = {
      ...view,
      section: { ...view.section, editorial_status: "reserved" },
    };
    render(<SectionView view={reserved} parentsLabel="" />);
    expect(screen.getByText(/Editorial status: reserved/)).toBeInTheDocument();
  });

  it("renders an empty placeholder when view is null", () => {
    render(<SectionView view={null} parentsLabel="" />);
    expect(screen.getByText("No section selected")).toBeInTheDocument();
  });

  it("does not render inline citation or defined-term markup yet", () => {
    // Phase-1 contract: citations + defined-term highlights belong to
    // feat/section-view. Lock the absence so additions can't sneak in
    // without a deliberate test update.
    render(<SectionView view={view} parentsLabel="" />);
    expect(document.querySelector(".lc-cite")).toBeNull();
    expect(document.querySelector(".lc-deftrm")).toBeNull();
  });
});
