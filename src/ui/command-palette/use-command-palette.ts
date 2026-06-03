// State + derived-values hook for the command palette. Keeps the
// component itself a thin presentational shell: this hook owns
//
//   - open/close + ⌘P toggle state (and `q` persistence across opens),
//   - subtype-prefix detection (`:def ` strips and switches mode),
//   - `searchableItems` precompute (memoized on `corpus`),
//   - the `useDeferredValue` + `rank()` chain that feeds `results`,
//   - `isStale` so the row container can dim when an async backend
//     swap arrives in v1.1 (sync today — flickers for one frame, never
//     visible).
//
// The interface is deliberately consumer-shaped, not implementation-
// shaped — the v1.1 IPC swap (renderer scan → main-process search)
// changes the inside of this hook (request cancellation, ordering,
// error/loading states) without touching App.tsx or the component.
// That's the deep-module property the eng review called out.

import { useCallback, useDeferredValue, useMemo, useState } from "react";
import type { CorpusModuleSummary, CorpusTreeNode } from "@/corpus/wire";
import { type PaletteMode, rank, type SearchableItem } from "./score";

/** Trailing space is required so that typing `:def` mid-string (with
 *  more to come) doesn't flip mode until the user commits with a
 *  space. `:de` and `:def` alone should not trigger; only `:def ` does. */
export const DEFINED_TERM_PREFIX = ":def ";

/** Empty-state cap: when the user opens the palette with no query (or
 *  deletes back to empty), show this many rows instead of the full
 *  corpus. Scrolling 11k sections without a search target is noise; a
 *  short preview is a tighter affordance to "start typing." Once any
 *  token is entered, the cap releases and the full ranked set shows
 *  (the AND filter is what narrows from there). */
export const EMPTY_STATE_CAP = 15;

export interface UseCommandPaletteResult {
  open: boolean;
  /** Live query — persists across `close()` and re-opens. */
  q: string;
  /** Active mode, derived from `q`. Default `"section"`; flips to
   *  `"defined-term"` when `q.startsWith(":def ")`. */
  mode: PaletteMode;
  /** Ranked items for the current deferred query. May be one keystroke
   *  behind `q` while a slow render catches up — `isStale` is true
   *  in that window. */
  results: SearchableItem[];
  /** True when `q` is ahead of the deferred value (or, post-v1.1,
   *  while an async backend search is in flight). Exposed for the row
   *  container to dim when latency creeps above one frame. */
  isStale: boolean;
  setQ: (q: string) => void;
  /** ⌘P toggle — flips `open`, preserves `q`. */
  toggle: () => void;
  /** Esc / scrim — flips `open` to false, preserves `q`. */
  close: () => void;
}

export function useCommandPalette(corpus: CorpusModuleSummary | null): UseCommandPaletteResult {
  const [open, setOpen] = useState(false);
  // `q` lives at the hook level so closing + reopening the palette
  // preserves the search — matches VS Code's ⌘P semantics ("I peeked
  // away; my search is still here").
  const [q, setQRaw] = useState("");

  const setQ = useCallback((next: string) => {
    setQRaw(next);
  }, []);
  const toggle = useCallback(() => {
    setOpen((o) => !o);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Precompute search-able items once per corpus. The hot path (rank)
  // sees only pre-lowered + pre-canonicalized strings; per-keystroke
  // string normalization is bounded by corpus size, not query rate.
  const searchableItems = useMemo<SearchableItem[]>(() => {
    if (!corpus) return [];
    return buildSearchableItems(corpus);
  }, [corpus]);

  // Detect subtype mode and strip the prefix BEFORE the deferred
  // wrap, so deferred-q flips mode + content in lockstep. Otherwise
  // the deferred query could lag the mode flag and rank the wrong
  // items for one frame.
  const { mode, strippedQ } = useMemo(() => parseQuery(q), [q]);
  const deferredQ = useDeferredValue(strippedQ);
  const deferredMode = useDeferredValue(mode);
  const ranked = useMemo(
    () => rank(searchableItems, deferredQ, deferredMode),
    [searchableItems, deferredQ, deferredMode],
  );
  // Empty-state cap operates on the DEFERRED q so the cap releases in
  // lockstep with the ranked output (otherwise typing a character could
  // cap the previous frame's full results, or vice versa).
  const results = useMemo(
    () => (deferredQ.trim().length === 0 ? ranked.slice(0, EMPTY_STATE_CAP) : ranked),
    [ranked, deferredQ],
  );
  // isStale: true while React hasn't caught up to the latest `q` yet.
  // Sync today (one frame) — visible only when v1.1 swaps in an async
  // backend (request cancellation pushes the deferred lag into the
  // hundreds of ms).
  const isStale = deferredQ !== strippedQ || deferredMode !== mode;

  return {
    open,
    q,
    mode,
    results,
    isStale,
    setQ,
    toggle,
    close,
  };
}

/** Strip the `:def ` prefix (with trailing space) and report the
 *  active mode. `:de` and bare `:def` are literal text — the prefix
 *  only "commits" when the user types the trailing space, which
 *  prevents flicker while the prefix is being typed. */
function parseQuery(raw: string): { mode: PaletteMode; strippedQ: string } {
  if (raw.startsWith(DEFINED_TERM_PREFIX)) {
    return { mode: "defined-term", strippedQ: raw.slice(DEFINED_TERM_PREFIX.length) };
  }
  return { mode: "section", strippedQ: raw };
}

/** Walk the corpus tree and the aggregated definitions into the
 *  flat `SearchableItem[]` shape the scorer consumes. Built once per
 *  corpus snapshot; the per-item precomputed fields move all the
 *  string normalization off the typing hot path. */
function buildSearchableItems(corpus: CorpusModuleSummary): SearchableItem[] {
  const out: SearchableItem[] = [];

  // Sections from the tree — same walk the placeholder used, but the
  // item shape carries precomputed numCanonical + lower-cased fields.
  const walk = (node: CorpusTreeNode, path: string[]): void => {
    if (node.kind === "section" && node.ref) {
      const num = node.code;
      const name = node.name;
      const pathStr = path.join(" · ");
      out.push({
        kind: "section",
        moduleId: node.ref.moduleId,
        sectionId: node.ref.sectionId,
        num,
        name,
        path: pathStr,
        numCanonical: num.toLowerCase().replace(/§/g, "").replace(/\s+/g, ""),
        nameLower: name.toLowerCase(),
        pathLower: pathStr.toLowerCase(),
      });
      return;
    }
    const nextPath = [...path, node.code];
    for (const k of node.kids ?? []) walk(k, nextPath);
  };
  for (const n of corpus.tree) walk(n, []);

  // Defined-term rows — already aggregated per-(term, moduleId) at
  // load time by the corpus loader. One row per pair; intra-module
  // duplicates collapse via the `definers[]` length count surfaced
  // as "+N more" in the row renderer.
  for (const def of corpus.definitions) {
    out.push({
      kind: "defined-term",
      moduleId: def.moduleId,
      term: def.term,
      termLower: def.term.toLowerCase(),
      definers: def.definers,
    });
  }

  return out;
}
