import { describe, expect, it } from "vitest";
import { LegalDateSchema, LegalInstrumentEntrySchema } from "@/types";

const validOrdinanceItem = {
  instrument_kind: "ordinance" as const,
  instrument_number: "Ord. 47-22",
  file_number: "File No. 220123",
  dates: [
    { kind: "adopted" as const, iso_value: "2022-04-12", raw_text: "Adopted April 12, 2022" },
    { kind: "effective" as const, iso_value: "2022-05-12", raw_text: "Effective May 12, 2022" },
  ],
  subject: "Amending the Public Works Code",
  body: "Body text of the ordinance summary...",
  raw_text: "Full original text from the digest",
  affected_sections: [{ raw_text: "Sec. 1.234", resolved_id: "1.234" }],
};

describe("LegalDateSchema", () => {
  it("accepts a known date kind with iso_value", () => {
    const result = LegalDateSchema.safeParse({
      kind: "approved",
      iso_value: "2023-01-15",
      raw_text: "Approved January 15, 2023",
    });
    expect(result.success).toBe(true);
  });

  it("accepts iso_value: null when source date isn't parseable", () => {
    const result = LegalDateSchema.safeParse({
      kind: "other",
      iso_value: null,
      raw_text: "Adopted in late January 2023",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown date kinds", () => {
    const result = LegalDateSchema.safeParse({
      kind: "ratified",
      iso_value: null,
      raw_text: "Ratified",
    });
    expect(result.success).toBe(false);
  });

  it("requires raw_text", () => {
    const result = LegalDateSchema.safeParse({
      kind: "adopted",
      iso_value: "2023-01-15",
      raw_text: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("LegalInstrumentEntrySchema", () => {
  it("accepts a valid ordinance entry", () => {
    expect(LegalInstrumentEntrySchema.parse(validOrdinanceItem).instrument_kind).toBe("ordinance");
  });

  it("accepts a valid resolution entry", () => {
    const result = LegalInstrumentEntrySchema.safeParse({
      ...validOrdinanceItem,
      instrument_kind: "resolution",
      instrument_number: "Res. 123-22",
    });
    expect(result.success).toBe(true);
  });

  it("accepts file_number: null", () => {
    const result = LegalInstrumentEntrySchema.safeParse({
      ...validOrdinanceItem,
      file_number: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty dates array", () => {
    const result = LegalInstrumentEntrySchema.safeParse({ ...validOrdinanceItem, dates: [] });
    expect(result.success).toBe(true);
  });

  it("defaults affected_sections to empty array", () => {
    const { affected_sections: _omit, ...withoutAffected } = validOrdinanceItem;
    expect(LegalInstrumentEntrySchema.parse(withoutAffected).affected_sections).toEqual([]);
  });

  it("accepts affected_sections with resolved_id: null (unresolved)", () => {
    const result = LegalInstrumentEntrySchema.safeParse({
      ...validOrdinanceItem,
      affected_sections: [{ raw_text: "Sec. 1.234 (a)", resolved_id: null }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown instrument_kind", () => {
    const result = LegalInstrumentEntrySchema.safeParse({
      ...validOrdinanceItem,
      instrument_kind: "directive",
    });
    expect(result.success).toBe(false);
  });

  it("requires instrument_number to be non-empty", () => {
    const result = LegalInstrumentEntrySchema.safeParse({
      ...validOrdinanceItem,
      instrument_number: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields under strict()", () => {
    const result = LegalInstrumentEntrySchema.safeParse({ ...validOrdinanceItem, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("preserves raw_text always (even when structured fields are populated)", () => {
    const parsed = LegalInstrumentEntrySchema.parse(validOrdinanceItem);
    expect(parsed.raw_text).toBe("Full original text from the digest");
  });
});
