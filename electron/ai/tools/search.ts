// search — case-insensitive substring scan across loaded section bodies.
//
// Why in-RAM scan instead of spawning ripgrep:
//   - corpus is already loaded in main process (eager load), so the
//     scan is microseconds per section vs ~5ms cold-start for rg
//   - hermetic: no external binary dependency in CI/tests
//   - sf corpus is ~11k sections; full-corpus scan is fine
//
// The "ripgrep" label in the design doc was the abstraction (text
// search), not the binary. C4's safety constraints (shell:false,
// fixed-strings, cwd-locked, timeouts) apply to ripgrep IF used;
// in-RAM scan has no shell surface and inherits the corpus's trust
// boundary (already validated by SectionFileSchema at load).

import type { ToolContext } from "./read";
import type { SearchHit, SearchInput, SearchResult } from "./types";

const DEFAULT_MAX_RESULTS = 25;
const HARD_CAP = 25;
const SNIPPET_RADIUS = 80;

export function runSearch(input: SearchInput, ctx: ToolContext): SearchResult {
  const cap = Math.min(input.max_results ?? DEFAULT_MAX_RESULTS, HARD_CAP);
  const needle = input.query.toLowerCase();
  const hits: SearchHit[] = [];
  let total = 0;

  for (const mod of ctx.corpus.modules) {
    if (input.module_id && mod.id !== input.module_id) continue;
    for (const wrap of mod.sections) {
      const text = wrap.section.text;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx < 0) continue;
      total += 1;
      if (hits.length < cap) {
        hits.push({
          module_id: mod.id,
          section_id: wrap.section.id,
          display_label: wrap.section.display_label,
          title: wrap.section.title,
          snippet: makeSnippet(text, idx, needle.length),
          path: `/modules/${mod.id}/sections/${wrap.section.id}`,
        });
      }
    }
  }

  return {
    ok: true,
    kind: "search-results",
    total_matches: total,
    hits,
    truncated: total > hits.length,
    fetched: hits.map((h) => ({ module_id: h.module_id, section_id: h.section_id })),
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function makeSnippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + len + SNIPPET_RADIUS);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}
