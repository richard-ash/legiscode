import { describe, expect, it } from "vitest";
import { DefinedTermSchema, ModuleIdSchema, SectionIdSchema } from "@/types";

describe("SectionIdSchema", () => {
  it("accepts dotted lowercase identifiers", () => {
    expect(SectionIdSchema.parse("10.04.020")).toBe("10.04.020");
  });

  it("accepts mixed dot/dash/underscore separators", () => {
    expect(SectionIdSchema.parse("title-10_chapter-04")).toBe("title-10_chapter-04");
  });

  it("rejects empty", () => {
    expect(SectionIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects leading slash", () => {
    expect(SectionIdSchema.safeParse("/10.04.020").success).toBe(false);
  });

  it("rejects spaces", () => {
    expect(SectionIdSchema.safeParse("10 04 020").success).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(SectionIdSchema.safeParse("10.04.020A").success).toBe(false);
  });
});

describe("ModuleIdSchema", () => {
  it("accepts kebab-case", () => {
    expect(ModuleIdSchema.parse("sf-municipal")).toBe("sf-municipal");
  });

  it("rejects starting with a digit", () => {
    expect(ModuleIdSchema.safeParse("1-municipal").success).toBe(false);
  });

  it("rejects underscores", () => {
    expect(ModuleIdSchema.safeParse("sf_municipal").success).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(ModuleIdSchema.safeParse("SF-Municipal").success).toBe(false);
  });
});

describe("DefinedTermSchema", () => {
  it("accepts a normal term", () => {
    expect(DefinedTermSchema.parse("Director of Transportation")).toBe(
      "Director of Transportation",
    );
  });

  it("accepts section-id-shaped strings as terms", () => {
    expect(DefinedTermSchema.parse("10.04.020")).toBe("10.04.020");
  });

  it("rejects empty", () => {
    expect(DefinedTermSchema.safeParse("").success).toBe(false);
  });

  it("rejects leading whitespace", () => {
    expect(DefinedTermSchema.safeParse(" Director").success).toBe(false);
  });

  it("rejects trailing whitespace", () => {
    expect(DefinedTermSchema.safeParse("Director ").success).toBe(false);
  });

  it("rejects doubled internal whitespace", () => {
    expect(DefinedTermSchema.safeParse("Director  of  Transportation").success).toBe(false);
  });

  it("rejects > 200 chars", () => {
    expect(DefinedTermSchema.safeParse("x".repeat(201)).success).toBe(false);
  });

  it("does not transform inputs (round-trip identity for accepted keys)", () => {
    const inputs = ["Director of Transportation", "10.04.020", "Bicycle", "x".repeat(200)];
    for (const input of inputs) {
      const parsed = DefinedTermSchema.parse(input);
      expect(parsed).toBe(input);
      expect(parsed.length).toBe(input.length);
    }
  });
});
