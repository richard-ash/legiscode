import { describe, expect, it } from "vitest";
import { cleanupOrdinanceText } from "@/parser/bills/text-cleanup";

describe("cleanupOrdinanceText — chrome stripping", () => {
  it("strips PDF page-margin line numbers (1..25)", () => {
    const input = [
      "Section 1 of the Code provides:",
      "1",
      "2",
      "3",
      "25",
      "The actual text here.",
    ].join("\n");
    // After stripping the line numbers, the two surrounding lines reflow
    // into a single paragraph — there's no structural marker between
    // them, so the reflow joins.
    expect(cleanupOrdinanceText(input)).toBe(
      "Section 1 of the Code provides: The actual text here.",
    );
  });

  it("preserves numbers >= 26 (real section numbers, not line numbers)", () => {
    const input = ["SEC. 407.", "26", "100", "407", "Body text."].join("\n");
    // 26, 100, 407 are NOT chrome — they survive the strip pass. Reflow
    // then joins them with the surrounding text into one paragraph
    // (no marker breaks them apart from "Body text.").
    const out = cleanupOrdinanceText(input);
    expect(out).toContain("26");
    expect(out).toContain("100");
    expect(out).toContain("407");
    expect(out).toContain("Body text.");
  });

  it("strips BOARD OF SUPERVISORS Page N footers", () => {
    const input = ["End of section.", "BOARD OF SUPERVISORS  Page 2", "Next page begins."].join(
      "\n",
    );
    expect(cleanupOrdinanceText(input)).toBe("End of section. Next page begins.");
  });

  it("strips FILE NO. headers", () => {
    const input = [
      "FILE NO. 260545  ORDINANCE NO.",
      "Supervisor Wong",
      "BOARD OF SUPERVISORS  Page 1",
      "Actual content.",
    ].join("\n");
    expect(cleanupOrdinanceText(input)).toBe("Actual content.");
  });

  it("strips sponsor reprint between pages", () => {
    const input = [
      "End of page 1.",
      "Supervisors Wong; Sherrill",
      "BOARD OF SUPERVISORS  Page 2",
      "Start of page 2.",
    ].join("\n");
    expect(cleanupOrdinanceText(input)).toBe("End of page 1. Start of page 2.");
  });

  it("strips the typography legend block", () => {
    const input = [
      "[Health Code - Code Cleanup]",
      "Ordinance amending the Health Code.",
      "NOTE:  Unchanged Code text and uncodified text  are in plain Arial font.",
      "Additions to Codes  are in  single-underline italics Times New Roman font .",
      "Deletions to Codes  are in  strikethrough italics Times New Roman font .",
      "Board amendment additions  are in double-underlined Arial font.",
      "Board amendment deletions  are in strikethrough Arial font.",
      "Asterisks (*  *  *  *)  indicate the omission of unchanged Code",
      "subsections or parts of tables.",
      "Be it ordained by the People of the City and County of San Francisco:",
    ].join("\n");
    // After stripping the 7-line legend, the bracket header, the long
    // title boilerplate, and the enacting clause each become their own
    // paragraph (reflow recognises each as a structural marker).
    expect(cleanupOrdinanceText(input)).toBe(
      [
        "[Health Code - Code Cleanup]",
        "",
        "Ordinance amending the Health Code.",
        "",
        "Be it ordained by the People of the City and County of San Francisco:",
      ].join("\n"),
    );
  });

  it("collapses runs of 3+ blank lines into a paragraph break", () => {
    const input = ["First paragraph.", "", "", "", "Second paragraph."].join("\n");
    expect(cleanupOrdinanceText(input)).toBe(
      ["First paragraph.", "", "Second paragraph."].join("\n"),
    );
  });

  it("strips inline sponsor reprints (when page-break merged into the preceding line)", () => {
    const input =
      "Section 2. Article 12 of the Health Code is hereby amended, to read as follows: Supervisors Wong; Sherrill";
    expect(cleanupOrdinanceText(input)).toBe(
      "Section 2. Article 12 of the Health Code is hereby amended, to read as follows:",
    );
  });

  it("leaves unrecognized patterns alone", () => {
    const input = "Some completely novel header line that we have never seen.";
    expect(cleanupOrdinanceText(input)).toBe(input);
  });
});

describe("cleanupOrdinanceText — paragraph reflow", () => {
  it("reflows wrapped paragraph lines into a single continuous paragraph", () => {
    // 5-line wrapped paragraph — exactly the shape pdfjs emits for an
    // ~80-char column. Reflow should join them into one prose paragraph.
    const input = [
      "It shall be unlawful for any person, firm, corporation or association owning, operating or",
      "having charge of any circulating or lending library to lend or rent to any person under the",
      "age of 21 years any book, magazine, pamphlet or other printed matter, unless and until such",
      "minor shall have registered with such circulating or lending library, and shall have received",
      "therefrom a membership card.",
    ].join("\n");
    expect(cleanupOrdinanceText(input)).toBe(
      "It shall be unlawful for any person, firm, corporation or association owning, operating or having charge of any circulating or lending library to lend or rent to any person under the age of 21 years any book, magazine, pamphlet or other printed matter, unless and until such minor shall have registered with such circulating or lending library, and shall have received therefrom a membership card.",
    );
  });

  it("preserves blank-line paragraph separators between bodies of prose", () => {
    const input = [
      "First wrapped paragraph that",
      "spans two lines.",
      "",
      "Second wrapped paragraph that",
      "also spans two lines.",
    ].join("\n");
    expect(cleanupOrdinanceText(input)).toBe(
      [
        "First wrapped paragraph that spans two lines.",
        "",
        "Second wrapped paragraph that also spans two lines.",
      ].join("\n"),
    );
  });

  it("does not reflow body prose into a following SEC. header line", () => {
    // Action line + SEC. header with no blank line between (the shape
    // pdfjs hands us). The SEC. line MUST start a new paragraph.
    const input = [
      "Section 1. Article 8 of the Health Code is hereby amended by deleting Section 407, to",
      "read as follows:",
      "SEC. 407. CONVEYANCE OF BREAD, ETC., THROUGH PUBLIC STREETS.",
      "It shall be unlawful for any person to carry bread in open baskets.",
    ].join("\n");
    const out = cleanupOrdinanceText(input);
    // Action line is one paragraph (with its wrap joined).
    expect(out).toContain(
      "Section 1. Article 8 of the Health Code is hereby amended by deleting Section 407, to read as follows:",
    );
    // SEC. line is on its own paragraph boundary — blank line before it.
    expect(out).toContain("\n\nSEC. 407. CONVEYANCE OF BREAD, ETC., THROUGH PUBLIC STREETS.");
  });

  it("does not reflow body prose into a following (a) subsection marker", () => {
    const input = [
      "SEC. 694. WIPING RAGS.",
      "(a)  Materials and Cleaning Thereof. It shall be unlawful to sell soiled cloths.",
      "(b)  Definition. Wiping rags within the meaning of this Section are cloths and",
      "rags used for wiping.",
    ].join("\n");
    const out = cleanupOrdinanceText(input);
    // SEC. line starts a paragraph; (a) line starts a new paragraph;
    // (b) line starts another. The (b) body wrap reflows inside that
    // paragraph.
    expect(out).toBe(
      [
        "SEC. 694. WIPING RAGS.",
        "",
        "(a) Materials and Cleaning Thereof. It shall be unlawful to sell soiled cloths.",
        "",
        "(b) Definition. Wiping rags within the meaning of this Section are cloths and rags used for wiping.",
      ].join("\n"),
    );
  });

  it("does not reflow into a following Section N. action line", () => {
    // Body prose immediately followed by the next code group's action
    // line — the action line MUST start a new paragraph.
    const input = [
      "...intended for human consumption.",
      "Section 2. Article 12 of the Health Code is hereby amended by deleting Sections",
      "694 and 695, to read as follows:",
    ].join("\n");
    const out = cleanupOrdinanceText(input);
    expect(out).toBe(
      [
        "...intended for human consumption.",
        "",
        "Section 2. Article 12 of the Health Code is hereby amended by deleting Sections 694 and 695, to read as follows:",
      ].join("\n"),
    );
  });

  it("strips a comma-separated inline sponsor list (260544 regression)", () => {
    // File 260544's SEC. 515 body contains the page-break-merged
    // sponsor reprint `Supervisors Wong; Sauter, Sherrill` mid-sentence.
    // The original regex only handled `;` separators and left
    // `, Sherrill` behind; the extended pattern eats the whole list.
    const input =
      "...in the presence of the Librarian in charge of such Library. In case such minor Supervisors Wong; Sauter, Sherrill has no regularly appointed legal guardian";
    const out = cleanupOrdinanceText(input);
    expect(out).not.toContain("Supervisors");
    expect(out).not.toContain("Sauter");
    expect(out).not.toContain("Sherrill");
    expect(out).toContain("In case such minor has no regularly appointed legal guardian");
  });
});
