// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Bill, BillSchema } from "@/types";
import { SectionPendingRail } from "@/ui/center-panel/section-view/section-pending-rail";

function makeBill(over: Partial<Bill> = {}): Bill {
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
    affected_sections: ["1.1"],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
    ...over,
  } as Bill);
}

const RESTING = {
  activeOverlayBillId: null,
  onToggleOverlay: vi.fn(),
};

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

  it("clicking the fileno does NOT toggle the overlay (stopPropagation)", () => {
    const onToggleOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        activeOverlayBillId={null}
        onToggleOverlay={onToggleOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open ord\. 260217/i }));
    expect(onToggleOverlay).not.toHaveBeenCalled();
  });
});

describe("SectionPendingRail — overlay toggle (variant B)", () => {
  it("renders a 'Show changes' button on each resting row", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        {...RESTING}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: /view this section as if/i })).toHaveLength(2);
  });

  it("clicking 'Show changes' calls onToggleOverlay with the bill's file_no", () => {
    const onToggleOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        activeOverlayBillId={null}
        onToggleOverlay={onToggleOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view this section as if/i }));
    expect(onToggleOverlay).toHaveBeenCalledWith("260217");
  });

  it("when active, the row's toggle reads 'Clear overlay' and calls onToggleOverlay(null)", () => {
    const onToggleOverlay = vi.fn();
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        activeOverlayBillId={"260217"}
        onToggleOverlay={onToggleOverlay}
        onOpenBill={vi.fn()}
      />,
    );
    const clear = screen.getByRole("button", { name: /clear overlay for ord\. 260217/i });
    expect(clear.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(clear);
    expect(onToggleOverlay).toHaveBeenCalledWith(null);
  });

  it("the active row shows the VIEWING badge", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        activeOverlayBillId={"260217"}
        onToggleOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText("VIEWING")).toBeInTheDocument();
  });

  it("the active row grows the explainer block (variant B locus)", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        activeOverlayBillId={"260217"}
        onToggleOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText(/as if Ord\. 260217 had passed/i)).toBeInTheDocument();
  });

  it("only the active bill grows the explainer (multi-bill case)", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        activeOverlayBillId={"260200"}
        onToggleOverlay={vi.fn()}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.queryByText(/as if Ord\. 260100 had passed/i)).toBeNull();
    expect(screen.getByText(/as if Ord\. 260200 had passed/i)).toBeInTheDocument();
  });

  it("when overlayUnavailable is true, the row shows the unavailable reason in place of the explainer", () => {
    render(
      <SectionPendingRail
        bills={[makeBill()]}
        activeOverlayBillId={"260217"}
        onToggleOverlay={vi.fn()}
        onOpenBill={vi.fn()}
        overlayUnavailable
      />,
    );
    expect(screen.queryByText(/as if Ord\. 260217 had passed/i)).toBeNull();
    expect(
      screen.getByText(/We couldn't compute changes for this section under Ord\. 260217/i),
    ).toBeInTheDocument();
  });
});
