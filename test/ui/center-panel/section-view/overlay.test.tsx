// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Bill, BillSchema } from "@/types";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { bodyParaBreak, bodyText, buildCorpusSectionView } from "./fixtures";

// The wholesale-delete corpus pattern: bill flat-deletes the section.
// Real shape: one TextDiffSpan with op:"delete", anchor covering the
// whole baseline.
function wholesaleDeleteBill(
  fileNo: string,
  moduleId: string,
  sectionId: string,
  baseline: string,
  over: Partial<Bill> = {},
): Bill {
  return BillSchema.parse({
    file_no: fileNo,
    module_id: moduleId,
    short_title: "Code Cleanup",
    long_title: "Ordinance repealing several sections of the Health Code…",
    sponsor: null,
    introduced_at: "2026-05-12",
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "committee",
    affected_sections: [sectionId],
    text_diff: [
      {
        op: "delete",
        text: baseline,
        section_id: sectionId,
        anchor: { baseline_offset: 0, baseline_length: baseline.length },
      },
    ],
    parse_status: "ok",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
    ...over,
  } as Bill);
}

// Inline-edit: a single word replacement at a known baseline offset.
function inlineEditBill(
  fileNo: string,
  moduleId: string,
  sectionId: string,
  deleteAt: { offset: number; length: number; text: string },
  insert: string,
): Bill {
  return BillSchema.parse({
    file_no: fileNo,
    module_id: moduleId,
    short_title: "Targeted Amendment",
    long_title: "Ordinance amending one section.",
    sponsor: null,
    introduced_at: "2026-05-12",
    legistar_url: "https://e/d?ID=2&GUID=g2",
    legistar_status: "Pending",
    bill_status: "committee",
    affected_sections: [sectionId],
    text_diff: [
      {
        op: "delete",
        text: deleteAt.text,
        section_id: sectionId,
        anchor: { baseline_offset: deleteAt.offset, baseline_length: deleteAt.length },
      },
      {
        op: "insert",
        text: insert,
        section_id: sectionId,
        anchor: { baseline_offset: deleteAt.offset, baseline_length: 0 },
      },
    ],
    parse_status: "ok",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
  } as Bill);
}

function manualReviewBill(fileNo: string, moduleId: string, sectionId: string): Bill {
  return BillSchema.parse({
    file_no: fileNo,
    module_id: moduleId,
    short_title: "Untyped Amendment",
    long_title: "Ordinance whose diff couldn't be parsed.",
    sponsor: null,
    introduced_at: "2026-05-12",
    legistar_url: "https://e/d?ID=3&GUID=g3",
    legistar_status: "Pending",
    bill_status: "committee",
    affected_sections: [sectionId],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
  } as Bill);
}

const BASELINE = "The committee shall meet quarterly.";

function buildSectionView() {
  return buildCorpusSectionView({
    moduleId: "sf-health",
    section: {
      id: "695",
      display_label: "695",
      title: "Permit Required",
      text: BASELINE,
      body: [bodyText(BASELINE)],
    },
  });
}

describe("SectionView overlay — resting state (overlay off)", () => {
  it("renders the body normally and the rail with a Show changes button", () => {
    const view = buildSectionView();
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText(BASELINE)).toBeInTheDocument();
    expect(document.querySelector(".lc-section-body--overlay")).toBeNull();
    expect(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    ).toBeInTheDocument();
  });

  it("suppresses the rail entirely when no pending bills affect the section", () => {
    const view = buildSectionView();
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[]}
        onOpenBill={vi.fn()}
      />,
    );
    expect(document.querySelector(".lc-section-pending-rail")).toBeNull();
  });
});

describe("SectionView overlay — wholesale delete", () => {
  it("activates by clicking Show changes — body re-renders with the whole baseline struck through", () => {
    const view = buildSectionView();
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    );
    expect(document.querySelector(".lc-section-body--overlay")).not.toBeNull();
    const deletes = document.querySelectorAll(".lc-overlay-delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.textContent).toBe(BASELINE);
  });

  it("keeps the header (eyebrow + §id + title) untouched in overlay mode (variant B)", () => {
    const view = buildSectionView();
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    );
    // §695, "Permit Required" still render as clean text — no strike on the header.
    const sectionId = screen.getByText("§ 695");
    const title = screen.getByText("Permit Required");
    expect(sectionId).toBeInTheDocument();
    expect(title).toBeInTheDocument();
    expect(sectionId.closest(".lc-section-body--overlay")).toBeNull();
    expect(title.closest(".lc-section-body--overlay")).toBeNull();
  });

  it("grows the explainer block on the active row (variant B locus)", () => {
    const view = buildSectionView();
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    );
    expect(screen.getByText("VIEWING")).toBeInTheDocument();
    expect(screen.getByText(/as if Ord\. 260545 had passed/i)).toBeInTheDocument();
  });

  it("clears overlay when the toggle is clicked a second time", () => {
    const view = buildSectionView();
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    );
    expect(document.querySelector(".lc-section-body--overlay")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /clear overlay for ord\. 260545/i }));
    expect(document.querySelector(".lc-section-body--overlay")).toBeNull();
    expect(screen.queryByText("VIEWING")).toBeNull();
  });
});

describe("SectionView overlay — inline edit", () => {
  it("interleaves struck deletes and highlighted inserts in body order", () => {
    // baseline: "The committee shall meet quarterly."  (offset 4..13 = "committee")
    const view = buildSectionView();
    const bill = inlineEditBill(
      "260700",
      "sf-health",
      "695",
      { offset: 4, length: 9, text: "committee" },
      "council",
    );
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260700 had passed/i }),
    );
    const overlay = document.querySelector(".lc-section-body--overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(".lc-overlay-delete")?.textContent).toBe("committee");
    expect(overlay?.querySelector(".lc-overlay-insert")?.textContent).toBe("council");
    expect(overlay?.textContent).toContain("The ");
    expect(overlay?.textContent).toContain(" shall meet quarterly.");
  });
});

describe("SectionView overlay — multi-bill section", () => {
  it("activating one bill's overlay doesn't change the other's row state", () => {
    const view = buildSectionView();
    const billA = wholesaleDeleteBill("260100", "sf-health", "695", BASELINE);
    const billB = wholesaleDeleteBill("260200", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[billA, billB]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260100 had passed/i }),
    );
    // billA's row reads as overlay-on; billB's row still says "View as if..."
    expect(
      screen.getByRole("button", { name: /clear overlay for ord\. 260100/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /view this section as if ord\. 260200 had passed/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("VIEWING")).toHaveLength(1);
  });

  it("toggling a second bill replaces the first as the active overlay", () => {
    const view = buildSectionView();
    const billA = wholesaleDeleteBill("260100", "sf-health", "695", BASELINE);
    const billB = wholesaleDeleteBill("260200", "sf-health", "695", BASELINE);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[billA, billB]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260100 had passed/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260200 had passed/i }),
    );
    expect(
      screen.getByRole("button", { name: /view this section as if ord\. 260100 had passed/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /clear overlay for ord\. 260200/i }),
    ).toBeInTheDocument();
  });
});

describe("SectionView overlay — unavailable", () => {
  it("manual_review bill: rail row appears but the Show changes toggle is suppressed", () => {
    const view = buildSectionView();
    const bill = manualReviewBill("260999", "sf-health", "695");
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    // Bill row + file_no open affordance still render — the user can
    // open the bill and see the manual_review status. The diff-overlay
    // toggle is suppressed because the parser couldn't produce a diff
    // for this section, so promising "Show changes" would lie.
    expect(screen.getByRole("button", { name: /open ord\. 260999/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /view this section as if ord\. 260999 had passed/i }),
    ).toBeNull();
    expect(document.querySelector(".lc-section-body--overlay")).toBeNull();
  });
});

describe("SectionView overlay — section change resets state", () => {
  it("switching to a different section clears the active overlay", () => {
    const viewA = buildCorpusSectionView({
      moduleId: "sf-health",
      section: {
        id: "695",
        display_label: "695",
        title: "Permit Required",
        text: BASELINE,
        body: [bodyText(BASELINE)],
      },
    });
    const viewB = buildCorpusSectionView({
      moduleId: "sf-health",
      section: {
        id: "696",
        display_label: "696",
        title: "Fees",
        text: "Fees shall be paid annually.",
        body: [bodyText("Fees shall be paid annually.")],
      },
    });
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", BASELINE);
    const { rerender } = render(
      <SectionView
        view={viewA}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    );
    expect(document.querySelector(".lc-section-body--overlay")).not.toBeNull();
    // Section changes; the overlay resets even though the rail bill stays the same.
    rerender(
      <SectionView
        view={viewB}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[]}
        onOpenBill={vi.fn()}
      />,
    );
    expect(document.querySelector(".lc-section-body--overlay")).toBeNull();
  });
});

describe("SectionView overlay — multi-paragraph body", () => {
  it("paragraphizes the inline-diff stream across `\\n` boundaries", () => {
    const baseline = "Para one.\nPara two.\nPara three.";
    const view = buildCorpusSectionView({
      moduleId: "sf-health",
      section: {
        id: "695",
        display_label: "695",
        title: "Permit Required",
        text: baseline,
        body: [
          bodyText("Para one."),
          bodyParaBreak(),
          bodyText("Para two."),
          bodyParaBreak(),
          bodyText("Para three."),
        ],
      },
    });
    const bill = wholesaleDeleteBill("260545", "sf-health", "695", baseline);
    render(
      <SectionView
        view={view}
        parentsLabel=""
        error={null}
        navigate={vi.fn()}
        pendingRailBills={[bill]}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view this section as if ord\. 260545 had passed/i }),
    );
    const overlayParas = document.querySelectorAll(".lc-section-body--overlay p.lc-para");
    expect(overlayParas).toHaveLength(3);
    expect(overlayParas[0]?.textContent).toBe("Para one.");
    expect(overlayParas[1]?.textContent).toBe("Para two.");
    expect(overlayParas[2]?.textContent).toBe("Para three.");
    // Each paragraph's content is wrapped in a delete span.
    expect(overlayParas[0]?.querySelector(".lc-overlay-delete")?.textContent).toBe("Para one.");
  });
});
