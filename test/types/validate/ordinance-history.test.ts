import { describe, expect, it } from "vitest";
import { OrdinanceHistorySchema } from "@/types";

const ordinanceItem = {
  instrument_kind: "ordinance" as const,
  instrument_number: "Ord. 47-22",
  file_number: "File No. 220123",
  dates: [],
  subject: "An ordinance",
  body: "...",
  raw_text: "raw",
  affected_sections: [],
};

const resolutionItem = {
  ...ordinanceItem,
  instrument_kind: "resolution" as const,
  instrument_number: "Res. 5-22",
};

const validHistory = {
  kind: "ordinance_history" as const,
  id: "2023-ordinances",
  year: 2023,
  module_id: "sf-transportation",
  items: [ordinanceItem],
  source_location: { line: 12000 },
};

describe("OrdinanceHistorySchema", () => {
  it("accepts a valid ordinance history", () => {
    expect(OrdinanceHistorySchema.parse(validHistory).year).toBe(2023);
  });

  it("defaults kind to 'ordinance_history' when omitted", () => {
    const { kind: _omit, ...withoutKind } = validHistory;
    expect(OrdinanceHistorySchema.parse(withoutKind).kind).toBe("ordinance_history");
  });

  it("rejects malformed id", () => {
    const result = OrdinanceHistorySchema.safeParse({ ...validHistory, id: "ordinances-2023" });
    expect(result.success).toBe(false);
  });

  it("rejects mismatch between id and year", () => {
    const result = OrdinanceHistorySchema.safeParse({
      ...validHistory,
      id: "2023-ordinances",
      year: 2022,
    });
    expect(result.success).toBe(false);
  });

  it("rejects items containing a resolution", () => {
    const result = OrdinanceHistorySchema.safeParse({
      ...validHistory,
      items: [ordinanceItem, resolutionItem],
    });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range year", () => {
    expect(
      OrdinanceHistorySchema.safeParse({ ...validHistory, year: 1800, id: "1800-ordinances" })
        .success,
    ).toBe(false);
    expect(
      OrdinanceHistorySchema.safeParse({ ...validHistory, year: 2300, id: "2300-ordinances" })
        .success,
    ).toBe(false);
  });

  it("requires module_id", () => {
    const { module_id: _omit, ...withoutModule } = validHistory;
    const result = OrdinanceHistorySchema.safeParse(withoutModule);
    expect(result.success).toBe(false);
  });

  it("accepts an empty items array (year with no recorded ordinances)", () => {
    const result = OrdinanceHistorySchema.safeParse({ ...validHistory, items: [] });
    expect(result.success).toBe(true);
  });

  it("rejects extra fields under strict()", () => {
    const result = OrdinanceHistorySchema.safeParse({ ...validHistory, extra: "no" });
    expect(result.success).toBe(false);
  });
});
