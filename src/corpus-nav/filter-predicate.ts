// Composable predicates over corpus tree nodes. Today the only real
// consumer is `prefixMatch` from the typeahead path; future consumers
// (search filter, watched-section filter, pending-amendment filter)
// compose through `and` / `or`.
//
// The displayed-label normalization rule (case-insensitive, whitespace-
// tokenized prefix match) is a v1.0 default. Changing the rule is a
// one-file edit here.

import type { CorpusTreeNode } from "@/corpus/wire";

export type Predicate = (node: CorpusTreeNode) => boolean;

export const alwaysTrue: Predicate = () => true;

export function and(...preds: readonly Predicate[]): Predicate {
  if (preds.length === 0) return alwaysTrue;
  return (node) => preds.every((p) => p(node));
}

export function or(...preds: readonly Predicate[]): Predicate {
  if (preds.length === 0) return alwaysTrue;
  return (node) => preds.some((p) => p(node));
}

/**
 * Case-insensitive whitespace-tokenized prefix match against the
 * displayed label (`code` + `name`). Empty buffer matches everything.
 *
 * Tokenization splits on whitespace, then asks "does any token start
 * with the buffer?". This makes typing "1" match a section row whose
 * code is "§ 1.1", and typing "C" match a section row whose name is
 * "Commission" — both common typeahead expectations from the existing
 * `chrome.jsx` mockup.
 */
export function prefixMatch(buffer: string): Predicate {
  if (buffer.length === 0) return alwaysTrue;
  const needle = buffer.toLowerCase();
  return (node) => {
    const label = `${node.code} ${node.name}`.toLowerCase();
    for (const token of label.split(/\s+/)) {
      if (token.length > 0 && token.startsWith(needle)) return true;
    }
    return false;
  };
}
