// Canonical data hook for the session-bills surfaces. Consumers:
//   - chrome/use-pending-bills-status (status-bar count badge; reads
//     the `pending` slice only so the status bar continues to answer
//     "what's in flight," not "session count" per design D7)
//   - left-panel/activity/activity-panel (the two-group list)
//   - center-panel/section-view (per-section pending-rail; reads
//     `bySection` which is already rail-eligible per D12.5)
//
// Returns five fields:
//   pending          — in-flight bills (PENDING_STATES), workflow order
//                      then introduced_at desc
//   enactedTerminal  — bills that reached a terminal status, sorted by
//                      coalesce(terminal_at, enacted_at, introduced_at) desc
//   classBMeta       — Class B (non-code) ordinances backed by jurisdiction-
//                      level BillsIndex; bare BillMeta rows, no parsed body,
//                      no module_id
//   bySection        — rail-eligible Bill[] per SectionId (excludes terminal
//                      bills at the hook level per D12.5 — terminal bills
//                      surface in the Activity panel, not the section rail)
//   byFileNo         — file_no → first per-module Bill row (any-module),
//                      for tab title resolution
//   count            — unique file_no count across pending + enacted/terminal +
//                      Class B

import { useMemo } from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { type Bill, type BillMeta, PENDING_STATES, type SectionId } from "@/types";

export interface SessionBills {
  pending: ReadonlyArray<Bill>;
  enactedTerminal: ReadonlyArray<Bill>;
  classBMeta: ReadonlyArray<BillMeta>;
  /** Section-id keyed lookup — rail-eligible only (PENDING_STATES). */
  bySection: ReadonlyMap<SectionId, ReadonlyArray<Bill>>;
  /** file_no → primary per-module Bill row, for tab labels. */
  byFileNo: ReadonlyMap<string, Bill>;
  count: number;
}

const EMPTY: SessionBills = {
  pending: [],
  enactedTerminal: [],
  classBMeta: [],
  bySection: new Map(),
  byFileNo: new Map(),
  count: 0,
};

// Workflow order for the pending group's primary sort (D3).
const WORKFLOW_ORDER: Record<string, number> = {
  filed: 0,
  committee: 1,
  engrossed: 2,
  floor: 3,
  enrolled: 4,
};

export function useSessionBills(summary: CorpusModuleSummary | null): SessionBills {
  return useMemo(() => {
    if (!summary) return EMPTY;
    return deriveSessionBills(
      summary.sessionBills.bills,
      summary.sessionBills.classBMeta,
      summary.sessionBills.count,
    );
  }, [summary]);
}

/** Pure derivation, exposed for unit tests + future SSR. */
export function deriveSessionBills(
  rows: ReadonlyArray<Bill>,
  classBMeta: ReadonlyArray<BillMeta>,
  count: number,
): SessionBills {
  if (rows.length === 0 && classBMeta.length === 0) {
    return { ...EMPTY, count };
  }

  // Dedupe Class A bills by file_no: a multi-code bill emits one Bill
  // per touched module, but the panel + tabs key off file_no. Workflow
  // order is the primary sort for the pending group; the
  // enacted/terminal group sorts by coalesce(terminal_at, enacted_at,
  // introduced_at) desc per D3 + D12.4.
  const byFileNo = new Map<string, Bill>();
  for (const bill of rows) {
    if (!byFileNo.has(bill.file_no)) byFileNo.set(bill.file_no, bill);
  }
  const uniqueBills = Array.from(byFileNo.values());

  const pending = uniqueBills.filter((b) => PENDING_STATES.has(b.bill_status)).sort(sortPending);
  const enactedTerminal = uniqueBills
    .filter((b) => !PENDING_STATES.has(b.bill_status))
    .sort(sortEnactedTerminal);

  // bySection contains rail-eligible per-module rows — PENDING_STATES
  // plus `enacted` (signed but possibly not yet absorbed). Vetoed /
  // withdrawn / failed bills never enter the rail because they won't
  // affect the section (D10 reduced; T6 minimal predicate). The rail
  // shape is locked here so the section view never has to re-filter.
  const bySection = new Map<SectionId, Bill[]>();
  for (const bill of rows) {
    if (!isRailEligible(bill.bill_status)) continue;
    for (const sectionId of bill.affected_sections) {
      const existing = bySection.get(sectionId);
      if (existing) existing.push(bill);
      else bySection.set(sectionId, [bill]);
    }
  }

  return { pending, enactedTerminal, classBMeta, bySection, byFileNo, count };
}

function sortPending(a: Bill, b: Bill): number {
  // workflow order asc, then introduced_at desc (nulls last)
  const wa = WORKFLOW_ORDER[a.bill_status] ?? 99;
  const wb = WORKFLOW_ORDER[b.bill_status] ?? 99;
  if (wa !== wb) return wa - wb;
  return compareDateDesc(a.introduced_at, b.introduced_at);
}

function sortEnactedTerminal(a: Bill, b: Bill): number {
  // We don't have terminal_at / enacted_at on the per-module Bill yet
  // (those live on BillMeta). Fall back to introduced_at desc until
  // the per-module shape carries the action-history dates. file_no
  // desc breaks ties so the freshest matters surface at top.
  const c = compareDateDesc(a.introduced_at, b.introduced_at);
  if (c !== 0) return c;
  return a.file_no > b.file_no ? -1 : 1;
}

function compareDateDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}

function isRailEligible(status: Bill["bill_status"]): boolean {
  return PENDING_STATES.has(status) || status === "enacted";
}
