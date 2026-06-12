// /bills/{file_no}/impact — composed impact report over the hermetic
// corpus-min fixture. Three fixture bills cover the parse shapes the
// real packet exhibits: 990001 (ok), 990002 (body_only, like prod
// 260538), 990003 (partial with no_baseline + unresolved outcomes).

import { describe, expect, it } from "vitest";
import type { Bill } from "@/types";
import { dispatchTool } from "../../../electron/ai/tool-router";
import { buildBillImpact } from "../../../electron/ai/tools/bill-impact";
import type { ToolContext } from "../../../electron/ai/tools/read";
import type { AiCorpusModule } from "../../../electron/corpus-loader";
import { loadFixtureCorpus } from "./load-fixture-corpus";

const TURN = 7;

interface ImpactShape {
  kind: string;
  impact: {
    file_no: string;
    module_id: string;
    parse_status: string;
    affected_section_ids: readonly string[];
    sections: readonly {
      module_id: string;
      section_id: string;
      status: string;
      change_kind: string;
      diff_stats: { inserted_words: number; deleted_words: number } | null;
      diff_path: string;
      section_path: string | null;
    }[];
    outcome_counts: Record<string, number>;
    risk_flags: readonly { flag: string; detail: string }[];
    cross_module_touches: readonly string[];
    truncated: boolean;
  };
}

async function readImpact(path: string) {
  const corpus = await loadFixtureCorpus();
  return dispatchTool({ toolUseId: "u1", name: "read", input: { path } }, { corpus, turnId: TURN });
}

describe("read /bills/{file_no}/impact", () => {
  it("reports a clean revised row with diff word counts for an ok bill", async () => {
    const result = await readImpact("/bills/990001/impact");
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as ImpactShape;
    expect(payload.kind).toBe("bill-impact");
    expect(payload.impact.file_no).toBe("990001");
    expect(payload.impact.parse_status).toBe("ok");
    expect(payload.impact.affected_section_ids).toEqual(["1.1"]);
    expect(payload.impact.sections).toHaveLength(1);
    const row = payload.impact.sections[0];
    expect(row?.status).toBe("anchored");
    expect(row?.change_kind).toBe("revised");
    // 990001 inserts " (revised by Ord. 990001)" — 4 words, 0 deleted.
    expect(row?.diff_stats).toEqual({ inserted_words: 4, deleted_words: 0 });
    expect(row?.diff_path).toBe("/bills/990001/changes/test-alpha/1.1");
    expect(row?.section_path).toBe("/modules/test-alpha/sections/1.1");
    expect(payload.impact.outcome_counts).toEqual({ anchored: 1 });
    expect(payload.impact.risk_flags).toEqual([]);
    expect(payload.impact.cross_module_touches).toEqual([]);
    expect(payload.impact.truncated).toBe(false);
    // Stats only — the impact payload never fetches section refs.
    expect(result.payload.fetched).toEqual([]);
    expect(result.payload.turn_id).toBe(TURN);
  });

  it("reports a body_only bill honestly: no rows, a body_only risk flag", async () => {
    const result = await readImpact("/bills/990002/impact");
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as ImpactShape;
    expect(payload.impact.parse_status).toBe("body_only");
    expect(payload.impact.affected_section_ids).toEqual([]);
    expect(payload.impact.sections).toEqual([]);
    expect(payload.impact.outcome_counts).toEqual({});
    const flags = payload.impact.risk_flags.map((f) => f.flag);
    expect(flags).toEqual(["body_only"]);
    expect(payload.impact.risk_flags[0]?.detail).toContain("/bills/990002/proposed-text");
  });

  it("orders mixed outcomes revised-first and flags every non-renderable status", async () => {
    const result = await readImpact("/bills/990003/impact");
    expect(result.payload.ok).toBe(true);
    const payload = result.payload as unknown as ImpactShape;
    expect(payload.impact.parse_status).toBe("partial");
    expect(payload.impact.affected_section_ids).toEqual(["1.2", "9.9", "8.8"]);
    expect(payload.impact.sections.map((s) => s.section_id)).toEqual(["1.2", "8.8", "9.9"]);
    expect(payload.impact.sections.map((s) => s.change_kind)).toEqual([
      "revised",
      "unclear",
      "unclear",
    ]);
    // The no_baseline row points at no current section and has no diff.
    const noBaseline = payload.impact.sections.find((s) => s.section_id === "9.9");
    expect(noBaseline?.section_path).toBeNull();
    expect(noBaseline?.diff_stats).toBeNull();
    expect(payload.impact.outcome_counts).toEqual({
      anchored: 1,
      no_baseline: 1,
      unresolved: 1,
    });
    const flags = payload.impact.risk_flags.map((f) => f.flag);
    expect(flags).toContain("partial");
    expect(flags).toContain("no_baseline_sections");
    expect(flags).toContain("unresolved_sections");
    const noBaselineFlag = payload.impact.risk_flags.find((f) => f.flag === "no_baseline_sections");
    expect(noBaselineFlag?.detail).toBe("test-alpha § 9.9");
  });

  it("returns not_found for an unknown file_no", async () => {
    const result = await readImpact("/bills/999999/impact");
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });

  it("rejects trailing segments after /impact", async () => {
    const result = await readImpact("/bills/990001/impact/extra");
    expect(result.payload.ok).toBe(false);
    expect((result.payload as unknown as { reason: string }).reason).toBe("not_found");
  });
});

// ─── buildBillImpact — unit (stub corpus) ───────────────────────────────────
//
// The corpus-min fixture carries only single-module bills with
// insert-only diffs, so the multi-slice union, the remaining
// change-kind arms, the parse-status risk-flag arms, and the row cap
// are exercised here against a hand-built corpus handle.

function makeBill(overrides: Partial<Bill> & Pick<Bill, "file_no" | "module_id">): Bill {
  return {
    short_title: "Stub Bill",
    long_title: "Stub bill for buildBillImpact unit coverage.",
    sponsor: null,
    introduced_at: null,
    legistar_url: "https://example.test/legislation?id=stub",
    legistar_status: "Pending",
    bill_status: "filed",
    section_outcomes: [],
    diff_chunks: [],
    new_bodies: [],
    parse_status: "body_only",
    structural_change_scope: null,
    body: { preamble: "Stub preamble.", amendments: [], closing: "" },
    ...overrides,
  };
}

function makeModule(id: string, sessionBills: readonly Bill[]): AiCorpusModule {
  return {
    id,
    name: `Stub Module ${id}`,
    codeTitle: `Stub Code ${id}`,
    jurisdiction: "test",
    sections: [],
    definitions: [],
    articles: [],
    sessionBills,
  };
}

function makeCtx(modules: readonly AiCorpusModule[]): ToolContext {
  return {
    corpus: {
      corpusHash: "stub-impact-unit",
      rootDir: "/stub",
      modules,
      getSection: () => null,
    },
    turnId: TURN,
  };
}

describe("buildBillImpact — multi-module and uncommon-status arms (unit)", () => {
  it("unions slices of a multi-module bill and counts deleted words", () => {
    const sliceA = makeBill({
      file_no: "880001",
      module_id: "mod-a",
      parse_status: "ok",
      section_outcomes: [{ section_id: "1.1", status: "anchored", detail: null }],
      diff_chunks: [
        { op: "insert", text: "three new words", section_id: "1.1" },
        { op: "delete", text: "two gone", section_id: "1.1" },
      ],
    });
    const sliceB = makeBill({
      file_no: "880001",
      module_id: "mod-b",
      parse_status: "ok",
      section_outcomes: [
        { section_id: "2.2", status: "anchored", detail: null },
        { section_id: "1.1", status: "anchored", detail: null },
      ],
    });
    const result = buildBillImpact(
      "880001",
      makeCtx([makeModule("mod-a", [sliceA]), makeModule("mod-b", [sliceB])]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "bill-impact") expect.fail("expected bill-impact");
    else {
      // Primary slice is the first module's; the other slice is listed.
      expect(result.impact.module_id).toBe("mod-a");
      expect(result.impact.cross_module_touches).toEqual(["mod-b"]);
      // Union dedupes the section id both slices touch.
      expect(result.impact.affected_section_ids).toEqual(["1.1", "2.2"]);
      // One row per (module, outcome); same change kind ties break by
      // module id then numeric section id.
      expect(result.impact.sections.map((s) => `${s.module_id}/${s.section_id}`)).toEqual([
        "mod-a/1.1",
        "mod-b/1.1",
        "mod-b/2.2",
      ]);
      expect(result.impact.sections[0]?.diff_stats).toEqual({
        inserted_words: 3,
        deleted_words: 2,
      });
      expect(result.impact.sections[1]?.diff_stats).toBeNull();
      expect(result.impact.outcome_counts).toEqual({ anchored: 3 });
      // getSection is null in the stub — every row's baseline is missing.
      expect(result.impact.sections.every((s) => s.section_path === null)).toBe(true);
    }
  });

  it("maps added / no_changes / low-confidence / structural / absorbed outcomes and flags each non-renderable status", () => {
    const bill = makeBill({
      file_no: "880002",
      module_id: "mod-a",
      parse_status: "partial",
      section_outcomes: [
        { section_id: "7.7", status: "classification_low_confidence", detail: "2 ambiguous spans" },
        { section_id: "5.5", status: "added_section", detail: null },
        { section_id: "3.3", status: "structural", detail: null },
        { section_id: "6.6", status: "no_changes", detail: null },
        { section_id: "4.4", status: "absorbed_external", detail: null },
      ],
    });
    const result = buildBillImpact("880002", makeCtx([makeModule("mod-a", [bill])]));
    if (!result.ok || result.kind !== "bill-impact") expect.fail("expected bill-impact");
    else {
      // Order: added → referenced_no_change → unclear (numeric within kind).
      expect(result.impact.sections.map((s) => `${s.section_id}:${s.change_kind}`)).toEqual([
        "5.5:added",
        "6.6:referenced_no_change",
        "3.3:unclear",
        "4.4:unclear",
        "7.7:unclear",
      ]);
      const flags = result.impact.risk_flags.map((f) => f.flag);
      expect(flags).toContain("partial");
      expect(flags).toContain("low_confidence_sections");
      expect(flags).toContain("structural_sections");
      expect(flags).toContain("absorbed_external_sections");
      const lowConfidence = result.impact.risk_flags.find(
        (f) => f.flag === "low_confidence_sections",
      );
      expect(lowConfidence?.detail).toBe("mod-a § 7.7");
    }
  });

  it("caps the row set at 50 and reports truncation", () => {
    const outcomes = Array.from({ length: 51 }, (_, i) => ({
      section_id: `${i + 1}`,
      status: "anchored" as const,
      detail: null,
    }));
    const bill = makeBill({
      file_no: "880003",
      module_id: "mod-a",
      parse_status: "ok",
      section_outcomes: outcomes,
    });
    const result = buildBillImpact("880003", makeCtx([makeModule("mod-a", [bill])]));
    if (!result.ok || result.kind !== "bill-impact") expect.fail("expected bill-impact");
    else {
      expect(result.impact.sections).toHaveLength(50);
      expect(result.impact.truncated).toBe(true);
      // The affected-id union is NOT capped — completeness data survives.
      expect(result.impact.affected_section_ids).toHaveLength(51);
      expect(result.impact.outcome_counts).toEqual({ anchored: 51 });
    }
  });

  it("emits manual_review, structural_change, and absorbed_external flags once each across slices", () => {
    const manualA = makeBill({
      file_no: "880004",
      module_id: "mod-a",
      parse_status: "manual_review",
      section_outcomes: [{ section_id: "1.1", status: "unresolved", detail: null }],
    });
    const manualB = makeBill({
      file_no: "880004",
      module_id: "mod-b",
      parse_status: "manual_review",
      section_outcomes: [{ section_id: "2.2", status: "unresolved", detail: null }],
    });
    const structural = makeBill({
      file_no: "880004",
      module_id: "mod-c",
      parse_status: "structural_change",
      structural_change_scope: "Article 7",
      section_outcomes: [{ section_id: "3.3", status: "structural", detail: null }],
    });
    const absorbed = makeBill({
      file_no: "880004",
      module_id: "mod-d",
      parse_status: "absorbed_external",
      section_outcomes: [{ section_id: "4.4", status: "absorbed_external", detail: null }],
    });
    const result = buildBillImpact(
      "880004",
      makeCtx([
        makeModule("mod-a", [manualA]),
        makeModule("mod-b", [manualB]),
        makeModule("mod-c", [structural]),
        makeModule("mod-d", [absorbed]),
      ]),
    );
    if (!result.ok || result.kind !== "bill-impact") expect.fail("expected bill-impact");
    else {
      const flags = result.impact.risk_flags.map((f) => f.flag);
      // Duplicate manual_review parse status across slices dedupes.
      expect(flags.filter((f) => f === "manual_review")).toHaveLength(1);
      expect(flags).toContain("structural_change");
      expect(flags).toContain("absorbed_external");
      const structuralFlag = result.impact.risk_flags.find((f) => f.flag === "structural_change");
      expect(structuralFlag?.detail).toContain("Article 7");
      // Both manual-review slices' sections land in the unresolved flag.
      const unresolvedFlag = result.impact.risk_flags.find((f) => f.flag === "unresolved_sections");
      expect(unresolvedFlag?.detail).toBe("mod-a § 1.1, mod-b § 2.2");
    }
  });
});
