import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBill } from "@/parser/bills";
import { type BillMeta, BillSchema, type JurisdictionManifest } from "@/types";
import { readJurisdictionManifest } from "@/types/validate";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BILLS_FIXTURE = join(REPO_ROOT, "test", "fixtures", "sf", "bills");

const MANIFEST_PATH = join(REPO_ROOT, "manifests", "sf", "jurisdiction.json");

async function loadManifest(): Promise<JurisdictionManifest> {
  return readJurisdictionManifest(MANIFEST_PATH);
}

function buildMeta(opts: {
  file_no: string;
  touched: string[];
  long_title: string;
  status?: string;
}): BillMeta {
  return {
    file_no: opts.file_no,
    matter_id: `m-${opts.file_no}`,
    matter_guid: "aaaaaaaa-bbbb-cccc-dddd-111111111111",
    short_title: `Bill ${opts.file_no}`,
    long_title: opts.long_title,
    legistar_status: opts.status ?? "Pending Committee Hearing",
    sponsor: null,
    introduced_at: null,
    enacted_at: null,
    terminal_at: null,
    legistar_url: "https://sfgov.legistar.com/LegislationDetail.aspx?ID=1&GUID=g",
    title_class: "A",
    touched_code_stubs: [],
    touched_modules: opts.touched as BillMeta["touched_modules"],
    installed_modules: [],
    not_installed_modules: [],
    scraped_at: "2026-05-30T10:00:00-07:00",
    attachment_id: "9001001",
    pdf_cache_path: "build/downloads/bills/pdfs/x.pdf",
    attachment_content_hash: "0123456789abcdef",
  };
}

describe("parseBill round-trip against committed fixtures (real PDFs)", () => {
  it("emits one Bill per touched_module for the 260217 multi-code redline and every Bill validates", async () => {
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const meta = buildMeta({
      file_no: "260217",
      touched: ["sf-administrative", "sf-health", "sf-planning"],
      long_title:
        "Ordinance amending the Administrative Code, Health Code, and Planning Code to update various fees and provisions.",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    expect(result.bills.length).toBeGreaterThan(0);
    for (const bill of result.bills) {
      // Validates the schema invariants (text_diff non-empty iff ok, etc.).
      const validated = BillSchema.parse(bill);
      expect(validated.file_no).toBe("260217");
      expect(validated.module_id).toMatch(/^sf-/);
      expect(["manual_review", "structural_change"]).toContain(validated.parse_status);
    }
  }, 30_000);

  it("promotes a new-chapter creation (260296) to structural_change", async () => {
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260296.pdf"));
    const meta = buildMeta({
      file_no: "260296",
      touched: ["sf-administrative"],
      long_title:
        "Ordinance amending the Administrative Code by adding Chapter 94C to establish a Climate Emergency Mobilization Office.",
      status: "Pending - Land Use & Transportation Committee",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    expect(result.bills).toHaveLength(1);
    const bill = result.bills[0];
    expect(bill?.module_id).toBe("sf-administrative");
    expect(bill?.parse_status).toBe("structural_change");
    expect(bill?.structural_change_scope).not.toBeNull();
    expect(bill?.bill_status).toBe("committee");
    // Schema invariant: structural_change_scope must be set when
    // parse_status is structural_change; .parse() throws if not.
    expect(() => BillSchema.parse(bill)).not.toThrow();
  }, 30_000);

  it("populates Bill.body with the parsed ordinance structure", async () => {
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const meta = buildMeta({
      file_no: "260217",
      touched: ["sf-administrative"],
      long_title: "Ordinance amending the Administrative Code, Health Code, and Planning Code.",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    const bill = result.bills[0];
    expect(bill?.body.preamble.length ?? 0).toBeGreaterThan(50);
    expect(bill?.body.amendments.length ?? 0).toBeGreaterThan(0);
    // Page chrome should never reach the body — every preamble / section
    // body / closing string is chrome-stripped + reflowed prose.
    const stringified = JSON.stringify(bill?.body);
    expect(stringified).not.toContain("BOARD OF SUPERVISORS  Page");
    expect(stringified).not.toMatch(/FILE NO\.\s+\d+\s+ORDINANCE NO/);
  }, 30_000);

  it("emits body_quality_warnings as a flat array (empty for clean parses)", async () => {
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const meta = buildMeta({
      file_no: "260217",
      touched: ["sf-administrative"],
      long_title: "Ordinance amending the Administrative Code.",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    expect(Array.isArray(result.body_quality_warnings)).toBe(true);
  }, 30_000);

  it("threads classify-spans output into ParseBillResult with length parity vs runs", async () => {
    // T6 wires Layer 3 into parseBill: every TextRun produces exactly
    // one ClassifiedSpan, in source order, with at least some non-context
    // classifications for the heavy redline fixture (260217).
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const meta = buildMeta({
      file_no: "260217",
      touched: ["sf-administrative"],
      long_title: "Ordinance amending the Administrative Code.",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    expect(result.classified_spans.length).toBe(result.runs.length);
    // source_index is the identity map over the TextRun array.
    for (let i = 0; i < result.classified_spans.length; i++) {
      expect(result.classified_spans[i]?.source_index).toBe(i);
    }
    const kinds = new Set(result.classified_spans.map((s) => s.kind));
    expect(kinds.has("context")).toBe(true);
    expect(kinds.has("insert")).toBe(true);
    expect(kinds.has("delete")).toBe(true);
    // Bill.text_diff still stays empty here — anchoring happens later
    // in scripts/sync-bills.ts via emit-diff.
    for (const bill of result.bills) {
      expect(bill.text_diff).toEqual([]);
    }
  }, 120_000);
});
