// Hermetic unit test for `deriveSessionBills` — no DOM, no live data.
// Verifies the two-group split (pending + enactedTerminal), the sort
// contracts within each group, the rail-eligible bySection contract,
// and the file_no dedupe contract.

import { describe, expect, it } from "vitest";
import { type Bill, BillSchema, deriveParseStatus, type SectionId } from "@/types";
import { deriveSessionBills } from "@/ui/left-panel/activity/use-session-bills";
import { outcomesFromAffectedSections } from "../../../helpers/section-outcomes";

function makeBill(over: Partial<Bill> & { affected_sections?: SectionId[] } = {}): Bill {
  const { affected_sections, ...rest } = over;
  const explicitParseStatus = rest.parse_status;
  const explicitOutcomes = rest.section_outcomes;
  const sectionOutcomes =
    explicitOutcomes ??
    (affected_sections
      ? outcomesFromAffectedSections(affected_sections, explicitParseStatus ?? "manual_review")
      : []);
  const hasStructural = explicitParseStatus === "structural_change";
  // Derive parse_status from the constructed outcomes so the helper is
  // schema-valid by construction. Explicit overrides win only when they
  // match the derivation.
  const derivedStatus = deriveParseStatus(sectionOutcomes, hasStructural);
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
    diff_chunks: [],
    new_bodies: [],
    structural_change_scope: hasStructural ? (rest.structural_change_scope ?? "structural") : null,
    body: { preamble: "", amendments: [], closing: "" },
    ...rest,
    // Override last so the derived values win.
    section_outcomes: sectionOutcomes,
    parse_status: derivedStatus,
  } as Bill);
}

describe("deriveSessionBills — empty input", () => {
  it("returns the empty shape", () => {
    const result = deriveSessionBills([], [], 0);
    expect(result.pending).toEqual([]);
    expect(result.enactedTerminal).toEqual([]);
    expect(result.classBMeta).toEqual([]);
    expect(result.bySection.size).toBe(0);
    expect(result.count).toBe(0);
  });
});

describe("deriveSessionBills — two-group split", () => {
  it("places PENDING_STATES in `pending` and terminal states in `enactedTerminal`", () => {
    const rows = [
      makeBill({ file_no: "260100", bill_status: "filed" }),
      makeBill({ file_no: "260200", bill_status: "committee" }),
      makeBill({ file_no: "260300", bill_status: "enacted" }),
      makeBill({ file_no: "260400", bill_status: "vetoed" }),
      makeBill({ file_no: "260500", bill_status: "enrolled" }),
    ];
    const result = deriveSessionBills(rows, [], 5);
    expect(result.pending.map((b) => b.file_no).sort()).toEqual(["260100", "260200", "260500"]);
    expect(result.enactedTerminal.map((b) => b.file_no).sort()).toEqual(["260300", "260400"]);
  });

  it("sorts pending by workflow order asc, then introduced_at desc", () => {
    // workflow order: filed < committee < engrossed < floor < enrolled
    const rows = [
      makeBill({ file_no: "260100", bill_status: "enrolled", introduced_at: "2026-04-01" }),
      makeBill({ file_no: "260200", bill_status: "filed", introduced_at: "2026-05-01" }),
      makeBill({ file_no: "260300", bill_status: "committee", introduced_at: "2026-05-15" }),
    ];
    const result = deriveSessionBills(rows, [], 3);
    expect(result.pending.map((b) => b.file_no)).toEqual(["260200", "260300", "260100"]);
  });

  it("sorts enacted/terminal by introduced_at desc (fallback while terminal_at lives on BillMeta)", () => {
    const rows = [
      makeBill({ file_no: "260100", bill_status: "enacted", introduced_at: "2026-03-01" }),
      makeBill({ file_no: "260200", bill_status: "enacted", introduced_at: "2026-05-15" }),
      makeBill({ file_no: "260300", bill_status: "vetoed", introduced_at: "2026-04-10" }),
    ];
    const result = deriveSessionBills(rows, [], 3);
    expect(result.enactedTerminal.map((b) => b.file_no)).toEqual(["260200", "260300", "260100"]);
  });
});

describe("deriveSessionBills — dedupe by file_no", () => {
  it("dedupes the pending group by file_no across modules", () => {
    const rows = [
      makeBill({ file_no: "260544", module_id: "sf-admin", bill_status: "committee" }),
      makeBill({ file_no: "260544", module_id: "sf-health", bill_status: "committee" }),
    ];
    const result = deriveSessionBills(rows, [], 1);
    expect(result.pending).toHaveLength(1);
  });
});

describe("deriveSessionBills — bySection (rail-eligible only)", () => {
  it("includes PENDING and enacted bills in bySection (rail-eligible)", () => {
    const rows = [
      makeBill({
        file_no: "260544",
        module_id: "sf-police",
        bill_status: "committee",
        affected_sections: ["3.15-2"],
      }),
      makeBill({
        file_no: "260600",
        module_id: "sf-police",
        bill_status: "enacted",
        affected_sections: ["3.15-2"],
      }),
    ];
    const result = deriveSessionBills(rows, [], 2);
    expect(result.bySection.get("3.15-2" as never)).toHaveLength(2);
  });

  it("excludes vetoed / withdrawn / failed from bySection (no longer affect the section)", () => {
    const rows = [
      makeBill({
        file_no: "260100",
        module_id: "sf-police",
        bill_status: "vetoed",
        affected_sections: ["3.15-2"],
      }),
      makeBill({
        file_no: "260200",
        module_id: "sf-police",
        bill_status: "withdrawn",
        affected_sections: ["3.15-2"],
      }),
      makeBill({
        file_no: "260300",
        module_id: "sf-police",
        bill_status: "failed",
        affected_sections: ["3.15-2"],
      }),
    ];
    const result = deriveSessionBills(rows, [], 3);
    expect(result.bySection.get("3.15-2" as never)).toBeUndefined();
  });

  it("keeps per-module rows distinct (cross-module collisions are different legal targets)", () => {
    const rows = [
      makeBill({
        file_no: "260544",
        module_id: "sf-admin",
        bill_status: "committee",
        affected_sections: ["1.0"],
      }),
      makeBill({
        file_no: "260544",
        module_id: "sf-health",
        bill_status: "committee",
        affected_sections: ["1.0"],
      }),
    ];
    const result = deriveSessionBills(rows, [], 1);
    expect(result.bySection.get("1.0" as never)).toHaveLength(2);
  });
});

describe("deriveSessionBills — Class B inclusion", () => {
  it("surfaces Class B BillMeta as a separate field", () => {
    const classB = [
      {
        file_no: "260700",
        matter_id: "m700",
        matter_guid: "g".padEnd(36, "g"),
        short_title: "Class B waiver",
        long_title: "Resolution authorizing a waiver",
        legistar_status: "Pending",
        sponsor: null,
        introduced_at: "2026-05-10",
        enacted_at: null,
        terminal_at: null,
        legistar_url: "https://e/d?ID=2",
        title_class: "B" as const,
        touched_code_stubs: [],
        touched_modules: [],
        installed_modules: [],
        not_installed_modules: [],
        scraped_at: "2026-05-30T10:00:00-07:00",
        attachment_id: "9",
        pdf_cache_path: "x.pdf",
        attachment_content_hash: "0".repeat(16),
      },
    ];
    const result = deriveSessionBills([], classB, 1);
    expect(result.classBMeta).toHaveLength(1);
    expect(result.classBMeta[0]?.file_no).toBe("260700");
  });
});
