// @vitest-environment jsdom
//
// Locks the D2 contract: per-kind data attributes the
// `feat/citation-resolution` (#9) branch will read off `el.dataset.*`. The
// parser today only emits `internal` and `external` kinds (citations.ts
// comment); the cross_module / vague / internal_appendix entries here are
// synthetic fixtures that prove the renderer's data-attr emission, not
// pipeline-side coverage.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationLink } from "@/ui/center-panel/section-view/citation-link";
import {
  citationCrossModule,
  citationExternal,
  citationInternal,
  citationInternalAppendix,
  citationVague,
} from "./fixtures";

function getLink(): HTMLAnchorElement {
  const link = document.querySelector("a.lc-cite");
  if (!link) throw new Error("expected an .lc-cite anchor");
  return link as HTMLAnchorElement;
}

describe("CitationLink — 5 citation kinds", () => {
  it("internal: emits data-cite-kind + section-id + optional subsection/range", () => {
    const citation = {
      display_text: "§ 1.01(a)–1.05",
      target: {
        kind: "internal" as const,
        section_id: "1.01",
        subsection: "(a)",
        range: { from: "1.01", to: "1.05" },
      },
    };
    render(<CitationLink raw="§ 1.01(a)–1.05" citation={citation} />);
    const link = getLink();
    expect(link.dataset.citeKind).toBe("internal");
    expect(link.dataset.sectionId).toBe("1.01");
    expect(link.dataset.subsection).toBe("(a)");
    expect(link.dataset.rangeFrom).toBe("1.01");
    expect(link.dataset.rangeTo).toBe("1.05");
    expect(link.dataset.raw).toBe("§ 1.01(a)–1.05");
    expect(link.classList.contains("lc-cite-internal")).toBe(true);
  });

  it("internal: omits subsection/range when not on the citation target", () => {
    render(<CitationLink raw="§ 1.01" citation={citationInternal("§ 1.01", "1.01")} />);
    const link = getLink();
    expect(link.dataset.citeKind).toBe("internal");
    expect(link.dataset.sectionId).toBe("1.01");
    expect(link.dataset.subsection).toBeUndefined();
    expect(link.dataset.rangeFrom).toBeUndefined();
  });

  it("cross_module: emits module-id + section-id; shares lc-cite-internal styling", () => {
    render(
      <CitationLink
        raw="SF Health § 12.05"
        citation={citationCrossModule("SF Health § 12.05", "sf-health", "12.05")}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("cross_module");
    expect(link.dataset.moduleId).toBe("sf-health");
    expect(link.dataset.sectionId).toBe("12.05");
    expect(link.classList.contains("lc-cite-internal")).toBe(true);
  });

  it("external: emits raw, no section/module IDs; uses lc-cite-external styling", () => {
    render(
      <CitationLink
        raw="Cal. Veh. Code § 21"
        citation={citationExternal("Cal. Veh. Code § 21", "Cal. Veh. Code § 21")}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("external");
    expect(link.dataset.sectionId).toBeUndefined();
    expect(link.dataset.moduleId).toBeUndefined();
    expect(link.classList.contains("lc-cite-external")).toBe(true);
  });

  it("vague: emits only raw + kind discriminator; uses lc-cite-vague styling", () => {
    render(<CitationLink raw="this Code" citation={citationVague("this Code", "this Code")} />);
    const link = getLink();
    expect(link.dataset.citeKind).toBe("vague");
    expect(link.dataset.sectionId).toBeUndefined();
    expect(link.classList.contains("lc-cite-vague")).toBe(true);
  });

  it("internal_appendix: emits appendix-id + kind; shares lc-cite-internal styling", () => {
    render(
      <CitationLink
        raw="see Appendix M"
        citation={citationInternalAppendix("see Appendix M", "article-1-appendix-m")}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("internal_appendix");
    expect(link.dataset.appendixId).toBe("article-1-appendix-m");
    expect(link.classList.contains("lc-cite-internal")).toBe(true);
  });
});
