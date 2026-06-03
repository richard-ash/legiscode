// DefinitionId construction. Single source of truth for canonical term
// hashing so the extractor, downstream callers, and any id-shape test
// agree on the algorithm.
//
//   DefinitionId = "<module_id>/<section_id>#<sha8(canonical_term)>"
//
// The sha8-over-canonical-term choice is stability-locked: adding new
// extraction patterns must not invalidate existing ids. sha8 over the
// term text (not over extraction order, not over file position) means
// the id of "Apartment" stays the same whether it was extracted by
// the shall-mean pattern or by a curly-quoted-means pattern added
// later.

import { createHash } from "node:crypto";
import { type DefinitionId, formatDefinitionId } from "@/types";

// canonicalizeTerm normalizes whitespace before hashing so that an
// extractor that emits "Director  of  Transportation" (doubled spaces)
// produces the same id as one that emits "Director of Transportation".
// The schema DefinedTermSchema already rejects leading/trailing whitespace
// and doubled internal whitespace at the section.defined_terms level, but
// the hash input is computed BEFORE schema validation runs, so it stays
// defensive here too.
export function canonicalizeTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ");
}

// sha8 returns the first 8 hex chars of sha256(input). 8 chars = 32 bits
// of identifier space; collision probability inside a single module's
// ~hundreds of definitions is negligible. The ModuleDefinitionsSchema
// uniqueness refinement catches any collision the extractor produces.
export function sha8(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8);
}

// buildDefinitionId composes the canonical wire form. Term is
// canonicalized before hashing.
export function buildDefinitionId(moduleId: string, sectionId: string, term: string): DefinitionId {
  return formatDefinitionId(moduleId, sectionId, sha8(canonicalizeTerm(term)));
}
