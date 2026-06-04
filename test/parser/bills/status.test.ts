import { describe, expect, it } from "vitest";
import {
  type ActionHistoryRow,
  auditStatusAgainstHistory,
  mapLegistarStatusToBillStatus,
} from "@/parser/bills/status";

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

  it("maps signed-by-Mayor variants to enacted", () => {
    expect(mapLegistarStatusToBillStatus("Signed by Mayor").status).toBe("enacted");
    expect(mapLegistarStatusToBillStatus("Signed by the Mayor on 4/12/2026").status).toBe(
      "enacted",
    );
    expect(mapLegistarStatusToBillStatus("Effective 6/1/2026").status).toBe("enacted");
    expect(mapLegistarStatusToBillStatus("Enacted - Mayor's signature").status).toBe("enacted");
  });

  it("keeps awaiting-Mayor as enrolled (NOT enacted)", () => {
    // "Awaiting Mayor's signature" carries the word "signature" but the
    // bill is still in flight. The pre-passage qualifier must fire
    // before the enacted matchers.
    expect(mapLegistarStatusToBillStatus("Awaiting Mayor's signature").status).toBe("enrolled");
    expect(mapLegistarStatusToBillStatus("Awaiting the Mayor").status).toBe("enrolled");
  });

  it("maps vetoed variants to vetoed", () => {
    expect(mapLegistarStatusToBillStatus("Vetoed").status).toBe("vetoed");
    expect(mapLegistarStatusToBillStatus("Veto sustained").status).toBe("vetoed");
  });

  it("maps withdrawn / rescinded to withdrawn", () => {
    expect(mapLegistarStatusToBillStatus("Withdrawn by sponsor").status).toBe("withdrawn");
    expect(mapLegistarStatusToBillStatus("Motion rescinded").status).toBe("withdrawn");
  });

  it("maps failed / defeated / tabled to failed", () => {
    expect(mapLegistarStatusToBillStatus("Failed on Board vote").status).toBe("failed");
    expect(mapLegistarStatusToBillStatus("Defeated").status).toBe("failed");
    expect(mapLegistarStatusToBillStatus("Tabled indefinitely").status).toBe("failed");
  });
});

describe("auditStatusAgainstHistory", () => {
  const enactedHistory: ActionHistoryRow[] = [
    { date: "2026-03-01", action: "Referred to Land Use Committee" },
    { date: "2026-04-10", action: "Passed second reading" },
    { date: "2026-04-15", action: "Signed by Mayor" },
  ];

  it("returns null when mapped status agrees with history terminal event", () => {
    const result = auditStatusAgainstHistory({
      legistarStatus: "Effective",
      mappedStatus: "enacted",
      history: enactedHistory,
    });
    expect(result).toBeNull();
  });

  it("returns null when history has no terminal events", () => {
    const result = auditStatusAgainstHistory({
      legistarStatus: "Pending — Land Use Committee",
      mappedStatus: "committee",
      history: [{ date: "2026-03-01", action: "Referred to Land Use Committee" }],
    });
    expect(result).toBeNull();
  });

  it("escalates when mapped status disagrees with a Mayor-signing history row", () => {
    const result = auditStatusAgainstHistory({
      legistarStatus: "Pending Committee Hearing",
      mappedStatus: "committee",
      history: enactedHistory,
    });
    expect(result).not.toBeNull();
    expect(result?.mapped_status).toBe("committee");
    expect(result?.implied_status).toBe("enacted");
    expect(result?.evidence.action).toMatch(/Signed by Mayor/);
  });

  it("escalates when mapped status disagrees with a veto history row", () => {
    const result = auditStatusAgainstHistory({
      legistarStatus: "Enrolled",
      mappedStatus: "enrolled",
      history: [
        { date: "2026-04-10", action: "Passed second reading" },
        { date: "2026-04-20", action: "Vetoed by Mayor" },
      ],
    });
    expect(result?.implied_status).toBe("vetoed");
  });
});
