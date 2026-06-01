// Hermetic unit test for `derivePendingBills` — no DOM, no live data.
// Verifies the sort contract (date DESC, file_no DESC, module_id ASC for
// stable tiebreak) and the bySection / file_no dedupe contracts.

import { describe, expect, it } from "vitest";
import { type Bill, BillSchema } from "@/types";
import { derivePendingBills } from "@/ui/left-panel/activity/use-pending-bills";

function makeBill(over: Partial<Bill> = {}): Bill {
  return BillSchema.parse({
    file_no: "260217",
    module_id: "sf-admin",
    short_title: "x",
    long_title: "Ordinance amending the Test Code…",
    sponsor: null,
    introduced_at: "2026-05-19",
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "filed",
    affected_sections: [],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    proposed_text: "",
    ...over,
  } as Bill);
}

describe("derivePendingBills — empty input", () => {
  it("returns the empty triple", () => {
    const result = derivePendingBills([], 0);
    expect(result.bills).toEqual([]);
    expect(result.bySection.size).toBe(0);
    expect(result.count).toBe(0);
  });
});

describe("derivePendingBills — sort", () => {
  it("sorts by introduced_at DESC", () => {
    const rows = [
      makeBill({ file_no: "260100", introduced_at: "2026-05-01" }),
      makeBill({ file_no: "260200", introduced_at: "2026-05-15" }),
      makeBill({ file_no: "260300", introduced_at: "2026-05-10" }),
    ];
    const result = derivePendingBills(rows, 3);
    expect(result.bills.map((b) => b.file_no)).toEqual(["260200", "260300", "260100"]);
  });

  it("on same date, sorts file_no DESC", () => {
    const rows = [
      makeBill({ file_no: "260100", introduced_at: "2026-05-19" }),
      makeBill({ file_no: "260300", introduced_at: "2026-05-19" }),
      makeBill({ file_no: "260200", introduced_at: "2026-05-19" }),
    ];
    const result = derivePendingBills(rows, 3);
    expect(result.bills.map((b) => b.file_no)).toEqual(["260300", "260200", "260100"]);
  });

  it("null introduced_at sorts last", () => {
    const rows = [
      makeBill({ file_no: "260100", introduced_at: null }),
      makeBill({ file_no: "260200", introduced_at: "2026-05-15" }),
    ];
    const result = derivePendingBills(rows, 2);
    expect(result.bills.map((b) => b.file_no)).toEqual(["260200", "260100"]);
  });
});

describe("derivePendingBills — dedupe", () => {
  it("dedupes the headline list by file_no", () => {
    // Same file_no in two modules — one logical bill.
    const rows = [
      makeBill({ file_no: "260544", module_id: "sf-admin" }),
      makeBill({ file_no: "260544", module_id: "sf-health" }),
    ];
    const result = derivePendingBills(rows, 1);
    expect(result.bills).toHaveLength(1);
  });

  it("preserves freshest row when deduping (date is stable across modules anyway)", () => {
    const rows = [
      makeBill({ file_no: "260544", module_id: "sf-health", introduced_at: "2026-05-19" }),
      makeBill({ file_no: "260544", module_id: "sf-admin", introduced_at: "2026-05-19" }),
    ];
    const result = derivePendingBills(rows, 1);
    expect(result.bills).toHaveLength(1);
    // module_id ASC tiebreak — sf-admin should win.
    expect(result.bills[0]?.module_id).toBe("sf-admin");
  });
});

describe("derivePendingBills — bySection", () => {
  it("groups bills by section id for O(1) section-view lookup", () => {
    const rows = [
      makeBill({
        file_no: "260544",
        module_id: "sf-police",
        affected_sections: ["3.15-2", "3.15-3"],
      }),
      makeBill({
        file_no: "260600",
        module_id: "sf-police",
        affected_sections: ["3.15-3"],
      }),
    ];
    const result = derivePendingBills(rows, 2);
    expect(result.bySection.get("3.15-2" as never)).toHaveLength(1);
    expect(result.bySection.get("3.15-3" as never)).toHaveLength(2);
  });

  it("keeps per-module rows distinct in bySection (cross-module collisions are different legal targets)", () => {
    const rows = [
      makeBill({
        file_no: "260544",
        module_id: "sf-admin",
        affected_sections: ["1.0"],
      }),
      makeBill({
        file_no: "260544",
        module_id: "sf-health",
        affected_sections: ["1.0"],
      }),
    ];
    const result = derivePendingBills(rows, 1);
    // Two rows in bySection["1.0"] even though file_no is the same —
    // a section "1.0" in sf-admin is a different legal target than
    // "1.0" in sf-health.
    expect(result.bySection.get("1.0" as never)).toHaveLength(2);
  });

  it("omits sections that no bill touches", () => {
    const rows = [makeBill({ affected_sections: ["3.15-2"] })];
    const result = derivePendingBills(rows, 1);
    expect(result.bySection.size).toBe(1);
    expect(result.bySection.has("3.15-2" as never)).toBe(true);
  });
});
