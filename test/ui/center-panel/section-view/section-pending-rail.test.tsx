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
    proposed_text: "",
    ...over,
  } as Bill);
}

describe("SectionPendingRail — visibility", () => {
  it("renders nothing when no bills affect this section", () => {
    const { container } = render(<SectionPendingRail bills={[]} onOpenBill={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a single-bill label when one bill affects the section", () => {
    render(<SectionPendingRail bills={[makeBill()]} onOpenBill={vi.fn()} />);
    expect(screen.getByText(/1 pending ordinance/i)).toBeInTheDocument();
  });

  it("renders the plural label when multiple bills affect the section", () => {
    render(
      <SectionPendingRail
        bills={[makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })]}
        onOpenBill={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 pending ordinances/i)).toBeInTheDocument();
  });
});

describe("SectionPendingRail — row activation", () => {
  it("clicking a row dispatches onOpenBill with primary intent", () => {
    const onOpenBill = vi.fn();
    render(<SectionPendingRail bills={[makeBill()]} onOpenBill={onOpenBill} />);
    fireEvent.click(screen.getByRole("button", { name: /260217/ }));
    expect(onOpenBill).toHaveBeenCalledWith("260217", "primary");
  });

  it("Cmd+click dispatches background intent", () => {
    const onOpenBill = vi.fn();
    render(<SectionPendingRail bills={[makeBill()]} onOpenBill={onOpenBill} />);
    fireEvent.click(screen.getByRole("button", { name: /260217/ }), { metaKey: true });
    expect(onOpenBill).toHaveBeenCalledWith("260217", "background");
  });

  it("Enter on a row dispatches onOpenBill", () => {
    const onOpenBill = vi.fn();
    render(<SectionPendingRail bills={[makeBill()]} onOpenBill={onOpenBill} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /260217/ }), { key: "Enter" });
    expect(onOpenBill).toHaveBeenCalledWith("260217", "primary");
  });

  it("each row carries the bill's status pill", () => {
    render(
      <SectionPendingRail bills={[makeBill({ bill_status: "committee" })]} onOpenBill={vi.fn()} />,
    );
    expect(screen.getByText("Committee")).toBeInTheDocument();
  });

  it("shows the bill title in the row", () => {
    render(<SectionPendingRail bills={[makeBill()]} onOpenBill={vi.fn()} />);
    expect(screen.getByText("Residential Speed Reduction")).toBeInTheDocument();
  });
});
