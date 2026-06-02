// Italic-detection + SF NOTE-block validator. Layer 3's classifier
// relies on Times New Roman Italic being the universal "amendment"
// marker — both insertions and deletions share that font in
// SF Legistar redlines. The deeper distinction (underline = insert,
// strikethrough = delete) comes from `classify-spans.ts` overlaying
// graphics-op decoration against text-run baselines.
//
// validateSfNoteBlock guards Class A bills against silently parsing
// when SF Legistar swaps in a non-standard convention; absent the
// expected NOTE phrases the whole bill cascades to manual_review.

import type { FontMetadata } from "@/parser/pdf/page-extractor";

/** True if pdfjs's font dictionary marks the font as italic. */
export function isItalicFont(meta: FontMetadata | undefined): boolean {
  if (meta === undefined) return false;
  return meta.italic;
}

/** True if pdfjs's font dictionary marks the font as bold. */
export function isBoldFont(meta: FontMetadata | undefined): boolean {
  if (meta === undefined) return false;
  return meta.bold;
}

/**
 * True if the font is a Times New Roman family member. The renderer
 * uses Times only for amendment-class text in SF Legistar bills; Arial
 * is used for context prose and board-amendment-class text.
 *
 * Fall back to the pdfjs alias (`g_d0_fN`) when the PostScript name is
 * absent — those aliases are stable across a single document but
 * carry no semantic info, so the caller's confidence drops.
 */
export function isTimesFont(meta: FontMetadata | undefined): boolean {
  if (meta === undefined) return false;
  return /times|tnr/i.test(meta.name);
}

export type NoteBlockValidation = { ok: true; matched: string } | { ok: false; reason: string };

// Phrases the SF Legistar boilerplate NOTE block always contains. Word
// breaks are tolerant (`\s+`) so PDF reflow doesn't trip the matcher.
// The three font-role phrases are non-negotiable; the asterisk-elision
// phrase is informative but not enforced (some bills truncate the
// sentence after rendering).
const NOTE_PHRASES: { re: RegExp; label: string }[] = [
  {
    re: /Unchanged\s+Code\s+text[^.]*plain\s+Arial\s+font/i,
    label: "context phrase (plain Arial)",
  },
  {
    re: /Additions\s+to\s+Codes[^.]*single-underline\s+italics\s+Times\s+New\s+Roman\s+font/i,
    label: "insert phrase (single-underline italics Times New Roman)",
  },
  {
    re: /Deletions\s+to\s+Codes[^.]*strikethrough\s+italics\s+Times\s+New\s+Roman\s+font/i,
    label: "delete phrase (strikethrough italics Times New Roman)",
  },
];

/**
 * Validate the SF Legistar redline NOTE block against the canonical
 * convention. Pass it the cleaned text of the bill's first 2-3 pages
 * (the NOTE block always appears in the preamble, on the title page or
 * page 2).
 *
 * The validator is tolerant of internal whitespace but strict about
 * the three font-role phrases — any one missing means the bill encodes
 * amendments under unknown rules and the classifier should not guess.
 */
export function validateSfNoteBlock(text: string): NoteBlockValidation {
  // Collapse runs of whitespace so PDF reflow doesn't desync the regexes.
  const normalized = text.replace(/\s+/g, " ");
  const missing: string[] = [];
  for (const { re, label } of NOTE_PHRASES) {
    if (!re.test(normalized)) missing.push(label);
  }
  if (missing.length > 0) {
    return { ok: false, reason: `NOTE block missing: ${missing.join("; ")}` };
  }
  return { ok: true, matched: "SF Legistar NOTE block" };
}
