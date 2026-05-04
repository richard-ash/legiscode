#!/usr/bin/env tsx
// Editorial chrome classifier audit: walk the source HTML and bucket
// every Section-classed rbox by id-signal presence. The classifier rule
// in src/parser/parse-html.ts drops "Section-class + no JD_ anchor + no
// SEC. heading" as editorial chrome. This script confirms the rule's
// blast radius and surfaces any rbox that uses a non-SEC heading
// convention (ARTICLE I., APPENDIX M., etc.) the rule would falsely
// classify as chrome.
//
// Operator-only — not shipped, not on PR CI. Re-run when AmLegal HTML
// evolves and a new chrome convention surfaces.
//
// Usage:  pnpm exec tsx scripts/audit-classifier.ts [path/to/sf.html]
// Default path: build/downloads/sf.html

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cheerio from "cheerio";

const HEADING_SEC_RE = /SEC(?:TION)?\.?\s+([\d.A-Za-z*-]+(?:\s+art\s+[\d.A-Za-z]+)?)\.?\s*/i;

const SOURCE_PATH = resolve(process.argv[2] ?? "build/downloads/sf.html");
const html = readFileSync(SOURCE_PATH, "utf8");
console.log(`Loaded ${SOURCE_PATH} (${html.length.toLocaleString()} bytes)`);

const $ = cheerio.load(html);
const allRboxes = $(".rbox").toArray();
console.log(`Total .rbox elements: ${allRboxes.length.toLocaleString()}`);

interface Bucket {
  total: number;
  withJD: number;
  withoutJD_withSEC: number;
  withoutJD_withoutSEC: number;
  // Texts of the at-risk bucket — the ones the chrome rule will drop
  atRiskHeadings: string[];
}

const bucket: Bucket = {
  total: 0,
  withJD: 0,
  withoutJD_withSEC: 0,
  withoutJD_withoutSEC: 0,
  atRiskHeadings: [],
};

function isSectionClassed(el: cheerio.Cheerio<any>): boolean {
  const cls: string = (el.get(0) as any)?.attribs?.class ?? "";
  const classes = new Set<string>(cls.split(/\s+/).filter((s) => s.length > 0));
  for (const c of classes) {
    if (c === "Section" || c === "level-Section") return true;
    if (c === "Section-NewOrd" || c === "level-Section-NewOrd") return true;
    if (c === "Section-Deleted" || c === "level-Section-Deleted") return true;
  }
  return false;
}

function rboxHeadingText(el: cheerio.Cheerio<any>): string {
  const childDivs = el.children("div");
  const raw = (childDivs.length === 0 ? el.text() : childDivs.first().text()).trim();
  return raw;
}

for (const node of allRboxes) {
  const el = $(node);
  if (!isSectionClassed(el)) continue;
  bucket.total += 1;

  const hasJD = el.find("a[name^='JD_']").length > 0;
  if (hasJD) {
    bucket.withJD += 1;
    continue;
  }

  const heading = rboxHeadingText(el);
  const hasSEC = HEADING_SEC_RE.test(heading);
  if (hasSEC) {
    bucket.withoutJD_withSEC += 1;
    continue;
  }
  bucket.withoutJD_withoutSEC += 1;
  bucket.atRiskHeadings.push(heading.length > 80 ? `${heading.slice(0, 80)}…` : heading);
}

console.log("\n--- Section-classed rbox audit ---");
console.log(`Total Section-classed rboxes: ${bucket.total.toLocaleString()}`);
console.log(`  with JD anchor:                         ${bucket.withJD.toLocaleString()}`);
console.log(
  `  without JD anchor, with SEC. heading:   ${bucket.withoutJD_withSEC.toLocaleString()}`,
);
console.log(
  `  without JD anchor, without SEC. heading:${bucket.withoutJD_withoutSEC.toLocaleString()}  ★ AT RISK`,
);

console.log("\n--- AT-RISK headings (chrome rule will drop these) ---");
const headingCounts = new Map<string, number>();
for (const h of bucket.atRiskHeadings) {
  headingCounts.set(h, (headingCounts.get(h) ?? 0) + 1);
}
const sorted = Array.from(headingCounts.entries()).sort(([, a], [, b]) => b - a);
for (const [heading, count] of sorted) {
  console.log(`  ${count.toString().padStart(3)}× ${heading || "<empty>"}`);
}

console.log("\n--- Pattern classification ---");
const patterns = {
  "New Ordinance/Legislation/Resolution Notice": /(new\s+(ordinance|legislation|resolution))/i,
  "Bracketed caption": /^\[[^\]]+\]$/,
  "Year label / Ordinances": /^(\d{4}\s*(ordinances?|>?))/i,
  "Map-sheet header": /(zoning|use district|map)/i,
  "Appendix label": /^appendix\s+/i,
  "ARTICLE label": /^article\s+/i,
  "CHAPTER label": /^chapter\s+/i,
  "DIVISION label": /^division\s+/i,
};
const classified = new Map<string, number>();
let unclassified = 0;
for (const heading of bucket.atRiskHeadings) {
  let matched = false;
  for (const [name, re] of Object.entries(patterns)) {
    if (re.test(heading)) {
      classified.set(name, (classified.get(name) ?? 0) + 1);
      matched = true;
      break;
    }
  }
  if (!matched) unclassified += 1;
}
for (const [name, count] of classified) {
  console.log(`  ${count.toString().padStart(3)}× ${name}`);
}
console.log(`  ${unclassified.toString().padStart(3)}× <unclassified>`);

console.log("\n--- Verdict ---");
const articleChapterCount =
  (classified.get("ARTICLE label") ?? 0) +
  (classified.get("CHAPTER label") ?? 0) +
  (classified.get("DIVISION label") ?? 0);
if (articleChapterCount > 0) {
  console.log(`★ ${articleChapterCount} rboxes use ARTICLE/CHAPTER/DIVISION heading convention.`);
  console.log("  These would be wrongly classified as chrome by the rule alone.");
  console.log("  Add HEADING_ARTICLE_RE / HEADING_CHAPTER_RE fallbacks before shipping.");
} else {
  console.log("✓ Zero ARTICLE/CHAPTER/DIVISION-heading rboxes lack a JD anchor.");
  console.log("  The chrome rule (no JD + no SEC → chrome) is precise; ship as written.");
}
