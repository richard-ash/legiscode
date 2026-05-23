import { z } from "zod";
import { ModuleIdSchema, SectionIdSchema } from "./identifiers";

// The app owns the schema. Schema-version compatibility for shipped module
// distributions is enforced at the backend (module distribution URLs
// namespace by schema_version), so the app at KNOWN_SCHEMA_VERSION = N
// only ever requests /modules/schema-N/... URLs from the backend.
//
// The --corpus-path power-user path bypasses that backend gate (custom
// local bundles can be at any schema_version), so L2b adds a load-time
// CorpusVersionError gate against MIN_SUPPORTED_SCHEMA_VERSION when
// reading from --corpus-path. L1 stages the constant bump that L2b
// will key off of: version 2 is the L1 schema with optional def_id /
// raw / candidates_dropped on defined_term segments and the canonical
// Definition record. L2b flips def_id required and removes the legacy
// `term` field, completing the schema-version-2 cutover.
export const KNOWN_SCHEMA_VERSION = 2;

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
