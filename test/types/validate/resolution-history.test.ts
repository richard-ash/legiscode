import { describe, expect, it } from "vitest";
import { ResolutionHistorySchema } from "@/types";

const resolutionItem = {
  instrument_kind: "resolution" as const,
  instrument_number: "Res. 12-23",
  file_number: null,
  dates: [],
  subject: "Urging the state",
  body: "...",
  raw_text: "raw",
  affected_sections: [],
};

const ordinanceItem = {
  ...resolutionItem,
  instrument_kind: "ordinance" as const,
  instrument_number: "Ord. 1-23",
};

const validHistory = {
  kind: "resolution_history" as const,
  id: "2023-resolutions",
  year: 2023,
  module_id: "sf-transportation",
  items: [resolutionItem],
  source_location: { line: 13000 },
};

describe("ResolutionHistorySchema", () => {
  it("accepts a valid resolution history", () => {
    expect(ResolutionHistorySchema.parse(validHistory).year).toBe(2023);
  });

  it("defaults kind to 'resolution_history' when omitted", () => {
    const { kind: _omit, ...withoutKind } = validHistory;
    expect(ResolutionHistorySchema.parse(withoutKind).kind).toBe("resolution_history");
  });

  it("rejects malformed id", () => {
    const result = ResolutionHistorySchema.safeParse({ ...validHistory, id: "2023-ordinances" });
    expect(result.success).toBe(false);
  });

  it("rejects items containing an ordinance", () => {
    const result = ResolutionHistorySchema.safeParse({
      ...validHistory,
      items: [resolutionItem, ordinanceItem],
    });
    expect(result.success).toBe(false);
  });

  it("rejects mismatch between id and year", () => {
    const result = ResolutionHistorySchema.safeParse({
      ...validHistory,
      id: "2023-resolutions",
      year: 2024,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty items array", () => {
    const result = ResolutionHistorySchema.safeParse({ ...validHistory, items: [] });
    expect(result.success).toBe(true);
  });

  it("rejects extra fields under strict()", () => {
    const result = ResolutionHistorySchema.safeParse({ ...validHistory, extra: "no" });
    expect(result.success).toBe(false);
  });
});
