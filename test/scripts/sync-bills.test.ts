import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BILLS_INDEX_SCHEMA_VERSION, BillSchema, type BillsIndex } from "@/types";
import { readJurisdictionManifest } from "@/types/validate";
import { syncBills } from "../../scripts/sync-bills";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const MANIFEST_PATH = join(REPO_ROOT, "manifests", "sf", "jurisdiction.json");
const FIXTURE_PDFS = join(REPO_ROOT, "test", "fixtures", "sf", "bills");

function makeBillsIndex(overrides: { bills: BillsIndex["bills"] }): BillsIndex {
  return {
    schema_version: BILLS_INDEX_SCHEMA_VERSION,
    source_url: "https://sfgov.legistar.com/Legislation.aspx",
    fetched_at: "2026-05-30T10:00:00-07:00",
    bills: overrides.bills,
  };
}

function makeMeta(overrides: Partial<BillsIndex["bills"][0]>): BillsIndex["bills"][0] {
  return {
    file_no: "260217",
    matter_id: "m1",
    matter_guid: "aaaaaaaa-bbbb-cccc-dddd-111111111111",
    short_title: "Multi-code update",
    long_title:
      "Ordinance amending the Administrative Code, Health Code, and Planning Code to update various fees.",
    legistar_status: "Pending Committee Hearing",
    sponsor: "Sup. Walton (District 10)",
    introduced_at: "2026-05-15",
    enacted_at: null,
    terminal_at: null,
    legistar_url: "https://sfgov.legistar.com/LegislationDetail.aspx?ID=1&GUID=g",
    title_class: "A",
    touched_code_stubs: ["Administrative Code", "Health Code", "Planning Code"],
    touched_modules: ["sf-administrative", "sf-health", "sf-planning"],
    installed_modules: ["sf-administrative", "sf-health", "sf-planning"],
    not_installed_modules: [],
    scraped_at: "2026-05-30T10:00:00-07:00",
    attachment_id: "9001001",
    pdf_cache_path: "build/downloads/bills/pdfs/x.pdf",
    attachment_content_hash: "0123456789abcdef",
    ...overrides,
  };
}

async function buildCorpusSkeleton(root: string, moduleIds: readonly string[]): Promise<void> {
  for (const id of moduleIds) {
    const moduleDir = join(root, id);
    await mkdir(join(moduleDir, "sections"), { recursive: true });
    await writeFile(
      join(moduleDir, "manifest.json"),
      JSON.stringify({
        id,
        name: `Module ${id}`,
        code_title: id,
        jurisdiction: "City and County of San Francisco",
        module_version: "2026.05.30",
        citation_patterns: [],
        defined_term_patterns: [],
      }),
    );
    await writeFile(
      join(moduleDir, "corpus-meta.json"),
      JSON.stringify({ module_version: "2026.05.30", jurisdiction: "Test" }),
    );
  }
}

describe("syncBills integration: fetch → parse → write → purge", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = mkdtempSync(join(tmpdir(), "legiscode-sync-bills-"));
    await buildCorpusSkeleton(outputDir, ["sf-administrative", "sf-health", "sf-planning"]);
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("writes one validated Bill per touched module under bills/", {
    timeout: 30_000,
  }, async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const billsIndex = makeBillsIndex({ bills: [makeMeta({})] });
    const result = await syncBills({
      manifest,
      billsIndex,
      outputDir,
      resolvePdfPath: () => join(FIXTURE_PDFS, "260217.pdf"),
    });

    // Each touched module gets exactly one Bill.
    expect(Object.keys(result.written).sort()).toEqual([
      "sf-administrative",
      "sf-health",
      "sf-planning",
    ]);
    for (const dir of ["sf-administrative", "sf-health", "sf-planning"]) {
      const files = await readdir(join(outputDir, dir, "bills"));
      expect(files).toEqual(["260217.json"]);
      const raw = await readFile(join(outputDir, dir, "bills", "260217.json"), "utf8");
      const validated = BillSchema.parse(JSON.parse(raw));
      expect(validated.module_id).toBe(dir);
      expect(validated.file_no).toBe("260217");
    }
  });

  it("purges stale session-bill files no longer in the bills-index", {
    timeout: 30_000,
  }, async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);

    // First run: writes 260217 across three modules.
    await syncBills({
      manifest,
      billsIndex: makeBillsIndex({ bills: [makeMeta({})] }),
      outputDir,
      resolvePdfPath: () => join(FIXTURE_PDFS, "260217.pdf"),
    });

    // Second run: the index no longer contains 260217 (matter aged out).
    const result = await syncBills({
      manifest,
      billsIndex: makeBillsIndex({ bills: [] }),
      outputDir,
      resolvePdfPath: () => "/dev/null",
    });
    // The previously-written 260217 file in each module gets purged.
    expect(result.purged["sf-administrative"]).toBe(1);
    expect(result.purged["sf-health"]).toBe(1);
    expect(result.purged["sf-planning"]).toBe(1);
    for (const dir of ["sf-administrative", "sf-health", "sf-planning"]) {
      const files = await readdir(join(outputDir, dir, "bills"));
      expect(files).toEqual([]);
    }
  });

  it("returns an anchor_outcomes array on the SyncResult (wiring check)", {
    timeout: 30_000,
  }, async () => {
    // The skeleton corpus has no on-disk sections, so the parser's
    // sectionIndex is empty → applyDisplayRules candidates don't
    // resolve → section_outcomes is []. anchorTextDiff therefore
    // produces zero outcomes. This asserts the field exists and
    // bills still validate + write.
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const result = await syncBills({
      manifest,
      billsIndex: makeBillsIndex({ bills: [makeMeta({})] }),
      outputDir,
      resolvePdfPath: () => join(FIXTURE_PDFS, "260217.pdf"),
    });
    expect(Array.isArray(result.anchor_outcomes)).toBe(true);
    // Bills are still written even when anchoring didn't fire.
    const adminFiles = await readdir(join(outputDir, "sf-administrative", "bills"));
    expect(adminFiles).toEqual(["260217.json"]);
    const billJson = await readFile(
      join(outputDir, "sf-administrative", "bills", "260217.json"),
      "utf8",
    );
    const billRecord = BillSchema.parse(JSON.parse(billJson));
    expect(billRecord.text_diff).toEqual([]);
    expect(billRecord.parse_status).toBe("manual_review");
  });

  it("skips matters whose cached PDF is missing without aborting the run", {
    timeout: 30_000,
  }, async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const result = await syncBills({
      manifest,
      billsIndex: makeBillsIndex({
        bills: [
          makeMeta({ file_no: "260217" }),
          // Second matter intentionally points at a non-existent PDF
          makeMeta({
            file_no: "999999",
            touched_modules: ["sf-administrative"],
          }),
        ],
      }),
      outputDir,
      resolvePdfPath: (m) =>
        m.file_no === "260217" ? join(FIXTURE_PDFS, "260217.pdf") : "/tmp/nonexistent.pdf",
    });
    // 260217 still written; 999999 skipped silently in the index.
    expect(Object.keys(result.written).sort()).toEqual([
      "sf-administrative",
      "sf-health",
      "sf-planning",
    ]);
    const adminFiles = await readdir(join(outputDir, "sf-administrative", "bills"));
    expect(adminFiles).toEqual(["260217.json"]);
  });
});
