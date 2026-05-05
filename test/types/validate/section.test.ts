import { describe, expect, it } from "vitest";
import { SectionFileSchema } from "@/types";

const validSection = {
  id: "10.04.020",
  title: "Definitions",
  text: "...",
  citations: [],
  defined_terms: [],
  hierarchy: ["title-10", "ch-10.04"],
};

describe("SectionFileSchema", () => {
  it("accepts a minimal section", () => {
    expect(SectionFileSchema.parse(validSection).id).toBe("10.04.020");
  });

  it("defaults kind to 'section' when omitted", () => {
    expect(SectionFileSchema.parse(validSection).kind).toBe("section");
  });

  it("defaults editorial_status to 'active' when omitted", () => {
    expect(SectionFileSchema.parse(validSection).editorial_status).toBe("active");
  });

  it("rejects an invalid section id", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, id: "INVALID ID" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("id");
    }
  });

  it("rejects extra fields under strict()", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field", () => {
    const { text: _text, ...incomplete } = validSection;
    const result = SectionFileSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("text");
    }
  });

  it("rejects wrong field type", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      hierarchy: "title-10",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("hierarchy");
    }
  });

  it("rejects kind: 'section' written with the wrong literal value", () => {
    const result = SectionFileSchema.safeParse({ ...validSection, kind: "appendix" });
    expect(result.success).toBe(false);
  });

  it("accepts editorial_status: 'reserved' / 'repealed' / 'redesignated'", () => {
    for (const status of ["reserved", "repealed", "redesignated"] as const) {
      const result = SectionFileSchema.safeParse({ ...validSection, editorial_status: status });
      expect(result.success).toBe(true);
    }
  });

  it("accepts redirect_to when editorial_status is 'redesignated'", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      editorial_status: "redesignated",
      redirect_to: "10.05.020",
    });
    expect(result.success).toBe(true);
  });

  it("rejects redirect_to when editorial_status is not 'redesignated'", () => {
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        editorial_status: "active",
        redirect_to: "10.05.020",
      }).success,
    ).toBe(false);
    expect(
      SectionFileSchema.safeParse({
        ...validSection,
        editorial_status: "repealed",
        redirect_to: "10.05.020",
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid redirect_to id", () => {
    const result = SectionFileSchema.safeParse({
      ...validSection,
      editorial_status: "redesignated",
      redirect_to: "INVALID",
    });
    expect(result.success).toBe(false);
  });
});
