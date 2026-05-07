// Derive a flat list of visible rows from a tree + expansion state +
// optional predicate. Memoized: when the inputs are reference-stable, the
// same array reference is returned, so React list reconciliation doesn't
// churn.
//
// The cache is single-entry on purpose. Multi-entry would require an
// eviction policy and a footgun where a long-lived stale entry retains a
// heavy tree. Single-entry means: the most recent input produces an O(1)
// lookup; any prior input pays the recomputation cost when it cycles back.
// For our usage (one tree, one expansion state, one predicate at a time)
// that's exactly right.

import type { CorpusRef } from "@/corpus/refs";
import { corpusRefFromWire } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import { alwaysTrue, type Predicate } from "./filter-predicate";

export interface Row {
  /** Stable id from the underlying tree node; unique within a corpus. */
  id: string;
  /** 0 = root code, 1 = chapter, 2+ = subdivisions. */
  depth: number;
  node: CorpusTreeNode;
  /** Branded ref for section leaves; null for non-section parents. */
  ref: CorpusRef | null;
  hasKids: boolean;
  isExpanded: boolean;
  /**
   * 1-based position among the row's parent's visible children (or among
   * roots when depth is 0). Counts only siblings that satisfy the active
   * predicate. Maps directly to `aria-posinset`.
   */
  siblingPos: number;
  /**
   * Count of visible siblings at this level under the same parent.
   * Counts only nodes that satisfy the active predicate. Maps directly to
   * `aria-setsize`.
   */
  siblingSize: number;
}

interface CacheEntry {
  tree: readonly CorpusTreeNode[];
  expansion: ReadonlySet<string>;
  predicate: Predicate;
  rows: readonly Row[];
}

let cache: CacheEntry | null = null;

export function visibleRows(
  tree: readonly CorpusTreeNode[],
  expansion: ReadonlySet<string>,
  predicate: Predicate = alwaysTrue,
): readonly Row[] {
  if (
    cache !== null &&
    cache.tree === tree &&
    cache.expansion === expansion &&
    cache.predicate === predicate
  ) {
    return cache.rows;
  }
  const rows = computeRows(tree, expansion, predicate);
  cache = { tree, expansion, predicate, rows };
  return rows;
}

/** Test seam — drops the memoization cache so cache-hit semantics can be exercised. */
export function __resetVisibleRowsCache(): void {
  cache = null;
}

function computeRows(
  tree: readonly CorpusTreeNode[],
  expansion: ReadonlySet<string>,
  predicate: Predicate,
): readonly Row[] {
  const out: Row[] = [];
  // Walk a sibling group: filter survivors first so siblingSize reflects the
  // post-predicate count (what assistive tech actually traverses), then emit
  // each survivor with a 1-based position within that group. This is the
  // ARIA-correct meaning of aria-posinset / aria-setsize for nested trees.
  const walkSiblings = (siblings: readonly CorpusTreeNode[], depth: number): void => {
    const survivors: CorpusTreeNode[] = [];
    for (const node of siblings) {
      if (predicate(node)) survivors.push(node);
    }
    const siblingSize = survivors.length;
    for (let i = 0; i < survivors.length; i++) {
      const node = survivors[i];
      if (!node) continue;
      const hasKids = node.kids !== undefined && node.kids.length > 0;
      const isExpanded = expansion.has(node.id);
      out.push({
        id: node.id,
        depth,
        node,
        ref: node.kind === "section" && node.ref ? corpusRefFromWire(node.ref) : null,
        hasKids,
        isExpanded,
        siblingPos: i + 1,
        siblingSize,
      });
      if (hasKids && isExpanded && node.kids) {
        walkSiblings(node.kids, depth + 1);
      }
    }
  };
  walkSiblings(tree, 0);
  return out;
}
