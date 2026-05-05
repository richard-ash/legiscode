import { describe, expect, it } from "vitest";
import { AppendixSchema } from "@/types";

const validAppendix = {
  kind: "appendix" as const,
  id: "article-10-appendix-a",
  parent: { kind: "article" as const, number: 10 },
  letter: "a",
  title: "Land Use Categories",
  body: "...",
  figures: [],
  source_location: { line: 12345 },
};

describe("AppendixSchema", () => {
  it("accepts a valid appendix", () => {
    expect(AppendixSchema.parse(validAppendix).id).toBe("article-10-appendix-a");
  });

  it("accepts a chapter-parented appendix", () => {
    const result = AppendixSchema.safeParse({
      ...validAppendix,
      id: "chapter-10-appendix-b",
      parent: { kind: "chapter", number: 10 },
      letter: "b",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an article-600 form appendix", () => {
    const result = AppendixSchema.safeParse({
      ...validAppendix,
      id: "article-600-appendix-a",
      parent: { kind: "article", number: 600 },
    });
    expect(result.success).toBe(true);
  });

  it("defaults kind to 'appendix' when omitted", () => {
    const { kind: _omit, ...withoutKind } = validAppendix;
    expect(AppendixSchema.parse(withoutKind).kind).toBe("appendix");
  });

  it("defaults figures to empty array", () => {
    const { figures: _omit, ...withoutFigures } = validAppendix;
    expect(AppendixSchema.parse(withoutFigures).figures).toEqual([]);
  });

  it("rejects malformed id slug", () => {
    const result = AppendixSchema.safeParse({ ...validAppendix, id: "Article 10, Appendix A" });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase letter", () => {
    const result = AppendixSchema.safeParse({ ...validAppendix, letter: "A" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown parent.kind", () => {
    const result = AppendixSchema.safeParse({
      ...validAppendix,
      parent: { kind: "division", number: 10 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields under strict()", () => {
    const result = AppendixSchema.safeParse({ ...validAppendix, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("accepts a figure with image_url and caption", () => {
    const result = AppendixSchema.safeParse({
      ...validAppendix,
      figures: [
        {
          caption: "Figure 1 — Zoning Map",
          image_url: "https://example.com/figure1.png",
          source_location: { line: 12350 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a figure with null image_url", () => {
    const result = AppendixSchema.safeParse({
      ...validAppendix,
      figures: [
        {
          caption: "Figure 1",
          image_url: null,
          source_location: { line: 12350 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
