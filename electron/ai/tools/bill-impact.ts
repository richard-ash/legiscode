// /bills/{file_no}/impact — composed impact report. Folds a bill's
// per-section outcomes, diff chunks, and parse status into the single
// payload a reviewer-facing affected-section table renders from.
//
// A multi-code bill emits one Bill per module it touches, so the
// builder walks EVERY module's sessionBills for the file_no — unlike
// the single-slice metadata path — and unions the slices. Stats only:
// the payload fetches no section refs (N18); the model still reads
// diffs or sections before citing them.

import type { Bill, SectionOutcome } from "@/types";
import type { ToolContext } from "./read";
import type {
  BillImpactChangeKind,
  BillImpactPayload,
  BillImpactSectionEntry,
  ReadResult,
  ToolError,
} from "./types";

const SECTION_ROW_CAP = 50;

const CHANGE_KIND_ORDER: Record<BillImpactChangeKind, number> = {
  revised: 0,
  added: 1,
  referenced_no_change: 2,
  unclear: 3,
};

/** SectionOutcomeStatus → count. Shared with the /bills listing rows. */
export function countOutcomes(
  outcomes: readonly { status: string }[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  }
  return counts;
}

export function buildBillImpact(fileNo: string, ctx: ToolContext): ReadResult {
  const slices: { moduleId: string; bill: Bill }[] = [];
  for (const mod of ctx.corpus.modules) {
    for (const bill of mod.sessionBills) {
      if (bill.file_no === fileNo) slices.push({ moduleId: mod.id, bill });
    }
  }
  if (slices.length === 0) return notFound(`No bill with file_no=${fileNo}.`, ctx);

  // Primary slice: first in module order — matches what /bills/{file_no}
  // returns, so the two payloads never disagree about the headline module.
  const primary = (slices[0] as { moduleId: string; bill: Bill }).bill;

  const rows: BillImpactSectionEntry[] = [];
  const outcomeCounts = countOutcomes(slices.flatMap((s) => s.bill.section_outcomes));
  const affectedIds: string[] = [];
  const seenAffected = new Set<string>();
  for (const { bill } of slices) {
    for (const outcome of bill.section_outcomes) {
      const affectedKey = outcome.section_id;
      if (!seenAffected.has(affectedKey)) {
        seenAffected.add(affectedKey);
        affectedIds.push(affectedKey);
      }
      rows.push(buildRow(bill, outcome, ctx));
    }
  }
  rows.sort((a, b) => {
    const order = CHANGE_KIND_ORDER[a.change_kind] - CHANGE_KIND_ORDER[b.change_kind];
    if (order !== 0) return order;
    if (a.module_id !== b.module_id) return a.module_id.localeCompare(b.module_id);
    return a.section_id.localeCompare(b.section_id, "en", { numeric: true });
  });
  const cappedRows = rows.slice(0, SECTION_ROW_CAP);

  const payload: BillImpactPayload = {
    file_no: primary.file_no,
    module_id: primary.module_id,
    short_title: primary.short_title,
    long_title: primary.long_title,
    bill_status: primary.bill_status,
    legistar_status: primary.legistar_status,
    sponsor: primary.sponsor,
    introduced_at: primary.introduced_at,
    legistar_url: primary.legistar_url,
    parse_status: primary.parse_status,
    structural_change_scope: primary.structural_change_scope,
    affected_section_ids: affectedIds,
    sections: cappedRows,
    outcome_counts: outcomeCounts,
    risk_flags: buildRiskFlags(slices.map((s) => s.bill)),
    cross_module_touches: slices.slice(1).map((s) => s.moduleId),
    truncated: rows.length > cappedRows.length,
  };
  return {
    ok: true,
    kind: "bill-impact",
    impact: payload,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function buildRow(bill: Bill, outcome: SectionOutcome, ctx: ToolContext): BillImpactSectionEntry {
  const chunks = bill.diff_chunks.filter((c) => c.section_id === outcome.section_id);
  let insertedWords = 0;
  let deletedWords = 0;
  for (const chunk of chunks) {
    if (chunk.op === "insert") insertedWords += wordCount(chunk.text);
    else if (chunk.op === "delete") deletedWords += wordCount(chunk.text);
  }
  const baseline = ctx.corpus.getSection(bill.module_id, outcome.section_id);
  return {
    module_id: bill.module_id,
    section_id: outcome.section_id,
    status: outcome.status,
    change_kind: toChangeKind(outcome.status),
    detail: outcome.detail,
    diff_stats:
      chunks.length > 0 ? { inserted_words: insertedWords, deleted_words: deletedWords } : null,
    diff_path: `/bills/${bill.file_no}/changes/${bill.module_id}/${outcome.section_id}`,
    section_path: baseline ? `/modules/${bill.module_id}/sections/${baseline.id}` : null,
  };
}

function toChangeKind(status: SectionOutcome["status"]): BillImpactChangeKind {
  switch (status) {
    case "anchored":
      return "revised";
    case "added_section":
      return "added";
    case "no_changes":
      return "referenced_no_change";
    case "classification_low_confidence":
    case "no_baseline":
    case "structural":
    case "unresolved":
    case "absorbed_external":
      return "unclear";
  }
}

/**
 * Risk flags a reviewer must clear before trusting the table. Two
 * families: parse-status flags (one per non-ok slice status) and
 * per-outcome flags listing the section ids stuck in each
 * non-renderable status.
 */
function buildRiskFlags(bills: readonly Bill[]): { flag: string; detail: string }[] {
  const flags: { flag: string; detail: string }[] = [];
  const seenParseStatus = new Set<string>();
  for (const bill of bills) {
    if (bill.parse_status === "ok" || seenParseStatus.has(bill.parse_status)) continue;
    seenParseStatus.add(bill.parse_status);
    switch (bill.parse_status) {
      case "partial":
        flags.push({
          flag: "partial",
          detail: "Some touched sections have no renderable diff; see per-status flags below.",
        });
        break;
      case "manual_review":
        flags.push({
          flag: "manual_review",
          detail: "No touched section produced a renderable diff; every row needs manual review.",
        });
        break;
      case "structural_change":
        flags.push({
          flag: "structural_change",
          detail: `Whole-chapter/article action; per-section diffs are not meaningful. Scope: ${bill.structural_change_scope ?? "unknown"}.`,
        });
        break;
      case "absorbed_external":
        flags.push({
          flag: "absorbed_external",
          detail: "AmLegal codifies these changes; read the codified sections, not inline diffs.",
        });
        break;
      case "body_only":
        flags.push({
          flag: "body_only",
          detail: `No section targets identified; read /bills/${bill.file_no}/proposed-text for the ordinance body.`,
        });
        break;
    }
  }
  const byStatus = new Map<string, string[]>();
  for (const bill of bills) {
    for (const outcome of bill.section_outcomes) {
      if (
        outcome.status === "anchored" ||
        outcome.status === "added_section" ||
        outcome.status === "no_changes"
      ) {
        continue;
      }
      const bucket = byStatus.get(outcome.status) ?? [];
      bucket.push(`${bill.module_id} § ${outcome.section_id}`);
      byStatus.set(outcome.status, bucket);
    }
  }
  const statusFlagNames: Record<string, string> = {
    no_baseline: "no_baseline_sections",
    unresolved: "unresolved_sections",
    classification_low_confidence: "low_confidence_sections",
    structural: "structural_sections",
    absorbed_external: "absorbed_external_sections",
  };
  for (const [status, refs] of byStatus) {
    flags.push({
      flag: statusFlagNames[status] ?? `${status}_sections`,
      detail: refs.join(", "),
    });
  }
  return flags;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function notFound(detail: string, ctx: ToolContext): ToolError {
  return {
    ok: false,
    reason: "not_found",
    detail,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}
