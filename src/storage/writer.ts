// Atomic-write the contents of a ParsedModule to disk. Owns the per-entry
// directory layout, the 0%-skip-rate gate, and the lock-recover-promote
// dance. Consumers (the CLI) hand in a ParsedModule + options and get back
// nothing but a Promise<void>; failures throw AtomicWriteError carrying an
// ExitCode.

import { access, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  Appendix,
  Bill,
  DistributedModuleManifest,
  ModuleConfig,
  OrdinanceHistory,
  ParsedModule,
  ResolutionHistory,
  SectionFile,
  SkippedEntry,
} from "@/types";
import {
  AtomicWriteError,
  acquireLock,
  ExitCodes,
  ensureCleanNew,
  promote,
  recover,
  releaseLock,
} from "./atomic-write";
import { fsyncDir, writeJson } from "./canonical-json";
import { composeCorpusMeta, writeCorpusMeta } from "./corpus-meta";

export interface WriteModuleOptions {
  /** Jurisdiction display name; lands in corpus-meta.jurisdiction. */
  jurisdiction: string;
  /** Per-module output directory: <output-base>/<module-id>. */
  outputDir: string;
  /** ISO 8601 datetime with offset; lands in corpus-meta.snapshot_at. */
  snapshotAt: string;
  /**
   * Maximum allowed `skipped[]` length. Exceeding this aborts the write
   * with AtomicWriteError(ExitCodes.PARSE) before any promotion. Default
   * source: `module.max_skip_count`; CLI may override per-run.
   */
  maxSkips: number;
  /**
   * sha256 of the source-export bytes (e.g., AmLegal HTML) the parser
   * consumed. Lands in corpus-meta.source_sha256.
   */
  sourceSha256: string;
}

/**
 * Atomically write a ParsedModule to disk under `opts.outputDir`. Acquires
 * a lockfile, recovers any in-flight prior build under the lock, writes
 * every entry into a `.new` directory, composes and writes the
 * corpus-meta sentinel last, and promotes via the 3-step swap. Returns
 * after `releaseLock` whether the write succeeded or threw.
 *
 * Skip-rate gate runs AFTER the parser has produced its `skipped[]` so
 * both parse-time and validation-time rejections count toward the
 * threshold. The gate runs BEFORE any disk write so a contract violation
 * never leaves bytes behind.
 */
export async function writeModule(parsed: ParsedModule, opts: WriteModuleOptions): Promise<void> {
  enforceSkipGate(parsed.module, parsed.skipped, opts.maxSkips);
  if (parsed.sections.length === 0) {
    throw new AtomicWriteError(
      ExitCodes.PARSE,
      `module "${parsed.module.id}": parser emitted zero sections — refusing to promote an empty bundle`,
    );
  }

  const lock = await acquireLock(opts.outputDir).catch((err) => {
    if (err instanceof AtomicWriteError) throw err;
    throw err;
  });

  try {
    await recover(opts.outputDir, lock);
    const newDir = await ensureCleanNew(opts.outputDir);

    for (const section of parsed.sections) {
      const pathParts = parsed.sectionPaths[section.id] ?? section.hierarchy;
      await writeSection(newDir, section, pathParts);
    }
    for (const appendix of parsed.appendices) {
      await writeAppendix(newDir, appendix);
    }
    for (const hist of parsed.ordinanceHistories) {
      await writeOrdinanceHistory(newDir, hist);
    }
    for (const hist of parsed.resolutionHistories) {
      await writeResolutionHistory(newDir, hist);
    }

    await writeJson(
      join(newDir, "manifest.json"),
      toDistributedManifest(opts.jurisdiction, parsed.module),
    );
    // definitions-v2.json (canonical Definition[]) is the only
    // definitions artifact. unresolved_references.json always ships
    // (even empty) so the operator coverage report has a stable file
    // path to read.
    await writeJson(join(newDir, "definitions-v2.json"), parsed.moduleDefinitions);
    await writeJson(join(newDir, "unresolved_references.json"), parsed.unresolvedReferences);

    const meta = await composeCorpusMeta({
      jurisdiction: opts.jurisdiction,
      module: parsed.module,
      moduleDir: newDir,
      snapshotAt: opts.snapshotAt,
      skipped: parsed.skipped,
      corpusEntryKinds: parsed.corpusEntryKinds,
      sourceSha256: opts.sourceSha256,
    });
    await writeCorpusMeta(newDir, meta);

    await promote(opts.outputDir, lock);
  } finally {
    await releaseLock(lock);
  }
}

function enforceSkipGate(
  module: ModuleConfig,
  skipped: readonly SkippedEntry[],
  maxSkips: number,
): void {
  if (skipped.length <= maxSkips) return;
  const summary = skipped
    .slice(0, 5)
    .map((s) => {
      if (s.kind === "section") return `  - section ${s.id}: ${s.reason}`;
      const id = s.raw_id ? ` raw_id="${s.raw_id}"` : "";
      return `  - parse line=${s.source_location.line}${id}: ${s.reason}`;
    })
    .join("\n");
  const tail =
    skipped.length > 5 ? `\n  ... ${skipped.length - 5} more (see corpus-meta.json)` : "";
  throw new AtomicWriteError(
    ExitCodes.PARSE,
    `module "${module.id}": parser skipped ${skipped.length} entries; ` +
      `max_skip_count is ${maxSkips}. Refusing to promote a corpus that ` +
      `silently drops content.\nFirst skipped entries:\n${summary}${tail}`,
  );
}

async function writeSection(
  newDir: string,
  section: SectionFile,
  pathParts: readonly string[],
): Promise<void> {
  const sectionDir = join(newDir, "sections", ...pathParts);
  await mkdir(sectionDir, { recursive: true });
  await fsyncDir(sectionDir);
  const filePath = join(sectionDir, `${section.id}.json`);
  // Defense-in-depth: refuse to overwrite an existing path. The
  // validateCorpus duplicate_section_ids gate catches collisions at
  // pipeline time and the orchestrator short-circuits writeModule
  // before we get here. If a future regression bypasses validation
  // (e.g. --skip-validation debug flag) or two ParsedModules ever
  // feed the same writeModule invocation, the writer must still
  // refuse to drop bytes.
  try {
    await access(filePath);
    throw new AtomicWriteError(
      ExitCodes.PARSE,
      `writeSection collision: ${filePath} already exists. ` +
        `Refusing to overwrite — two sections in this module emitted ` +
        `the same id "${section.id}", which would silently drop bytes ` +
        `from one of them.`,
    );
  } catch (err) {
    if (err instanceof AtomicWriteError) throw err;
    // ENOENT is the happy path — the file does not exist yet, proceed
    // to write. Any other errno (EACCES, EIO) is a real fs failure we
    // surface as a write error instead of swallowing.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AtomicWriteError(
        ExitCodes.WRITE,
        `writeSection probe failed for ${filePath}: ${(err as Error).message}`,
      );
    }
  }
  await writeJson(filePath, section);
}

async function writeAppendix(newDir: string, appendix: Appendix): Promise<void> {
  const appendixDir = join(
    newDir,
    "appendices",
    `${appendix.parent.kind}-${appendix.parent.number}`,
  );
  await mkdir(appendixDir, { recursive: true });
  await fsyncDir(appendixDir);
  await writeJson(join(appendixDir, `${appendix.id}.json`), appendix);
}

async function writeOrdinanceHistory(newDir: string, hist: OrdinanceHistory): Promise<void> {
  const histDir = join(newDir, "ordinance-history");
  await mkdir(histDir, { recursive: true });
  await fsyncDir(histDir);
  await writeJson(join(histDir, `${hist.id}.json`), hist);
}

async function writeResolutionHistory(newDir: string, hist: ResolutionHistory): Promise<void> {
  const histDir = join(newDir, "resolution-history");
  await mkdir(histDir, { recursive: true });
  await fsyncDir(histDir);
  await writeJson(join(histDir, `${hist.id}.json`), hist);
}

/**
 * Pending-bill writer. Persists a single Bill into
 * `<moduleDir>/pending-bills/<file_no>.json` using the same
 * write-to-temp + rename-on-flush pattern the main corpus path uses.
 *
 * Pending-bills are operator-driven (Lane 2 runs outside the build
 * pipeline), so they sidestep the writeModule promotion dance and write
 * file-by-file. The atomicity boundary is the single file: a crashed
 * sync that wrote some but not all pending-bills leaves the previously-
 * promoted files intact, and the next sync re-derives the full set
 * from the bills-index.
 *
 * The file_no is used directly as the filename; BillSchema guarantees
 * it's non-empty, and Legistar file numbers are filesystem-safe
 * (digits + hyphens) by convention.
 */
export async function writePendingBill(opts: {
  moduleDir: string;
  bill: Bill;
}): Promise<{ path: string }> {
  const dir = join(opts.moduleDir, "pending-bills");
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${opts.bill.file_no}.json`);
  const tmp = `${target}.tmp`;
  await writeJson(tmp, opts.bill);
  await rename(tmp, target);
  await fsyncDir(dir);
  return { path: target };
}

/**
 * Stale-purge for pending-bills. Lists every .json file under
 * `<moduleDir>/pending-bills/` and deletes any whose basename
 * (file_no) is NOT in the keep set. Used by sync-bills after a fresh
 * fetch to drop matters that aged out of the bills-index (enacted,
 * withdrawn, filed, tabled).
 *
 * Returns the list of deleted file paths so the operator log can audit
 * what disappeared. Idempotent; missing directory returns an empty list.
 */
export async function purgeStalePendingBills(opts: {
  moduleDir: string;
  keepFileNos: ReadonlySet<string>;
}): Promise<{ deleted: string[] }> {
  const dir = join(opts.moduleDir, "pending-bills");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { deleted: [] };
    throw err;
  }
  const deleted: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fileNo = entry.slice(0, -".json".length);
    if (opts.keepFileNos.has(fileNo)) continue;
    const full = join(dir, entry);
    await unlink(full);
    deleted.push(full);
  }
  if (deleted.length > 0) {
    await fsyncDir(dir);
  }
  return { deleted };
}

function toDistributedManifest(
  jurisdiction: string,
  module: ModuleConfig,
): DistributedModuleManifest {
  const out: DistributedModuleManifest = {
    id: module.id,
    name: module.name,
    jurisdiction,
    code_title: module.code_title,
    module_version: module.module_version,
    citation_patterns: module.citation_patterns,
    defined_term_patterns: module.defined_term_patterns,
  };
  if (module.jd_anchor !== undefined) {
    out.jd_anchor = module.jd_anchor;
  }
  if (module.min_section_count !== undefined) {
    out.min_section_count = module.min_section_count;
  }
  if (module.global_definer_sections !== undefined) {
    out.global_definer_sections = module.global_definer_sections;
  }
  return out;
}
