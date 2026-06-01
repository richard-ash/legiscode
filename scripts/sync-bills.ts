#!/usr/bin/env node
// Lane 2 — hermetic bill sync. Reads build/downloads/bills/bills-index.json,
// loads each cached PDF, runs the parser, validates each emitted Bill
// against BillSchema, writes per-module pending-bill files, and purges
// any stale entries (matters that aged out of the index since the last
// run).
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

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseBill } from "@/parser/bills";
import { purgeStalePendingBills, writePendingBill } from "@/storage/writer";
import {
  type Bill,
  type BillMeta,
  BillSchema,
  type BillsIndex,
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
  --manifest <path>       Jurisdiction manifest with pending_bill_source declared.
  --bills-index <path>    bills-index.json produced by scripts/fetch-bills.ts.

Optional:
  --output <dir>          Corpus root (default: build/modules/). Each module's
                          pending-bills/ subdirectory gets written under
                          <output>/<module-id>/pending-bills/.
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
  /** Per-module count of pending-bill files written this run. */
  written: Record<string, number>;
  /** Per-module count of pending-bill files purged this run. */
  purged: Record<string, number>;
  /** Section IDs the parser couldn't resolve against the loaded module tree. */
  unresolved: Array<{ file_no: string; module_id: ModuleId; raw_section_id: string }>;
  /**
   * Soft body-parser warnings tagged with the matter that emitted them.
   * Surfaced in the sync summary so the operator can investigate, but
   * not gating (the renderer always has a body to show — see A5 in the
   * locked plan).
   */
  body_warnings: Array<{ file_no: string; message: string }>;
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
  for (const mod of args.manifest.modules) {
    const ids = await loadSectionIds(args.outputDir, mod.id);
    sectionIndex.set(mod.id, ids);
  }

  const resolvePath = args.resolvePdfPath ?? defaultResolvePdfPath;
  const limit = args.maxMatters ?? Number.POSITIVE_INFINITY;
  const bills = args.billsIndex.bills.slice(0, limit);

  const written: Record<string, number> = {};
  const unresolved: SyncResult["unresolved"] = [];
  const bodyWarnings: SyncResult["body_warnings"] = [];
  const keepByModule = new Map<ModuleId, Set<string>>();

  for (const meta of bills) {
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
    for (const bill of result.bills) {
      if (!installedIds.has(bill.module_id)) continue;
      const validated = BillSchema.parse(bill satisfies Bill);
      const moduleDir = join(args.outputDir, bill.module_id);
      await writePendingBill({ moduleDir, bill: validated });
      written[bill.module_id] = (written[bill.module_id] ?? 0) + 1;
      const keep = keepByModule.get(bill.module_id) ?? new Set<string>();
      keep.add(bill.file_no);
      keepByModule.set(bill.module_id, keep);
    }
  }

  // Stale-purge: any pending-bill file whose file_no doesn't appear in
  // this run's keep set gets deleted. Mirrors the writer's invariant
  // that the on-disk set is a function of the bills-index, not
  // accretive across runs.
  const purged: Record<string, number> = {};
  for (const mod of args.manifest.modules) {
    const keep = keepByModule.get(mod.id) ?? new Set<string>();
    const moduleDir = join(args.outputDir, mod.id);
    const result = await purgeStalePendingBills({ moduleDir, keepFileNos: keep });
    if (result.deleted.length > 0) purged[mod.id] = result.deleted.length;
  }

  return { written, purged, unresolved, body_warnings: bodyWarnings };
}

function defaultResolvePdfPath(meta: BillMeta): string {
  return isAbsolute(meta.pdf_cache_path)
    ? meta.pdf_cache_path
    : resolve(process.cwd(), meta.pdf_cache_path);
}

/**
 * Walk a module's sections/ tree and collect every section.id. Used by
 * sync to feed parseBill's section-validation gate. Missing module dir
 * returns an empty set — the parser logs all hits as unresolved, which
 * the operator sees in the sync summary.
 */
async function loadSectionIds(
  outputDir: string,
  moduleId: ModuleId,
): Promise<ReadonlySet<SectionId>> {
  const sectionsRoot = join(outputDir, moduleId, "sections");
  const out = new Set<SectionId>();
  await collectIds(sectionsRoot, out);
  return out;
}

async function collectIds(dir: string, out: Set<SectionId>): Promise<void> {
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
      await collectIds(p, out);
      continue;
    }
    if (!e.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw);
      const validated = SectionFileSchema.safeParse(parsed);
      if (validated.success) {
        out.add(validated.data.id);
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
    billsIndex = BillsIndexSchema.parse(JSON.parse(raw));
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
