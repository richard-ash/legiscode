// End-to-end regression set for the diff-completeness redesign. Each
// real-bill fixture below was a known failure mode under the old
// diffAgainstBaseline + reconstructInline pipeline. They now anchor
// cleanly via anchorContextSpansToBaseline + emitInlineSpans (or, for
// wholesale-replace bodies, the implicit-rewrite fallback in
// anchorTextDiff).
//
// Tests are hermetic per repo guidance: committed PDF + committed
// baseline JSON in, asserted (offset, length, op) shape out. The
// baselines were extracted from the local corpus at commit time and
// live next to the bill PDFs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBill } from "@/parser/bills";
import { anchorTextDiff } from "@/parser/bills/emit-diff";
import { type BillMeta, type JurisdictionManifest, type ModuleId, type SectionId } from "@/types";
import { readJurisdictionManifest } from "@/types/validate";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BILLS_FIXTURE = join(REPO_ROOT, "test", "fixtures", "sf", "bills");
const BASELINES_DIR = join(BILLS_FIXTURE, "baselines");
const MANIFEST_PATH = join(REPO_ROOT, "manifests", "sf", "jurisdiction.json");

async function loadManifest(): Promise<JurisdictionManifest> {
  return readJurisdictionManifest(MANIFEST_PATH);
}

async function loadBaseline(moduleId: string, sectionId: string): Promise<string> {
  const raw = await readFile(join(BASELINES_DIR, `${moduleId}.${sectionId}.json`), "utf8");
  return (JSON.parse(raw) as { id: string; text: string }).text;
}

function buildMeta(opts: { file_no: string; touched: string[]; long_title: string }): BillMeta {
  return {
    file_no: opts.file_no,
    matter_id: `m-${opts.file_no}`,
    matter_guid: "aaaaaaaa-bbbb-cccc-dddd-111111111111",
    short_title: `Bill ${opts.file_no}`,
    long_title: opts.long_title,
    legistar_status: "Pending Committee Hearing",
    sponsor: null,
    introduced_at: null,
    enacted_at: null,
    terminal_at: null,
    legistar_url: "https://sfgov.legistar.com/x",
    title_class: "A",
    touched_code_stubs: [],
    touched_modules: opts.touched as BillMeta["touched_modules"],
    installed_modules: [],
    not_installed_modules: [],
    scraped_at: "2026-06-04T10:00:00-07:00",
    attachment_id: "9000000",
    pdf_cache_path: "build/downloads/bills/pdfs/x.pdf",
    attachment_content_hash: "0000000000000000",
  };
}

function buildIndex(
  entries: ReadonlyArray<[ModuleId, ReadonlyArray<string>]>,
): ReadonlyMap<ModuleId, ReadonlySet<SectionId>> {
  const m = new Map<ModuleId, ReadonlySet<SectionId>>();
  for (const [moduleId, ids] of entries) {
    m.set(moduleId, new Set(ids as SectionId[]));
  }
  return m;
}

describe("redline rendering — three formerly-failing real bills", () => {
  it("260539 CEQA: every amended §31.x section emits at least one delete or insert span", async () => {
    // Old failure (Cause C): diffWords drove a global cursor that
    // walked off the baseline mid-section, after which every later
    // hunk's anchor was discarded by the bounds gate and the section
    // rendered with zero highlights. New path positions each span via
    // substring-search of its surrounding context, so no global cursor
    // exists to drift.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260539.pdf"));
    const meta = buildMeta({
      file_no: "260539",
      touched: ["sf-administrative"],
      long_title: "Ordinance amending the Administrative Code to streamline CEQA procedures.",
    });
    const baselines = new Map<string, string>();
    for (const sid of ["31.02", "31.05", "31.09", "31.10", "31.14", "31.19"]) {
      baselines.set(`sf-administrative::${sid}`, await loadBaseline("sf-administrative", sid));
    }
    const sectionIndex = buildIndex([
      [
        "sf-administrative" as ModuleId,
        ["31.02", "31.05", "31.09", "31.10", "31.14", "31.19"] satisfies string[],
      ],
    ]);
    const parsed = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    const anchored = anchorTextDiff(parsed, (mid, sid) => baselines.get(`${mid}::${sid}`));
    const bill = anchored.bills[0];
    expect(bill).toBeDefined();

    for (const sid of ["31.02", "31.05", "31.09", "31.10", "31.14", "31.19"] as SectionId[]) {
      const sectionSpans = bill!.text_diff.filter((s) => s.section_id === sid);
      const hasEdit = sectionSpans.some((s) => s.op === "delete" || s.op === "insert");
      expect(hasEdit, `${sid} must emit at least one delete or insert span`).toBe(true);
      for (const s of sectionSpans) {
        const baseline = baselines.get(`sf-administrative::${sid}`)!;
        expect(s.anchor.baseline_offset + s.anchor.baseline_length).toBeLessThanOrEqual(
          baseline.length,
        );
      }
    }
  }, 60_000);

  it("260542 Housing Choice §206.10: 'Francisco Program' does not surface as a fake amendment pair", async () => {
    // Old failure (Cause D): pdfjs splits "Francisco" + " " + "Program"
    // into separate TextRuns; the old diff path concatenated span text
    // without the synthetic-space glue that runsToText injected for the
    // render path. The two pipelines disagreed, so diffWords saw
    // "FranciscoProgram" (joined) vs "Francisco Program" (baseline) and
    // emitted a phantom delete/insert pair. Under the new path,
    // classify-spans labels each run as context and substring-anchoring
    // is whitespace-tolerant — no fake pair gets emitted.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260542.pdf"));
    const meta = buildMeta({
      file_no: "260542",
      touched: ["sf-planning"],
      long_title:
        "Ordinance amending the Planning Code to exempt projects on corner lots under the Housing Choice program.",
    });
    const baseline = await loadBaseline("sf-planning", "206.10");
    const sectionIndex = buildIndex([["sf-planning" as ModuleId, ["206.10"]]]);
    const parsed = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    const anchored = anchorTextDiff(parsed, (mid, sid) =>
      mid === "sf-planning" && sid === "206.10" ? baseline : null,
    );
    const bill = anchored.bills[0];
    expect(bill).toBeDefined();
    const sectionSpans = bill!.text_diff.filter((s) => s.section_id === ("206.10" as SectionId));

    // No delete + insert pair at the SAME baseline offset whose
    // whitespace-stripped text is identical. The Cause-D bug emitted
    // both spans at the same anchor (the joined-vs-spaced "Francisco
    // Program" comparison produced delete "Francisco Program" + insert
    // "FranciscoProgram" anchored to the same baseline position).
    // Same-text deletes and inserts at DIFFERENT offsets are legitimate
    // — e.g., two unrelated renumbers on the same page can both involve
    // the digit "1" without that being a false amendment.
    const dels = sectionSpans.filter((s) => s.op === "delete");
    const inserts = sectionSpans.filter((s) => s.op === "insert");
    for (const d of dels) {
      const compact = d.text.replace(/\s+/g, "");
      const matchingFakePair = inserts.find(
        (i) =>
          i.text.replace(/\s+/g, "") === compact &&
          i.anchor.baseline_offset === d.anchor.baseline_offset,
      );
      expect(
        matchingFakePair,
        `delete ${JSON.stringify(d.text)} has a matching insert with the same compact text at the same baseline offset — this is the Cause-D false-amendment pattern`,
      ).toBeUndefined();
    }

    // Cause-D-adjacent: short "(c)" context spans must anchor at the
    // subsection-heading "(c)" in the baseline (just before
    // "Inclusionary Housing Ordinance Alternatives"), NOT at the first
    // in-text "(c)" inside item (5) of (b)'s parenthetical reference
    // list. Without the lookahead anchor rule, the new-(c) inserts
    // dumped into item (5) and the actual subsection-(c) heading
    // location was left empty.
    const inclusionaryPos = baseline.indexOf("Inclusionary Housing Ordinance Alternatives");
    expect(inclusionaryPos).toBeGreaterThan(0);
    const newSubsectionCInserts = sectionSpans.filter(
      (s) => s.op === "insert" && s.text.includes("Development Impact Fees"),
    );
    expect(newSubsectionCInserts.length).toBeGreaterThan(0);
    for (const ins of newSubsectionCInserts) {
      // Must land at the subsection-(c) heading position (right before
      // "Inclusionary"), not 1500+ chars earlier inside item (5).
      expect(
        ins.anchor.baseline_offset,
        `new-(c) insert ${JSON.stringify(ins.text.slice(0, 40))} anchored at ${ins.anchor.baseline_offset}, expected near ${inclusionaryPos}`,
      ).toBeGreaterThan(inclusionaryPos - 10);
    }
  }, 60_000);

  it("260543 Fireworks §1290: preserves the inline redline (per-word marks visible, no block render)", async () => {
    // Old failure (Cause E): bill rewrites §1290 into three labeled
    // subsections (a)(b)(c). The bill PDF draws (b) Prohibition as a
    // genuine inline redline — corporation is preserved as context,
    // "any" struck before "F" inserted before "fireworks", "limits of
    // the" struck before "City", "and County of San Francisco" struck,
    // etc. (a) Definition and (c) Penalties are entirely new content.
    // The diffWords path mis-aligned matching words across the (a)/(b)
    // restructure and rendered "corporation(a) Definition. shall fire…".
    // New path: any successful context anchor in the body routes to the
    // inline path; the renderer's gap-fill from baseline keeps the (b)
    // edits visible without forcing a full-block delete-then-insert.
    const manifest = await loadManifest();
    const bytes = await readFile(join(BILLS_FIXTURE, "260543.pdf"));
    const meta = buildMeta({
      file_no: "260543",
      touched: ["sf-police"],
      long_title:
        "Ordinance amending the Police Code to provide penalties for the prohibited discharge of fireworks.",
    });
    const baseline = await loadBaseline("sf-police", "1290");
    const sectionIndex = buildIndex([["sf-police" as ModuleId, ["1290"]]]);
    const parsed = await parseBill(new Uint8Array(bytes), meta, manifest, { sectionIndex });
    const anchored = anchorTextDiff(parsed, (mid, sid) =>
      mid === "sf-police" && sid === "1290" ? baseline : null,
    );
    const bill = anchored.bills[0];
    expect(bill).toBeDefined();
    const outcome = bill!.section_outcomes.find((o) => o.section_id === ("1290" as SectionId));
    expect(outcome?.status).toBe("anchored");

    const sectionSpans = bill!.text_diff.filter((s) => s.section_id === ("1290" as SectionId));
    expect(sectionSpans.length).toBeGreaterThan(0);

    // The inline path emits both granular deletes and granular inserts
    // — never a single full-baseline-delete sentinel.
    const hasFullBaselineDelete = sectionSpans.some(
      (s) =>
        s.op === "delete" &&
        s.anchor.baseline_offset === 0 &&
        s.anchor.baseline_length === baseline.length,
    );
    expect(hasFullBaselineDelete, "§1290 must not be flattened into one full-baseline delete").toBe(
      false,
    );

    // Several distinct delete spans cover the redline cuts (any /
    // limits of the / and County / of San Francisco / the trailing
    // Fire Marshal sentence). They're short, not one giant span.
    const deletes = sectionSpans.filter((s) => s.op === "delete");
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    for (const d of deletes) {
      expect(d.anchor.baseline_length).toBeLessThan(baseline.length);
    }

    // Several distinct insert spans cover the new content — (a) and
    // (c) prose, plus the small inline inserts inside (b).
    const inserts = sectionSpans.filter((s) => s.op === "insert");
    expect(inserts.length).toBeGreaterThanOrEqual(3);

    // Subsection labels appear in the insert stream (the (a)/(b)/(c)
    // headers the bill adds) — they're not lost on the cutting-room
    // floor, and they aren't jammed mid-baseline-word.
    const insertCorpus = inserts.map((i) => i.text).join("\n");
    for (const label of ["(a)", "(b)", "(c)"]) {
      const idx = insertCorpus.indexOf(label);
      expect(idx, `${label} should appear among inserts`).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});
