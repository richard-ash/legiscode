import { describe, expect, it } from "vitest";
import { CitationSchema, CitationTargetSchema } from "@/types";

describe("CitationTargetSchema (internal)", () => {
  it("accepts a bare internal target", () => {
    const result = CitationTargetSchema.parse({ kind: "internal", section_id: "10.04.020" });
    expect(result.kind).toBe("internal");
  });

  it("accepts internal with subsection", () => {
    const result = CitationTargetSchema.parse({
      kind: "internal",
      section_id: "10.04.020",
      subsection: "(a)(2)",
    });
    expect(result.kind === "internal" && result.subsection).toBe("(a)(2)");
  });

  it("accepts internal with range when section_id equals range.from", () => {
    const result = CitationTargetSchema.parse({
      kind: "internal",
      section_id: "10.04.020",
      range: { from: "10.04.020", to: "10.04.030" },
    });
    expect(result.kind === "internal" && result.range?.to).toBe("10.04.030");
  });

  it("rejects internal with range when section_id differs from range.from", () => {
    const result = CitationTargetSchema.safeParse({
      kind: "internal",
      section_id: "10.04.020",
      range: { from: "10.04.025", to: "10.04.030" },
    });
    expect(result.success).toBe(false);
  });
});

describe("CitationTargetSchema (cross_module)", () => {
  it("accepts a cross-module target with subsection", () => {
    const result = CitationTargetSchema.parse({
      kind: "cross_module",
      module_id: "ca-vehicle",
      section_id: "22358",
      subsection: "(a)",
    });
    expect(result.kind).toBe("cross_module");
  });

  it("rejects cross_module with mismatched range/section_id", () => {
    const result = CitationTargetSchema.safeParse({
      kind: "cross_module",
      module_id: "ca-vehicle",
      section_id: "22358",
      range: { from: "22359", to: "22360" },
    });
    expect(result.success).toBe(false);
  });
});

describe("CitationTargetSchema (structural + vague)", () => {
  it("accepts a structural target", () => {
    const result = CitationTargetSchema.parse({
      kind: "structural",
      level: "article",
      number: "5",
    });
    expect(result).toEqual({ kind: "structural", level: "article", number: "5" });
  });

  it("rejects a structural target with an unknown level", () => {
    expect(
      CitationTargetSchema.safeParse({ kind: "structural", level: "subarticle", number: "5" })
        .success,
    ).toBe(false);
  });

  it("accepts vague", () => {
    const result = CitationTargetSchema.parse({ kind: "vague", raw: "the previous section" });
    expect(result.kind).toBe("vague");
  });

  it("rejects unknown kind", () => {
    expect(CitationTargetSchema.safeParse({ kind: "wat", raw: "x" }).success).toBe(false);
  });

  it("rejects the removed external kind (post-refoundation)", () => {
    expect(
      CitationTargetSchema.safeParse({ kind: "external", raw: "Cal. Veh. Code § 22358" }).success,
    ).toBe(false);
  });
});

describe("CitationTargetSchema (internal_appendix)", () => {
  it("accepts an internal_appendix target", () => {
    const result = CitationTargetSchema.parse({
      kind: "internal_appendix",
      appendix_id: "article-10-appendix-a",
    });
    expect(result.kind).toBe("internal_appendix");
  });

  it("rejects internal_appendix with malformed appendix_id", () => {
    expect(
      CitationTargetSchema.safeParse({
        kind: "internal_appendix",
        appendix_id: "Article 10, Appendix A",
      }).success,
    ).toBe(false);
  });

  it("rejects internal_appendix with extra fields under strict", () => {
    expect(
      CitationTargetSchema.safeParse({
        kind: "internal_appendix",
        appendix_id: "article-10-appendix-a",
        section_id: "1.234",
      }).success,
    ).toBe(false);
  });
});

// Phase 1 — section-ref carries an anchor-bound citation target produced
// by the build-time binder. The discriminated union routes on `kind`;
// the resolver collapses to a titleMap lookup once these supersede the
// legacy internal / cross_module variants in Phase 5.
describe("CitationTargetSchema (section-ref)", () => {
  it("accepts a bare section-ref target", () => {
    const result = CitationTargetSchema.parse({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "sf-building",
    });
    expect(result.kind).toBe("section-ref");
  });

  it("accepts section-ref with subsection", () => {
    const result = CitationTargetSchema.parse({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "sf-building",
      subsection: "(a)(2)",
    });
    expect(result.kind === "section-ref" && result.subsection).toBe("(a)(2)");
  });

  it("accepts section-ref with range when anchor_id equals range.from", () => {
    const result = CitationTargetSchema.parse({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "sf-building",
      range: { from: "b102a", to: "b110a" },
    });
    expect(result.kind === "section-ref" && result.range?.to).toBe("b110a");
  });

  it("rejects section-ref with range when anchor_id differs from range.from", () => {
    const result = CitationTargetSchema.safeParse({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "sf-building",
      range: { from: "b110a", to: "b120" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects section-ref with malformed anchor_id", () => {
    const result = CitationTargetSchema.safeParse({
      kind: "section-ref",
      anchor_id: "INVALID ID",
      module_id: "sf-building",
    });
    expect(result.success).toBe(false);
  });

  it("rejects section-ref with malformed module_id", () => {
    const result = CitationTargetSchema.safeParse({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "SF Building",
    });
    expect(result.success).toBe(false);
  });

  it("rejects section-ref with extra fields under strict", () => {
    const result = CitationTargetSchema.safeParse({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "sf-building",
      raw: "should not be allowed",
    });
    expect(result.success).toBe(false);
  });
});

describe("CitationSchema", () => {
  it("requires a non-empty display_text", () => {
    expect(
      CitationSchema.safeParse({
        display_text: "",
        target: { kind: "internal", section_id: "10.04.020" },
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      CitationSchema.safeParse({
        display_text: "§ 10.04.020",
        target: { kind: "internal", section_id: "10.04.020" },
        extra: "no",
      }).success,
    ).toBe(false);
  });
});
