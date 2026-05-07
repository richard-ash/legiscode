// Layer 3 — tree expansion state. Pure, immutable: every mutator returns
// a new `ExpansionState` (a `ReadonlySet<string>`) so React change-
// detection works against object identity. The expansion state is
// orthogonal to the tree itself — the tree describes structure, the
// expansion describes which parents are open.
//
// The default expansion auto-opens the top two levels (depth 0 = code
// modules, depth 1 = chapters/articles) so first-launch matches the
// populated mockup state without a user click; deeper levels stay
// collapsed until the user expands them.

import type { CorpusTreeNode } from "@/corpus/wire";

export type ExpansionState = ReadonlySet<string>;

export function emptyExpansion(): ExpansionState {
  return new Set<string>();
}

/**
 * Auto-expand all parents at depth ≤ `maxDepth`. The default of 1 opens
 * codes + chapters but leaves sections collapsed (they have no children
 * to reveal anyway).
 */
export function defaultExpansion(tree: readonly CorpusTreeNode[], maxDepth = 1): ExpansionState {
  const out = new Set<string>();
  const walk = (node: CorpusTreeNode, depth: number): void => {
    if (depth <= maxDepth && node.kids && node.kids.length > 0) {
      out.add(node.id);
    }
    if (node.kids) {
      for (const k of node.kids) walk(k, depth + 1);
    }
  };
  for (const n of tree) walk(n, 0);
  return out;
}

export function toggle(state: ExpansionState, id: string): ExpansionState {
  const next = new Set(state);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function expand(state: ExpansionState, id: string): ExpansionState {
  if (state.has(id)) return state;
  const next = new Set(state);
  next.add(id);
  return next;
}

export function collapse(state: ExpansionState, id: string): ExpansionState {
  if (!state.has(id)) return state;
  const next = new Set(state);
  next.delete(id);
  return next;
}

export function isExpanded(state: ExpansionState, id: string): boolean {
  return state.has(id);
}
