// Canonical data hook for the pending-bills surfaces. Consumers:
//   - chrome/use-pending-bills-status (status-bar count badge)
//   - left-panel/activity/activity-panel (the list itself)
//   - center-panel/section-view (per-section pending-rail)
//
// Returns a triple:
//   bills      — sorted by date DESC, then file_no DESC (Pass 7 lock #3)
//   bySection  — ReadonlyMap<SectionId, Bill[]> for O(1) lookup in the
//                section pending-rail (Section 4 perf lock)
//   count      — unique file_no count (matches the corpus-loader's
//                pre-computed count, kept on the hook so callers don't
//                need both inputs)
//
// Bills are deduped by file_no for the `bills` array (a multi-code bill
// emits one row per touched module, but the activity panel and tabs key
// off file_no, not module). `bySection` keeps the per-module rows
// distinct because two modules with the same section.id are different
// legal targets — the section-view rail wants to surface both.

import { useMemo } from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import type { Bill, SectionId } from "@/types";

export interface PendingBills {
  /** Deduped by file_no, sorted date DESC then file_no DESC. */
  bills: ReadonlyArray<Bill>;
  /** Section-id keyed lookup. Each value is the per-module Bill rows
   *  whose `affected_sections` include that section id, in the same
   *  primary sort as `bills`. */
  bySection: ReadonlyMap<SectionId, ReadonlyArray<Bill>>;
  /** Unique-file_no count, mirrors `summary.pendingBills.count`. */
  count: number;
}

const EMPTY: PendingBills = {
  bills: [],
  bySection: new Map(),
  count: 0,
};

export function usePendingBills(summary: CorpusModuleSummary | null): PendingBills {
  return useMemo(() => {
    if (!summary) return EMPTY;
    return derivePendingBills(summary.pendingBills.bills, summary.pendingBills.count);
  }, [summary]);
}

/** Pure derivation, exposed for unit tests + future SSR. */
export function derivePendingBills(rows: ReadonlyArray<Bill>, count: number): PendingBills {
  if (rows.length === 0) {
    return { bills: [], bySection: new Map(), count };
  }

  // Primary sort: date DESC (most-recent first). Nulls sort last so a
  // bill with no introduced_at doesn't push real activity off the top.
  // Secondary: file_no DESC — newer file numbers usually mean
  // higher-numbered ordinances in the same session, and the user wants
  // the freshest at the top.
  const sorted = [...rows].sort(sortBillRow);

  // Dedupe by file_no for the headline list. Preserve sort order — the
  // first occurrence wins because `sorted` already has the freshest row.
  const seenFileNos = new Set<string>();
  const bills: Bill[] = [];
  for (const bill of sorted) {
    if (seenFileNos.has(bill.file_no)) continue;
    seenFileNos.add(bill.file_no);
    bills.push(bill);
  }

  // bySection keeps per-module rows distinct because (moduleId,
  // sectionId) is the legal identity, not file_no alone. The section
  // pending-rail in section-view reads this map keyed by the section it
  // is rendering; rows that touch sections in OTHER modules don't show
  // up under that section.
  const bySection = new Map<SectionId, Bill[]>();
  for (const bill of sorted) {
    for (const sectionId of bill.affected_sections) {
      const existing = bySection.get(sectionId);
      if (existing) existing.push(bill);
      else bySection.set(sectionId, [bill]);
    }
  }

  return { bills, bySection, count };
}

function sortBillRow(a: Bill, b: Bill): number {
  // date DESC, nulls last
  if (a.introduced_at !== b.introduced_at) {
    if (a.introduced_at === null) return 1;
    if (b.introduced_at === null) return -1;
    return a.introduced_at > b.introduced_at ? -1 : 1;
  }
  // file_no DESC
  if (a.file_no !== b.file_no) return a.file_no > b.file_no ? -1 : 1;
  // Stable tiebreak on module_id so multi-code rows render in a fixed
  // order; ascending matches the corpus-loader's existing order.
  return a.module_id.localeCompare(b.module_id);
}
