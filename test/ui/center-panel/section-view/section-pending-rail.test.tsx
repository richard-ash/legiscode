// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Bill, BillSchema, deriveParseStatus, type SectionId } from "@/types";
import {
  type ActiveOverlay,
  SectionPendingRail,
} from "@/ui/center-panel/section-view/section-pending-rail";
import { outcomesFromAffectedSections } from "../../../helpers/section-outcomes";

const SECTION_ID = "1.1" as SectionId;

function makeBill(over: Partial<Bill> & { affected_sections?: SectionId[] } = {}): Bill {
  const { affected_sections, ...rest } = over;
  const explicitParseStatus = rest.parse_status;
  const sectionOutcomes =
    rest.section_outcomes ??
    outcomesFromAffectedSections(
      affected_sections ?? (["1.1"] as SectionId[]),
      explicitParseStatus ?? "ok",
    );
  const hasStructural = explicitParseStatus === "structural_change";
  const derivedStatus = deriveParseStatus(sectionOutcomes, hasStructural);
  const defaultNewBodies = sectionOutcomes
    .filter((o) => o.status === "anchored" || o.status === "added_section")
    .map((o) => ({ section_id: o.section_id, body: [] }));
  return BillSchema.parse({
    file_no: "260217",
    module_id: "sf-port",
    short_title: "Residential Speed Reduction",
    long_title: "Ordinance amending the Port Code…",
    sponsor: null,
    introduced_at: "2026-05-12",
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "committee",
    diff_chunks: [
      {
        section_id: "1.1",
        op: "insert",
        text: "new",
      },
    ],
    new_bodies: defaultNewBodies,
    structural_change_scope: hasStructural ? (rest.structural_change_scope ?? "structural") : null,
    body: { preamble: "", amendments: [], closing: "" },
    ...rest,
    section_outcomes: sectionOutcomes,
    parse_status: derivedStatus,
  } as Bill);
}

const RESTING = {
  activeOverlay: null as ActiveOverlay | null,
  onChangeOverlay: vi.fn(),
  sectionId: SECTION_ID,
};

const CHANGES = (billId: string): ActiveOverlay => ({ billId, mode: "changes" });
const PROPOSED = (billId: string): ActiveOverlay => ({ billId, mode: "proposed" });

describe("SectionPendingRail — visibility", () => {
  it("renders nothing when no bills affect this section", () => {
    const { container } = render(
      <SectionPendingRail bills={[]} {...RESTING} onOpenBill={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a single-bill label when one bill affects the section", () => {
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={vi.fn()} />);
    expect(screen.getByText(/1 pending ordinance/i)).toBeInTheDocument();
  });

  it("renders the plural label when multiple bills affect the section", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 pending ordinances/i)).toBeInTheDocument();
  });

  it("each row carries the bill's status pill", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ bill_status: "committee" })]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText("Committee")).toBeInTheDocument();
  });

  it("shows the bill title in the row", () => {
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={vi.fn()} />);
    expect(screen.getByText("Residential Speed Reduction")).toBeInTheDocument();
  });
});

describe("SectionPendingRail — file-no opens bill", () => {
  it("clicking the fileno dispatches onOpenBill with primary intent", () => {
    const onOpenBill = vi.fn();
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={onOpenBill} />);
    fireEvent.click(screen.getByRole("button", { name: /open ord\. 260217/i }));
    expect(onOpenBill).toHaveBeenCalledWith("260217", "primary");
  });

  it("Cmd+click on the fileno dispatches background intent", () => {
    const onOpenBill = vi.fn();
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={onOpenBill} />);
    fireEvent.click(screen.getByRole("button", { name: /open ord\. 260217/i }), {
      metaKey: true,
    });
    expect(onOpenBill).toHaveBeenCalledWith("260217", "background");
  });

  it("Enter on the fileno dispatches onOpenBill", () => {
    const onOpenBill = vi.fn();
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={onOpenBill} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /open ord\. 260217/i }), {
      key: "Enter",
    });
    expect(onOpenBill).toHaveBeenCalledWith("260217", "primary");
  });

  it("clicking the fileno does NOT change the overlay (button is its own click target)", () => {
    const onChangeOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={null}
        onChangeOverlay={onChangeOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open ord\. 260217/i }));
    expect(onChangeOverlay).not.toHaveBeenCalled();
  });
});

describe("SectionPendingRail — segmented control (Original · Changes · Proposed)", () => {
  it("renders the three mode buttons on each resting row", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Original" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Changes" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Proposed" })).toHaveLength(2);
  });

  it("Original is the default pressed state when no overlay is active", () => {
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={vi.fn()} />);
    const original = screen.getByRole("button", { name: "Original" });
    expect(original.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Changes" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "Proposed" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("clicking Changes dispatches onChangeOverlay with mode='changes'", () => {
    const onChangeOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={null}
        onChangeOverlay={onChangeOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(onChangeOverlay).toHaveBeenCalledWith({ billId: "260217", mode: "changes" });
  });

  it("clicking Proposed dispatches onChangeOverlay with mode='proposed'", () => {
    const onChangeOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={null}
        onChangeOverlay={onChangeOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Proposed" }));
    expect(onChangeOverlay).toHaveBeenCalledWith({ billId: "260217", mode: "proposed" });
  });

  it("Changes is pressed when the active overlay is on this bill in changes mode", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("Proposed is pressed when the active overlay is on this bill in proposed mode", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={PROPOSED("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Proposed" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("clicking Original on the active row clears the overlay (null)", () => {
    const onChangeOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={onChangeOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(onChangeOverlay).toHaveBeenCalledWith(null);
  });

  it("non-active rows render with Original pressed even when another row is active", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260200")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    // Two rows. The active one (260200) has Changes pressed; the
    // other (260100) has Original pressed.
    const originals = screen.getAllByRole("button", { name: "Original" });
    const changes = screen.getAllByRole("button", { name: "Changes" });
    expect(originals.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    expect(changes.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("the active row in Changes mode shows the VIEWING CHANGES badge", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText("VIEWING CHANGES")).toBeInTheDocument();
  });

  it("the active row in Proposed mode shows the VIEWING PROPOSED badge", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={PROPOSED("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText("VIEWING PROPOSED")).toBeInTheDocument();
  });

  it("Changes explainer surfaces the strike/highlight copy", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText(/Deletions are struck through/i)).toBeInTheDocument();
  });

  it("Proposed explainer surfaces the post-amendment copy", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={PROPOSED("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText(/as if Ord\. 260217 had passed/i)).toBeInTheDocument();
  });

  it("only the active bill grows the explainer (multi-bill case)", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260200")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    // Only one explainer should render at a time.
    expect(screen.getAllByText(/Deletions are struck through/i)).toHaveLength(1);
  });

  it("when overlayUnavailable AND the section has a specific non-renderable outcome, the banner surfaces that reason", () => {
    render(
      <SectionPendingRail
        bills={[
          makeBill({
            section_outcomes: [
              {
                section_id: "1.1" as SectionId,
                status: "classification_low_confidence",
                detail: null,
              },
            ],
            diff_chunks: [],
            new_bodies: [],
          }),
        ]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
        overlayUnavailable
      />,
    );
    expect(screen.getByTestId("diff-banner-classification_low_confidence")).toBeInTheDocument();
  });

  it("when overlayUnavailable is true, the row shows the unavailable reason in place of the explainer", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
        overlayUnavailable
      />,
    );
    expect(screen.queryByText(/Deletions are struck through/i)).toBeNull();
    expect(
      screen.getByText(/We couldn't compute changes for this section under Ord\. 260217/i),
    ).toBeInTheDocument();
  });
});

describe("SectionPendingRail — gating (parse_status + diff coverage)", () => {
  it("suppresses the segmented control when bill.parse_status is not 'ok'", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ parse_status: "manual_review", diff_chunks: [], new_bodies: [] })]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Proposed" })).toBeNull();
    // Bill row itself still renders — file_no opens the bill.
    expect(screen.getByRole("button", { name: /open ord\. 260217/i })).toBeInTheDocument();
  });

  it("suppresses the segmented control for structural_change bills", () => {
    render(
      <SectionPendingRail
        bills={[
          makeBill({
            parse_status: "structural_change",
            diff_chunks: [],
            new_bodies: [],
            structural_change_scope: "Section 1. Article 4 is hereby repealed.",
          }),
        ]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("suppresses the segmented control when no diff chunk anchors to this section", () => {
    render(
      <SectionPendingRail
        bills={[
          makeBill({
            diff_chunks: [
              {
                section_id: "9.9",
                op: "insert",
                text: "other section",
              },
            ],
          }),
        ]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("renders the segmented control when parse_status is ok AND a diff chunk anchors to this section", () => {
    render(<SectionPendingRail bills={[makeBill()]} {...RESTING} onOpenBill={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proposed" })).toBeInTheDocument();
  });

  it("partial bill: shows the control when THIS section is anchored even if a sibling failed", () => {
    render(
      <SectionPendingRail
        bills={[
          makeBill({
            section_outcomes: [
              { section_id: "1.1", status: "anchored", detail: null },
              { section_id: "1.2", status: "classification_low_confidence", detail: null },
            ],
            diff_chunks: [
              {
                section_id: "1.1",
                op: "insert",
                text: "new",
              },
            ],
          }),
        ]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes" })).toBeInTheDocument();
  });

  it("partial bill, rail on a failed section: control is suppressed", () => {
    render(
      <SectionPendingRail
        bills={[
          makeBill({
            section_outcomes: [
              { section_id: "1.1", status: "anchored", detail: null },
              { section_id: "1.2", status: "classification_low_confidence", detail: null },
            ],
            diff_chunks: [
              {
                section_id: "1.1",
                op: "insert",
                text: "new",
              },
            ],
          }),
        ]}
        sectionId={"1.2" as SectionId}
        activeOverlay={null}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("keeps the segmented control visible on the active row even if hasDiff would now be false", () => {
    // Defensive: corpus rebuilt after the user clicked Changes. The
    // active row keeps showing the control so the user can return to
    // Original.
    render(
      <SectionPendingRail
        bills={[makeBill({ parse_status: "manual_review", diff_chunks: [], new_bodies: [] })]}
        sectionId={SECTION_ID}
        activeOverlay={CHANGES("260217")}
        onChangeOverlay={vi.fn()}
        onOpenBill={vi.fn()}
        overlayUnavailable
      />,
    );
    expect(screen.getByRole("button", { name: "Original" })).toBeInTheDocument();
  });
});
