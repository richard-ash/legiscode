import { describe, expect, it } from "vitest";
import { ScopeExprSchema } from "@/types";

describe("ScopeExprSchema", () => {
  describe("hierarchy", () => {
    it("parses a hierarchy scope with a non-empty prefix array", () => {
      const result = ScopeExprSchema.parse({
        kind: "hierarchy",
        prefix: ["Housing Code", "Preface", "Chapter 4 Definitions"],
      });
      expect(result).toEqual({
        kind: "hierarchy",
        prefix: ["Housing Code", "Preface", "Chapter 4 Definitions"],
      });
    });

    it("parses a hierarchy scope with an empty prefix array (degenerate top-of-hierarchy)", () => {
      const result = ScopeExprSchema.parse({ kind: "hierarchy", prefix: [] });
      expect(result).toEqual({ kind: "hierarchy", prefix: [] });
    });

    it("rejects empty-string entries in prefix", () => {
      const result = ScopeExprSchema.safeParse({
        kind: "hierarchy",
        prefix: ["Housing Code", ""],
      });
      expect(result.success).toBe(false);
    });

    it("rejects a hierarchy scope missing prefix", () => {
      const result = ScopeExprSchema.safeParse({ kind: "hierarchy" });
      expect(result.success).toBe(false);
    });

    it("rejects extra fields under strict()", () => {
      const result = ScopeExprSchema.safeParse({
        kind: "hierarchy",
        prefix: ["Housing Code"],
        extra: "no",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("module", () => {
    it("parses a module scope (manifest-declared)", () => {
      const result = ScopeExprSchema.parse({ kind: "module" });
      expect(result).toEqual({ kind: "module" });
    });

    it("rejects extra fields under strict()", () => {
      const result = ScopeExprSchema.safeParse({ kind: "module", module_id: "sf-housing" });
      expect(result.success).toBe(false);
    });
  });

  describe("cross_module", () => {
    it("parses a cross_module scope with a valid module_id", () => {
      const result = ScopeExprSchema.parse({ kind: "cross_module", module_id: "sf-charter" });
      expect(result).toEqual({ kind: "cross_module", module_id: "sf-charter" });
    });

    it("rejects a cross_module scope missing module_id", () => {
      const result = ScopeExprSchema.safeParse({ kind: "cross_module" });
      expect(result.success).toBe(false);
    });

    it("rejects a cross_module scope with a non-kebab module_id", () => {
      const result = ScopeExprSchema.safeParse({ kind: "cross_module", module_id: "SF Charter" });
      expect(result.success).toBe(false);
    });
  });

  it("rejects an unknown kind discriminator", () => {
    const result = ScopeExprSchema.safeParse({ kind: "global", prefix: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a missing kind discriminator", () => {
    const result = ScopeExprSchema.safeParse({ prefix: ["X"] });
    expect(result.success).toBe(false);
  });
});
