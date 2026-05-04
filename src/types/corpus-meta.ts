import { z } from "zod";
import { ModuleIdSchema, SectionIdSchema } from "./identifiers";

// The app owns the schema. Schema-version compatibility is enforced at the
// backend (module distribution URLs namespace by schema_version), so the app
// at KNOWN_SCHEMA_VERSION = N only ever requests /modules/schema-N/... URLs.
// The field is on CorpusMeta for diagnostics, not as a runtime gate. When a
// future schema version ships, the backend serves both URL namespaces and
// each client picks the one it can read — no cross-version reads at the
// wire layer.
export const KNOWN_SCHEMA_VERSION = 1;

// CorpusEntry kinds enumerated in corpus-meta.json's `corpus_entry_kinds`
// field, so consumers can detect kind-extension at meta-read time without
// scanning every file in the bundle.
export const CorpusEntryKindSchema = z.enum([
  "section",
  "ordinance_history",
  "resolution_history",
  "appendix",
]);
export type CorpusEntryKind = z.infer<typeof CorpusEntryKindSchema>;

// SkippedEntry is a discriminated union so the parser doesn't have to push
// raw_id values through SectionId validation — the whole point of recording
// them is that they didn't validate. kind:"section" is for post-parse
// validator rejections (a complete SectionFile that fails its schema);
// kind:"parse" is for parse-time skips (UTF-8 strays, malformed anchors).
const SkippedSectionEntrySchema = z
  .object({
    kind: z.literal("section"),
    id: SectionIdSchema,
    reason: z.string().min(1),
  })
  .strict();

const SkippedParseEntrySchema = z
  .object({
    kind: z.literal("parse"),
    raw_id: z.string().min(1).optional(),
    source_location: z
      .object({
        line: z.number().int().positive(),
        byte_offset: z.number().int().nonnegative().optional(),
      })
      .strict(),
    reason: z.string().min(1),
  })
  .strict();

const SkippedEntrySchema = z.discriminatedUnion("kind", [
  SkippedSectionEntrySchema,
  SkippedParseEntrySchema,
]);

export const CorpusMetaSchema = z
  .object({
    jurisdiction: z.string().min(1),
    module_id: ModuleIdSchema,
    snapshot_at: z.iso.datetime({ offset: true }),
    schema_version: z.number().int().positive(),
    module_version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/),
    checksum: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
    // sha256 of the source-export bytes the build consumed. Same
    // module_version + same source_sha256 = bit-identical inputs to the
    // parser; a downstream consumer can compare across snapshots without
    // re-reading the source.
    source_sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
    skipped: z.array(SkippedEntrySchema),
    // Defaults to ["section"] for lenient parsing of corpus-meta files
    // that omit the field; the parser always writes it explicitly.
    corpus_entry_kinds: z.array(CorpusEntryKindSchema).nonempty().default(["section"]),
  })
  .strict();

export type SkippedEntry = z.infer<typeof SkippedEntrySchema>;
export type CorpusMeta = z.infer<typeof CorpusMetaSchema>;
