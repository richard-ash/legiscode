// @vitest-environment jsdom
//
// Asserts non-crash + correct paragraph count on a synthetic ~100KB
// section that matches the real-corpus worst case (sf-publicworks 184.12
// at 99KB). Per codex C12 jsdom is unreliable for perf timing — perf
// budget enforcement lives in test/e2e/electron/section-view.spec.ts
// (Playwright) which actually measures real-Chromium render. This file
// only asserts the renderer survives the size.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { bodyParaBreak, bodyText, buildCorpusSectionView } from "./fixtures";

describe("SectionView — long-section (matches sf-publicworks 184.12 worst case)", () => {
  it("renders 100KB body across 200 paragraphs without crashing", () => {
    const para = "x".repeat(500); // 500 bytes per paragraph
    const segments = [];
    const textLines: string[] = [];
    for (let i = 0; i < 200; i++) {
      segments.push(bodyText(para));
      textLines.push(para);
      if (i < 199) {
        segments.push(bodyParaBreak());
        textLines.push("\n");
      }
    }
    const view = buildCorpusSectionView({
      section: { text: textLines.join(""), body: segments },
    });
    const { unmount } = render(
      <SectionView view={view} parentsLabel="" error={null} onActivate={vi.fn()} />,
    );
    // 200 paragraphs → 200 <p> elements.
    expect(document.querySelectorAll("p.lc-para")).toHaveLength(200);
    // Total body text length matches the synthetic input (rough sanity).
    const sectionViewBody = document.querySelector(".lc-section-body");
    expect((sectionViewBody?.textContent ?? "").length).toBeGreaterThanOrEqual(100_000);
    unmount();
  });
});
