import { describe, expect, it } from "vitest";
import { ReferencesFileSchema } from "@/types";

const sectionRef = (moduleId: string, id: string) => ({
  module_id: moduleId,
  kind: "section" as const,
  id,
});

describe("ReferencesFileSchema", () => {
  it("accepts a valid references map", () => {
    const result = ReferencesFileSchema.parse({
      "10.04.020": {
        citations: [
          {
            display_text: "§ 10.04.030",
            target: { kind: "internal", section_id: "10.04.030" },
          },
        ],
        cited_by: [sectionRef("sf-transportation", "10.04.040")],
      },
    });
    expect(Object.keys(result)).toEqual(["10.04.020"]);
  });

  it("accepts an empty references map", () => {
    expect(ReferencesFileSchema.parse({})).toEqual({});
  });

  it("rejects invalid section-id keys", () => {
    const result = ReferencesFileSchema.safeParse({
      "INVALID KEY": { citations: [], cited_by: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed EntryRef in cited_by (string instead of object)", () => {
    const result = ReferencesFileSchema.safeParse({
      "10.04.020": { citations: [], cited_by: ["10.04.040"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects EntryRef with invalid module_id", () => {
    const result = ReferencesFileSchema.safeParse({
      "10.04.020": {
        citations: [],
        cited_by: [{ module_id: "INVALID MODULE", kind: "section", id: "10.04.040" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects EntryRef with unknown kind", () => {
    const result = ReferencesFileSchema.safeParse({
      "10.04.020": {
        citations: [],
        cited_by: [{ module_id: "sf-transportation", kind: "made-up", id: "x" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts cross-module EntryRef in cited_by", () => {
    const result = ReferencesFileSchema.safeParse({
      "10.04.020": {
        citations: [],
        cited_by: [sectionRef("sf-transportation", "10.04.040"), sectionRef("sf-charter", "5.10")],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts non-section kinds in cited_by", () => {
    const result = ReferencesFileSchema.safeParse({
      "10.04.020": {
        citations: [],
        cited_by: [
          { module_id: "sf-transportation", kind: "ordinance_history", id: "2023-ordinances" },
          { module_id: "sf-transportation", kind: "appendix", id: "article-10-appendix-a" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("carries every citation kind through unchanged", () => {
    const parsed = ReferencesFileSchema.parse({
      "10.04.020": {
        citations: [
          { display_text: "§ 10.04.030", target: { kind: "internal", section_id: "10.04.030" } },
          {
            display_text: "Cal. Veh. Code § 22358",
            target: { kind: "external", raw: "Cal. Veh. Code § 22358" },
          },
          {
            display_text: "the previous section",
            target: { kind: "vague", raw: "the previous section" },
          },
          {
            display_text: "Appendix M",
            target: { kind: "internal_appendix", appendix_id: "article-10-appendix-m" },
          },
        ],
        cited_by: [],
      },
    });
    expect(parsed["10.04.020"]?.citations).toHaveLength(4);
  });
});
