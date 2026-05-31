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
// at any position — the proper-noun semicolon list is the giveaway. Strips
// the match (and any trailing whitespace) so the surrounding text rejoins
// cleanly.
const INLINE_SPONSOR_REPRINT = /\s*Supervisors? [A-Z][A-Za-z'-]+(?:;\s+[A-Z][A-Za-z'-]+)*(?=\s|$)/g;

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
  // Collapse runs of 3+ blank lines into a paragraph break.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
