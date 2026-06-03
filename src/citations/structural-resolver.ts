// Structural-citation resolver: maps a (module, level, number) tuple
// — e.g. ("sf-admin", "chapter", "5") for "Chapter 5 of the
// Administrative Code" — to the first section's CorpusRef under that
// chapter or article in the loaded corpus tree.
//
// Pure functions over the wire CorpusTreeNode shape. No React, no IPC.
// Lives in @/citations alongside the resolver so structural cites and
// section-id cites share the same module boundary.

import { type CorpusRef, parse as parseRef } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import type { ModuleId } from "@/types";

// SF's chapter/article naming uses both forms — Articles tend to be
// Roman ("ARTICLE V"), chapters arabic ("CHAPTER 5") — so the resolver
// tries both when matching tree node prefixes. Cap is 3999 because no
// SF code chapter exceeds two digits.
const ROMAN_PIECES: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 3999) return "";
  let remaining = n;
  let out = "";
  for (const [value, symbol] of ROMAN_PIECES) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

export function findStructuralRef(
  tree: readonly CorpusTreeNode[],
  module: ModuleId,
  level: "article" | "chapter" | "division" | "title",
  number: string,
): CorpusRef | null {
  const moduleRoot = findModuleRoot(tree, module);
  if (!moduleRoot?.kids) return null;
  const labelUpper = level.toUpperCase();
  const candidates = new Set<string>([number]);
  const asInt = Number.parseInt(number, 10);
  if (!Number.isNaN(asInt)) {
    const roman = toRoman(asInt);
    if (roman) candidates.add(roman);
  }
  // Delimited prefixes (e.g. "CHAPTER 1:" / "CHAPTER 1 ") match by
  // startsWith — the trailing delimiter prevents "CHAPTER 1" from
  // claiming "CHAPTER 10". Bare matchers (no trailing delimiter) must
  // be exact-equality matches so labels that are just the cited number
  // with no trailing prose still resolve.
  const prefixMatchers: string[] = [];
  const exactMatchers: string[] = [];
  for (const cand of candidates) {
    prefixMatchers.push(`${labelUpper} ${cand}:`);
    prefixMatchers.push(`${labelUpper} ${cand} `);
    exactMatchers.push(`${labelUpper} ${cand}`);
  }
  function firstSection(node: CorpusTreeNode): CorpusTreeNode | null {
    if (node.kind === "section" && node.ref) return node;
    if (node.kids) {
      for (const k of node.kids) {
        const r = firstSection(k);
        if (r) return r;
      }
    }
    return null;
  }
  const stack: CorpusTreeNode[] = [...moduleRoot.kids];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (
      node.kind === "chapter" &&
      (prefixMatchers.some((p) => node.code.startsWith(p)) ||
        exactMatchers.some((e) => node.code === e))
    ) {
      const leaf = firstSection(node);
      if (leaf?.ref) {
        try {
          return parseRef({ module, section: leaf.ref.sectionId });
        } catch {
          // Fall through to next match if ref parse fails.
        }
      }
    }
    if (node.kids) for (const k of node.kids) stack.push(k);
  }
  return null;
}

/**
 * Locate a module's root tree node, walking through any jurisdiction
 * wrapper. Returns null when the module isn't loaded.
 */
function findModuleRoot(
  tree: readonly CorpusTreeNode[],
  moduleId: ModuleId,
): CorpusTreeNode | null {
  const stack: CorpusTreeNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === "code" && node.id === moduleId) return node;
    if (node.kids) for (const k of node.kids) stack.push(k);
  }
  return null;
}
