// React adapter over corpus-nav. Holds the expansion state and re-derives
// the flat visible-rows list on every render. `visibleRows` is internally
// memoized (single-entry cache on tree+expansion+predicate identity), so
// the same inputs produce a stable array reference without an outer
// `useMemo` here.

import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import type { CorpusTreeNode } from "@/corpus/wire";
import { defaultExpansion, type ExpansionState, type Row, visibleRows } from "@/corpus-nav";

export interface UseCorpusTreeResult {
  expansion: ExpansionState;
  /** React-style setter — accepts a value or `(prev) => next` updater.
   * Callers MUST use the functional form when reading the previous value;
   * the value form would re-introduce stale-closure bugs in event handlers
   * that close over an outdated expansion state. */
  setExpansion: Dispatch<SetStateAction<ExpansionState>>;
  rows: readonly Row[];
  /** Reverse index: row id → position in `rows`. Memoized on `rows`
   * identity so arrow-key dispatch stays O(1) at large corpus sizes;
   * consumers MUST use `Map.get` rather than `Array.findIndex`. */
  rowIndexById: ReadonlyMap<string, number>;
}

export function useCorpusTree(tree: readonly CorpusTreeNode[]): UseCorpusTreeResult {
  const [expansion, setExpansion] = useState<ExpansionState>(() => defaultExpansion(tree));
  const rows = visibleRows(tree, expansion);
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      map.set(row.id, i);
    });
    return map;
  }, [rows]);
  return { expansion, setExpansion, rows, rowIndexById };
}
