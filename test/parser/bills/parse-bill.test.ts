import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBill } from "@/parser/bills";
import {
  type BillMeta,
  BillSchema,
  type JurisdictionManifest,
  type ModuleId,
  type SectionId,
} from "@/types";
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
      // Pre-anchor parse_status is one of body_only / manual_review /
      // structural_change. The build-time anchorer then upgrades to
      // ok / partial / absorbed_external as outcomes resolve.
      expect(["body_only", "manual_review", "structural_change"]).toContain(validated.parse_status);
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

  it("threads classify-spans output into ParseBillResult preserving source-order over runs", async () => {
    // T6 wires Layer 3 into parseBill: every TextRun produces ONE OR
    // MORE ClassifiedSpans in source order. Length is normally 1:1 with
    // runs, but the decoration-boundary splitter emits multiple spans
    // when a single TextRun carries both a strike and an underline
    // covering different glyph footprints (the `(3)(2)` shape). Each
    // span's source_index still points back to the producing run, so
    // the run-offset map remains the right lookup.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const meta = buildMeta({
      file_no: "260217",
      touched: ["sf-administrative"],
      long_title: "Ordinance amending the Administrative Code.",
    });
    const result = await parseBill(new Uint8Array(bytes), meta, manifest);
    expect(result.classified_spans.length).toBeGreaterThanOrEqual(result.runs.length);
    // source_index is monotonically non-decreasing and bounded by the
    // run count.
    let prev = -1;
    for (const span of result.classified_spans) {
      expect(span.source_index).toBeGreaterThanOrEqual(prev);
      expect(span.source_index).toBeLessThan(result.runs.length);
      prev = span.source_index;
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

// Regression coverage for the three real-world unresolved cases surfaced
// by the 100-matter corpus eval. Each test owns the failure-mode + bill
// it represents so the next refactor that breaks one fails loudly.
describe("parseBill regression — formerly-unresolved real-world bills", () => {
  function buildIndex(
    entries: ReadonlyArray<[ModuleId, ReadonlyArray<string>]>,
  ): ReadonlyMap<ModuleId, ReadonlySet<SectionId>> {
    const m = new Map<ModuleId, ReadonlySet<SectionId>>();
    for (const [moduleId, ids] of entries) {
      m.set(moduleId, new Set(ids as SectionId[]));
    }
    return m;
  }

  it("260361 §1009.6 resolves once display_label is indexed (sf-health)", async () => {
    // Real corpus state: Article 19E has a section file named 1009.71.json
    // whose `id` is "1009.71" but `display_label` is "1009.6". Bills cite
    // the display form. Before the index loader change, "1009.6" wasn't a
    // key in sf-health's index and the lookup missed. The fix indexes
    // display_label too, so a bill citing §1009.6 resolves cleanly.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260361.pdf"));
    const meta = buildMeta({
      file_no: "260361",
      touched: ["sf-health"],
      long_title: "Ordinance amending the Health Code to prohibit smoking…",
    });
    // Synthetic sf-health index modeling the real corpus state — both
    // the canonical id "1009.71" AND the lowercased display_label "1009.6"
    // are present after the loader fix.
    const sectionIndex = buildIndex([
      [
        "sf-health" as ModuleId,
        [
          "1009.5",
          "1009.6", // ← display_label key, the new entry the loader adds
          "1009.7",
          "1009.71", // ← canonical id, unchanged
          "1009.8",
          "1009.9",
          "1009.10",
        ],
      ],
    ]);
    const result = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    const health = result.bills.find((b) => b.module_id === "sf-health");
    expect(health).toBeDefined();
    // No partition for §1009.6 ends up as null-section_id (i.e. unresolved
    // at the partition layer).
    const unresolvedFor1009_6 = result.section_partitions.filter(
      (p) =>
        p.module_id === "sf-health" &&
        p.section_id === null &&
        (p.raw_section_id === "1009.6" || p.candidates.includes("1009.6" as SectionId)),
    );
    expect(unresolvedFor1009_6).toEqual([]);
  }, 60_000);

  it("260449 §94A.2/§94D.2 route to sf-administrative once `is are` is tolerated", async () => {
    // Real bill text from matter 260449 §3:
    //   "The Chapters 94A and 94D of the Administrative Code is are
    //    hereby amended by revising Sections 94A.2, 94A.4, and 94D.2…"
    // Before Fix A, the structural pass missed Section 3 and the nested
    // SEC. 94A.2 / SEC. 94D.2 headers rolled into Section 2's
    // sf-transportation group, where lookup naturally failed. After the
    // fix, Section 3 resolves to sf-administrative and the headers route
    // there cleanly.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260449.pdf"));
    const meta = buildMeta({
      file_no: "260449",
      touched: ["sf-transportation", "sf-administrative", "sf-fire"],
      long_title:
        "Ordinance amending Division I of the Transportation Code; amending the Administrative and Fire Codes…",
    });
    const sectionIndex = buildIndex([
      [
        "sf-transportation" as ModuleId,
        ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9", "6.10"],
      ],
      ["sf-administrative" as ModuleId, ["94a.2", "94a.4", "94d.2"]],
      ["sf-fire" as ModuleId, ["108", "108.2.3"]],
    ]);
    const result = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    // Every §94A.2 / §94D.2 partition resolves under sf-administrative,
    // not sf-transportation.
    const adminPartitions = result.section_partitions.filter(
      (p) => p.module_id === "sf-administrative",
    );
    const adminRawIds = adminPartitions.map((p) => p.raw_section_id);
    expect(adminRawIds).toContain("94A.2");
    expect(adminRawIds).toContain("94D.2");
    // None of the §94 partitions show up mis-routed to sf-transportation.
    const transportMisroutes = result.section_partitions.filter(
      (p) =>
        p.module_id === "sf-transportation" &&
        (p.raw_section_id.startsWith("94A") || p.raw_section_id.startsWith("94D")),
    );
    expect(transportMisroutes).toEqual([]);
  }, 60_000);

  it("260538 §5.29-6/§10.100-49 route to sf-administrative once plural verbs are accepted", async () => {
    // Real bill text from matter 260538's second `Section 8`:
    //   "Chapter 5, Article XXIX, and Chapter 10, Article XIII, of the
    //    Administrative Code are hereby amended by revising sections
    //    5.29-6, and 10.100-49 respectively…"
    // Plural subject → plural verb. The widened regex now matches and
    // the headers route to sf-administrative instead of cascading into
    // the preceding sf-building Section 8 group.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260538.pdf"));
    const meta = buildMeta({
      file_no: "260538",
      touched: ["sf-planning", "sf-building", "sf-administrative"],
      long_title:
        "Ordinance amending the Planning Code…; amending the Building Code…; and amending the Administrative Code…",
    });
    const sectionIndex = buildIndex([
      ["sf-planning" as ModuleId, ["413.6", "414a.6", "415", "402", "403", "406", "409"]],
      ["sf-building" as ModuleId, ["107a.13"]],
      ["sf-administrative" as ModuleId, ["5.29-6", "10.100-49"]],
    ]);
    const result = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    const adminPartitions = result.section_partitions.filter(
      (p) => p.module_id === "sf-administrative",
    );
    const adminRawIds = adminPartitions.map((p) => p.raw_section_id);
    expect(adminRawIds).toContain("5.29-6");
    expect(adminRawIds).toContain("10.100-49");
    // Building Code Section 8 still anchors §107A.13 and does NOT carry
    // the bled-in Admin Code section IDs.
    const buildingPartitions = result.section_partitions.filter(
      (p) => p.module_id === "sf-building",
    );
    const buildingRawIds = buildingPartitions.map((p) => p.raw_section_id);
    expect(buildingRawIds).not.toContain("5.29-6");
    expect(buildingRawIds).not.toContain("10.100-49");
  }, 60_000);

  it("orphan-in-module flag fires when a header's candidates resolve in a different installed module", async () => {
    // Hand-crafted synthetic check: when the parser CAN'T resolve a
    // section against the routed module but DOES find it elsewhere, the
    // partition entry surfaces `orphan_in_module` so the operator log
    // can tell silent mis-routing from a true corpus gap.
    //
    // We exercise this via the 260449 bill but with an artificially
    // narrow sf-administrative index that's missing §94D.2 — leaving
    // 94d.2 in sf-transportation's index instead (as if the real-world
    // mis-routing had inverted). The orphan check should flag it.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260449.pdf"));
    const meta = buildMeta({
      file_no: "260449",
      touched: ["sf-transportation", "sf-administrative", "sf-fire"],
      long_title:
        "Ordinance amending Division I of the Transportation Code; amending the Administrative and Fire Codes…",
    });
    const sectionIndex = buildIndex([
      ["sf-transportation" as ModuleId, ["6.1", "94d.2"]],
      ["sf-administrative" as ModuleId, ["94a.2", "94a.4"]],
    ]);
    const result = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    // Find the §94D.2 partition routed to sf-administrative. With the
    // widened regex it routes correctly, but the synthetic index doesn't
    // have 94d.2 under sf-administrative — it's only under
    // sf-transportation. The orphan check should fire and surface
    // sf-transportation as the smoking-gun module.
    const admin94D2 = result.section_partitions.find(
      (p) => p.module_id === "sf-administrative" && p.raw_section_id === "94D.2",
    );
    expect(admin94D2).toBeDefined();
    expect(admin94D2?.section_id).toBeNull();
    expect(admin94D2?.orphan_in_module).toBe("sf-transportation");
  }, 60_000);
});
