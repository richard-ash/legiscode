// Content-aware smoothing for PDF-reconstructed section text. The
// per-run whitespace emitter (`emit-structural-whitespace.ts`) decides
// "line wrap" vs "paragraph break" from y-deltas; on SF Legistar PDFs
// whose body line spacing happens to exceed the 22pt threshold, every
// visual line wrap is wrongly promoted to a paragraph break. That
// over-fragments definition sections into one-line "paragraphs", with
// trailing-fragment lines starting with "," or "and" or lowercase
// continuation words. Tuning the y-threshold per-bill is whack-a-mole
// (every PDF has slightly different metrics, and a tweak for bill X
// breaks bill Y). Content-aware merge is robust where geometric
// thresholds are not: keep "\n" only when the previous line ends with
// a sentence terminator; otherwise the break is a wrap artifact.
//
// Also drops single-capital-letter alphabet sub-group headers that
// appear in alphabetically-organized definition sections — those are
// PDF visual organizers, not legal structure, and the surrounding
// definitions already self-identify by their quoted defined term.
//
// Runs immediately after `collapseStructuralWhitespace`. Order matters:
// collapse first reduces `\n   \n` to `\n` so this pass can reason
// about lines cleanly.

// Sentence terminator at end of line: . ! ? : optionally followed by a
// closing quote (straight or smart) or close paren. Matches conservatively
// — false negatives mean a real paragraph break gets merged (minor visual
// glitch), false positives mean a wrap-induced break is kept (the bug we
// are fixing). Bias toward precision: require an actual terminator.
const SENTENCE_TERMINATOR = /[.!?:]["'”’)\]]?$/;

// Lines that are exactly one uppercase letter, optionally surrounded by
// whitespace. Alphabet section headers ("A", "B", "C"...) in definition
// blocks. Single digits intentionally NOT dropped — "1" alone could be
// the start of a numbered list, and that has semantic meaning.
const ALPHA_HEADER = /^\s*[A-Z]\s*$/;

// Leading punctuation on the next line means "don't insert a join space"
// — joining "Procedures Manual" + ", as amended" should produce
// "Procedures Manual, as amended" not "Procedures Manual , as amended".
const NEXT_LINE_LEADS_WITH_PUNCT = /^[,.;:!?)\]]/;

/**
 * Drop alphabet headers and merge wrap-induced paragraph breaks.
 *
 * Operates on the post-`collapseStructuralWhitespace` text where every
 * vertical break is a single `\n`. The output preserves real paragraph
 * structure (every break follows a terminating sentence) and removes
 * artifacts (single-letter headers, wrap-promoted breaks).
 *
 * Pure string-in / string-out — no PDF metrics, no schema awareness.
 * Safe to compose with the existing whitespace normalization pipeline.
 */
export function smoothReconstructedText(text: string): string {
  if (text.length === 0) return text;

  const lines = text.split("\n");

  // Pass 1 — drop alphabet header lines entirely. They contribute no
  // legal content; the surrounding definitions are already self-titled.
  const filtered: string[] = [];
  for (const line of lines) {
    if (ALPHA_HEADER.test(line)) continue;
    filtered.push(line);
  }

  // Pass 2 — merge continuation lines into the previous line. A line is
  // a "continuation" when the previous emitted line does NOT end with a
  // sentence terminator. Empty lines reset the merge state (treat as
  // explicit blank paragraph boundary).
  const merged: string[] = [];
  for (const raw of filtered) {
    if (merged.length === 0) {
      merged.push(raw);
      continue;
    }
    const prev = merged[merged.length - 1] ?? "";
    const prevTrimmed = prev.trimEnd();

    if (prevTrimmed.length === 0 || SENTENCE_TERMINATOR.test(prevTrimmed)) {
      merged.push(raw);
      continue;
    }

    const nextTrimmed = raw.trimStart();
    if (nextTrimmed.length === 0) {
      merged.push(raw);
      continue;
    }

    const joiner = NEXT_LINE_LEADS_WITH_PUNCT.test(nextTrimmed) ? "" : " ";
    merged[merged.length - 1] = prevTrimmed + joiner + nextTrimmed;
  }

  return merged.join("\n");
}
