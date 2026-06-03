// Shared recognition layer — the reusable primitive both defined-term
// tagging and citation tiling consume. Owns three things:
//
//   1. The `Span` model — the position-bearing primary annotations that
//      tile a section's normalized `text`.
//   2. The glossary recognizer — a per-module, case-sensitive,
//      longest-match trie over every defined term, plus the
//      capitalised-extent guard that suppresses a name highlighted
//      inside a longer proper name.
//   3. The overlap arbiter — one tiler that resolves citation/term
//      overlaps (citation wins) and passes structural tokens through.
//
// THE CENTRAL INVERSION: the glossary recognises, capitalisation
// guards. The dictionary trie — not a capitalisation
// grammar — is the recognizer, so the 8.7% of defined terms that are
// lower-case ("fiscal year", "affordable housing") survive as ordinary
// dictionary entries matched verbatim. Matching is case-sensitive (each
// term at its defined case): "any case" matching would newly tag generic
// lower-case prose and break resolve-definition's exact-term keying.
//
// Lives in its own module (not buried in build-body-segments.ts) so the
// Span model + recognizer + arbiter are reusable — they feed the
// find_definition surface later.

import type { DefinitionId } from "@/types";

// A primary annotation — the non-format spans that tile `text`. Gaps
// between primaries become `text` segments at emit time. defined_term
// spans start with just `term` (from the recognizer); the per-occurrence
// resolver pass attaches def_id + raw, or drops the span to a text gap
// when unresolved or self-suppressed.
export type Span =
  | { kind: "citation"; start: number; end: number; raw: string; citation_index: number }
  | {
      kind: "defined_term";
      start: number;
      end: number;
      term: string;
      def_id?: DefinitionId;
      raw?: string;
      candidates_dropped?: DefinitionId[];
    }
  | { kind: "subsection_label"; start: number; end: number; label: string }
  | { kind: "paragraph_break"; start: number; end: number };

// ─── Word-boundary helpers (JS \b semantics) ───────────────────────────────

function isWordCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

function isAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isUpperCode(code: number): boolean {
  return code >= 65 && code <= 90;
}

// True iff position p sits on a word boundary — exactly JS RegExp \b: one
// side is a word char and the other is not (string edges count as
// non-word). Used to gate trie matches so "Person" never tags inside
// "Personal".
function isWordBoundary(text: string, p: number): boolean {
  const before = p > 0 ? isWordCharCode(text.charCodeAt(p - 1)) : false;
  const after = p < text.length ? isWordCharCode(text.charCodeAt(p)) : false;
  return before !== after;
}

// ─── Capitalised-extent guard (the ① fix) ──────────────────────────────────
//
// For a glossary hit M, compute the maximal capitalised proper-noun
// extent E containing M and grow it in BOTH directions:
//   - the next Capitalized word extends E (adjacency);
//   - `of` / `of the` followed by a Capital is a bridge;
//   - `and` is a wall (stops extension);
//   - a possessive `'s` does not merge two capitals — it stops
//     extension because there is no whitespace before it.
//
// The leftward walk also refuses common English determiners ("The",
// "A", "An", "This", "That", "These", "Those") even when they appear
// Capitalized: they are sentence-initial grammar, not proper-noun
// fragments. Without this wall, "The Commission shall act" would lose
// its Commission tag to a "The Commission" extent. The rightward walk
// does not need the same wall — sentence-initial determiners only
// precede the proper noun, never trail it.
//
// The guard only ever runs around a real dictionary hit, so a
// sentence-initial capital that isn't a term is never examined. A
// lower-case term has no capitalised extent, so the guard never fires on
// it — that is exactly how the lower-case 8.7% is preserved.

const SPACE = 32; // ' '
const TAB = 9; // '\t'

function isInlineSpace(code: number): boolean {
  // Newline deliberately excluded: a paragraph break ends a proper-noun
  // extent. Only spaces/tabs bridge words.
  return code === SPACE || code === TAB;
}

// Common English determiners that appear Capitalized only because they
// open a sentence. Refuse them in the leftward walk so "The Commission
// shall act" keeps its Commission tag instead of growing the extent to
// the determiner.
const LEFTWARD_DETERMINER_WALL = new Set(["The", "A", "An", "This", "That", "These", "Those"]);

// Given `pos` = the end offset of a Capitalized word, return the end
// offset of the maximal capitalised proper-noun extent beginning at that
// word. Returns `pos` unchanged when the extent does not grow.
export function capitalizedExtentEnd(text: string, pos: number): number {
  const n = text.length;
  let end = pos;
  for (;;) {
    // Require at least one inline-space separator before the next word.
    let p = end;
    while (p < n && isInlineSpace(text.charCodeAt(p))) p++;
    if (p === end || p >= n) break;

    // Read the next letter token.
    let q = p;
    while (q < n && isAlphaCode(text.charCodeAt(q))) q++;
    if (q === p) break; // punctuation/digit — stop

    if (isUpperCode(text.charCodeAt(p))) {
      // Adjacency: a Capitalized word extends the extent.
      end = q;
      continue;
    }

    // Lower-case token: only `of` / `of the` (followed by a Capital)
    // bridges; `and` is a wall; anything else stops.
    const word = text.slice(p, q);
    if (word !== "of") break;

    // After `of`, an optional `the`, then a required Capitalized word.
    let r = q;
    while (r < n && isInlineSpace(text.charCodeAt(r))) r++;
    let s = r;
    while (s < n && isAlphaCode(text.charCodeAt(s))) s++;
    if (s === r) break;
    if (text.slice(r, s) === "the") {
      // `of the` — advance past `the` to the next word.
      let t = s;
      while (t < n && isInlineSpace(text.charCodeAt(t))) t++;
      let u = t;
      while (u < n && isAlphaCode(text.charCodeAt(u))) u++;
      if (u > t && isUpperCode(text.charCodeAt(t))) {
        end = u;
        continue;
      }
      break;
    }
    // `of <Capital>` directly.
    if (isUpperCode(text.charCodeAt(r))) {
      end = s;
      continue;
    }
    break;
  }
  return end;
}

// Given `pos` = the start offset of a Capitalized word, return the
// start offset of the maximal capitalised proper-noun extent ending at
// that word. Mirror of capitalizedExtentEnd: adjacency, `of`/`of the`
// bridge, `and`-wall, but additionally refuses LEFTWARD_DETERMINER_WALL
// words because a sentence-initial determiner ("The Commission") is
// not part of the proper-noun extent.
export function capitalizedExtentStart(text: string, pos: number): number {
  let start = pos;
  for (;;) {
    // Skip inline-spaces backward to find the end of the previous word.
    let p = start;
    while (p > 0 && isInlineSpace(text.charCodeAt(p - 1))) p--;
    if (p === start || p === 0) break;

    // Read the previous letter token (walk back over alphas).
    let q = p;
    while (q > 0 && isAlphaCode(text.charCodeAt(q - 1))) q--;
    if (q === p) break; // punctuation/digit — stop

    if (isUpperCode(text.charCodeAt(q))) {
      // Adjacency: a Capitalized word extends the extent — unless it is
      // a determiner that only Capitalized because it opens a sentence.
      if (LEFTWARD_DETERMINER_WALL.has(text.slice(q, p))) break;
      start = q;
      continue;
    }

    // Lower-case token: only `of` (directly + Capital) or `the` (with
    // an `of` before it + Capital) bridges. Mirror of the rightward
    // `of` / `of the` logic.
    const word = text.slice(q, p);
    if (word === "of") {
      // Look for the Capital word BEFORE `of`.
      let r = q;
      while (r > 0 && isInlineSpace(text.charCodeAt(r - 1))) r--;
      let s = r;
      while (s > 0 && isAlphaCode(text.charCodeAt(s - 1))) s--;
      if (s < r && isUpperCode(text.charCodeAt(s))) {
        if (LEFTWARD_DETERMINER_WALL.has(text.slice(s, r))) break;
        start = s;
        continue;
      }
      break;
    }
    if (word === "the") {
      // `the` only bridges as the tail of `of the`. Look for `of` before
      // `the`, then a Capital word before `of`.
      let r = q;
      while (r > 0 && isInlineSpace(text.charCodeAt(r - 1))) r--;
      let s = r;
      while (s > 0 && isAlphaCode(text.charCodeAt(s - 1))) s--;
      if (s < r && text.slice(s, r) === "of") {
        let t = s;
        while (t > 0 && isInlineSpace(text.charCodeAt(t - 1))) t--;
        let u = t;
        while (u > 0 && isAlphaCode(text.charCodeAt(u - 1))) u--;
        if (u < t && isUpperCode(text.charCodeAt(u))) {
          if (LEFTWARD_DETERMINER_WALL.has(text.slice(u, t))) break;
          start = u;
          continue;
        }
      }
      break;
    }
    break;
  }
  return start;
}

// ─── Glossary recognizer (case-sensitive longest-match trie) ────────────────

interface TrieNode {
  children: Map<number, TrieNode>;
  terminal: boolean;
}

function newNode(): TrieNode {
  return { children: new Map(), terminal: false };
}

export interface GlossaryRecognizer {
  /**
   * Scan `text` and return non-overlapping defined_term spans, longest
   * match first, with the capitalised-extent guard already applied
   * (inside-name hits suppressed). Case-sensitive: a term matches only at
   * its defined case.
   */
  recognizeTerms(text: string): Span[];
  /** Exact-membership test (case-sensitive) the guard uses. */
  has(term: string): boolean;
}

// Build the per-module recognizer once and reuse it across every section
// in the build — do NOT rebuild per section. Terms are inserted at their
// defined case; the trie is keyed on UTF-16 code units, which is
// sufficient for the corpus's term inventory and avoids a code-point
// iteration cost on the hot build path.
export function buildGlossaryRecognizer(terms: Iterable<string>): GlossaryRecognizer {
  const root = newNode();
  for (const term of terms) {
    if (!term) continue;
    let node = root;
    for (let i = 0; i < term.length; i++) {
      const code = term.charCodeAt(i);
      let next = node.children.get(code);
      if (!next) {
        next = newNode();
        node.children.set(code, next);
      }
      node = next;
    }
    node.terminal = true;
  }

  function has(term: string): boolean {
    let node = root;
    for (let i = 0; i < term.length; i++) {
      const next = node.children.get(term.charCodeAt(i));
      if (!next) return false;
      node = next;
    }
    return node.terminal;
  }

  function guardSuppresses(text: string, start: number, end: number): boolean {
    // Lower-case terms have no capitalised extent — never suppressed.
    if (!isUpperCode(text.charCodeAt(start))) return false;
    const extentEnd = capitalizedExtentEnd(text, end);
    const extentStart = capitalizedExtentStart(text, start);
    // Extent equals the match in both directions — a standalone name.
    if (extentStart === start && extentEnd === end) return false;
    // The whole extent being itself a defined term means the trie's
    // longest match should win; don't suppress.
    if (has(text.slice(extentStart, extentEnd))) return false;
    return true;
  }

  function recognizeTerms(text: string): Span[] {
    const spans: Span[] = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      // Longest match starting at i (case-sensitive, boundary-gated).
      let node = root;
      let j = i;
      let bestEnd = -1;
      const leftBoundary = isWordBoundary(text, i);
      while (j < n) {
        const next = node.children.get(text.charCodeAt(j));
        if (!next) break;
        node = next;
        j++;
        if (next.terminal && leftBoundary && isWordBoundary(text, j)) {
          bestEnd = j;
        }
      }
      if (bestEnd > i) {
        if (!guardSuppresses(text, i, bestEnd)) {
          spans.push({
            kind: "defined_term",
            start: i,
            end: bestEnd,
            term: text.slice(i, bestEnd),
          });
        }
        // Advance past the matched name whether or not it was suppressed:
        // a suppressed head ("Department") must not re-tag a sub-part of
        // itself. Inner words of a longer name are reached on the next
        // scan step, preserving today's inner-word behavior.
        i = bestEnd;
      } else {
        i++;
      }
    }
    return spans;
  }

  return { recognizeTerms, has };
}

// ─── Overlap arbiter ────────────────────────────────────────────────────────
//
// One tiler for the whole section. Term spans (from the recognizer)
// and citation spans (from the citation extractor) are each internally
// non-overlapping; the only real contest is citation vs defined_term,
// resolved strictly in citation's favor. subsection_label and
// paragraph_break are positional and don't overlap primaries in
// practice; a contained overlap drops the inner span.
//
// citation_index integrity: a citation always outranks a defined_term,
// so a defined_term never displaces a citation — the citation's body
// span stays in sync with its citations[] index. (Two citations that
// overlap each other resolve by start order, dropping the later one;
// that only arises when a module declares multiple citation_patterns
// whose matches collide. SF declares a single pattern, so its matches
// never overlap.)
export function arbitrate(spans: readonly Span[]): Span[] {
  // Sort by start ascending; on tie, the longer span first (a citation is
  // usually longer than a defined_term covering the same head).
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (!last || last.end <= span.start) {
      out.push(span);
      continue;
    }
    // Overlap with `last`.
    if (last.kind === "citation") {
      // Citation already won this range; drop the overlapping span.
      continue;
    }
    if (span.kind === "citation" && last.kind === "defined_term") {
      // Citation outranks defined_term — replace.
      out[out.length - 1] = span;
      continue;
    }
    if (last.kind === "defined_term" && span.kind === "defined_term") {
      // Two term spans overlap (only possible across recognizer + caller
      // merges): keep the longer/earlier already in place, drop this one.
      continue;
    }
    // subsection_label / paragraph_break vs anything: drop only when fully
    // contained; otherwise pass through (positions don't trim).
    if (span.start >= last.start && span.end <= last.end) continue;
    out.push(span);
  }
  return out;
}
