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

const PAGE_LINE_NUMBER = /^\s*\d{1,2}\s*$/;
const BOARD_FOOTER = /^BOARD OF SUPERVISORS\b/;
const FILE_NO_HEADER = /^FILE NO\.\s+\d+\s+ORDINANCE NO\b/;
const SPONSOR_REPRINT = /^Supervisors? [A-Z]/;

// The 7-line legend that introduces every SF ordinance. Lines are
// matched by prefix (the PDF extractor sometimes inserts trailing
// whitespace or odd spacing inside the line, but the prefix is
// stable).
const LEGEND_PREFIXES = [
  "NOTE:",
  "Additions to Codes",
  "Deletions to Codes",
  "Board amendment additions",
  "Board amendment deletions",
  "Asterisks (",
  "subsections or parts of tables",
];

// Inline sponsor reprint pattern: occurs mid-line when the PDF extractor
// merges a page-break into the preceding sentence. Matches `Supervisors X; Y`
// or `Supervisors X, Y` at any position — the proper-noun separator list is
// the giveaway. Both `;` and `,` show up as separators in the wild
// (e.g. `Supervisors Wong; Sauter, Sherrill` in file 260544). Strips the
// match (and any leading whitespace) so the surrounding text rejoins cleanly.
const INLINE_SPONSOR_REPRINT =
  /\s*Supervisors? [A-Z][A-Za-z'-]+(?:[;,]\s+[A-Z][A-Za-z'-]+)*(?=\s|$)/g;

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
function reflowParagraphs(text: string): string {
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

export function cleanupOrdinanceText(raw: string): string {
  const stripped = raw.replace(INLINE_SPONSOR_REPRINT, "");
  const lines = stripped.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      kept.push("");
      continue;
    }
    if (PAGE_LINE_NUMBER.test(trimmed)) {
      const n = Number(trimmed);
      if (n >= 1 && n <= 25) continue;
    }
    if (BOARD_FOOTER.test(trimmed)) continue;
    if (FILE_NO_HEADER.test(trimmed)) continue;
    if (SPONSOR_REPRINT.test(trimmed)) continue;
    if (LEGEND_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    kept.push(line);
  }
  // Collapse runs of 3+ blank lines so the reflow pass sees at most one
  // blank between paragraphs.
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return reflowParagraphs(collapsed);
}
