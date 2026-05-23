// Diagnostic: walk every parsed section and report disagreements between
// the anchor-derived id (current parser default) and the heading-text
// section number. Pattern B (sf-building g5.106 case) proposes preferring
// heading text when they disagree — this script measures the blast
// radius before we change the rule.

import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { parseExport } from "@/parser";
import { readJurisdictionManifest } from "@/types/validate";

// Mirror of parse-html.ts:HEADING_SEC_RE — keep in sync if that changes.
const HEADING_SEC_RE =
  /SEC(?:TION)?\.?\s+((?:[\dA-Za-z*-]|\.(?=[\dA-Za-z*-]))+(?:\s+art\s+[\d.A-Za-z]+)?)/i;

function normalize(rawId: string): string {
  return rawId
    .trim()
    .replace(/(\*+)$/, (_, asterisks: string) => `-fn${asterisks.length}`)
    .replace(/\.$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .trim();
}

interface Disagreement {
  moduleId: string;
  sectionId: string;
  anchorIdNorm: string;
  headingIdNorm: string;
  titleRaw: string;
  headingTextSnippet: string;
}

async function main(): Promise<void> {
  const manifest = await readJurisdictionManifest("manifests/sf/jurisdiction.json");
  const buf = await readFile("build/downloads/sf.html");
  const parsed = parseExport(buf, manifest);
  const $ = cheerio.load(buf.toString("utf-8"));

  const disagreements: Disagreement[] = [];
  let totalSections = 0;
  let bothPresent = 0;
  let agreeCount = 0;

  for (const mod of parsed) {
    for (const s of mod.sections) {
      totalSections++;

      // Re-derive what the parser saw. We use the section's own id as
      // the "anchor-derived id" view (it's the canonical product of the
      // current rules: title attr → name attr → heading fallback). The
      // collisions we care about for Pattern B are where the section
      // ALSO has a heading-text section number that differs from this
      // anchor-derived id.
      const anchorIdNorm = s.id;

      // Look up the section's heading element in the source HTML by
      // searching for its title text, then scan the rbox for a SECTION
      // heading-text number. Simpler: walk the toc-destination element
      // we know maps to this section, then run HEADING_SEC_RE on its
      // heading text.
      //
      // The parser stores `display_label` as the heading-text-derived
      // section number when present. We compare normalized forms.
      const displayLabel = s.display_label ?? "";
      const headingMatch = displayLabel.match(/^[\dA-Za-z*-]+(?:\.[\dA-Za-z*-]+)*/);
      const headingNumRaw = headingMatch?.[0] ?? "";
      if (headingNumRaw === "") continue;
      const headingIdNorm = normalize(headingNumRaw);

      bothPresent++;

      if (anchorIdNorm === headingIdNorm) {
        agreeCount++;
        continue;
      }

      disagreements.push({
        moduleId: mod.module.id,
        sectionId: s.id,
        anchorIdNorm,
        headingIdNorm,
        titleRaw: s.title.slice(0, 80).replace(/\s+/g, " "),
        headingTextSnippet: displayLabel.slice(0, 60),
      });
    }
  }

  console.log(`Total sections parsed: ${totalSections}`);
  console.log(`Sections with BOTH anchor-id and heading-text-num: ${bothPresent}`);
  console.log(`  Agreement:    ${agreeCount}`);
  console.log(`  Disagreement: ${disagreements.length}`);
  console.log();

  if (disagreements.length === 0) {
    console.log("No disagreements found.");
    return;
  }

  // Group disagreements by module, then by the (anchor → heading) shape
  // pattern. If sf-building has 6 entries all with anchor=g5.106, those
  // collapse into one row. If we see 100s of unique shapes elsewhere,
  // the prefer-heading rule needs scoping.
  const byShape = new Map<string, Disagreement[]>();
  for (const d of disagreements) {
    const key = `${d.moduleId}\t${d.anchorIdNorm} → ${d.headingIdNorm}`;
    const arr = byShape.get(key) ?? [];
    arr.push(d);
    byShape.set(key, arr);
  }

  console.log("=== Disagreements grouped by (module, anchor → heading) shape ===");
  console.log("(showing groups sorted by size, first 30)");
  console.log();
  const groups = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, members] of groups.slice(0, 30)) {
    const [moduleId, shape] = key.split("\t");
    console.log(`[${moduleId}] ${shape}  (×${members.length})`);
    for (const m of members.slice(0, 3)) {
      console.log(
        `    id=${JSON.stringify(m.sectionId)} display=${JSON.stringify(m.headingTextSnippet)} title=${JSON.stringify(m.titleRaw)}`,
      );
    }
    if (members.length > 3) console.log(`    ... and ${members.length - 3} more`);
  }

  if (groups.length > 30) {
    console.log();
    console.log(
      `(... and ${groups.length - 30} more shape groups, totaling ${disagreements.length - groups.slice(0, 30).reduce((sum, g) => sum + g[1].length, 0)} more disagreements)`,
    );
  }

  console.log();
  console.log("=== Per-module disagreement counts ===");
  const byModule = new Map<string, number>();
  for (const d of disagreements) {
    byModule.set(d.moduleId, (byModule.get(d.moduleId) ?? 0) + 1);
  }
  for (const [moduleId, count] of [...byModule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${moduleId.padEnd(25)} ${count}`);
  }

  void $; // unused — left for future drilldowns
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
