#!/usr/bin/env -S node --experimental-vm-modules
// Recogniser-stage recall gate — classified before/after diff.
//
// The defined-term precision work intentionally drops two classes of
// tag: ① a name highlighted inside a longer proper name ("Department"
// inside "Department of Emergency Management"), and ② a term inside its
// own defining clause. Those drops are CORRECT. The arch decision —
// "the glossary recognises, capitalisation guards" — hinges on one
// invariant the naive "zero drops" gate cannot express: the lower-case
// 8.7% of defined terms ("fiscal year", "affordable housing") must NOT
// be dropped. A capitalisation-as-recogniser regression would silently
// delete them, and a count-level audit would miss it.
//
// This tool captures the tagged (section, def_id) SET and the cited
// (section, raw) SET from a built corpus, and diffs two captures. The
// hard gate: zero lower-case-term tag drops in a NON-definer section.
// Capitalised drops (①) and definer-section drops (②) are reported for
// eyeball but don't fail the gate. Citation drops are reported so a
// boundary correction ("Section 10A" → "Section 10A.4") is visibly a
// re-shaping, not a recall loss.
//
//   capture <build-modules-dir> <out.json>
//   diff    <baseline.json> <build-modules-dir>
//
// Operator-driven, mirrors validate:full. Not in CI — it reads the full
// corpus, which is local-only per the hermetic-tests rule.

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface DefinedTag {
  section_id: string;
  def_id: string;
}
interface CiteTag {
  section_id: string;
  raw: string;
}
interface ModuleCapture {
  defined: DefinedTag[];
  cites: CiteTag[];
}
export interface Capture {
  // def_id -> canonical term, so the diff can classify case without the
  // corpus present.
  terms: Record<string, string>;
  modules: Record<string, ModuleCapture>;
}

type BodySegment =
  | { type: "text"; text: string }
  | { type: "citation"; raw: string; citation_index: number }
  | { type: "defined_term"; raw: string; def_id: string }
  | { type: "subsection_label"; label: string }
  | { type: "paragraph_break" }
  | { type: "format"; children: BodySegment[] };

async function listDirs(root: string): Promise<string[]> {
  const exists = await stat(root).catch(() => null);
  if (!exists?.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(join(root, entry.name));
  }
  return out;
}

async function walkJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const exists = await stat(dir).catch(() => null);
    if (!exists?.isDirectory()) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith(".json")) out.push(full);
    }
  }
  return out;
}

function collectSegments(
  segs: readonly BodySegment[],
  sectionId: string,
  defined: DefinedTag[],
  cites: CiteTag[],
): void {
  for (const seg of segs) {
    if (seg.type === "defined_term") {
      defined.push({ section_id: sectionId, def_id: seg.def_id });
    } else if (seg.type === "citation") {
      cites.push({ section_id: sectionId, raw: seg.raw });
    } else if (seg.type === "format") {
      collectSegments(seg.children, sectionId, defined, cites);
    }
  }
}

async function capture(buildDir: string): Promise<Capture> {
  const terms: Record<string, string> = {};
  const modules: Record<string, ModuleCapture> = {};
  for (const moduleDir of await listDirs(buildDir)) {
    const moduleId = moduleDir.split("/").pop() ?? moduleDir;
    const defsPath = join(moduleDir, "definitions-v2.json");
    const defsExists = await stat(defsPath).catch(() => null);
    if (!defsExists?.isFile()) continue; // not a module dir (e.g. corpus-meta sibling)
    const defs = JSON.parse(await readFile(defsPath, "utf8")) as {
      id: string;
      term: string;
    }[];
    for (const d of defs) terms[d.id] = d.term;

    const defined: DefinedTag[] = [];
    const cites: CiteTag[] = [];
    for (const file of await walkJsonFiles(join(moduleDir, "sections"))) {
      const section = JSON.parse(await readFile(file, "utf8")) as {
        id: string;
        body?: BodySegment[];
      };
      collectSegments(section.body ?? [], section.id, defined, cites);
    }
    modules[moduleId] = { defined, cites };
  }
  return { terms, modules };
}

function keyDefined(t: DefinedTag): string {
  return `${t.section_id}\t${t.def_id}`;
}
function keyCite(t: CiteTag): string {
  return `${t.section_id}\t${t.raw}`;
}

// The definer section is encoded in the def_id: <module>/<section>#<sha8>.
function definerSection(defId: string): string {
  const slash = defId.indexOf("/");
  const hash = defId.indexOf("#");
  if (slash < 0 || hash < 0 || hash < slash) return "";
  return defId.slice(slash + 1, hash);
}

function isCapitalInitial(term: string): boolean {
  const c = term.charCodeAt(0);
  return c >= 65 && c <= 90; // A-Z
}

export function diff(baseline: Capture, current: Capture): number {
  let lowercaseRegressions = 0;
  let capitalisedDrops = 0;
  let definerLowercaseDrops = 0;
  let definedAdds = 0;
  let citeDrops = 0;
  let citeAdds = 0;
  const moduleIds = new Set([...Object.keys(baseline.modules), ...Object.keys(current.modules)]);
  const sortedModuleIds = [...moduleIds].sort();

  const regressionSamples: string[] = [];
  const capitalisedSamples: string[] = [];
  const citeDropSamples: string[] = [];

  for (const moduleId of sortedModuleIds) {
    const before = baseline.modules[moduleId] ?? { defined: [], cites: [] };
    const after = current.modules[moduleId] ?? { defined: [], cites: [] };

    // Immutable snapshot of the before-set; the dedupe pass below mutates a
    // copy, so the adds computation reads this snapshot instead of rebuilding
    // it per iteration.
    const beforeDefinedSnapshot = new Set(before.defined.map(keyDefined));
    const beforeDefined = new Set(beforeDefinedSnapshot);
    const afterDefined = new Set(after.defined.map(keyDefined));
    for (const t of before.defined) {
      const k = keyDefined(t);
      if (afterDefined.has(k)) continue;
      if (!beforeDefined.has(k)) continue; // dedupe within before set
      beforeDefined.delete(k); // count each dropped pair once
      const term = baseline.terms[t.def_id] ?? current.terms[t.def_id] ?? "";
      const inDefiner = definerSection(t.def_id) === t.section_id;
      if (isCapitalInitial(term)) {
        capitalisedDrops += 1;
        if (capitalisedSamples.length < 12) {
          capitalisedSamples.push(`    ${moduleId} §${t.section_id} "${term}"`);
        }
      } else if (inDefiner) {
        definerLowercaseDrops += 1;
      } else {
        lowercaseRegressions += 1;
        if (regressionSamples.length < 25) {
          regressionSamples.push(`    ${moduleId} §${t.section_id} "${term}" (def ${t.def_id})`);
        }
      }
    }
    for (const k of afterDefined) if (!beforeDefinedSnapshot.has(k)) definedAdds += 1;

    const beforeCites = new Set(before.cites.map(keyCite));
    const afterCites = new Set(after.cites.map(keyCite));
    for (const k of beforeCites) {
      if (!afterCites.has(k)) {
        citeDrops += 1;
        if (citeDropSamples.length < 20) {
          const [sectionId, raw] = k.split("\t");
          citeDropSamples.push(`    ${moduleId} §${sectionId} "${raw}"`);
        }
      }
    }
    for (const k of afterCites) if (!beforeCites.has(k)) citeAdds += 1;
  }

  process.stdout.write("\n=== RECALL DIFF (classified) ===\n\n");
  process.stdout.write("DEFINED-TERM TAGS (section, def_id) set:\n");
  process.stdout.write(`  added:                       ${definedAdds}\n`);
  process.stdout.write(`  dropped — capitalised (①):    ${capitalisedDrops} (intended)\n`);
  process.stdout.write(`  dropped — definer lower-case (②): ${definerLowercaseDrops} (intended)\n`);
  process.stdout.write(`  dropped — lower-case REGRESSION: ${lowercaseRegressions} (MUST be 0)\n`);
  if (capitalisedSamples.length > 0) {
    process.stdout.write("  capitalised-drop sample:\n");
    process.stdout.write(`${capitalisedSamples.join("\n")}\n`);
  }
  if (regressionSamples.length > 0) {
    process.stdout.write("  LOWER-CASE REGRESSION sample:\n");
    process.stdout.write(`${regressionSamples.join("\n")}\n`);
  }
  process.stdout.write("\nCITATION TAGS (section, raw) set:\n");
  process.stdout.write(`  added:   ${citeAdds}\n`);
  process.stdout.write(
    `  dropped: ${citeDrops} (expect boundary re-shapes, e.g. "Section 10A" → "Section 10A.4")\n`,
  );
  if (citeDropSamples.length > 0) {
    process.stdout.write("  cite-drop sample:\n");
    process.stdout.write(`${citeDropSamples.join("\n")}\n`);
  }
  process.stdout.write("\n");

  if (lowercaseRegressions > 0) {
    process.stdout.write(
      `GATE FAIL: ${lowercaseRegressions} lower-case term tag(s) dropped outside their definer section. ` +
        "The trie, not capitalisation, must recognise lower-case terms — investigate the root cause.\n",
    );
    return 1;
  }
  process.stdout.write("GATE PASS: no lower-case recall regression.\n");
  return 0;
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "capture") {
    const [buildDir, outPath] = rest;
    if (!buildDir || !outPath) {
      throw new Error("usage: recall-diff capture <build-modules-dir> <out.json>");
    }
    const cap = await capture(buildDir);
    await writeFile(outPath, `${JSON.stringify(cap)}\n`);
    const nDefined = Object.values(cap.modules).reduce((s, m) => s + m.defined.length, 0);
    const nCites = Object.values(cap.modules).reduce((s, m) => s + m.cites.length, 0);
    process.stdout.write(
      `captured ${Object.keys(cap.modules).length} modules, ${nDefined} defined-term tags, ${nCites} cite tags → ${outPath}\n`,
    );
    return;
  }
  if (mode === "diff") {
    const [baselinePath, buildDir] = rest;
    if (!baselinePath || !buildDir) {
      throw new Error("usage: recall-diff diff <baseline.json> <build-modules-dir>");
    }
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Capture;
    const current = await capture(buildDir);
    process.exit(diff(baseline, current));
  }
  throw new Error(
    "usage:\n  recall-diff capture <build-modules-dir> <out.json>\n  recall-diff diff <baseline.json> <build-modules-dir>",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("recall-diff.ts") || process.argv[1].endsWith("recall-diff.js"));

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`recall-diff failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
