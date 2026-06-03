#!/usr/bin/env node
// Lane 2 — hermetic bill sync. Reads build/downloads/bills/bills-index.json,
// loads each cached PDF, runs the parser, validates each emitted Bill
// against BillSchema, writes per-module session-bill files under
// `<module>/bills/`, and purges any stale entries (matters that aged
// out of the index since the last run, including ones that fell out of
// the legislative-session window at session turnover).
//
// Hermetic by construction: no HTTP, only fs reads against the operator's
// local cache + the committed corpus tree. CI runs this against
// test/fixtures/sf/bills/ via the integration suite; production runs
// happen after the operator invokes `mise run bills:fetch`.
//
// The corpus tree must already be built (sections/ + manifest.json
// present per module) — sync-bills uses the existing section index to
// validate that applyDisplayRules candidates actually resolve to real
// sections, dropping anything that doesn't to the unresolved log
// rather than emitting affected_sections that point at nothing.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseBill } from "@/parser/bills";
import type { AnchorOutcome } from "@/parser/bills/emit-diff";
import { anchorTextDiff } from "@/parser/bills/emit-diff";
import { purgeStaleSessionBills, writeSessionBill } from "@/storage/writer";
import {
  type Bill,
  type BillMeta,
  BillSchema,
  type BillsIndex,
  BILLS_INDEX_SCHEMA_VERSION,
  BillsIndexSchema,
  type JurisdictionManifest,
  type ModuleId,
  SectionFileSchema,
  type SectionId,
} from "@/types";
import { readJurisdictionManifest } from "@/types/validate";

const HELP_TEXT = `\
Usage: tsx scripts/sync-bills.ts --manifest <path> --bills-index <path> [options]

Required:
  --manifest <path>       Jurisdiction manifest with bill_source declared.
  --bills-index <path>    bills-index.json produced by scripts/fetch-bills.ts.

Optional:
  --output <dir>          Corpus root (default: build/modules/). Each module's
                          bills/ subdirectory gets written under
                          <output>/<module-id>/bills/.
  --max-matters <N>       Cap the number of bills processed (test runs).
  --help                  Show this help.

Exit codes:
  0  success
  2  argument error
  3  parse / validation error
  5  write error
`;

export interface Args {
  manifest: string;
  billsIndex: string;
  output: string;
  maxMatters: number | null;
}

const DEFAULT_OUTPUT = "build/modules";

export function parseArgs(argv: string[]): Args | { help: true } | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `flag ${flag} requires a value` };
    }
    switch (flag) {
      case "--manifest":
        out.manifest = value;
        break;
      case "--bills-index":
        out.billsIndex = value;
        break;
      case "--output":
        out.output = value;
        break;
      case "--max-matters": {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { error: `--max-matters requires a positive integer, got "${value}"` };
        }
        out.maxMatters = n;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.manifest) return { error: "missing required --manifest" };
  if (!out.billsIndex) return { error: "missing required --bills-index" };
  return {
    manifest: out.manifest,
    billsIndex: out.billsIndex,
    output: out.output ?? DEFAULT_OUTPUT,
    maxMatters: out.maxMatters ?? null,
  };
}

export type SyncResult = {
  /** Per-module count of session-bill files written this run. */
  written: Record<string, number>;
  /** Per-module count of session-bill files purged this run. */
  purged: Record<string, number>;
  /** Section IDs the parser couldn't resolve against the loaded module tree. */
  unresolved: Array<{ file_no: string; module_id: ModuleId; raw_section_id: string }>;
  /**
   * Soft body-parser warnings tagged with the matter that emitted
   * them. Surfaced in the sync summary so the operator can
   * investigate, but not gating (the renderer always has a body to
   * show).
   */
  body_warnings: Array<{ file_no: string; message: string }>;
  /**
   * Per-section anchoring outcome from `anchorTextDiff`. Each
   * affected section produces exactly one outcome.
   * status="anchored" means `text_diff[]` is populated on disk; the
   * other statuses are per-section fallbacks (section-level sparse
   * failure).
   */
  anchor_outcomes: AnchorOutcome[];
  /**
   * Per-matter timing telemetry, ms from PDF read → schema-validated
   * Bill array. Surfaces outlier matters when the session corpus
   * grows from ~30 (pending-only) to ~500 bills per session window
   * per D12.9. Don't pre-optimize; let the data say which matter is
   * worth investigating.
   */
  per_matter_ms: Array<{ file_no: string; ms: number }>;
  /** Aggregate wall-clock for the sync loop, ms. */
  total_ms: number;
};

/**
 * Hermetic sync entry point. Tests + the CLI both invoke this. Returns
 * a structured result instead of touching process.exit so the
 * integration suite can assert on every field.
 */
export async function syncBills(args: {
  manifest: JurisdictionManifest;
  billsIndex: BillsIndex;
  outputDir: string;
  maxMatters?: number | null;
  /**
   * Resolves a PDF path from a BillMeta. Defaults to using the
   * BillMeta.pdf_cache_path verbatim (absolute or repo-relative).
   * Tests inject a fixture-mapper so they don't need the operator
   * cache layout on disk.
   */
  resolvePdfPath?: (meta: BillMeta) => string;
}): Promise<SyncResult> {
  const installedIds = new Set(args.manifest.modules.map((m) => m.id));
  // Pre-load the per-module section index so the parser can validate
  // candidate ids against real sections. Modules whose corpus hasn't
  // been built yet get an empty index — applyDisplayRules will still
  // emit candidates and the parser will surface every miss in the
  // unresolved log.
  const sectionIndex = new Map<ModuleId, ReadonlySet<SectionId>>();
  // Pre-load baseline section text for every module so the build-time
  // anchorer can dereference (moduleId, sectionId) without per-bill
  // disk reads. Keyed by `${moduleId}::${sectionId}`. Modules whose
  // corpus tree isn't built yet contribute an empty slice; affected
  // sections in those modules will return "no_baseline" outcomes.
  const baselineTexts = new Map<string, string>();
  for (const mod of args.manifest.modules) {
    const { ids, texts } = await loadSectionIndex(args.outputDir, mod.id);
    sectionIndex.set(mod.id, ids);
    for (const [sid, text] of texts) {
      baselineTexts.set(`${mod.id}::${sid}`, text);
    }
  }

  const resolvePath = args.resolvePdfPath ?? defaultResolvePdfPath;
  const limit = args.maxMatters ?? Number.POSITIVE_INFINITY;
  const bills = args.billsIndex.bills.slice(0, limit);

  const written: Record<string, number> = {};
  const unresolved: SyncResult["unresolved"] = [];
  const bodyWarnings: SyncResult["body_warnings"] = [];
  const anchorOutcomes: AnchorOutcome[] = [];
  const keepByModule = new Map<ModuleId, Set<string>>();
  const perMatterMs: SyncResult["per_matter_ms"] = [];
  const totalStart = Date.now();

  for (const meta of bills) {
    const matterStart = Date.now();
    const pdfPath = resolvePath(meta);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(pdfPath));
    } catch (err) {
      // Missing PDF means the operator's fetch cache was pruned; skip
      // the matter with a typed warning rather than aborting the run.
      process.stderr.write(
        `sync-bills: PDF not found for ${meta.file_no} at ${pdfPath} (${(err as Error).message}); skipping\n`,
      );
      continue;
    }
    const result = await parseBill(bytes, meta, args.manifest, { sectionIndex });
    // Build-time alignment: bind classified spans to the corpus
    // baseline. Failures are per-section + non-gating (sparse
    // text_diff across affected_sections), so we keep the bills
    // array regardless.
    const anchored = anchorTextDiff(result, (moduleId, sectionId) =>
      baselineTexts.get(`${moduleId}::${sectionId}`),
    );
    for (const o of anchored.outcomes) anchorOutcomes.push(o);

    for (const u of result.unresolved_sections) {
      unresolved.push({
        file_no: meta.file_no,
        module_id: u.module_id,
        raw_section_id: u.raw_section_id,
      });
    }
    for (const message of result.body_quality_warnings) {
      bodyWarnings.push({ file_no: meta.file_no, message });
    }
    for (const bill of anchored.bills) {
      if (!installedIds.has(bill.module_id)) continue;
      const validated = BillSchema.parse(bill satisfies Bill);
      const moduleDir = join(args.outputDir, bill.module_id);
      await writeSessionBill({ moduleDir, bill: validated });
      written[bill.module_id] = (written[bill.module_id] ?? 0) + 1;
      const keep = keepByModule.get(bill.module_id) ?? new Set<string>();
      keep.add(bill.file_no);
      keepByModule.set(bill.module_id, keep);
    }
    perMatterMs.push({ file_no: meta.file_no, ms: Date.now() - matterStart });
  }

  // Stale-purge: any session-bill file whose file_no doesn't appear in
  // this run's keep set gets deleted. Mirrors the writer's invariant
  // that the on-disk set is a function of the bills-index, not
  // accretive across runs.
  const purged: Record<string, number> = {};
  for (const mod of args.manifest.modules) {
    const keep = keepByModule.get(mod.id) ?? new Set<string>();
    const moduleDir = join(args.outputDir, mod.id);
    const result = await purgeStaleSessionBills({ moduleDir, keepFileNos: keep });
    if (result.deleted.length > 0) purged[mod.id] = result.deleted.length;
  }

  // Copy the bills-index to the corpus root so the loader can surface
  // Class B (non-code) ordinances in the Activity panel. Class B never
  // produces a per-module Bill file (no touched_modules), so without
  // this jurisdiction-level index the panel would silently drop them
  // (D11 — the codex review caught this).
  await writeFile(
    join(args.outputDir, "bills-index.json"),
    `${JSON.stringify(args.billsIndex, null, 2)}\n`,
  );

  return {
    written,
    purged,
    unresolved,
    body_warnings: bodyWarnings,
    anchor_outcomes: anchorOutcomes,
    per_matter_ms: perMatterMs,
    total_ms: Date.now() - totalStart,
  };
}

function defaultResolvePdfPath(meta: BillMeta): string {
  return isAbsolute(meta.pdf_cache_path)
    ? meta.pdf_cache_path
    : resolve(process.cwd(), meta.pdf_cache_path);
}

/**
 * Walk a module's sections/ tree once and surface both:
 *   • `ids` — every section.id, for parseBill's section-validation gate.
 *   • `texts` — the canonical baseline text per section.id, for the
 *               build-time anchorer's per-section dereference.
 *
 * Missing module dir returns empty maps — the parser logs hits as
 * unresolved and the anchorer emits "no_baseline" outcomes.
 */
async function loadSectionIndex(
  outputDir: string,
  moduleId: ModuleId,
): Promise<{ ids: ReadonlySet<SectionId>; texts: ReadonlyMap<SectionId, string> }> {
  const sectionsRoot = join(outputDir, moduleId, "sections");
  const ids = new Set<SectionId>();
  const texts = new Map<SectionId, string>();
  await collectIdsAndTexts(sectionsRoot, ids, texts);
  return { ids, texts };
}

async function collectIdsAndTexts(
  dir: string,
  ids: Set<SectionId>,
  texts: Map<SectionId, string>,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await collectIdsAndTexts(p, ids, texts);
      continue;
    }
    if (!e.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw);
      const validated = SectionFileSchema.safeParse(parsed);
      if (validated.success) {
        ids.add(validated.data.id);
        // SectionFile.text is the roundtrip-invariant flat text
        // (bodyToText(body) === text); use it directly so we don't pay
        // the cost of re-flattening per section.
        texts.set(validated.data.id, validated.data.text);
      }
    } catch {
      // ignore unreadable / malformed; the existing corpus build's
      // validation gate catches these during the main build path.
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n${HELP_TEXT}`);
    return 2;
  }
  const args = parsed;
  const manifestPath = resolve(args.manifest);
  let manifest: JurisdictionManifest;
  try {
    manifest = await readJurisdictionManifest(manifestPath);
  } catch (err) {
    process.stderr.write(`manifest invalid: ${(err as Error).message}\n`);
    return 3;
  }
  const indexPath = resolve(args.billsIndex);
  let billsIndex: BillsIndex;
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    // Schema-version preflight: the most common cause of "bills-index
    // invalid" in practice is a cached file from before a schema bump,
    // not a structurally broken file. Catch that case explicitly so
    // the operator sees one actionable line instead of a 70-line Zod
    // dump that buries the real cause.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.schema_version === "number" &&
      parsed.schema_version !== BILLS_INDEX_SCHEMA_VERSION
    ) {
      process.stderr.write(
        `bills-index schema mismatch: file is schema v${parsed.schema_version}, ` +
          `parser expects v${BILLS_INDEX_SCHEMA_VERSION}. ` +
          `Run \`make bills-fetch\` to refresh the cache.\n`,
      );
      return 3;
    }
    billsIndex = BillsIndexSchema.parse(parsed);
  } catch (err) {
    process.stderr.write(`bills-index invalid: ${(err as Error).message}\n`);
    return 3;
  }
  const outputDir = resolve(args.output);
  try {
    await stat(outputDir);
  } catch {
    process.stderr.write(`output dir does not exist: ${outputDir}\n`);
    return 2;
  }
  try {
    const result = await syncBills({
      manifest,
      billsIndex,
      outputDir,
      maxMatters: args.maxMatters,
    });
    const writtenTotal = Object.values(result.written).reduce((a, b) => a + b, 0);
    const purgedTotal = Object.values(result.purged).reduce((a, b) => a + b, 0);
    process.stdout.write(
      `sync-bills: wrote ${writtenTotal} files across ${Object.keys(result.written).length} modules; purged ${purgedTotal} stale; unresolved sections: ${result.unresolved.length}; body warnings: ${result.body_warnings.length}\n`,
    );
    // D12.9: per-matter timing telemetry. Surfaces outlier matters
    // worth investigating; never gating. Don't pre-optimize until
    // a real number says we should.
    if (result.per_matter_ms.length > 0) {
      const totalSec = (result.total_ms / 1000).toFixed(1);
      const avgMs = Math.round(result.total_ms / result.per_matter_ms.length);
      const sorted = [...result.per_matter_ms].sort((a, b) => b.ms - a.ms);
      const slowest = sorted.slice(0, 3);
      const slowSummary = slowest.map((s) => `${s.file_no}=${s.ms}ms`).join(", ");
      process.stdout.write(
        `sync-bills: timing — ${totalSec}s total over ${result.per_matter_ms.length} matters (avg ${avgMs}ms); slowest 3: ${slowSummary}\n`,
      );
    }
    // Per-section anchoring outcomes — invisible from the file
    // tree, so surface a count breakdown for the operator. Empty
    // text_diff on a written bill is meaningful (a no_baseline gap
    // is a corpus issue; an alignment_failed is a parser issue);
    // operators shouldn't have to source-dive to discover which.
    const outcomeCounts: Record<string, number> = {};
    for (const o of result.anchor_outcomes) {
      outcomeCounts[o.status] = (outcomeCounts[o.status] ?? 0) + 1;
    }
    if (result.anchor_outcomes.length > 0) {
      const summary = Object.entries(outcomeCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      process.stdout.write(`sync-bills: anchor outcomes — ${summary}\n`);
      const failures = result.anchor_outcomes.filter(
        (o) => o.status === "alignment_failed" || o.status === "classification_low_confidence",
      );
      for (const f of failures) {
        process.stdout.write(
          `  ${f.status}: ${f.file_no} §${f.section_id} (${f.module_id})${f.detail ? ` — ${f.detail}` : ""}\n`,
        );
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`sync failed: ${(err as Error).message}\n`);
    return 5;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("sync-bills.ts") || process.argv[1].endsWith("sync-bills.js"));

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

export { main };
