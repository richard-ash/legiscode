// End-to-end regression set for the diff-completeness redesign. Each
// real-bill fixture below was a known failure mode under the v1
// anchor-context pipeline. v2 produces DiffChunk[] from
// `diffWords(baseline, reconstructedNewText)` — the three failure
// modes translate to v2 invariants the chunk stream must satisfy.
//
// Tests are hermetic: committed PDF + committed baseline JSON in,
// asserted chunk shape out.

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

/**
 * Load-bearing invariant for the structured overlay walker. Equal+delete
 * chunk char lengths MUST sum to baseline.length; any drift cascades into
 * mid-word truncation in the rendered Changes/Proposed views (e.g.
 * "consumption" → "consumptiog" when a chunk slice overruns by one char
 * and the next chunk's start drifts forward). The diff emitter uses
 * diffWordsWithSpace specifically to make this hold by construction, but
 * pinning it here catches future regressions (lib version bump, primitive
 * swap, pre-diff transform that breaks byte alignment).
 */
function assertOffsetInvariant(
  chunks: ReadonlyArray<{ op: "equal" | "insert" | "delete"; text: string }>,
  baseline: string,
  context: string,
): void {
  let span = 0;
  for (const c of chunks) if (c.op !== "insert") span += c.text.length;
  expect(span, `${context}: sum(equal+delete).length must equal baseline.length`).toBe(
    baseline.length,
  );
}

/**
 * No surviving adjacent (delete-whitespace, insert-whitespace) pair. PDF
 * reconstruction routinely wraps a baseline space to a newline at column
 * boundaries; diffWordsWithSpace emits that as `del " " + ins "\n"`. If
 * the coalesce pass in emit-diff is skipped or broken, those pairs leak
 * through and the renderer's pushText turns the inserted newline into a
 * phantom paragraph break in Proposed/Changes mode — sentence flow
 * shatters into one-clause-per-paragraph blocks.
 */
function assertNoWhitespaceOnlyPairs(
  chunks: ReadonlyArray<{ op: "equal" | "insert" | "delete"; text: string }>,
  context: string,
): void {
  const isWs = (s: string) => /^\s+$/.test(s);
  for (let i = 1; i < chunks.length; i++) {
    const a = chunks[i - 1];
    const b = chunks[i];
    if (!a || !b) continue;
    if (a.op === "delete" && b.op === "insert" && isWs(a.text) && isWs(b.text)) {
      throw new Error(
        `${context}: surviving del-ws + ins-ws pair at chunk ${i - 1}/${i} (del=${JSON.stringify(a.text)}, ins=${JSON.stringify(b.text)}) — coalesce broken, will render as phantom paragraph break`,
      );
    }
    if (a.op === "insert" && b.op === "delete" && isWs(a.text) && isWs(b.text)) {
      throw new Error(
        `${context}: surviving ins-ws + del-ws pair at chunk ${i - 1}/${i} (ins=${JSON.stringify(a.text)}, del=${JSON.stringify(b.text)}) — coalesce broken`,
      );
    }
  }
}

describe("redline rendering — three formerly-failing real bills", () => {
  it("260539 CEQA: every amended §31.x section emits at least one insert or delete chunk", async () => {
    // Old failure (Cause C, v1): diffWords drove a global cursor that
    // walked off the baseline mid-section, after which every later
    // hunk's anchor was discarded by the bounds gate and the section
    // rendered with zero highlights. v2 invariant: each section's
    // reconstructed newText differs from baseline at the amended
    // points, so diffWords emits at least one non-equal chunk.
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
      const sectionChunks = bill!.diff_chunks.filter((c) => c.section_id === sid);
      const hasEdit = sectionChunks.some((c) => c.op === "insert" || c.op === "delete");
      expect(hasEdit, `${sid} must emit at least one insert or delete chunk`).toBe(true);
      assertOffsetInvariant(
        sectionChunks,
        baselines.get(`sf-administrative::${sid}`)!,
        `260539 §${sid}`,
      );
      assertNoWhitespaceOnlyPairs(sectionChunks, `260539 §${sid}`);
    }
  }, 60_000);

  it("260542 Housing Choice §206.10: 'Francisco Program' does not surface as a fake amendment pair", async () => {
    // Old failure (Cause D, v1): pdfjs splits "Francisco" + " " +
    // "Program" into separate TextRuns; the old diff path emitted a
    // phantom delete/insert pair when concatenated runs disagreed
    // with the baseline's spacing. v2 invariant: the reconstructed
    // newText keeps "Francisco Program" verbatim because every run
    // is context-classified, so diffWords aligns it as equal — no
    // insert with whitespace-stripped content matching a delete.
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
    const sectionChunks = bill!.diff_chunks.filter((c) => c.section_id === ("206.10" as SectionId));

    // The Cause-D smoking gun: a delete whose whitespace-stripped text
    // matches an insert's whitespace-stripped text. Under v1 this
    // appeared as delete "Francisco Program" + insert "FranciscoProgram"
    // at the same anchor offset. Under v2 the runs reconstruct as
    // equal text, so no such substantive pair is emitted.
    //
    // Filter to compact matches ≥ 5 chars: single-char or short matches
    // (renumbered subsection digits, punctuation tokens like "(c)")
    // legitimately appear on both sides of the diff and aren't the
    // FranciscoProgram-class regression.
    const MIN_CHARS = 5;
    const dels = sectionChunks.filter((c) => c.op === "delete");
    const inserts = sectionChunks.filter((c) => c.op === "insert");
    for (const d of dels) {
      const compact = d.text.replace(/\s+/g, "");
      if (compact.length < MIN_CHARS) continue;
      const fakePair = inserts.find((i) => i.text.replace(/\s+/g, "") === compact);
      expect(
        fakePair,
        `delete ${JSON.stringify(d.text)} has an insert sibling with the same compact text — Cause-D false-amendment pattern`,
      ).toBeUndefined();
    }

    // The actual subsection-(c) Development Impact Fees content the
    // bill adds shows up as an insert.
    // Concatenate the chunks in order, keeping equal + insert content
    // (the post-amendment text the reader sees in Proposed mode). The
    // bill's added subsection-(c) text must surface verbatim somewhere
    // in that stream. We can't pin "Development Impact Fees" to a
    // single insert chunk: under diffWordsWithSpace the inter-word
    // spaces frequently land in equal chunks (baseline whitespace
    // happens to align with the inserted phrase's spaces), so the
    // phrase shows up as alternating insert/equal slices that
    // concatenate into the visible text.
    const proposedText = sectionChunks
      .filter((c) => c.op !== "delete")
      .map((c) => c.text)
      .join("");
    expect(proposedText).toContain("Development Impact Fees");
    assertOffsetInvariant(sectionChunks, baseline, "260542 §206.10");
    assertNoWhitespaceOnlyPairs(sectionChunks, "260542 §206.10");
  }, 60_000);

  it("260543 Fireworks §1290: emits per-word inline edits, not one full-section block", async () => {
    // Old failure (Cause E, v1): bill rewrites §1290 into three labeled
    // subsections (a)(b)(c). diffWords misaligned matching words across
    // the (a)/(b) restructure and rendered "corporation(a) Definition.
    // shall fire…". v2 invariant: the diff stream contains multiple
    // distinct insert and delete chunks (not collapsed into one
    // full-baseline replace), and the (a)/(b)/(c) labels show up as
    // inserts.
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

    const sectionChunks = bill!.diff_chunks.filter((c) => c.section_id === ("1290" as SectionId));
    expect(sectionChunks.length).toBeGreaterThan(0);

    // The diff must include at least one equal chunk — proves it's
    // NOT a flattened wholesale delete + insert.
    const hasEqual = sectionChunks.some((c) => c.op === "equal");
    expect(
      hasEqual,
      "§1290 must include equal chunks (preserved context), not a wholesale rewrite",
    ).toBe(true);

    // Several distinct inserts cover the new (a)/(c) content plus
    // smaller (b) inline edits. The (a)(b)(c) labels show up among
    // them — they aren't lost or jammed mid-word.
    const inserts = sectionChunks.filter((c) => c.op === "insert");
    expect(inserts.length).toBeGreaterThanOrEqual(3);
    const insertCorpus = inserts.map((i) => i.text).join("\n");
    for (const label of ["(a)", "(b)", "(c)"]) {
      const idx = insertCorpus.indexOf(label);
      expect(idx, `${label} should appear among inserts`).toBeGreaterThanOrEqual(0);
    }

    // No single delete chunk reproduces the entire baseline (the
    // Cause-E shape that misalignment used to produce). The "hasEqual"
    // check above already implies preserved context, but assert
    // explicitly so a future regression that emits one wholesale
    // delete is caught at the right invariant.
    const deletes = sectionChunks.filter((c) => c.op === "delete");
    for (const d of deletes) {
      expect(d.text).not.toBe(baseline);
    }
    assertOffsetInvariant(sectionChunks, baseline, "260543 §1290");
    assertNoWhitespaceOnlyPairs(sectionChunks, "260543 §1290");
  }, 60_000);
});
