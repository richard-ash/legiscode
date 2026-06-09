// @vitest-environment jsdom
/// <reference lib="dom" />
//
// Activity panel: empty state, populated list, keyboard nav, click →
// open dispatch, collapse semantics, fetch-failure hairline.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { type Bill, BillSchema, deriveParseStatus, type SectionId } from "@/types";
import { ActivityPanel } from "@/ui/left-panel/activity/activity-panel";
import { outcomesFromAffectedSections } from "../../../helpers/section-outcomes";

function makeBill(over: Partial<Bill> & { affected_sections?: SectionId[] } = {}): Bill {
  const { affected_sections, ...rest } = over;
  const explicitParseStatus = rest.parse_status;
  const sectionOutcomes =
    rest.section_outcomes ??
    outcomesFromAffectedSections(
      affected_sections ?? (["1.1", "1.2"] as SectionId[]),
      explicitParseStatus ?? "manual_review",
    );
  const hasStructural = explicitParseStatus === "structural_change";
  const derivedStatus = deriveParseStatus(sectionOutcomes, hasStructural);
  return BillSchema.parse({
    file_no: "260217",
    module_id: "sf-port",
    short_title: "Residential Speed Reduction Act",
    long_title: "Ordinance amending the Port Code…",
    sponsor: "Sup. Walton",
    introduced_at: "2026-05-12",
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "committee",
    diff_chunks: [],
    new_bodies: [],
    structural_change_scope: hasStructural ? (rest.structural_change_scope ?? "structural") : null,
    body: { preamble: "", amendments: [], closing: "" },
    ...rest,
    section_outcomes: sectionOutcomes,
    parse_status: derivedStatus,
  } as Bill);
}

function summaryWith(bills: ReadonlyArray<Bill>): CorpusModuleSummary {
  const unique = new Set(bills.map((b) => b.file_no)).size;
  return {
    jurisdiction: "Test",
    rootLabel: "Test Municipal Code",
    jurisdictionVersion: "2026.05.31",
    codeCount: 1,
    sectionCount: 0,
    defaultRef: { moduleId: "sf-port", sectionId: "1.1" },
    tree: [],
    definitions: [],
    sessionBills: { count: unique, bills, classBMeta: [] },
  };
}

describe("ActivityPanel — empty state", () => {
  it("renders the empty caption when corpus is null", () => {
    render(
      <ActivityPanel
        corpus={null}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText(/No bills this session/i)).toBeInTheDocument();
  });

  it("renders the empty caption when no module has bills", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText(/No bills this session/i)).toBeInTheDocument();
  });
});

describe("ActivityPanel — header", () => {
  it("emits onToggleCollapse on header click", () => {
    const onToggleCollapse = vi.fn();
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("aria-expanded reflects the collapsed prop", () => {
    const { rerender } = render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Activity/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    rerender(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={true}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Activity/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows the pending count", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill({ file_no: "260100" }), makeBill({ file_no: "260200" })])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText("2 pending")).toBeInTheDocument();
  });
});

describe("ActivityPanel — bill rows", () => {
  it("renders one row per unique file_no, sorted date DESC", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([
          makeBill({ file_no: "260100", introduced_at: "2026-05-01" }),
          makeBill({ file_no: "260200", introduced_at: "2026-05-15" }),
          makeBill({ file_no: "260300", introduced_at: "2026-05-10" }),
        ])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole("button").filter((b) => b.dataset.billId !== undefined);
    expect(rows.map((r) => r.dataset.billId)).toEqual(["260200", "260300", "260100"]);
  });

  it("clicking a bill row dispatches onOpenBill with primary intent", () => {
    const onOpenBill = vi.fn();
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={onOpenBill}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Residential Speed Reduction Act"));
    expect(onOpenBill).toHaveBeenCalledWith("260217", "primary");
  });

  it("Cmd+click dispatches background intent", () => {
    const onOpenBill = vi.fn();
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={onOpenBill}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Residential Speed Reduction Act"), { metaKey: true });
    expect(onOpenBill).toHaveBeenCalledWith("260217", "background");
  });

  it("Enter on a focused row dispatches onOpenBill", () => {
    const onOpenBill = vi.fn();
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={onOpenBill}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    const row = screen.getAllByRole("button").find((b) => b.dataset.billId === "260217");
    if (!row) throw new Error("row missing");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenBill).toHaveBeenCalledWith("260217", "primary");
  });

  it("highlights the active bill row", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([
          makeBill({ file_no: "260100", introduced_at: "2026-05-01" }),
          makeBill({ file_no: "260200", introduced_at: "2026-05-15" }),
        ])}
        activeBillId="260100"
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    const active = screen.getAllByRole("button").find((b) => b.dataset.billId === "260100");
    expect(active?.className).toContain("is-active");
    const inactive = screen.getAllByRole("button").find((b) => b.dataset.billId === "260200");
    expect(inactive?.className).not.toContain("is-active");
  });

  it("renders the touches strip when affected_sections is non-empty", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill({ affected_sections: ["3.15-2", "3.15-3"] })])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText("§ 3.15-2")).toBeInTheDocument();
    expect(screen.getByText("§ 3.15-3")).toBeInTheDocument();
  });
});

describe("ActivityPanel — keyboard nav", () => {
  it("ArrowDown moves focus to the next row", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([
          makeBill({ file_no: "260100", introduced_at: "2026-05-15" }),
          makeBill({ file_no: "260200", introduced_at: "2026-05-10" }),
        ])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: /Session ordinances/ });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.dataset.billId).toBe("260200");
  });

  it("ArrowUp from the top stays on the first row (no wrap)", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([
          makeBill({ file_no: "260100", introduced_at: "2026-05-15" }),
          makeBill({ file_no: "260200", introduced_at: "2026-05-10" }),
        ])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: /Session ordinances/ });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.dataset.billId).toBe("260100");
  });
});

describe("ActivityPanel — fetch failure", () => {
  it("renders the retry hairline when fetchFailed is true", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        fetchFailed
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/Last refresh failed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("the retry line is non-interactive when onRetry isn't wired", () => {
    render(
      <ActivityPanel
        corpus={summaryWith([makeBill()])}
        activeBillId={null}
        onOpenBill={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        fetchFailed
      />,
    );
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});
