import { describe, expect, it } from "vitest";
import { BILLS_INDEX_SCHEMA_VERSION, BillMetaSchema, BillSchema, BillsIndexSchema } from "@/types";

function validMeta(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    file_no: "260217",
    matter_id: "6789012",
    matter_guid: "aaaaaaaa-bbbb-cccc-dddd-111111111111",
    short_title: "Multi-code update",
    long_title: "Ordinance amending the Administrative Code…",
    legistar_status: "Pending Committee Hearing",
    sponsor: "Sup. Walton (District 10)",
    introduced_at: "2026-05-15",
    enacted_at: null,
    terminal_at: null,
    legistar_url: "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789012&GUID=aaaa",
    title_class: "A",
    touched_code_stubs: ["Administrative Code", "Building Code"],
    touched_modules: ["sf-administrative", "sf-building"],
    installed_modules: ["sf-administrative", "sf-building"],
    not_installed_modules: [],
    scraped_at: "2026-05-30T10:00:00-07:00",
    attachment_id: "9001002",
    pdf_cache_path: "build/downloads/bills/pdfs/9001002-aaaaaaaa-deadbeef00001234.pdf",
    attachment_content_hash: "deadbeef00001234",
    ...overrides,
  };
}

describe("BillMetaSchema", () => {
  it("accepts a well-formed Class A row", () => {
    expect(() => BillMetaSchema.parse(validMeta())).not.toThrow();
  });

  it("accepts a Class B row with empty touched arrays and null sponsor", () => {
    expect(() =>
      BillMetaSchema.parse(
        validMeta({
          title_class: "B",
          sponsor: null,
          introduced_at: null,
          touched_code_stubs: [],
          touched_modules: [],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an unknown class value", () => {
    const result = BillMetaSchema.safeParse(validMeta({ title_class: "C" }));
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO introduced_at", () => {
    const result = BillMetaSchema.safeParse(validMeta({ introduced_at: "5/15/2026" }));
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL legistar_url", () => {
    const result = BillMetaSchema.safeParse(validMeta({ legistar_url: "/relative/path" }));
    expect(result.success).toBe(false);
  });

  it("rejects content hash that isn't 16 hex chars", () => {
    const fail1 = BillMetaSchema.safeParse(validMeta({ attachment_content_hash: "tooshort" }));
    expect(fail1.success).toBe(false);
    const fail2 = BillMetaSchema.safeParse(validMeta({ attachment_content_hash: "G".repeat(16) }));
    expect(fail2.success).toBe(false);
  });
});

function validBill(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    file_no: "260217",
    module_id: "sf-administrative",
    short_title: "Multi-code update",
    long_title: "Ordinance amending the Administrative Code…",
    sponsor: "Sup. Walton",
    introduced_at: "2026-05-15",
    legistar_url: "https://sfgov.legistar.com/LegislationDetail.aspx?ID=1&GUID=g",
    legistar_status: "Pending Committee Hearing",
    bill_status: "committee",
    section_outcomes: [
      { section_id: "10.04.020", status: "classification_low_confidence", detail: null },
      { section_id: "10.04.030", status: "classification_low_confidence", detail: null },
    ],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
    ...overrides,
  };
}

describe("BillSchema", () => {
  it("accepts a manual_review bill with empty text_diff and per-section outcomes", () => {
    expect(() => BillSchema.parse(validBill())).not.toThrow();
  });

  it("accepts an ok bill with non-empty text_diff (the invariant honored)", () => {
    expect(() =>
      BillSchema.parse(
        validBill({
          parse_status: "ok",
          section_outcomes: [
            { section_id: "10.04.020", status: "anchored", detail: null },
            { section_id: "10.04.030", status: "anchored", detail: null },
          ],
          text_diff: [
            {
              op: "insert",
              text: "new text",
              section_id: "10.04.020",
              anchor: { baseline_offset: 0, baseline_length: 0 },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects ok with no renderable outcomes (derived-status invariant)", () => {
    // parse_status === "ok" must mean section_outcomes has at least
    // one anchored/added_section outcome. A claim of ok without any
    // renderable outcomes fails the refine.
    const result = BillSchema.safeParse(
      validBill({
        parse_status: "ok",
        text_diff: [],
        section_outcomes: [
          { section_id: "10.04.020", status: "classification_low_confidence", detail: null },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts structural_change only when scope is set; rejects otherwise", () => {
    expect(() =>
      BillSchema.parse(
        validBill({
          parse_status: "structural_change",
          structural_change_scope: "by adding Chapter 94C",
          section_outcomes: [
            { section_id: "10.04.020", status: "structural", detail: null },
            { section_id: "10.04.030", status: "structural", detail: null },
          ],
        }),
      ),
    ).not.toThrow();

    const noScope = BillSchema.safeParse(
      validBill({
        parse_status: "structural_change",
        structural_change_scope: null,
        section_outcomes: [{ section_id: "10.04.020", status: "structural", detail: null }],
      }),
    );
    expect(noScope.success).toBe(false);

    const scopeWithoutStructural = BillSchema.safeParse(
      validBill({ parse_status: "manual_review", structural_change_scope: "oops" }),
    );
    expect(scopeWithoutStructural.success).toBe(false);
  });

  it("rejects an unknown bill_status key", () => {
    expect(BillSchema.safeParse(validBill({ bill_status: "absorbed" })).success).toBe(false);
  });

  it("accepts the four new terminal bill_status values", () => {
    for (const bill_status of ["enacted", "vetoed", "withdrawn", "failed"]) {
      const result = BillSchema.safeParse(validBill({ bill_status }));
      expect(result.success).toBe(true);
    }
  });
});

describe("BillsIndexSchema", () => {
  it("accepts the current schema_version", () => {
    expect(() =>
      BillsIndexSchema.parse({
        schema_version: BILLS_INDEX_SCHEMA_VERSION,
        source_url: "https://sfgov.legistar.com/Legislation.aspx",
        fetched_at: "2026-05-30T10:00:00-07:00",
        bills: [validMeta()],
      }),
    ).not.toThrow();
  });

  it("rejects an older schema_version (literal mismatch)", () => {
    const result = BillsIndexSchema.safeParse({
      schema_version: 0,
      source_url: "https://sfgov.legistar.com/Legislation.aspx",
      fetched_at: "2026-05-30T10:00:00-07:00",
      bills: [],
    });
    expect(result.success).toBe(false);
  });
});
