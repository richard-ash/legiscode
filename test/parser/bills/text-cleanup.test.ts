import { describe, expect, it } from "vitest";
import { cleanupOrdinanceText } from "@/parser/bills/text-cleanup";

describe("cleanupOrdinanceText", () => {
  it("strips PDF page-margin line numbers (1..25)", () => {
    const input = ["Section 1 of the Code provides:", "1", "2", "3", "25", "The actual text here."].join("\n");
    expect(cleanupOrdinanceText(input)).toBe(
      ["Section 1 of the Code provides:", "The actual text here."].join("\n"),
    );
  });

  it("preserves numbers >= 26 (real section numbers, not line numbers)", () => {
    const input = ["SEC. 407.", "26", "100", "407", "Body text."].join("\n");
    // 26 is on its own line and is > 25 → keep. 100 and 407 likewise.
    expect(cleanupOrdinanceText(input)).toBe(input);
  });

  it("strips BOARD OF SUPERVISORS Page N footers", () => {
    const input = [
      "End of section.",
      "BOARD OF SUPERVISORS  Page 2",
      "Next page begins.",
    ].join("\n");
    expect(cleanupOrdinanceText(input)).toBe(["End of section.", "Next page begins."].join("\n"));
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
    expect(cleanupOrdinanceText(input)).toBe(["End of page 1.", "Start of page 2."].join("\n"));
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
    expect(cleanupOrdinanceText(input)).toBe(
      [
        "[Health Code - Code Cleanup]",
        "Ordinance amending the Health Code.",
        "Be it ordained by the People of the City and County of San Francisco:",
      ].join("\n"),
    );
  });

  it("collapses runs of 3+ blank lines into a paragraph break", () => {
    const input = ["First paragraph.", "", "", "", "Second paragraph."].join("\n");
    expect(cleanupOrdinanceText(input)).toBe(["First paragraph.", "", "Second paragraph."].join("\n"));
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
