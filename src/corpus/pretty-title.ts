// Title-case prettifier for ALL-CAPS legal-source titles. The parser
// (src/parser/parse-html.ts) calls this at extraction time so the
// canonical on-disk JSON ships display-cased titles; downstream code
// (loader, renderers) is pass-through. Future parsers for sources that
// emit already-cased titles simply don't call this — there is no
// runtime detection step.
//
// Strategy: per-word. Each tokenized word that contains no lowercase
// letters is treated as ALL-CAPS source and re-cased (acronym
// whitelist, small-word interior lowercase, otherwise title-case).
// Any token with at least one lowercase letter is mixed-case and
// passes through verbatim. This is what makes "(a)" inside an
// otherwise-ALL-CAPS title work: the single "a" token is preserved
// because it carries its own case information.
//
// Tokenization recognizes words that may embed periods (for acronyms
// like "U.S.") and treats hyphens / brackets / semicolons as glue.
// Apostrophes inside a word terminate the title-case token before
// them so possessives ("FARMERS'") capitalize the bare letters and
// keep the trailing apostrophe untouched.
//
// Small-word lowercase rule applies to interior tokens only — first
// and last words always capitalize, matching Chicago title-case.

/**
 * Acronyms preserved verbatim when encountered in an ALL-CAPS source.
 * The ALL-CAPS form destroys the acronym signal — "CEQA" and "CEQA"
 * (legitimate acronym vs. an over-capitalized fragment of a regular
 * word) are indistinguishable to a context-free transformer. This
 * whitelist drives the disambiguation: only entries here stay
 * uppercase; everything else gets title-cased.
 *
 * Verified by grep against sf-administrative / sf-health /
 * sf-transportation that each entry appears in real corpus titles at
 * least once. Add a new acronym only after confirming it's a real
 * usage, not a one-off bracketed gloss.
 */
export const KNOWN_ACRONYMS: ReadonlySet<string> = new Set([
  "CEQA",
  "NEPA",
  "DNA",
  "HIV",
  "AIDS",
  "SFMTA",
  "BART",
  "CCSF",
  "EIR",
  "EPA",
  "OSHA",
  "ADA",
  "LGBT",
  "LGBTQ",
  "MOU",
  "U.S.",
]);

// Articles, coordinating conjunctions, and short prepositions that lose
// initial capitalization when they appear between the first and last
// words of a title. Chicago-style; first/last words always capitalize.
const SMALL_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "or",
  "the",
  "to",
  "with",
]);

// Match a word: starts with a Unicode letter, may contain interior
// letters and periods (for "U.S."), and end with a letter or a
// trailing period (for "U.S." or "REPEALED."). Apostrophes are NOT
// included — they stop the match so possessives like "FARMERS'"
// capitalize their letters and leave the trailing apostrophe as
// glue. Unicode `\p{L}` keeps accented letters intact ("CAFÉ" stays
// one word, then locale-aware lowercase produces "café").
const WORD_RE = /\p{L}(?:[\p{L}.]*\p{L})?\.?/gu;

/**
 * Transform an ALL-CAPS title into Title Case. Per-word: tokens with
 * any lowercase letter pass through verbatim (mixed-case input is
 * preserved; section-ref letters like "(a)" survive because the "a"
 * is its own lowercase token). Tokens that are uniformly uppercase
 * are re-cased.
 *
 * Examples:
 *   "RENT LIMITATIONS"                    → "Rent Limitations"
 *   "CITY-OPERATED FARMERS' MARKETS"      → "City-Operated Farmers' Markets"
 *   "[REPEALED.]"                         → "[Repealed.]"
 *   "U.S. DEPARTMENT OF LABOR"            → "U.S. Department of Labor"
 *   "TENANT RIGHTS UNDER SECTION 37.9(a)" → "Tenant Rights Under Section 37.9(a)"
 *   "Already Cased Title"                 → "Already Cased Title"
 */
export function prettifyTitle(raw: string): string {
  // First pass: collect word-token positions so the small-word rule
  // knows which tokens are first and last in the title.
  const matches: Array<{ start: number; end: number; word: string }> = [];
  for (const m of raw.matchAll(WORD_RE)) {
    const idx = m.index;
    if (idx === undefined) continue;
    matches.push({ start: idx, end: idx + m[0].length, word: m[0] });
  }
  if (matches.length === 0) return raw;

  let out = "";
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const entry = matches[i];
    if (!entry) continue;
    out += raw.slice(cursor, entry.start);
    out += transformWord(entry.word, i === 0, i === matches.length - 1);
    cursor = entry.end;
  }
  out += raw.slice(cursor);
  return out;
}

function transformWord(word: string, isFirst: boolean, isLast: boolean): string {
  // Acronym whitelist wins regardless of position. Compare in upper
  // form so "u.s." (if it ever appears in mixed-case source) still
  // round-trips to "U.S.".
  const upper = word.toLocaleUpperCase();
  for (const acronym of KNOWN_ACRONYMS) {
    if (upper === acronym.toLocaleUpperCase()) return acronym;
  }

  // Pass-through: if the token contains any lowercase letter, the
  // source has cased this token intentionally. Section-ref letters
  // like the "a" in "(a)" land here. Mixed-case tokens like
  // "Already" / "camelCaseInput" also land here.
  if (word !== upper) return word;

  // Token is uniformly uppercase. Apply title-case rules.
  const lower = word.toLocaleLowerCase();
  if (!isFirst && !isLast && SMALL_WORDS.has(lower)) return lower;

  // Title-case: capitalize first letter. For tokens with embedded
  // periods like "U.S." — only reachable when not in the acronym
  // whitelist, e.g. an unusual lowercased input — capitalize the
  // first letter only; per-segment capitalization across periods
  // would change semantics ("u.s." → "U.s." not "U.S."), so we leave
  // any subsequent letters as their lowercased form.
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}
