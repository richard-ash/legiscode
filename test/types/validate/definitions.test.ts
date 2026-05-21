import { describe, expect, it } from "vitest";
import { DefinitionsFileSchema } from "@/types";

describe("DefinitionsFileSchema", () => {
  it("accepts a single-section term (array length 1)", () => {
    const result = DefinitionsFileSchema.parse({
      "Director of Transportation": [{ defined_in_section: "10.04.020" }],
    });
    expect(result["Director of Transportation"]).toHaveLength(1);
  });

  it("accepts a multi-section term (array length > 1)", () => {
    const result = DefinitionsFileSchema.parse({
      Bicycle: [{ defined_in_section: "10.04.020" }, { defined_in_section: "10.04.040" }],
    });
    expect(result.Bicycle).toHaveLength(2);
  });

  it("rejects bad section IDs in the value", () => {
    const result = DefinitionsFileSchema.safeParse({
      Director: [{ defined_in_section: "INVALID" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty value arrays (.min(1))", () => {
    const result = DefinitionsFileSchema.safeParse({ Director: [] });
    expect(result.success).toBe(false);
  });

  it("rejects bad term keys (whitespace)", () => {
    const result = DefinitionsFileSchema.safeParse({
      " Director ": [{ defined_in_section: "10.04.020" }],
    });
    expect(result.success).toBe(false);
  });

  it("does NOT use SectionIdSchema for keys (negative case)", () => {
    // A term like "Director of Transportation" must be accepted; it would
    // be rejected if we'd wrongly used SectionIdSchema for keys.
    const result = DefinitionsFileSchema.parse({
      "Director of Transportation": [{ defined_in_section: "10.04.020" }],
    });
    expect(Object.keys(result)).toContain("Director of Transportation");
  });

  it("does NOT silently transform/normalize keys", () => {
    // Round-trip identity: parsed key === input key.
    const input = "Director of Transportation";
    const parsed = DefinitionsFileSchema.parse({
      [input]: [{ defined_in_section: "10.04.020" }],
    });
    expect(Object.keys(parsed)).toEqual([input]);
  });

  it("section-id-shaped strings are accepted as terms", () => {
    // Proves the key validator is term-shaped, not section-id-shaped: a
    // value that happens to look like a section id is still a term.
    const result = DefinitionsFileSchema.parse({
      "10.04.020": [{ defined_in_section: "10.04.020" }],
    });
    expect(Object.keys(result)).toEqual(["10.04.020"]);
  });
});
