// @vitest-environment jsdom
//
// D8 + C7 lock — error prop replaces the body with an in-section banner.
// Pairs with App.test.tsx's F3 regression which asserts upstream that
// `setSection(null)` clears chrome on r.ok=false; this file pins the
// renderer-side behaviour in isolation.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { bodyText, buildCorpusSectionView } from "./fixtures";

describe("SectionView — error banner (D8)", () => {
  it("renders the banner with the error detail when error is set", () => {
    render(
      <SectionView
        view={null}
        parentsLabel=""
        error={{ kind: "not_found", detail: "Section 9.9 not found" }}
        navigate={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load this section")).toBeInTheDocument();
    expect(screen.getByText(/Section 9.9 not found/)).toBeInTheDocument();
  });

  it("renders the banner instead of the body even when view is also present (C7 paired path)", () => {
    // App.tsx clears `view` to null on r.ok=false, but if a future caller
    // forgot to clear, the banner still wins. Asserts the precedence so
    // C7's null-clear is not the only protection against stale chrome.
    const view = buildCorpusSectionView({
      section: {
        text: "Body of the prior section.",
        body: [bodyText("Body of the prior section.")],
      },
    });
    render(
      <SectionView
        view={view}
        parentsLabel="Port Code"
        error={{ kind: "corrupt", detail: "Schema parse failed" }}
        navigate={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Body of the prior section.")).toBeNull();
  });

  it("does not render the banner when error is null", () => {
    render(<SectionView view={null} parentsLabel="" error={null} navigate={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
