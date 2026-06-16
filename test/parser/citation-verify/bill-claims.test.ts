// Bill-claim extraction tests — the claim surfaces, the quoting
// defenses, and the negation guard. Verifier-level integration
// (extraction × affected_section_ids) lives in sources-block.test.ts.

import { describe, expect, it } from "vitest";
import { blankQuotedRegions, extractBillClaims } from "@/parser/citation-verify";

describe("blankQuotedRegions", () => {
  it("blanks blockquote lines while preserving offsets", () => {
    const text = "Line one.\n> The draft claims [Bill #260545] amends § 99.\nLine three.";
    const blanked = blankQuotedRegions(text);
    expect(blanked.length).toBe(text.length);
    expect(blanked).toContain("Line one.");
    expect(blanked).toContain("Line three.");
    expect(blanked).not.toContain("260545");
  });

  it("blanks fenced code blocks, including quoted lines inside them", () => {
    const text = "Before.\n```\n[Bill #260545] amends § 99.\n```\nAfter.";
    const blanked = blankQuotedRegions(text);
    expect(blanked.length).toBe(text.length);
    expect(blanked).not.toContain("260545");
    expect(blanked).toContain("After.");
  });
});

describe("extractBillClaims — affected listing (surface A)", () => {
  it("attributes every cite in the Affected Sections region to the heading bill", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "**Re:** Health code cleanup\n" +
      "**Affected Sections** — [sf-health § 694] and [sf-health § 695].\n" +
      "- [sf-health § 19.1]\n" +
      "Some closing prose.\n";
    const claims = extractBillClaims(body);
    const listed = claims.filter((c) => c.surface === "affected_listing");
    expect(listed.map((c) => c.section_id).sort()).toEqual(["19.1", "694", "695"]);
    expect(listed.every((c) => c.file_no === "260545")).toBe(true);
  });

  it("falls back to the only bill cited when the heading carries no bill cite", () => {
    const body =
      "## Memo: Health code cleanup draft\n" +
      "**Re:** Review of [Bill #260545]\n" +
      "**Affected Sections** — [sf-health § 694].\n";
    const claims = extractBillClaims(body);
    const listed = claims.filter((c) => c.surface === "affected_listing");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ file_no: "260545", section_id: "694" });
  });

  it("recognizes a markdown Affected Sections heading and skips blank lines in the region", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "### Affected Sections\n" +
      "\n" +
      "- [sf-health § 694]\n" +
      "- [sf-health § 695]\n" +
      "Closing prose ends the region.\n";
    const claims = extractBillClaims(body);
    const listed = claims.filter((c) => c.surface === "affected_listing");
    expect(listed.map((c) => c.section_id).sort()).toEqual(["694", "695"]);
    expect(listed.every((c) => c.file_no === "260545")).toBe(true);
  });

  it("skips surface A entirely when the subject bill is ambiguous", () => {
    // Two bills cited, neither in the heading: no attribution is safe.
    const body =
      "## Memo: street vendor cleanup\n" +
      "Compares [Bill #260543] and [Bill #260544].\n" +
      "**Affected Sections** — [sf-police § 12].\n";
    const claims = extractBillClaims(body);
    expect(claims.filter((c) => c.surface === "affected_listing")).toEqual([]);
  });
});

describe("extractBillClaims — table rows (surface B)", () => {
  it("attributes section cites in table rows to the impact heading bill", () => {
    const body =
      "## What [Bill #260545] does to the Health Code\n" +
      "| Section | Change |\n" +
      "| --- | --- |\n" +
      "| [sf-health § 694] | Repealed |\n" +
      "| [sf-health § 19.1] | Revised |\n";
    const claims = extractBillClaims(body);
    const rows = claims.filter((c) => c.surface === "impact_table");
    expect(rows.map((c) => c.section_id).sort()).toEqual(["19.1", "694"]);
    expect(rows.every((c) => c.file_no === "260545")).toBe(true);
  });
});

describe("extractBillClaims — attribution sentences (surface C)", () => {
  it("captures an explicit amendment claim with qualified and bare cites", () => {
    const body = "## Memo: [Bill #260545]\nAlso, [Bill #260545] repeals [sf-health § 696] today.\n";
    const claims = extractBillClaims(body);
    const sentence = claims.filter((c) => c.surface === "attribution_sentence");
    expect(sentence).toHaveLength(1);
    expect(sentence[0]).toMatchObject({
      file_no: "260545",
      module_id: "sf-health",
      section_id: "696",
    });
  });

  it("resolves bare cites with a null module for the verifier to fill", () => {
    const body = "## Memo: [Bill #260545]\nNote that [Bill #260545] amends § 694 directly.\n";
    const claims = extractBillClaims(body);
    const sentence = claims.filter((c) => c.surface === "attribution_sentence");
    expect(sentence[0]).toMatchObject({ module_id: null, section_id: "694" });
  });

  it("skips blockquoted claims — the T6 quoting defense", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "> The draft claims [Bill #260545] amends [sf-health § 19.1].\n" +
      "That claim is wrong.\n";
    expect(extractBillClaims(body)).toEqual([]);
  });

  it("skips guarded debunking sentences outside blockquotes", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "Contrary to the draft, [Bill #260545] does not amend [sf-health § 19.1].\n";
    expect(extractBillClaims(body)).toEqual([]);
  });

  it("skips reported-speech attributions", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "The memo asserts [Bill #260545] changes [sf-health § 19.1], which is unverified.\n";
    expect(extractBillClaims(body)).toEqual([]);
  });

  it("skips fenced code blocks", () => {
    const body =
      "## Memo: [Bill #260545]\n```\n[Bill #260545] amends [sf-health § 19.1].\n```\nProse.\n";
    expect(extractBillClaims(body)).toEqual([]);
  });

  it("requires an amendment verb in the same sentence", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "[Bill #260545] is pending. The committee will discuss [sf-health § 19.1] separately.\n";
    expect(extractBillClaims(body)).toEqual([]);
  });

  it("dedupes the same (bill, section) across surfaces", () => {
    const body =
      "## Memo: [Bill #260545]\n" +
      "**Affected Sections** — [sf-health § 694].\n\n" +
      "[Bill #260545] amends [sf-health § 694] as described.\n";
    const claims = extractBillClaims(body);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.surface).toBe("affected_listing");
  });
});
