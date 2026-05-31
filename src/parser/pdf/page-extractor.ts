// Per-page text extraction over a pdfjs document. Returns a stream of
// text runs (one per pdfjs textContent item) annotated with page number
// and font name — enough for the structural pass (regex over the text)
// and the future typography pass (font-name discriminates Roman vs
// italics in the SF redline convention).
//
// Read-only: we never mutate the underlying document; the caller owns
// its lifecycle (loadPdfBuffer → use → .destroy()).

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

export type TextRun = {
  /** 1-indexed page number for human-readable diagnostics. */
  page: number;
  /** Raw text content of the run; may contain trailing whitespace. */
  text: string;
  /**
   * The font face name pdfjs reports for this run — e.g.
   * "g_d0_f3" mapped via styles to "Times-Italic". Used by the
   * future typography decoder to discriminate insertions/deletions
   * (italic) from context (Roman).
   */
  font_name: string;
  /**
   * Whether pdfjs flagged this run as ending a line. The structural
   * regex relies on line boundaries to anchor "Section N. <Code> Code"
   * patterns.
   */
  has_eol: boolean;
};

/** Walk all pages and yield every text run in document order. */
export async function extractTextRuns(doc: PDFDocumentProxy): Promise<TextRun[]> {
  const out: TextRun[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    try {
      const content = await page.getTextContent({ includeMarkedContent: false });
      for (const item of content.items) {
        // pdfjs items are TextItem | TextMarkedContent; we only care about
        // TextItem (has .str). TextMarkedContent is structure metadata.
        if (!("str" in item)) continue;
        const fontName =
          item.fontName !== undefined && content.styles[item.fontName] !== undefined
            ? (content.styles[item.fontName]?.fontFamily ?? item.fontName)
            : (item.fontName ?? "");
        out.push({
          page: pageNum,
          text: item.str,
          font_name: fontName,
          has_eol: item.hasEOL === true,
        });
      }
    } finally {
      page.cleanup();
    }
  }
  return out;
}

/**
 * Concatenate text runs into a single string with `\n` between runs that
 * end an EOL marker, otherwise just spaces. Lossy but enough for the
 * structural-pass regex matcher (which cares about line anchors and
 * Code/Charter words, not exact spacing).
 */
export function runsToText(runs: readonly TextRun[]): string {
  const out: string[] = [];
  for (const run of runs) {
    out.push(run.text);
    if (run.has_eol) {
      out.push("\n");
    } else if (!run.text.endsWith(" ")) {
      out.push(" ");
    }
  }
  return out.join("").replace(/[ \t]+\n/g, "\n");
}

/** Lazy wrapper that also calls .cleanup() on each page after read. */
export async function* iterPages(doc: PDFDocumentProxy): AsyncGenerator<PDFPageProxy> {
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    try {
      yield page;
    } finally {
      page.cleanup();
    }
  }
}
