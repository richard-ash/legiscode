import { describe, expect, it } from "vitest";
import { CorpusMetaSchema, KNOWN_SCHEMA_VERSION } from "@/types";

const validMeta = {
  jurisdiction: "City and County of San Francisco",
  module_id: "sf-transportation",
  snapshot_at: "2026-04-30T12:34:56-07:00",
  schema_version: KNOWN_SCHEMA_VERSION,
  module_version: "2026.05.01",
  checksum: "0".repeat(64),
  source_sha256: "1".repeat(64),
  skipped: [],
};

describe("CorpusMetaSchema", () => {
  it("KNOWN_SCHEMA_VERSION is exported as 1", () => {
    expect(KNOWN_SCHEMA_VERSION).toBe(1);
  });

  it("accepts a valid corpus-meta", () => {
    expect(CorpusMetaSchema.parse(validMeta).schema_version).toBe(1);
  });

  it("requires source_sha256 (rejects when omitted)", () => {
    const { source_sha256: _omit, ...incomplete } = validMeta;
    expect(CorpusMetaSchema.safeParse(incomplete).success).toBe(false);
  });

  it("rejects non-sha256 source_sha256", () => {
    expect(CorpusMetaSchema.safeParse({ ...validMeta, source_sha256: "deadbeef" }).success).toBe(
      false,
    );
  });

  it("defaults corpus_entry_kinds to ['section'] when absent", () => {
    expect(CorpusMetaSchema.parse(validMeta).corpus_entry_kinds).toEqual(["section"]);
  });

  it("accepts an explicit corpus_entry_kinds array", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      corpus_entry_kinds: ["section", "appendix", "ordinance_history"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty corpus_entry_kinds array", () => {
    const result = CorpusMetaSchema.safeParse({ ...validMeta, corpus_entry_kinds: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown CorpusEntry kind", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      corpus_entry_kinds: ["section", "made-up-kind"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a snapshot_at without offset", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      snapshot_at: "2026-04-30T12:34:56",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a UTC Z snapshot_at (offset: true allows Z)", () => {
    expect(
      CorpusMetaSchema.safeParse({ ...validMeta, snapshot_at: "2026-04-30T12:34:56Z" }).success,
    ).toBe(true);
  });

  it("rejects non-sha256 checksum", () => {
    const result = CorpusMetaSchema.safeParse({ ...validMeta, checksum: "deadbeef" });
    expect(result.success).toBe(false);
  });

  it("rejects negative schema_version", () => {
    const result = CorpusMetaSchema.safeParse({ ...validMeta, schema_version: -1 });
    expect(result.success).toBe(false);
  });

  it("requires skipped (empty array allowed)", () => {
    const { skipped: _skipped, ...incomplete } = validMeta;
    const result = CorpusMetaSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });
});

describe("SkippedEntry discriminated union", () => {
  it("accepts a kind:section entry", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ kind: "section", id: "1.1", reason: "validator failed" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a kind:parse entry with raw_id", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [
        {
          kind: "parse",
          raw_id: "1.6A",
          source_location: { line: 42 },
          reason: "unrecognized SEC. anchor",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a kind:parse entry without raw_id but with byte_offset", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [
        {
          kind: "parse",
          source_location: { line: 12, byte_offset: 1024 },
          reason: "utf8_stray_byte",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a mixed array of section and parse entries", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [
        { kind: "section", id: "1.2", reason: "validator failed" },
        {
          kind: "parse",
          source_location: { line: 99 },
          reason: "drift_trigger",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects the legacy { id, reason } shape (no kind discriminator)", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ id: "1.1", reason: "selector miss" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects kind:section missing id", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ kind: "section", reason: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects kind:section with invalid id", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ kind: "section", id: "Not Valid", reason: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects kind:parse missing source_location", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ kind: "parse", reason: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects kind:parse with non-positive line", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ kind: "parse", source_location: { line: 0 }, reason: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const result = CorpusMetaSchema.safeParse({
      ...validMeta,
      skipped: [{ kind: "weird", id: "1.1", reason: "x" }],
    });
    expect(result.success).toBe(false);
  });
});
