// Display-label-to-path-segment transformer. Used by parse-html.ts to
// compute hierarchy_slugs, which sync-corpus.ts then joins to form the
// section file path. Deterministic: same label always produces same slug,
// regardless of OS or locale.
//
// Algorithm:
//   1. NFKD normalize so accented characters split into base + combining mark
//   2. strip combining marks (Unicode category Mn) so "É" → "E"
//   3. lowercase
//   4. replace any whitespace, punctuation, or filesystem-reserved character
//      with a single hyphen — this is the broad "anything not alnum" rule,
//      narrowed only by the explicit allow-list of [a-z0-9]
//   5. collapse consecutive hyphens
//   6. strip leading/trailing hyphens
//   7. suffix "-x" if the result is a Windows reserved device name — those
//      paths cannot be created on Windows, so module artifacts built on
//      Linux CI would fail extraction by Windows users
//
// Throws on empty result (e.g. label was all punctuation).

const COMBINING_MARK = /\p{M}/gu;
const NON_ALNUM = /[^a-z0-9]+/g;
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function slugify(label: string): string {
  const decomposed = label.normalize("NFKD").replace(COMBINING_MARK, "");
  const lowered = decomposed.toLowerCase();
  const hyphenated = lowered.replace(NON_ALNUM, "-");
  const trimmed = hyphenated.replace(/^-+|-+$/g, "");
  if (trimmed.length === 0) {
    throw new Error(`slugify: label "${label}" produced empty slug`);
  }
  if (WINDOWS_RESERVED.has(trimmed)) {
    return `${trimmed}-x`;
  }
  return trimmed;
}
