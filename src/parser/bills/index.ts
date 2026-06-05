// Bill parser orchestrator. Pure function of (pdf bytes, BillMeta, manifest)
// → Bill[]. One Bill is emitted per (matter, touched_module) pair so the
// renderer can show "this bill affects sf-admin §10.04.020 and sf-building
// §b102a" by loading two per-module files independently.
//
// The structural pass populates section_outcomes (initially empty for
// inline-amendment bills; the build-time anchorer in sync-bills then
// fills in per-section outcomes). text_diff[] is populated alongside
// outcomes; parse_status is DERIVED from section_outcomes via
// `deriveParseStatus`. See src/types/bill.ts for the status taxonomy.

import { loadPdfBuffer } from "@/parser/pdf/load";
import type { TextRun } from "@/parser/pdf/page-extractor";
import {
  extractFontMetadata,
  extractGraphicsOps,
  extractTextRuns,
} from "@/parser/pdf/page-extractor";
import type {
  Bill,
  BillMeta,
  JurisdictionManifest,
  ModuleId,
  OrdinanceBody,
  SectionId,
  SectionOutcome,
} from "@/types";
import { deriveParseStatus } from "@/types";
import { parseBody } from "./body-parser";
import type { ClassifiedSpan } from "./classify-spans";
import { classifySpans } from "./classify-spans";
import { computeRunOffsetMap, type RunOffsetMap } from "./run-offset-map";
import type { InstalledModule } from "./scope-filter";
import { mapLegistarStatusToBillStatus } from "./status";
import { applyDisplayRules, runStructuralPass } from "./structural-pass";

/**
 * Per-section partition input the build-time anchorer consumes. One
 * entry per (target_section) inside this Bill's module. `raw_section_id`
 * is the bill-body string the structural pass extracted; `section_id`
 * is the corpus-tree-resolved id (or `null` when the candidate didn't
 * resolve — added_section detection in T4 keys off that case).
 * `chrome_range` is the half-open `[start, end)` range in the
 * chrome-stripped text where this section's body lives (sourced from
 * `CodeGroup.targetHeaders[].text_offset_*`).
 *
 * `orphan_in_module` is set when local resolution failed BUT the same
 * candidates resolved against a different installed module's index. It's
 * a smoking-gun signal that the structural pass mis-routed the header —
 * the section exists, just in a different code. Distinguishes silent
 * routing failures (a missed `Section N. <Code> Code is hereby amended…`
 * line cascading nested headers into the previous group) from genuine
 * corpus gaps (the cited section truly doesn't exist anywhere installed).
 */
export interface SectionPartitionEntry {
  module_id: ModuleId;
  raw_section_id: string;
  section_id: SectionId | null;
  candidates: SectionId[];
  chrome_range: { start: number; end: number };
  orphan_in_module?: ModuleId | null;
}

export type ParseBillResult = {
  /** One Bill per touched + installed module. Sorted by module_id. */
  bills: Bill[];
  /**
   * Sections that matched the structural pattern but couldn't resolve
   * against an installed module's section index. Surfaced for the
   * operator log AND consumed by the build-time anchorer's
   * added_section detection (bill-body add actions whose raw_section_id
   * matches one of these get classified as `added_section`).
   */
  unresolved_sections: Array<{
    module_id: ModuleId;
    raw_section_id: string;
    candidates: SectionId[];
  }>;
  /**
   * Body-parser soft warnings (operator-only). Empty when every Bill's
   * body was tokenized cleanly. Flows into the operator log alongside
   * `unresolved_sections`.
   */
  body_quality_warnings: string[];
  /**
   * Classified text runs, in source order across the whole PDF.
   * Sidecar data for the build-time anchorer.
   *
   * Length parity with the runs returned by `extractTextRuns` — each
   * span's `source_index` indexes into that array.
   */
  classified_spans: ClassifiedSpan[];
  /**
   * The exact `TextRun[]` the classifier saw, retained so the build-time
   * anchorer can rebuild the section→span mapping without re-parsing
   * the PDF.
   */
  runs: TextRun[];
  /**
   * Per-run multi-range map in the chrome-stripped text. The build-time
   * anchorer partitions classified spans per section by intersecting
   * each span's run ranges with the section's `chrome_range`. Indexed
   * by run index (matches `runs.length`).
   */
  run_offset_map: RunOffsetMap;
  /**
   * Per-section partition entries — one per (target_section) inside
   * each touched module. Consumed by the build-time anchorer to drive
   * per-section attribution. Empty for bills where the structural pass
   * didn't bind to any section headers (body_only shape).
   */
  section_partitions: SectionPartitionEntry[];
};

export type ParseBillOptions = {
  /**
   * Per-module section index — `moduleId → Set<sectionId>`. The parser
   * uses this to validate the candidates applyDisplayRules emits. When
   * absent, the parser accepts the first candidate without validation
   * (used in unit tests where loading the corpus is overkill).
   */
  sectionIndex?: ReadonlyMap<ModuleId, ReadonlySet<SectionId>>;
};

export async function parseBill(
  pdfBytes: Uint8Array,
  meta: BillMeta,
  manifest: JurisdictionManifest,
  opts: ParseBillOptions = {},
): Promise<ParseBillResult> {
  const installed: InstalledModule[] = manifest.modules.map((m) => ({
    id: m.id,
    code_title: m.code_title,
  }));
  const moduleConfigByCanonical = new Map(manifest.modules.map((m) => [m.id, m]));

  const loaded = await loadPdfBuffer(pdfBytes);
  let runs: TextRun[];
  let classifiedSpans: ClassifiedSpan[];
  try {
    // Pull text runs, graphics-op decoration, and font metadata in one
    // pass so we don't open the PDF twice. Layer 3 (classify-spans)
    // consumes all three to flag amendment-class runs.
    // SF Legistar template footer (signature block, BOARD OF SUPERVISORS,
    // Page N, iManage doc id) lives entirely at y ≤ 56; body content
    // starts at y ≥ 88. Filtering footer runs upstream of text join
    // prevents document-order extraction from interleaving signature
    // chrome into body prose at every page boundary. When more
    // jurisdictions ship, this should move into the manifest as a
    // per-template setting.
    [runs] = await Promise.all([extractTextRuns(loaded.doc, { footer_y_max: 70 })]);
    const [graphicsOps, fontMeta] = await Promise.all([
      extractGraphicsOps(loaded.doc),
      extractFontMetadata(loaded.doc),
    ]);
    classifiedSpans = classifySpans(runs, graphicsOps, fontMeta);
  } finally {
    await loaded.destroy();
  }

  // Chrome-stripped text is the shared substrate for the structural
  // pass and the body parser; the run-offset map projects each text
  // run's footprint into this stripped text so the build-time anchorer
  // can partition classified spans per target section.
  const { text, offsetMap: runOffsetMap } = computeRunOffsetMap(runs);
  const pass = runStructuralPass(text, installed);
  const { body, quality_warnings: bodyQualityWarnings } = parseBody(text, pass);
  const billStatus = mapLegistarStatusToBillStatus(meta.legistar_status).status;

  // Walk every (module → target_section) the structural pass found and
  // build the per-section partition entries. Each entry carries the
  // chrome-text range bounding the section's body so the anchorer can
  // intersect classified-span ranges with it to partition.
  type PerModule = { partitions: SectionPartitionEntry[] };
  const perModule = new Map<ModuleId, PerModule>();
  const unresolved: ParseBillResult["unresolved_sections"] = [];

  for (const group of pass.groups) {
    if (group.module_id === null) continue;
    const moduleConfig = moduleConfigByCanonical.get(group.module_id);
    const index = opts.sectionIndex?.get(group.module_id);
    const acc = perModule.get(group.module_id) ?? { partitions: [] };
    for (const header of group.targetHeaders) {
      const candidates = applyDisplayRules(header.raw_id, moduleConfig?.display_rules);
      const resolved =
        index === undefined
          ? (candidates[0] ?? null)
          : (candidates.find((c) => index.has(c)) ?? null);
      // Orphan check: when local resolution fails AND we have indices for
      // other installed modules, see if the same candidate ids exist
      // elsewhere. A hit means the structural pass routed this header to
      // the wrong code — typically because an ord-section boundary line
      // wasn't matched and the headers cascaded into the previous group.
      // We don't reroute (that would mask the structural-pass bug); we
      // record the smoking gun for the operator log.
      let orphanIn: ModuleId | null = null;
      if (resolved === null && index !== undefined && opts.sectionIndex) {
        for (const [otherId, otherIndex] of opts.sectionIndex) {
          if (otherId === group.module_id) continue;
          if (candidates.some((c) => otherIndex.has(c))) {
            orphanIn = otherId;
            break;
          }
        }
      }
      acc.partitions.push({
        module_id: group.module_id,
        raw_section_id: header.raw_id,
        section_id: resolved,
        candidates,
        chrome_range: {
          start: header.text_offset_after_header,
          end: header.text_offset_end,
        },
        orphan_in_module: orphanIn,
      });
      if (resolved === null && index !== undefined) {
        unresolved.push({
          module_id: group.module_id,
          raw_section_id: header.raw_id,
          candidates,
        });
      }
    }
    perModule.set(group.module_id, acc);
  }

  // Always emit a Bill for every touched_module the title classifier
  // recorded — even when the structural pass found zero sections in
  // that module. section_outcomes ships empty in that case and
  // deriveParseStatus reports `body_only`.
  const bills: Bill[] = [];
  const sectionPartitions: SectionPartitionEntry[] = [];
  for (const moduleId of meta.touched_modules) {
    const pm = perModule.get(moduleId);
    if (pm) for (const p of pm.partitions) sectionPartitions.push(p);
    const initialOutcomes: SectionOutcome[] = pass.has_structural_action
      ? (pm?.partitions ?? [])
          .filter((p) => p.section_id !== null)
          .map((p) => ({
            section_id: p.section_id as SectionId,
            status: "structural",
            detail: null,
          }))
      : [];
    const parseStatus = deriveParseStatus(initialOutcomes, pass.has_structural_action);
    const bill: Bill = {
      file_no: meta.file_no,
      module_id: moduleId,
      short_title: meta.short_title,
      long_title: meta.long_title,
      sponsor: meta.sponsor,
      introduced_at: meta.introduced_at,
      legistar_url: meta.legistar_url,
      legistar_status: meta.legistar_status,
      bill_status: billStatus,
      section_outcomes: initialOutcomes,
      text_diff: [],
      parse_status: parseStatus,
      structural_change_scope: pass.has_structural_action ? pass.structural_action_text : null,
      // The same parsed body is shared across every per-module Bill row
      // for a given matter.
      body,
    };
    bills.push(bill);
  }
  bills.sort((a, b) => a.module_id.localeCompare(b.module_id));

  return {
    bills,
    unresolved_sections: unresolved,
    body_quality_warnings: bodyQualityWarnings,
    classified_spans: classifiedSpans,
    runs,
    run_offset_map: runOffsetMap,
    section_partitions: sectionPartitions,
  };
}

// Re-export OrdinanceBody for callers that need to construct or annotate
// the body shape (test fixtures, the renderer, the storage writer).
export type { OrdinanceBody };
