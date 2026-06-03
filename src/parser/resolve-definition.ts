// Per-occurrence definition resolver. Given a term occurrence in a
// reader section, find the canonical Definition that applies (winner +
// dropped runner-ups) per the precedence rule in plan §4 RESOLVE:
//
//   1. Filter candidates to those whose scope contains the reader section
//   2. Precedence: hierarchy beats module
//   3. Within hierarchy, longest matching prefix wins
//   4. Ties broken by defined_in ascending
//
// cross_module-scoped Definitions never resolve here — no extractor
// emits them yet. The resolver explicitly treats cross_module as
// out-of-scope so a hypothetical hand-curated cross_module entry
// doesn't accidentally resolve without the matching reader-side
// support.

import type { Definition, ScopeExpr, SectionId } from "@/types";

export interface Reader {
  id: SectionId;
  hierarchy: readonly string[];
}

export interface ResolutionResult {
  /**
   * The winning Definition, or null if no in-scope candidate exists.
   * Callers treat null as "unresolved" — emit plain text segment, append
   * to unresolved_references.
   */
  winner: Definition | null;
  /**
   * Other in-scope candidates that lost the precedence rule. Empty
   * when winner is null or when no other candidates were in scope.
   * Stored on the defined_term body segment as candidates_dropped
   * (per-occurrence, not per-Definition).
   */
  dropped: Definition[];
}

// Build a per-term candidate index from a module's Definition[]. Linear
// scan to construct; constant-time lookups during per-occurrence
// resolution. Called once per buildBodySegments invocation per section,
// so the construction cost amortizes across every occurrence in a
// section.
export function buildCandidatesByTerm(
  definitions: readonly Definition[],
): Map<string, Definition[]> {
  const map = new Map<string, Definition[]>();
  for (const def of definitions) {
    const existing = map.get(def.term);
    if (existing) existing.push(def);
    else map.set(def.term, [def]);
  }
  return map;
}

// Is this Definition's scope satisfied by the reader's hierarchy chain?
function isInScope(scope: ScopeExpr, readerHierarchy: readonly string[]): boolean {
  if (scope.kind === "module") return true;
  if (scope.kind === "cross_module") return false;
  // hierarchy: scope.prefix must be a prefix of readerHierarchy.
  if (scope.prefix.length > readerHierarchy.length) return false;
  for (let i = 0; i < scope.prefix.length; i++) {
    if (scope.prefix[i] !== readerHierarchy[i]) return false;
  }
  return true;
}

// Precedence comparator: returns negative if a beats b, positive if b
// beats a. Hierarchy > module; longer prefix > shorter prefix; ascending
// defined_in as tiebreak.
function precedenceCompare(a: Definition, b: Definition): number {
  const aHier = a.scope.kind === "hierarchy" ? 1 : 0;
  const bHier = b.scope.kind === "hierarchy" ? 1 : 0;
  if (aHier !== bHier) return bHier - aHier;
  if (a.scope.kind === "hierarchy" && b.scope.kind === "hierarchy") {
    if (a.scope.prefix.length !== b.scope.prefix.length) {
      return b.scope.prefix.length - a.scope.prefix.length;
    }
  }
  return a.defined_in.localeCompare(b.defined_in);
}

export function resolveDefinitionForOccurrence(
  term: string,
  reader: Reader,
  candidatesByTerm: ReadonlyMap<string, readonly Definition[]>,
): ResolutionResult {
  const candidates = candidatesByTerm.get(term) ?? [];
  const inScope = candidates.filter((c) => isInScope(c.scope, reader.hierarchy));
  if (inScope.length === 0) return { winner: null, dropped: [] };
  const sorted = [...inScope].sort(precedenceCompare);
  const [winner, ...dropped] = sorted;
  return { winner: winner ?? null, dropped };
}
