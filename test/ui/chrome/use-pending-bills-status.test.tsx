// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { type Bill, BillSchema } from "@/types";
import { StatusBar } from "@/ui/chrome/status-bar";
import { usePendingBillsStatus } from "@/ui/chrome/use-pending-bills-status";

function Harness({ corpus }: { corpus: CorpusModuleSummary | null }) {
  usePendingBillsStatus(corpus);
  return <StatusBar rootLabel="SF" jurisdictionVersion="2026.05.30" codeCount={3} />;
}

const baseSummary: Omit<CorpusModuleSummary, "sessionBills"> = {
  jurisdiction: "Test",
  rootLabel: "SF",
  jurisdictionVersion: "2026.05.30",
  codeCount: 3,
  sectionCount: 10,
  defaultRef: { moduleId: "sf-test", sectionId: "1.0" },
  tree: [],
  definitions: [],
};

function pendingBill(file_no: string): Bill {
  return BillSchema.parse({
    file_no,
    module_id: "sf-test",
    short_title: "x",
    long_title: "Ordinance amending the Test Code…",
    sponsor: null,
    introduced_at: "2026-05-19",
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "committee",
    section_outcomes: [],
    diff_chunks: [],
    parse_status: "body_only",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
  } as Bill);
}

describe("usePendingBillsStatus", () => {
  it("hides the indicator when corpus is null (boot state)", () => {
    const { queryByText } = render(<Harness corpus={null} />);
    expect(queryByText(/pending$/)).toBeNull();
  });

  it("hides the indicator when count is 0 (no bills loaded)", () => {
    const { queryByText } = render(
      <Harness
        corpus={{ ...baseSummary, sessionBills: { count: 0, bills: [], classBMeta: [] } }}
      />,
    );
    expect(queryByText(/pending$/)).toBeNull();
  });

  it("renders 'N pending' with peach icon when pending count is positive", () => {
    const bills = [pendingBill("260100"), pendingBill("260200"), pendingBill("260300")];
    const { queryByText } = render(
      <Harness corpus={{ ...baseSummary, sessionBills: { count: 3, bills, classBMeta: [] } }} />,
    );
    expect(queryByText("3 pending")).not.toBeNull();
  });

  it("singular tooltip when count is 1, plural otherwise", () => {
    const { container, rerender } = render(
      <Harness
        corpus={{
          ...baseSummary,
          sessionBills: { count: 1, bills: [pendingBill("260100")], classBMeta: [] },
        }}
      />,
    );
    expect(container.querySelector('[title="1 pending ordinance loaded"]')).not.toBeNull();
    rerender(
      <Harness
        corpus={{
          ...baseSummary,
          sessionBills: {
            count: 5,
            bills: [
              pendingBill("260100"),
              pendingBill("260200"),
              pendingBill("260300"),
              pendingBill("260400"),
              pendingBill("260500"),
            ],
            classBMeta: [],
          },
        }}
      />,
    );
    expect(container.querySelector('[title="5 pending ordinances loaded"]')).not.toBeNull();
  });

  it("hides the indicator when only enacted/terminal bills are loaded (D7 — status bar = pending only)", () => {
    const enacted = BillSchema.parse({
      ...pendingBill("260100"),
      bill_status: "enacted",
    } as Bill);
    const { queryByText } = render(
      <Harness
        corpus={{
          ...baseSummary,
          sessionBills: { count: 1, bills: [enacted], classBMeta: [] },
        }}
      />,
    );
    expect(queryByText(/pending$/)).toBeNull();
  });
});
