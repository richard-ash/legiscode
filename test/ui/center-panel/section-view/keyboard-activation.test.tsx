// @vitest-environment jsdom
//
// Citation keyboard activation. The cite span has carried `tabIndex={0}`
// + `role="link"` since the citation refoundation, but no key handler
// ever existed — Enter on a focused cite was a silent no-op. This file
// pins the new delegate's contract:
//
//   Enter / Mod+Enter → onCitationActivate(citation, "primary")
//   Space            → no-op (text-selection / scroll territory)
//   Enter outside a cite → no-op
//
// Hover lifecycle (timers, scroll-dismiss, Escape) is owned by
// useHoverPopover and tested there — keep this file focused on the
// keyboard delegate alone.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { bodyCitation, bodyText, buildCorpusSectionView, citationInternal } from "./fixtures";

function viewWithCite() {
  return buildCorpusSectionView({
    section: {
      text: "see § 1.01",
      citations: [citationInternal("§ 1.01", "1.01")],
      body: [bodyText("see "), bodyCitation("§ 1.01", 0)],
    },
  });
}

describe("Citation keyboard activation (delegated)", () => {
  it("Enter on a focused cite dispatches onCitationActivate(citation, 'primary')", () => {
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={viewWithCite()}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const span = document.querySelector("[data-cite-kind]") as HTMLElement;
    fireEvent.keyDown(span, { key: "Enter" });
    expect(onCitationActivate).toHaveBeenCalledTimes(1);
    const [citation, intent] = onCitationActivate.mock.calls[0] ?? [];
    expect(citation?.target?.kind).toBe("internal");
    expect(intent).toBe("primary");
  });

  it("Mod+Enter on a focused cite also dispatches primary", () => {
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={viewWithCite()}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const span = document.querySelector("[data-cite-kind]") as HTMLElement;
    fireEvent.keyDown(span, { key: "Enter", metaKey: true });
    expect(onCitationActivate).toHaveBeenCalledTimes(1);
    expect(onCitationActivate.mock.calls[0]?.[1]).toBe("primary");
  });

  it("Space on a focused cite is a no-op (text-selection territory)", () => {
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={viewWithCite()}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const span = document.querySelector("[data-cite-kind]") as HTMLElement;
    fireEvent.keyDown(span, { key: " " });
    expect(onCitationActivate).not.toHaveBeenCalled();
  });

  it("Enter outside any cite is a no-op", () => {
    const onCitationActivate = vi.fn();
    render(
      <SectionView
        view={viewWithCite()}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        onCitationActivate={onCitationActivate}
      />,
    );
    const body = document.querySelector(".lc-section-body") as HTMLElement;
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onCitationActivate).not.toHaveBeenCalled();
  });
});
