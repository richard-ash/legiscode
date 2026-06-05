import { describe, expect, it } from "vitest";
import { DiffChunksSchema } from "@/types";

function chunk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    op: "insert",
    text: "new text",
    section_id: "10.04.020",
    ...overrides,
  };
}

describe("DiffChunksSchema", () => {
  it("accepts an empty diff", () => {
    expect(DiffChunksSchema.parse([])).toEqual([]);
  });

  it("accepts an insert chunk", () => {
    expect(() => DiffChunksSchema.parse([chunk()])).not.toThrow();
  });

  it("accepts a delete chunk", () => {
    expect(() =>
      DiffChunksSchema.parse([chunk({ op: "delete", text: "old prose" })]),
    ).not.toThrow();
  });

  it("accepts an equal chunk", () => {
    expect(() =>
      DiffChunksSchema.parse([chunk({ op: "equal", text: "unchanged prose" })]),
    ).not.toThrow();
  });

  it("rejects an unknown op", () => {
    const result = DiffChunksSchema.safeParse([chunk({ op: "replace" })]);
    expect(result.success).toBe(false);
  });

  it("rejects the legacy 'context' op (renamed to 'equal' in v2)", () => {
    const result = DiffChunksSchema.safeParse([chunk({ op: "context" })]);
    expect(result.success).toBe(false);
  });

  it("rejects the legacy 'elision' op (substituted into baseline in v2)", () => {
    const result = DiffChunksSchema.safeParse([chunk({ op: "elision" })]);
    expect(result.success).toBe(false);
  });

  it("rejects a chunk carrying the legacy anchor field (strict)", () => {
    const result = DiffChunksSchema.safeParse([
      { ...chunk(), anchor: { baseline_offset: 0, baseline_length: 0 } },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid section_id", () => {
    const result = DiffChunksSchema.safeParse([chunk({ section_id: "Not Valid" })]);
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on the chunk (strict)", () => {
    const result = DiffChunksSchema.safeParse([{ ...chunk(), confidence: 0.9 }]);
    expect(result.success).toBe(false);
  });
});
