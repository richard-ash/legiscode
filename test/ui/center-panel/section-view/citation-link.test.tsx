// @vitest-environment jsdom
//
// Locks the rendering contract for CitationLink. The element is a
// `<span>` with `role="link"` + `tabIndex={0}` so plain text selection
// works across citation boundaries (VS Code semantics); ⌘/Ctrl-click
// dispatches navigation via the section-view body's delegated handler.
// Styling is driven by `data-cite-kind` (CSS attribute selectors), not
// by kind-suffix class names.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationLink } from "@/ui/center-panel/section-view/citation-link";
import {
  citationCrossModule,
  citationInternal,
  citationInternalAppendix,
  citationStructural,
  citationVague,
} from "./fixtures";

function getLink(): HTMLSpanElement {
  const link = document.querySelector("span.lc-cite");
  if (!link) throw new Error("expected a .lc-cite span");
  return link as HTMLSpanElement;
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
    render(<CitationLink raw="§ 1.01(a)–1.05" citation={citation} citation_index={0} />);
    const link = getLink();
    expect(link.dataset.citeKind).toBe("internal");
    expect(link.dataset.sectionId).toBe("1.01");
    expect(link.dataset.subsection).toBe("(a)");
    expect(link.dataset.rangeFrom).toBe("1.01");
    expect(link.dataset.rangeTo).toBe("1.05");
    expect(link.dataset.raw).toBe("§ 1.01(a)–1.05");
  });

  it("internal: omits subsection/range when not on the citation target", () => {
    render(
      <CitationLink
        raw="§ 1.01"
        citation={citationInternal("§ 1.01", "1.01")}
        citation_index={0}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("internal");
    expect(link.dataset.sectionId).toBe("1.01");
    expect(link.dataset.subsection).toBeUndefined();
    expect(link.dataset.rangeFrom).toBeUndefined();
  });

  it("cross_module: emits module-id + section-id", () => {
    render(
      <CitationLink
        raw="SF Health § 12.05"
        citation={citationCrossModule("SF Health § 12.05", "sf-health", "12.05")}
        citation_index={0}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("cross_module");
    expect(link.dataset.moduleId).toBe("sf-health");
    expect(link.dataset.sectionId).toBe("12.05");
  });

  it("structural: emits level + number", () => {
    render(
      <CitationLink
        raw="Article 5"
        citation={citationStructural("Article 5", "article", "5")}
        citation_index={0}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("structural");
    expect(link.dataset.structuralLevel).toBe("article");
    expect(link.dataset.structuralNumber).toBe("5");
  });

  it("vague: emits only raw + kind discriminator", () => {
    render(
      <CitationLink
        raw="this Code"
        citation={citationVague("this Code", "this Code")}
        citation_index={0}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("vague");
    expect(link.dataset.sectionId).toBeUndefined();
  });

  it("internal_appendix: emits appendix-id + kind", () => {
    render(
      <CitationLink
        raw="see Appendix M"
        citation={citationInternalAppendix("see Appendix M", "article-1-appendix-m")}
        citation_index={0}
      />,
    );
    const link = getLink();
    expect(link.dataset.citeKind).toBe("internal_appendix");
    expect(link.dataset.appendixId).toBe("article-1-appendix-m");
  });

  it("emits data-citation-index so the delegated click can recover the citation", () => {
    render(
      <CitationLink
        raw="§ 1.01"
        citation={citationInternal("§ 1.01", "1.01")}
        citation_index={7}
      />,
    );
    const link = getLink();
    expect(link.dataset.citationIndex).toBe("7");
  });

  it("renders as a span with role='link' + tabIndex so text selection works yet keyboard tab still lands here", () => {
    // VS Code semantics: plain click is selection, ⌘-click is open. A
    // <span> with role="link" + tabIndex={0} keeps the cite keyboard-
    // reachable without consuming text-selection drags.
    render(
      <CitationLink
        raw="§ 1.01"
        citation={citationInternal("§ 1.01", "1.01")}
        citation_index={0}
      />,
    );
    const link = getLink();
    expect(link.tagName).toBe("SPAN");
    expect(link.getAttribute("role")).toBe("link");
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);
  });
});
