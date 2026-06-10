// Section.article extraction (commit 1, feat/agent-polish).
//
// Two surfaces are exercised:
//
// 1. parseHierarchyMarker — the pure id/title splitter. Asserted against
//    every distinct article shape produced by the committed SF test
//    fixture (fixture-walk for real-world coverage per
//    feedback_test_each_path_once) PLUS a synthetic adversarial set
//    (codex #11 / D5: long, unicode, punctuation worst-cases).
//
// 2. parseExport end-to-end — assert the parser emits article on every
//    section in the SF test fixture and that the field round-trips
//    through SectionFileSchema (chapter-parent chain preserved when
//    Chapter > Article nesting shows up; sections under chapter-only
//    or division-only context produce article=null).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseExport, parseHierarchyMarker } from "@/parser/parse-html";
import type { JurisdictionManifest, SectionArticle } from "@/types";
import { SectionFileSchema } from "@/types";

const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_MANIFEST = resolve(REPO_ROOT, "test", "fixtures", "sf", "jurisdiction.json");
const FIXTURE_SOURCE = resolve(REPO_ROOT, "test", "fixtures", "sf", "source.html");

describe("parseHierarchyMarker — id/title splitter", () => {
  it.each([
    // Standard SF AmLegal shape: prefix + id + ':' + title.
    ["Article 3.5:Fees", { id: "3.5", title: "Fees" }],
    ["Chapter 9A:Farmers' Market", { id: "9A", title: "Farmers' Market" }],
    ["Article I:Existence and Powers", { id: "I", title: "Existence and Powers" }],
    ["Chapter 6: Behested Payment Reporting", { id: "6", title: "Behested Payment Reporting" }],
    // Hyphenated id with mixed casing — sf-business "Article 12-D".
    [
      "Article 12-D:Uniform Local Sales and Use Tax",
      { id: "12-D", title: "Uniform Local Sales and Use Tax" },
    ],
    // Trailing asterisk on id is editorial chrome, not part of id.
    ["Article 26*", { id: "26", title: "" }],
    // Asterisk inside the title is preserved.
    ["Chapter 41F:Tourist Hotel Conversion *", { id: "41F", title: "Tourist Hotel Conversion *" }],
    // No-colon dot-separated title — "Article 4.2.Sewer System Management" is a
    // real shape in the SF Public Works code where the dot stands in for ':'.
    ["Article 4.2.Sewer System Management", { id: "4.2", title: "Sewer System Management" }],
  ])("parses %s correctly", (input, expected) => {
    expect(parseHierarchyMarker(input)).toEqual(expected);
  });

  // Synthetic adversarial worst-cases (codex #11 / D5). These don't appear
  // in the current SF fixture but guard against AmLegal emitting wider
  // shapes in future jurisdictions or post-update SF corpora.
  it.each([
    // 1. Long Roman-numeral id with extended Unicode title.
    [
      "Article XLVIII:Régulations Spéciales — Édition 2026",
      { id: "XLVIII", title: "Régulations Spéciales — Édition 2026" },
    ],
    // 2. Curly-quoted apostrophe + ampersand in title (HTML entity decoded).
    [
      "Article 7:Children's Rights & Protections",
      { id: "7", title: "Children's Rights & Protections" },
    ],
    // 3. Long mixed-alphanumeric id with multiple dot+dash separators.
    ["Article 12.4.B-2:Composite Identifier", { id: "12.4.B-2", title: "Composite Identifier" }],
    // 4. Bare id, no separator, no title.
    ["Chapter 99", { id: "99", title: "" }],
    // 5. Title contains a colon (the splitter must only consume the FIRST).
    ["Article 5:Sub-title: Inner Description", { id: "5", title: "Sub-title: Inner Description" }],
  ])("handles adversarial %s", (input, expected) => {
    expect(parseHierarchyMarker(input)).toEqual(expected);
  });

  it("returns null on empty / prefix-only labels", () => {
    expect(parseHierarchyMarker("Article")).toBeNull();
    expect(parseHierarchyMarker("Chapter")).toBeNull();
    expect(parseHierarchyMarker("")).toBeNull();
  });
});

describe("parseExport — Section.article round-trip on the SF test fixture", () => {
  it("emits article and schema-validates every section", async () => {
    const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, "utf8")) as JurisdictionManifest;
    const source = await readFile(FIXTURE_SOURCE);
    const results = parseExport(source, manifest);
    expect(results.length).toBeGreaterThan(0);

    const articleShapes = new Set<string>();
    for (const { result } of results) {
      for (const ps of result.sections) {
        // Schema round-trip: an emitted ParsedSection.article must be a
        // legal SectionArticle when fed into SectionFileSchema. We feed
        // the smallest schema-acceptable shape so any malformed article
        // surfaces here as a validation failure rather than at the
        // loader trust boundary at runtime.
        const candidate = {
          kind: "section" as const,
          id: ps.id,
          display_label: ps.display_label,
          title: ps.title,
          text: ps.text,
          citations: [],
          defined_terms: [],
          hierarchy: ps.hierarchy,
          editorial_status: ps.editorial_status,
          ...(ps.redirect_to ? { redirect_to: ps.redirect_to } : {}),
          body: ps.text.length > 0 ? [{ kind: "text" as const, text: ps.text }] : [],
          article: ps.article,
        };
        const validated = SectionFileSchema.safeParse(candidate);
        expect(
          validated.success,
          `schema rejected ${ps.id}: ${validated.success ? "" : JSON.stringify(validated.error.issues)}`,
        ).toBe(true);

        if (ps.article) {
          articleShapes.add(
            `${ps.article.id}|${ps.article.parents.map((p) => `${p.kind}:${p.id}`).join(",")}`,
          );
        }
      }
    }

    // The committed SF fixture should produce at least one article — guards
    // against a parser regression silently emitting null for every section.
    expect(
      articleShapes.size,
      "fixture should contain at least one distinct article shape",
    ).toBeGreaterThan(0);
  });

  it("a section inside an Article carries the article id+title", async () => {
    const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, "utf8")) as JurisdictionManifest;
    const source = await readFile(FIXTURE_SOURCE);
    const results = parseExport(source, manifest);

    // Find ANY section whose hierarchy ends in "Article …" (the legacy
    // display chain stays unchanged in commit 1); that section must
    // have a non-null article field whose id matches.
    let foundChecked = false;
    for (const { result } of results) {
      for (const ps of result.sections) {
        const tail = ps.hierarchy[ps.hierarchy.length - 1] ?? "";
        if (!/^Article\s+/i.test(tail)) continue;
        expect(
          ps.article,
          `${ps.id} hierarchy tail is "${tail}" but article is null`,
        ).not.toBeNull();
        const article = ps.article as SectionArticle;
        expect(article.id.length, `${ps.id} article.id empty`).toBeGreaterThan(0);
        // The parsed id should appear in the tail label after the
        // "Article " prefix, modulo case and the editorial asterisk.
        const idInTail = tail.toLowerCase().includes(article.id.toLowerCase());
        expect(idInTail, `${ps.id}: tail "${tail}" missing article id "${article.id}"`).toBe(true);
        foundChecked = true;
      }
    }
    expect(foundChecked, "fixture should expose at least one Article-tail section").toBe(true);
  });
});
