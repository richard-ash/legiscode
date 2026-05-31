import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBill } from "@/parser/bills";
import { BillSchema, type BillMeta, type JurisdictionManifest } from "@/types";
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

  it("preserves the extracted PDF body in proposed_text, with page chrome stripped", async () => {
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const meta = buildMeta({
      file_no: "260217",
      touched: ["sf-administrative"],
      long_title:
        "Ordinance amending the Administrative Code, Health Code, and Planning Code.",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    const bill = result.bills[0];
    expect(bill?.proposed_text.length ?? 0).toBeGreaterThan(200);
    // Page chrome should be gone after the cleanup pass.
    expect(bill?.proposed_text).not.toContain("BOARD OF SUPERVISORS  Page");
    expect(bill?.proposed_text).not.toMatch(/^FILE NO\.\s+\d+\s+ORDINANCE NO/m);
    expect(bill?.proposed_text).not.toMatch(/^\s*1\s*$/m); // PDF page line numbers
  }, 30_000);
});
