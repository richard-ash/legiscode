// Reverse-citation graph. Walks every loaded section's `citations[]` and
// inverts the forward edges into a Map<targetRef, Set<citingRef>> the
// `get_cited_by` tool reads. Lazy: built on the first call and cached for
// the lifetime of the loader's corpus snapshot per A7 / P2.
//
// In RAM, not on disk (per the v1 lock — no `references.json` artifact
// in this branch). The upgrade path to a disk-emitted version is one new
// file behind the same `ReverseGraph` interface.

import type { Citation, ModuleId } from "@/types";
import type { AiCorpusHandle, AiCorpusModule } from "../corpus-loader";

export interface CitingSection {
  readonly module_id: string;
  readonly section_id: string;
  readonly display_label: string;
  readonly title: string;
}

export interface ReverseGraph {
  /** Returns the set of citers for a target qualified ref, or [] if none. */
  citers(mod: string, section: string): readonly CitingSection[];
}

let cached: { corpusHash: string; graph: ReverseGraph } | null = null;

/**
 * Get-or-build the reverse-citation graph for the current corpus
 * snapshot. Lazy: the first call walks ~11k sections (~150ms warm); every
 * subsequent call within the same boot is O(1). When the corpus reloads
 * (different `corpus_hash`), the next call rebuilds.
 */
export function getReverseGraph(handle: AiCorpusHandle): ReverseGraph {
  if (cached && cached.corpusHash === handle.corpusHash) return cached.graph;
  cached = { corpusHash: handle.corpusHash, graph: buildReverseGraph(handle) };
  return cached.graph;
}

/** Test seam. */
export function __resetReverseGraphForTests(): void {
  cached = null;
}

function buildReverseGraph(handle: AiCorpusHandle): ReverseGraph {
  // Key shape: `${module_id}::${section_id}`. The map is built once and
  // never mutated; consumers read it through the closure.
  const reverse = new Map<string, CitingSection[]>();
  for (const mod of handle.modules) {
    for (const wrap of mod.sections) {
      const citing: CitingSection = {
        module_id: mod.id,
        section_id: wrap.section.id,
        display_label: wrap.section.display_label,
        title: wrap.section.title,
      };
      for (const citation of wrap.section.citations) {
        const targets = enumerateTargets(citation, mod.id);
        for (const target of targets) {
          const key = `${target.module}::${target.section}`;
          const bucket = reverse.get(key);
          if (bucket) {
            bucket.push(citing);
          } else {
            reverse.set(key, [citing]);
          }
        }
      }
    }
  }
  // De-dupe each bucket (same citing section can appear via multiple
  // citation entries) and freeze the arrays.
  const frozen = new Map<string, readonly CitingSection[]>();
  for (const [key, bucket] of reverse) {
    const seen = new Set<string>();
    const unique: CitingSection[] = [];
    for (const c of bucket) {
      const k = `${c.module_id}::${c.section_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(c);
    }
    unique.sort((a, b) => {
      if (a.module_id !== b.module_id) return a.module_id.localeCompare(b.module_id);
      return a.section_id.localeCompare(b.section_id, "en", { numeric: true });
    });
    frozen.set(key, unique);
  }
  return {
    citers(mod: string, section: string): readonly CitingSection[] {
      return frozen.get(`${mod}::${section}`) ?? [];
    },
  };
}

interface ResolvedTarget {
  module: ModuleId;
  section: string;
}

// Map a Citation.target to the qualified refs it points at. The
// reverse-index records forward edges from a citing section to every
// section it cites; only the four citation kinds that name a section qualify.
//
// Ranges expand to (from, to) ENDPOINTS only — the in-between sections
// aren't materialized because the reverse-index is for "what other
// sections mention me", and range citations explicitly mention only the
// endpoints. The display behavior of ranges (jumping to from-section)
// matches.
function enumerateTargets(citation: Citation, citingModule: ModuleId): ResolvedTarget[] {
  const target = citation.target;
  switch (target.kind) {
    case "internal":
      if (target.range) {
        return [
          { module: citingModule, section: target.range.from },
          { module: citingModule, section: target.range.to },
        ];
      }
      return [{ module: citingModule, section: target.section_id }];
    case "cross_module":
      if (target.range) {
        return [
          { module: target.module_id, section: target.range.from },
          { module: target.module_id, section: target.range.to },
        ];
      }
      return [{ module: target.module_id, section: target.section_id }];
    case "section-ref":
      if (target.range) {
        return [
          { module: target.module_id, section: target.range.from },
          { module: target.module_id, section: target.range.to },
        ];
      }
      return [{ module: target.module_id, section: target.anchor_id }];
    case "structural":
    case "vague":
    case "internal_appendix":
      return [];
  }
}

// Helper to expose the citer projection for a citing section — used by
// get_section when it builds the qualified citations array.
export function extractCitedRefs(
  section: AiCorpusModule["sections"][number]["section"],
  citingModule: ModuleId,
): readonly { module_id: string; section_id: string }[] {
  const refs: { module_id: string; section_id: string }[] = [];
  const seen = new Set<string>();
  for (const citation of section.citations) {
    for (const target of enumerateTargets(citation, citingModule)) {
      const key = `${target.module}::${target.section}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ module_id: target.module, section_id: target.section });
    }
  }
  return refs;
}
