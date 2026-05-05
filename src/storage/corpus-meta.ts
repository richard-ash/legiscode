// Composes and writes corpus-meta.json — the completion sentinel for an
// atomic build. Runs LAST after every other file in <output>.new is
// fsynced, so the presence of corpus-meta.json with a valid checksum is
// the proof that the .new directory is complete.

import { join } from "node:path";
import type { CorpusEntryKind, CorpusMeta, ModuleConfig, SkippedEntry } from "@/types";
import { CorpusMetaSchema, KNOWN_SCHEMA_VERSION } from "@/types";
import { computeChecksum, SENTINEL_FILENAME } from "./atomic-write";
import { writeJson } from "./canonical-json";

export interface ComposeCorpusMetaInput {
  jurisdiction: string;
  module: ModuleConfig;
  /** Module dir to scan for the checksum. Should already contain every other file. */
  moduleDir: string;
  /** ISO 8601 datetime with offset; injected for test determinism. */
  snapshotAt: string;
  skipped: SkippedEntry[];
  /** Which CorpusEntry kinds appear in this bundle. Always includes "section". */
  corpusEntryKinds: readonly CorpusEntryKind[];
  /**
   * sha256 of the source-export bytes (e.g., AmLegal HTML) the parser
   * consumed for this build. The provenance trail.
   */
  sourceSha256: string;
}

export async function composeCorpusMeta(input: ComposeCorpusMetaInput): Promise<CorpusMeta> {
  const checksum = await computeChecksum(input.moduleDir);
  // Sort and deduplicate to make corpus-meta.json deterministic regardless
  // of the order kinds were emitted in by the parser.
  const sortedKinds = Array.from(new Set(input.corpusEntryKinds)).sort();
  if (sortedKinds.length === 0) {
    throw new Error("composeCorpusMeta: corpusEntryKinds must include at least one kind");
  }
  const meta: CorpusMeta = {
    jurisdiction: input.jurisdiction,
    module_id: input.module.id,
    snapshot_at: input.snapshotAt,
    schema_version: KNOWN_SCHEMA_VERSION,
    module_version: input.module.module_version,
    checksum,
    source_sha256: input.sourceSha256,
    skipped: input.skipped,
    corpus_entry_kinds: sortedKinds as [CorpusEntryKind, ...CorpusEntryKind[]],
  };
  // Defense-in-depth: parse our own output. Catches bugs where this writer
  // drifts from the schema.
  return CorpusMetaSchema.parse(meta);
}

export async function writeCorpusMeta(moduleDir: string, meta: CorpusMeta): Promise<void> {
  await writeJson(join(moduleDir, SENTINEL_FILENAME), meta);
}
