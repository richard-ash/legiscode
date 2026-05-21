// Pure field-weighted scorer for the command palette. The headline win
// is U1: typing "133" returns § 133 at the top, not buried under § 1.33
// / § 1330 / § 11.33 — the current placeholder uses
// `${num} ${name} ${path}`.toLowerCase().includes(q)` and silently
// orders the (random!) input.
//
// Three Codex amendments make the scorer correct rather than vaguely
// better:
//
//   - F1 numCanonical: strip `§` and all whitespace from both the
//     item's `num` and the user's query before comparing, so "133"
//     matches "§ 133" exactly (not just as a substring of "§ 1330").
//
//   - F3 case folding: defined-term `:def` mode lower-cases both
//     `term` and the query before matching, but the original
//     non-folded `term` is what the row renderer displays.
//
//   - F7 filter-before-sort: items with score 0 (no match anywhere)
//     are dropped before the sort runs, so sort cost is bounded by
//     match count, not corpus size. At 5-10× SF scale this is the
//     difference between "feels instant" and "noticeable lag."
//
// Position-aware substring: substring matches whose `q` lands earlier
// in the field rank higher than later matches in the same field. The
// position penalty is small (1 point per char) so it refines order
// within a field band without ever flipping a `prefix` win over a
// `substring` win in a higher-weight field.

import type { SectionId } from "@/types";

/**
 * One row in the search-able corpus. Built once by the hook (memoized
 * on `corpus`) so the scorer stays a pure synchronous transform — the
 * canonical / lower-cased fields are pre-computed off the hot path.
 */
export type SearchableItem =
  | {
      kind: "section";
      moduleId: string;
      sectionId: string;
      /** Display string from the tree, e.g. "§ 1.01" or "§ 109.0". */
      num: string;
      /** Display name from the tree, e.g. "Definitions". */
      name: string;
      /** Hierarchy path, e.g. "Port Code · ARTICLE 1". */
      path: string;
      /** `num` with `§` + all whitespace stripped and lower-cased.
       *  Lets "133" match "§ 133" exactly rather than as a substring
       *  of "§ 1330"; lets "1.01.010" match without the user typing
       *  the section sigil. */
      numCanonical: string;
      /** `name`.toLowerCase(). */
      nameLower: string;
      /** `path`.toLowerCase(). */
      pathLower: string;
    }
  | {
      kind: "defined-term";
      moduleId: string;
      /** Defining section ids — preserved verbatim so the row can
       *  navigate to the first one and show a "+N more" count when
       *  the same module defines the term in multiple sections. */
      definers: ReadonlyArray<SectionId>;
      /** Original-case term for display, e.g. "Director". */
      term: string;
      /** `term`.toLowerCase() for matching. */
      termLower: string;
    };

export type PaletteMode = "section" | "defined-term";

/**
 * Filter `items` against `q` and return ranked matches.
 *
 * Empty `q` returns the input array unchanged (mode-filtered if
 * `mode === "defined-term"`) — the open palette renders the full
 * corpus until the user types.
 *
 * Items scoring 0 are dropped BEFORE the sort runs (F7) so sort cost
 * is bounded by match count rather than corpus size. Stable sort
 * preserves original order on ties.
 */
export function rank(
  items: ReadonlyArray<SearchableItem>,
  q: string,
  mode: PaletteMode = "section",
): SearchableItem[] {
  const qLowerRaw = q.trim().toLowerCase();
  // Mode is a hard filter on `kind` — section mode shows sections,
  // defined-term mode shows defined-terms. The plan's mode-aware
  // empty-state copy ("No sections match" vs "No defined terms match")
  // depends on the kind staying single-discriminator per mode.
  const wantKind: SearchableItem["kind"] = mode === "defined-term" ? "defined-term" : "section";
  const modeFiltered = items.filter((it) => it.kind === wantKind);
  if (qLowerRaw.length === 0) return [...modeFiltered];

  const qCanonical = canonicalizeNum(qLowerRaw);
  const scored: Array<{ item: SearchableItem; score: number; idx: number }> = [];
  for (let i = 0; i < modeFiltered.length; i++) {
    const item = modeFiltered[i];
    if (!item) continue;
    const score = scoreItem(item, qLowerRaw, qCanonical, mode);
    // F7: filter score=0 BEFORE sort so the sort runs over matches only.
    if (score <= 0) continue;
    scored.push({ item, score, idx: i });
  }
  // Stable sort: ties fall back to original idx so display order is
  // deterministic across renders (and across runs of the perf test).
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return scored.map((s) => s.item);
}

/** Strip `§` and ALL whitespace, then lowercase. Used on both the
 *  item's `num` (precomputed once) and the user's query (per
 *  keystroke).
 *
 *  Drops dots too? NO — `1.01` must stay `1.01`, otherwise typing
 *  "1.01" against numCanonical "101" would false-match `§ 101`. The
 *  separators stay; only the sigil and whitespace go. */
export function canonicalizeNum(s: string): string {
  return s.toLowerCase().replace(/§/g, "").replace(/\s+/g, "");
}

function scoreItem(
  item: SearchableItem,
  qLower: string,
  qCanonical: string,
  _mode: PaletteMode,
): number {
  // `rank()` already narrowed the input to a single kind via wantKind;
  // dispatch on the item's own discriminator so the scoring math is
  // colocated with its inputs and TypeScript narrows cleanly.
  if (item.kind === "defined-term") return scoreDefinedTerm(item, qLower);
  return scoreSection(item, qLower, qCanonical);
}

function scoreSection(
  item: Extract<SearchableItem, { kind: "section" }>,
  qLower: string,
  qCanonical: string,
): number {
  let best = 0;

  // numCanonical: 1000 exact, 800 prefix, 500-pos substring.
  if (qCanonical.length > 0) {
    if (item.numCanonical === qCanonical) {
      best = Math.max(best, 1000);
    } else if (item.numCanonical.startsWith(qCanonical)) {
      best = Math.max(best, 800);
    } else {
      const i = item.numCanonical.indexOf(qCanonical);
      if (i >= 0) best = Math.max(best, 500 - i);
    }
  }

  // name: 400 exact, 300 prefix, 150-pos substring.
  if (item.nameLower === qLower) {
    best = Math.max(best, 400);
  } else if (item.nameLower.startsWith(qLower)) {
    best = Math.max(best, 300);
  } else {
    const i = item.nameLower.indexOf(qLower);
    if (i >= 0) best = Math.max(best, 150 - i);
  }

  // path: 50-pos substring. Floor at 1 so a path-only match is still
  // a match (and stays well below name's prefix at 300).
  const i = item.pathLower.indexOf(qLower);
  if (i >= 0) best = Math.max(best, Math.max(50 - i, 1));

  return best;
}

function scoreDefinedTerm(
  item: Extract<SearchableItem, { kind: "defined-term" }>,
  qLower: string,
): number {
  if (item.termLower === qLower) return 1000;
  if (item.termLower.startsWith(qLower)) return 800;
  const i = item.termLower.indexOf(qLower);
  if (i >= 0) return 500 - i;
  return 0;
}
