// Bills-by-affected-section index. Walks every loaded module's
// session bills, inverts them into a Map<refKey, Bill[]> the
// `get_pending_amendments` tool reads.
//
// Lazy + cached per corpus snapshot (A7). Same pattern as the
// reverse-citation graph; the cost is small (current SF corpus has
// double-digit bills), so the laziness is more about not building it
// before any user query than about absolute perf.

import type { Bill } from "@/types";
import type { AiCorpusHandle } from "../corpus-loader";

export interface BillsIndex {
  /** Returns the bills whose change_ops target this section ref. */
  forSection(mod: string, section: string): readonly Bill[];
}

let cached: { corpusHash: string; index: BillsIndex } | null = null;

export function getBillsIndex(handle: AiCorpusHandle): BillsIndex {
  if (cached && cached.corpusHash === handle.corpusHash) return cached.index;
  cached = { corpusHash: handle.corpusHash, index: buildBillsIndex(handle) };
  return cached.index;
}

/** Test seam. */
export function __resetBillsIndexForTests(): void {
  cached = null;
}

function buildBillsIndex(handle: AiCorpusHandle): BillsIndex {
  const byKey = new Map<string, Bill[]>();
  for (const mod of handle.modules) {
    for (const bill of mod.sessionBills) {
      const refs = collectAffectedRefs(bill);
      for (const ref of refs) {
        const key = `${ref.module_id}::${ref.section_id}`;
        const bucket = byKey.get(key);
        if (bucket) {
          // Same bill can appear in multiple modules (Bill.module_id
          // discriminates which slice this Bill represents). Dedupe
          // by file_no within the same key.
          if (!bucket.some((b) => b.file_no === bill.file_no)) bucket.push(bill);
        } else {
          byKey.set(key, [bill]);
        }
      }
    }
  }
  return {
    forSection(mod: string, section: string): readonly Bill[] {
      const bucket = byKey.get(`${mod}::${section}`);
      if (!bucket) return [];
      // Newest first by introduced_at; nulls last.
      return [...bucket].sort((a, b) => {
        const ai = a.introduced_at ?? "";
        const bi = b.introduced_at ?? "";
        if (ai !== bi) return bi.localeCompare(ai);
        return a.file_no.localeCompare(b.file_no);
      });
    },
  };
}

function collectAffectedRefs(bill: Bill): { module_id: string; section_id: string }[] {
  const seen = new Set<string>();
  const out: { module_id: string; section_id: string }[] = [];
  for (const outcome of bill.section_outcomes) {
    const key = `${bill.module_id}::${outcome.section_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ module_id: bill.module_id, section_id: outcome.section_id });
  }
  return out;
}
