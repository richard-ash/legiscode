// Bill parser orchestrator. Pure function of (pdf bytes, BillMeta, manifest)
// → Bill[]. One Bill is emitted per (matter, touched_module) pair so the
// renderer can show "this bill affects sf-admin §10.04.020 and sf-building
// §b102a" by loading two per-module files independently.
//
// v1 ships **structural pass only**: text_diff[] is always empty and
// parse_status is "manual_review" or "structural_change". The inline-diff
// rendering follows in the deferred follow-up PR (per the locked plan's
// "Renderer-scope expansion" section). affected_sections is populated from
// the structural pass so the v1 renderer can still surface which sections
// a bill touches without inline content.

import { loadPdfBuffer } from "@/parser/pdf/load";
import { extractTextRuns, runsToText } from "@/parser/pdf/page-extractor";
import type { Bill, BillMeta, JurisdictionManifest, ModuleId, SectionId } from "@/types";
import type { InstalledModule } from "./scope-filter";
import { mapLegistarStatusToBillStatus } from "./status";
import { applyDisplayRules, runStructuralPass } from "./structural-pass";
import { cleanupOrdinanceText } from "./text-cleanup";

export type ParseBillResult = {
  /** One Bill per touched + installed module. Sorted by module_id. */
  bills: Bill[];
  /**
   * Sections that matched the structural pattern but couldn't resolve
   * against an installed module's section index. Surfaced for the
   * operator log; not gating (per project_legal_corpus_zero_skip the
   * pipeline can't silently drop content, but a section the structural
   * pass couldn't resolve means new SF code is in flight — the bill
   * still gets a Bill record with affected_sections = [] in that case).
   */
  unresolved_sections: Array<{
    module_id: ModuleId;
    raw_section_id: string;
    candidates: SectionId[];
  }>;
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
  let text: string;
  try {
    const runs = await extractTextRuns(loaded.doc);
    text = runsToText(runs);
  } finally {
    await loaded.destroy();
  }

  const pass = runStructuralPass(text, installed);
  const billStatus = mapLegistarStatusToBillStatus(meta.legistar_status).status;

  // Group section hits by module id. Each group's affected_sections is
  // the de-duplicated set of resolved section ids that exist in the
  // module's tree (when section index is provided).
  type PerModule = {
    affected: SectionId[];
    rawHits: Array<{ raw: string; candidates: SectionId[] }>;
  };
  const perModule = new Map<ModuleId, PerModule>();
  const unresolved: ParseBillResult["unresolved_sections"] = [];

  for (const group of pass.groups) {
    if (group.module_id === null) continue;
    const moduleConfig = moduleConfigByCanonical.get(group.module_id);
    const index = opts.sectionIndex?.get(group.module_id);
    const acc = perModule.get(group.module_id) ?? { affected: [], rawHits: [] };
    for (const section of group.sections) {
      const candidates = applyDisplayRules(section.raw_id, moduleConfig?.display_rules);
      acc.rawHits.push({ raw: section.raw_id, candidates });
      const resolved = index === undefined ? candidates[0] : candidates.find((c) => index.has(c));
      if (resolved !== undefined) {
        if (!acc.affected.includes(resolved)) acc.affected.push(resolved);
      } else if (index !== undefined) {
        unresolved.push({
          module_id: group.module_id,
          raw_section_id: section.raw_id,
          candidates,
        });
      }
    }
    perModule.set(group.module_id, acc);
  }

  // Always emit a Bill for every touched_module the title classifier
  // recorded — even when the structural pass found zero sections in that
  // module (e.g. the title mentioned the code but the body amended other
  // codes). The renderer's "affects this code" surface depends on
  // touched_modules; emitting empty-affected bills lets the operator see
  // the title-vs-body mismatch.
  const bills: Bill[] = [];
  for (const moduleId of meta.touched_modules) {
    const pm = perModule.get(moduleId);
    const affected = pm ? [...pm.affected].sort() : [];
    const parseStatus: Bill["parse_status"] = pass.has_structural_action
      ? "structural_change"
      : "manual_review";
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
      affected_sections: affected,
      text_diff: [],
      parse_status: parseStatus,
      structural_change_scope: pass.has_structural_action ? pass.structural_action_text : null,
      proposed_text: cleanupOrdinanceText(text),
    };
    bills.push(bill);
  }
  bills.sort((a, b) => a.module_id.localeCompare(b.module_id));

  return { bills, unresolved_sections: unresolved };
}
