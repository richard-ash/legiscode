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

describe("CitationTargetSchema (external + vague)", () => {
  it("accepts external with raw only", () => {
    const result = CitationTargetSchema.parse({
      kind: "external",
      raw: "Cal. Veh. Code § 22358",
    });
    expect(result.kind).toBe("external");
  });

  it("accepts external with parsed", () => {
    const result = CitationTargetSchema.parse({
      kind: "external",
      raw: "Cal. Veh. Code § 22358(a)",
      parsed: { jurisdiction: "ca", code: "veh", section: "22358", subsection: "(a)" },
    });
    expect(result.kind === "external" && result.parsed?.section).toBe("22358");
  });

  it("accepts vague", () => {
    const result = CitationTargetSchema.parse({ kind: "vague", raw: "the previous section" });
    expect(result.kind).toBe("vague");
  });

  it("rejects unknown kind", () => {
    expect(CitationTargetSchema.safeParse({ kind: "wat", raw: "x" }).success).toBe(false);
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
