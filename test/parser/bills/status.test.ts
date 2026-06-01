import { describe, expect, it } from "vitest";
import { mapLegistarStatusToBillStatus } from "@/parser/bills/status";

describe("mapLegistarStatusToBillStatus", () => {
  it("maps committee-pending free-text to committee", () => {
    expect(mapLegistarStatusToBillStatus("Pending — Land Use Committee")).toEqual({
      status: "committee",
      unmatched: false,
    });
    expect(mapLegistarStatusToBillStatus("Continued — Rules Committee")).toEqual({
      status: "committee",
      unmatched: false,
    });
    expect(mapLegistarStatusToBillStatus("Pending Committee Hearing")).toEqual({
      status: "committee",
      unmatched: false,
    });
  });

  it("maps board reading to floor", () => {
    expect(mapLegistarStatusToBillStatus("Pending — Second Reading").status).toBe("floor");
    expect(mapLegistarStatusToBillStatus("Board Vote Scheduled").status).toBe("floor");
  });

  it("maps engrossed forms to engrossed", () => {
    expect(mapLegistarStatusToBillStatus("Engrossed").status).toBe("engrossed");
    expect(mapLegistarStatusToBillStatus("Passed Committee — Engrossed").status).toBe("engrossed");
  });

  it("maps enrolled / awaiting-mayor variants to enrolled", () => {
    expect(mapLegistarStatusToBillStatus("Enrolled").status).toBe("enrolled");
    expect(mapLegistarStatusToBillStatus("Awaiting Mayor's signature").status).toBe("enrolled");
  });

  it("maps filed / introduced variants to filed", () => {
    expect(mapLegistarStatusToBillStatus("Filed").status).toBe("filed");
    expect(mapLegistarStatusToBillStatus("Introduced").status).toBe("filed");
    expect(mapLegistarStatusToBillStatus("Pending Assignment").status).toBe("filed");
  });

  it("flags unmatched statuses with unmatched=true and falls back to filed", () => {
    const r = mapLegistarStatusToBillStatus("Some Future Legistar Verbiage");
    expect(r.status).toBe("filed");
    expect(r.unmatched).toBe(true);
  });

  it("prefers enrolled over committee when both words appear in the status", () => {
    // First-match-wins ordering means the more-specific later-stage match
    // fires before the generic "committee" catch.
    const r = mapLegistarStatusToBillStatus("Enrolled — moved out of committee");
    expect(r.status).toBe("enrolled");
  });
});
