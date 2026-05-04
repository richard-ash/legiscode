import { describe, expect, it } from "vitest";
import { EntryRefSchema } from "@/types";

describe("EntryRefSchema", () => {
  it("accepts a section EntryRef", () => {
    const result = EntryRefSchema.safeParse({
      module_id: "sf-transportation",
      kind: "section",
      id: "1.234",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an appendix EntryRef", () => {
    const result = EntryRefSchema.safeParse({
      module_id: "sf-building",
      kind: "appendix",
      id: "article-10-appendix-a",
    });
    expect(result.success).toBe(true);
  });

  it("accepts ordinance_history and resolution_history kinds", () => {
    expect(
      EntryRefSchema.safeParse({
        module_id: "sf-transportation",
        kind: "ordinance_history",
        id: "2023-ordinances",
      }).success,
    ).toBe(true);
    expect(
      EntryRefSchema.safeParse({
        module_id: "sf-transportation",
        kind: "resolution_history",
        id: "2023-resolutions",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid module_id", () => {
    const result = EntryRefSchema.safeParse({
      module_id: "INVALID",
      kind: "section",
      id: "1.234",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing module_id (required, not optional)", () => {
    const result = EntryRefSchema.safeParse({ kind: "section", id: "1.234" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown kind", () => {
    const result = EntryRefSchema.safeParse({
      module_id: "sf-transportation",
      kind: "made-up",
      id: "1.234",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty id", () => {
    const result = EntryRefSchema.safeParse({
      module_id: "sf-transportation",
      kind: "section",
      id: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields under strict()", () => {
    const result = EntryRefSchema.safeParse({
      module_id: "sf-transportation",
      kind: "section",
      id: "1.234",
      extra: "no",
    });
    expect(result.success).toBe(false);
  });
});
