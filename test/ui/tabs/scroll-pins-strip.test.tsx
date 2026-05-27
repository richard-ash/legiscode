// @vitest-environment jsdom
/// <reference lib="dom" />

// Structural regression guard for the .lc-center flex-chain that pins the
// TabStrip + Breadcrumb while the section body scrolls.
//
// Two classes of bug can re-break the pin, and this file covers both:
//
//   1. A CSS rule on the chain gets deleted — caught by the CSS-rule
//      assertions below (.lc-center min-height:0, .lc-tabs-row +
//      .lc-breadcrumb flex-shrink:0, .lc-doc overflow:auto).
//   2. A new DOM wrapper is added between .lc-center and .lc-doc — caught
//      by the DOM-shape assertions below. The original wrapper (a
//      <section role="tabpanel"> rendered by TabContent) had no flex
//      properties of its own, so .lc-doc's flex:1 + overflow:auto never
//      engaged and the strip scrolled out of view. The role is now folded
//      onto .lc-doc itself.
//
// jsdom doesn't compute layout, so getBoundingClientRect()-style behavior
// assertions aren't meaningful — both classes of bug are caught by
// structural assertions. Real-layout assertions live in the Playwright
// e2e suite.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parse as corpusRefParse } from "@/corpus/refs";
import { TabContent } from "@/ui/tabs/tab-content";
import { buildCorpusSectionView } from "../center-panel/section-view/fixtures";

const globalsCss = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "src", "styles", "globals.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "m");
  const m = globalsCss.match(re);
  if (!m?.[1]) throw new Error(`Selector ${selector} not found in globals.css`);
  return m[1];
}

describe("scroll-chain CSS contract — TabStrip + Breadcrumb stay pinned", () => {
  it(".lc-center bounds its height to the panel via height:100% + min-height:0", () => {
    // Both rules are load-bearing. height:100% anchors .lc-center to the
    // react-resizable-panels inner wrapper (which is display:block, so
    // .lc-center's flex:1 doesn't take effect on its own). min-height:0
    // lets the .lc-doc flex child shrink past its content size so its
    // overflow:auto engages. Drop either and the parent panel takes the
    // overflow, dragging TabStrip + Breadcrumb out of view on long
    // sections.
    const body = ruleBody(".lc-center");
    expect(body).toMatch(/height:\s*100%/);
    expect(body).toMatch(/min-height:\s*0\b/);
  });

  it(".lc-tabs-row holds via flex-shrink:0 (pinned upstream of .lc-doc)", () => {
    // The wrapper carries the pin; .lc-tabs inside is a horizontal flex
    // item whose flex-shrink no longer matters for vertical pinning.
    expect(ruleBody(".lc-tabs-row")).toMatch(/flex-shrink:\s*0\b/);
  });

  it(".lc-breadcrumb holds via flex-shrink:0 (pinned upstream of .lc-doc)", () => {
    expect(ruleBody(".lc-breadcrumb")).toMatch(/flex-shrink:\s*0\b/);
  });

  it(".lc-doc owns the overflow as the intended scroll container", () => {
    const body = ruleBody(".lc-doc");
    expect(body).toMatch(/flex:\s*1\b/);
    expect(body).toMatch(/overflow:\s*auto\b/);
  });
});

describe("scroll-chain DOM contract — TabContent renders .lc-doc as its root", () => {
  // Any wrapper element between .lc-center and .lc-doc breaks the flex
  // chain unless it carries flex:1 + min-height:0 of its own. Renderer-
  // owned wrappers (anything React puts here, ARIA or otherwise) have
  // historically lacked that styling — easier to forbid the wrapper than
  // to remember to style it. role=tabpanel lives directly on .lc-doc.
  const item = { kind: "section" as const, ref: corpusRefParse({ module: "m", section: "1.1" }) };

  function rootOf(node: HTMLElement): HTMLElement {
    const root = node.firstElementChild as HTMLElement | null;
    if (!root) throw new Error("TabContent rendered no root element");
    return root;
  }

  it("loaded-view branch renders .lc-doc directly with role=tabpanel", () => {
    const { container } = render(
      <TabContent
        item={item}
        section={buildCorpusSectionView()}
        sectionError={null}
        parentsLabel=""
        navigate={() => {}}
      />,
    );
    const root = rootOf(container);
    expect(root.classList.contains("lc-doc")).toBe(true);
    expect(root.getAttribute("role")).toBe("tabpanel");
    expect(root.getAttribute("aria-labelledby")).toMatch(/^tab-section:/);
  });

  it("error branch renders .lc-doc directly with role=tabpanel", () => {
    const { container } = render(
      <TabContent
        item={item}
        section={null}
        sectionError={{ kind: "not_found", detail: "boom" }}
        parentsLabel=""
        navigate={() => {}}
      />,
    );
    const root = rootOf(container);
    expect(root.classList.contains("lc-doc")).toBe(true);
    expect(root.getAttribute("role")).toBe("tabpanel");
  });

  it("loading branch renders .lc-doc directly with role=tabpanel", () => {
    const { container } = render(
      <TabContent
        item={item}
        section={null}
        sectionError={null}
        parentsLabel=""
        navigate={() => {}}
      />,
    );
    const root = rootOf(container);
    expect(root.classList.contains("lc-doc")).toBe(true);
    expect(root.getAttribute("role")).toBe("tabpanel");
  });
});
