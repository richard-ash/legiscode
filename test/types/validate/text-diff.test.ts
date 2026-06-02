import { describe, expect, it } from "vitest";
import { TextDiffSchema } from "@/types";

function span(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    op: "insert",
    text: "new text",
    section_id: "10.04.020",
    anchor: { baseline_offset: 0, baseline_length: 0 },
    ...overrides,
  };
}

describe("TextDiffSchema", () => {
  it("accepts an empty diff", () => {
    expect(TextDiffSchema.parse([])).toEqual([]);
  });

  it("accepts an insert span (baseline_length 0 at the insertion offset)", () => {
    expect(() => TextDiffSchema.parse([span()])).not.toThrow();
  });

  it("accepts a delete span (baseline_length > 0)", () => {
    expect(() =>
      TextDiffSchema.parse([
        span({ op: "delete", text: "old", anchor: { baseline_offset: 12, baseline_length: 3 } }),
      ]),
    ).not.toThrow();
  });

  it("accepts a context span", () => {
    expect(() =>
      TextDiffSchema.parse([
        span({
          op: "context",
          text: "unchanged prose",
          anchor: { baseline_offset: 0, baseline_length: 15 },
        }),
      ]),
    ).not.toThrow();
  });

  it("accepts an elision span (wildcard gap: baseline_length must be 0)", () => {
    expect(() =>
      TextDiffSchema.parse([
        span({
          op: "elision",
          text: "* * * *",
          anchor: { baseline_offset: 100, baseline_length: 0 },
        }),
      ]),
    ).not.toThrow();
  });

  it("rejects elision with non-zero baseline_length", () => {
    const result = TextDiffSchema.safeParse([
      span({
        op: "elision",
        text: "* * * *",
        anchor: { baseline_offset: 0, baseline_length: 5 },
      }),
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown op", () => {
    const result = TextDiffSchema.safeParse([span({ op: "replace" })]);
    expect(result.success).toBe(false);
  });

  it("rejects a span without anchor (anchor is required at v3)", () => {
    const { anchor: _omit, ...incomplete } = span();
    const result = TextDiffSchema.safeParse([incomplete]);
    expect(result.success).toBe(false);
  });

  it("rejects negative baseline_offset", () => {
    const result = TextDiffSchema.safeParse([
      span({ anchor: { baseline_offset: -1, baseline_length: 0 } }),
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects negative baseline_length", () => {
    const result = TextDiffSchema.safeParse([
      span({ anchor: { baseline_offset: 0, baseline_length: -3 } }),
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer offsets", () => {
    const result = TextDiffSchema.safeParse([
      span({ anchor: { baseline_offset: 1.5, baseline_length: 0 } }),
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid section_id", () => {
    const result = TextDiffSchema.safeParse([span({ section_id: "Not Valid" })]);
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on anchor (strict)", () => {
    const result = TextDiffSchema.safeParse([
      span({ anchor: { baseline_offset: 0, baseline_length: 0, extra: 1 } }),
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on the span (strict)", () => {
    const result = TextDiffSchema.safeParse([{ ...span(), confidence: 0.9 }]);
    expect(result.success).toBe(false);
  });
});
