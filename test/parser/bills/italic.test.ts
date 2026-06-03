import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBoldFont, isItalicFont, isTimesFont, validateSfNoteBlock } from "@/parser/bills/italic";
import { loadPdfBuffer } from "@/parser/pdf/load";
import { extractFontMetadata, extractTextRuns, runsToText } from "@/parser/pdf/page-extractor";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BILLS_FIXTURE = join(REPO_ROOT, "test", "fixtures", "sf", "bills");

describe("isItalicFont / isBoldFont / isTimesFont", () => {
  it("returns false for undefined metadata", () => {
    expect(isItalicFont(undefined)).toBe(false);
    expect(isBoldFont(undefined)).toBe(false);
    expect(isTimesFont(undefined)).toBe(false);
  });

  it("isItalicFont returns the metadata's italic flag verbatim", () => {
    expect(isItalicFont({ name: "TimesNewRomanPS-ItalicMT", italic: true, bold: false })).toBe(
      true,
    );
    expect(isItalicFont({ name: "ArialMT", italic: false, bold: false })).toBe(false);
  });

  it("isBoldFont returns the metadata's bold flag verbatim", () => {
    expect(isBoldFont({ name: "Arial-BoldMT", italic: false, bold: true })).toBe(true);
    expect(isBoldFont({ name: "ArialMT", italic: false, bold: false })).toBe(false);
  });

  it("isTimesFont matches Times-family names case-insensitively", () => {
    expect(isTimesFont({ name: "TimesNewRomanPS-ItalicMT", italic: true, bold: false })).toBe(true);
    expect(isTimesFont({ name: "Times-Roman", italic: false, bold: false })).toBe(true);
    expect(isTimesFont({ name: "TNR-Italic", italic: true, bold: false })).toBe(true);
    expect(isTimesFont({ name: "ArialMT", italic: false, bold: false })).toBe(false);
    expect(isTimesFont({ name: "", italic: false, bold: false })).toBe(false);
  });
});

describe("validateSfNoteBlock", () => {
  const canonical =
    "NOTE: Unchanged Code text and uncodified text are in plain Arial font. " +
    "Additions to Codes are in single-underline italics Times New Roman font. " +
    "Deletions to Codes are in strikethrough italics Times New Roman font. " +
    "Board amendment additions are in double-underlined Arial font. " +
    "Board amendment deletions are in strikethrough Arial font. " +
    "Asterisks (* * * *) indicate the omission of unchanged Code subsections or parts of tables.";

  it("accepts the canonical SF Legistar NOTE block", () => {
    const result = validateSfNoteBlock(canonical);
    expect(result.ok).toBe(true);
  });

  it("tolerates internal whitespace runs (PDF reflow)", () => {
    const reflowed = canonical.replace(/\s+/g, "\n\t  ");
    const result = validateSfNoteBlock(reflowed);
    expect(result.ok).toBe(true);
  });

  it("rejects when the context phrase is missing", () => {
    const result = validateSfNoteBlock(canonical.replace(/Unchanged.*?Arial font\.\s*/i, ""));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/context phrase/i);
  });

  it("rejects when the insert phrase is missing", () => {
    const result = validateSfNoteBlock(
      canonical.replace(/Additions.*?Times New Roman font\.\s*/i, ""),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/insert phrase/i);
  });

  it("rejects when the delete phrase is missing", () => {
    const result = validateSfNoteBlock(
      canonical.replace(/Deletions.*?Times New Roman font\.\s*/i, ""),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/delete phrase/i);
  });

  it("rejects empty text", () => {
    const result = validateSfNoteBlock("");
    expect(result.ok).toBe(false);
  });
});

describe("extractFontMetadata against fixture PDFs", () => {
  it("260217.pdf surfaces a Times-Italic font flagged as italic", async () => {
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const loaded = await loadPdfBuffer(new Uint8Array(bytes));
    try {
      const meta = await extractFontMetadata(loaded.doc);
      const entries = [...meta.values()];
      const italicTimes = entries.find((m) => isItalicFont(m) && isTimesFont(m));
      expect(italicTimes).toBeDefined();
      // Arial regular shows up as the context font; ensure we detect it
      // as non-italic.
      const arial = entries.find(
        (m) => /arial/i.test(m.name) && !isBoldFont(m) && !isItalicFont(m),
      );
      expect(arial).toBeDefined();
    } finally {
      await loaded.destroy();
    }
  }, 60_000);

  it("each fixture's preamble contains a passing SF NOTE block", async () => {
    // Cascading manual_review is only triggered when the NOTE block is
    // absent — every committed fixture should pass.
    const fixtures = ["260217.pdf", "260544.pdf", "260545.pdf", "260296.pdf"];
    for (const f of fixtures) {
      const bytes = await readFile(join(BILLS_FIXTURE, f));
      const loaded = await loadPdfBuffer(new Uint8Array(bytes));
      try {
        const runs = await extractTextRuns(loaded.doc);
        // The NOTE block lives in the first ~3 pages.
        const preamble = runsToText(runs.filter((r) => r.page <= 3));
        const result = validateSfNoteBlock(preamble);
        expect(result.ok, `${f}: ${(result as { reason?: string }).reason ?? ""}`).toBe(true);
      } finally {
        await loaded.destroy();
      }
    }
  }, 60_000);
});
