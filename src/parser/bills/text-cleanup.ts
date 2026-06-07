import { stripChromeWithOffsets } from "./run-offset-map";

// PDF text cleanup pass for SF Legistar ordinance PDFs.
//
// `pdfjs` returns positioned text runs that include page chrome — line
// numbers down the left margin (always 1–25 in SF's template), the
// sponsor reprint at the top of each page, the "BOARD OF SUPERVISORS
// Page N" footer, the "FILE NO. NNNNNN  ORDINANCE NO." header, and the
// boilerplate typography legend that introduces every ordinance. None
// of it is the ordinance content; all of it interrupts the readable
// flow.
//
// This pass strips those known artifacts. It's deliberately conservative
// — it removes lines we recognize, never lines we don't. The classes of
// noise are:
//   1. PDF page-margin line numbers (1..25, each on its own line)
//   2. Page-footer "BOARD OF SUPERVISORS  Page N"
//   3. Page-header "FILE NO. NNNNNN  ORDINANCE NO."
//   4. Sponsor reprint "Supervisors X; Y" between pages
//   5. The 7-line typography legend (same on every SF ordinance)
//
// When new ordinance template variants surface (different jurisdictions,
// Legistar updates), extend the strip-list rather than reaching for
// regex permissiveness. The principle: if the parser doesn't know the
// pattern, it leaves the text alone.

// Structural-marker line patterns. A line matching any of these starts a
// new paragraph during reflow — even when the source PDF has no blank
// line before it. Without these breaks, the join step below would merge
// the marker into the preceding paragraph, hiding the document structure.
//
// These are deliberately narrow: bracket-titles, ordinance preamble
// phrases, AMEND ordinance-section lines, nested SEC. headers, paren
// subsection markers, and the signature-block opener. Any line shape we
// don't recognise stays in its current paragraph.
const REFLOW_BREAK_PATTERNS: readonly RegExp[] = [
  /^\[/, // [Code - Short title] header
  /^Ordinance\s+(?:amending|adopting|repealing|enacting|making|approving|authorizing)\b/,
  /^Be it ordained\b/,
  /^Section\s+\d+[A-Z]?\./, // Section 1. / Section 2A.
  /^(?:SEC\.|SECTION)\s+\d/, // SEC. 407. / SECTION 12
  /^\([a-z]+\)\s/, // (a) (b) (c) ...
  /^\(\d+\)\s/, // (1) (2) ...
  /^APPROVED AS TO FORM\b/,
];

function isReflowBreak(line: string): boolean {
  const trimmed = line.trimStart();
  for (const re of REFLOW_BREAK_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// Reflow paragraph-internal single newlines (the ~80-char wrap the PDF
// extractor preserves) into spaces, while keeping structural markers on
// their own paragraph boundaries.
//
// Strategy: walk the line list and INSERT a blank line before every
// structural-marker line that isn't already preceded by one. The existing
// "blank line separates paragraphs" rule then takes over — paragraphs
// are joined with spaces, blank lines stay as paragraph breaks. This
// keeps the reflow logic and the marker-detection logic separated: the
// reflow doesn't need to know which side of a marker the body sits on.
//
// Exported so the body parser can apply the same reflow rule to the
// preamble + closing slices it carves out of the chrome-stripped text.
export function reflowParagraphs(text: string): string {
  const rawLines = text.split("\n");
  const withBreaks: string[] = [];
  for (const line of rawLines) {
    if (isReflowBreak(line)) {
      const last = withBreaks.at(-1);
      if (last !== undefined && last.trim() !== "") {
        withBreaks.push("");
      }
    }
    withBreaks.push(line);
  }
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const joined = current.join(" ").replace(/\s+/g, " ").trim();
    if (joined.length > 0) paragraphs.push(joined);
    current = [];
  };
  for (const line of withBreaks) {
    if (line.trim() === "") {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return paragraphs.join("\n\n");
}

/**
 * Strip known PDF chrome from the raw text — page-margin line numbers,
 * page footers, FILE NO. headers, sponsor reprints (both standalone
 * lines and inline-merged tails), and the typography legend block.
 * Returns text with line breaks preserved (no paragraph reflow).
 *
 * Exposed separately from `cleanupOrdinanceText` so consumers that need
 * to walk the document structurally (the structural pass + body
 * parser) can operate on chrome-stripped lines without losing the
 * column-wrapped line breaks that anchor regex-based section detection.
 *
 * Thin `.text` wrapper around `stripChromeWithOffsets`. The offset-aware
 * variant is the canonical implementation; callers that need the
 * per-run offset map (the build-time anchorer) consume it directly.
 */
export function stripChrome(raw: string): string {
  // Pass a single full-range so the offsets logic runs over the whole
  // input; discard the offset map and return just the stripped text.
  return stripChromeWithOffsets(raw, [{ start: 0, end: raw.length }]).text;
}

export function cleanupOrdinanceText(raw: string): string {
  return reflowParagraphs(stripChrome(raw));
}
