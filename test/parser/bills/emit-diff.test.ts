import { describe, expect, it } from "vitest";
import type { ClassifiedSpan } from "@/parser/bills/classify-spans";
import type { CorpusBaselineLookup } from "@/parser/bills/emit-diff";
import { anchorTextDiff, classifySectionAction } from "@/parser/bills/emit-diff";
import type { ParseBillResult, SectionPartitionEntry } from "@/parser/bills/index";
import type { RunRange } from "@/parser/bills/run-offset-map";
import type { Bill, ModuleId, SectionId, TextDiffSpan } from "@/types";

// Default partition: a single section covering an effectively-infinite
// chrome range. This is the common-case shape for unit tests that don't
// exercise partition edges — every classified span lands in this one
// section. Tests that DO exercise partition edges build their own.
function defaultPartition(sectionId: SectionId, moduleId: ModuleId): SectionPartitionEntry {
  return {
    module_id: moduleId,
    raw_section_id: sectionId,
    section_id: sectionId,
    candidates: [sectionId],
    chrome_range: { start: 0, end: 1_000_000 },
  };
}

function bill(over: Partial<Bill> = {}): Bill {
  return {
    file_no: "260217",
    module_id: "sf-administrative",
    short_title: "Test",
    long_title: "Ordinance amending the Administrative Code.",
    sponsor: null,
    introduced_at: null,
    legistar_url: "https://sfgov.legistar.com/x",
    legistar_status: "Pending",
    bill_status: "committee",
    section_outcomes: [],
    text_diff: [],
    parse_status: "body_only",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
    ...over,
  };
}

function span(over: Partial<ClassifiedSpan>): ClassifiedSpan {
  return {
    page: 1,
    text: "",
    kind: "context",
    source_index: 0,
    ...over,
  };
}

// Default offset map: each span maps to a single ranged in the section's
// chrome range. Tests can override by passing their own.
function defaultOffsetMap(
  spans: readonly ClassifiedSpan[],
): ReadonlyArray<ReadonlyArray<RunRange>> {
  // Every span lives at chrome_start=0,chrome_end=1 — well inside the
  // defaultPartition range, so every span bucket-attributes to the
  // partition section.
  const map: RunRange[][] = [];
  for (const s of spans) {
    const idx = s.source_index;
    while (map.length <= idx) map.push([]);
    map[idx] = [{ chrome_start: 0, chrome_end: 1 }];
  }
  return map;
}

interface ResultOpts {
  bills?: Bill[];
  classified_spans?: ClassifiedSpan[];
  section_partitions?: SectionPartitionEntry[];
  run_offset_map?: ReadonlyArray<ReadonlyArray<RunRange>>;
  unresolved_sections?: ParseBillResult["unresolved_sections"];
}

function result(over: ResultOpts = {}): ParseBillResult {
  const defaultBill = over.bills?.[0] ?? bill();
  // Auto-derive partitions if not provided: one partition per section
  // mentioned in the bill's body amendments / by inference from
  // explicit override partitions. Default: a single partition covering
  // the bill's module + section_outcomes[0]?.section_id, or 10.04.020.
  const moduleId = defaultBill.module_id;
  // Pull section_ids from section_outcomes when given (round-trip)
  // OR fall back to the legacy single-section convention.
  let defaultPartitions: SectionPartitionEntry[];
  if (defaultBill.section_outcomes.length > 0) {
    defaultPartitions = defaultBill.section_outcomes.map((o) =>
      defaultPartition(o.section_id, moduleId),
    );
  } else {
    defaultPartitions = [defaultPartition("10.04.020" as SectionId, moduleId)];
  }
  const partitions = over.section_partitions ?? defaultPartitions;
  const classifiedSpans = over.classified_spans ?? [];
  const offsetMap = over.run_offset_map ?? defaultOffsetMap(classifiedSpans);
  return {
    bills: over.bills ?? [defaultBill],
    unresolved_sections: over.unresolved_sections ?? [],
    body_quality_warnings: [],
    classified_spans: classifiedSpans,
    runs: [],
    run_offset_map: offsetMap,
    section_partitions: partitions,
  };
}

describe("anchorTextDiff", () => {
  it("emits no_baseline when the corpus has no text for the section", () => {
    const lookup: CorpusBaselineLookup = () => null;
    const r = result({
      classified_spans: [span({ kind: "context", text: "anything" })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.outcomes.find((o) => o.section_id === "10.04.020")?.status).toBe("no_baseline");
  });

  it("a bill that reprints baseline verbatim produces context-only diff", () => {
    // Bill body reprints the section unchanged (single context span
    // covering the full baseline text). diffWords produces one equal
    // hunk; we emit it as op:"context" anchored to the full baseline.
    const baseline = "The committee shall meet quarterly.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [span({ kind: "context", text: baseline })],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(1);
    expect(diff[0]?.op).toBe("context");
    expect(diff[0]?.anchor.baseline_offset).toBe(0);
    expect(diff[0]?.anchor.baseline_length).toBe(baseline.length);
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("inserted words surface as op:insert hunks with baseline_length 0", () => {
    // Bill reprints baseline but inserts "Advisory " before "committee".
    const baseline = "The committee shall meet quarterly.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "The ", source_index: 0 }),
        span({ kind: "insert", text: "Advisory ", source_index: 1 }),
        span({ kind: "context", text: "committee shall meet quarterly.", source_index: 2 }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    const inserts = diff.filter((d) => d.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.text.trim()).toBe("Advisory");
    expect(inserts[0]?.anchor.baseline_length).toBe(0);
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("a delete span drops baseline words, surfacing as op:delete hunks", () => {
    // Bill reprints baseline but strikes "Advisory ". The classifier
    // marks "Advisory " as a delete span; diffAgainstBaseline drops it
    // from newText, so diffWords sees the word missing and emits a
    // removed hunk anchored against baseline.
    const baseline = "The Advisory committee shall meet quarterly.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "The ", source_index: 0 }),
        span({ kind: "delete", text: "Advisory ", source_index: 1 }),
        span({ kind: "context", text: "committee shall meet quarterly.", source_index: 2 }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    const deletes = diff.filter((d) => d.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.text.trim()).toBe("Advisory");
    expect(deletes[0]?.anchor.baseline_length).toBeGreaterThan(0);
    expect(
      baseline.slice(
        deletes[0]?.anchor.baseline_offset ?? -1,
        (deletes[0]?.anchor.baseline_offset ?? 0) + (deletes[0]?.anchor.baseline_length ?? 0),
      ),
    ).toContain("Advisory");
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("a delete+insert replacement produces both delete and insert hunks", () => {
    const baseline = "The Advisory Committee shall provide input.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "The Advisory ", source_index: 0 }),
        span({ kind: "delete", text: "Committee ", source_index: 1 }),
        span({ kind: "insert", text: "Council ", source_index: 2 }),
        span({ kind: "context", text: "shall provide input.", source_index: 3 }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff: readonly TextDiffSpan[] = out.bills[0]?.text_diff ?? [];
    expect(diff.some((d) => d.op === "delete" && d.text.trim() === "Committee")).toBe(true);
    expect(diff.some((d) => d.op === "insert" && d.text.trim() === "Council")).toBe(true);
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("a substantial revision still anchors (no alignment_failed cascade)", () => {
    // Bill rewrites the entire section. Old anchor-walker would fail
    // ("no token run found"); diffAgainstBaseline produces the right
    // diff regardless of how much text changed.
    const baseline = "The committee shall meet quarterly to review reports.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({
          kind: "delete",
          text: "The committee shall meet quarterly to review reports.",
          source_index: 0,
        }),
        span({
          kind: "insert",
          text: "The Board shall convene monthly to consider applications.",
          source_index: 1,
        }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.parse_status).toBe("ok");
    expect(out.outcomes.find((o) => o.section_id === "10.04.020")?.status).toBe("anchored");
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff.some((d) => d.op === "insert")).toBe(true);
    expect(diff.some((d) => d.op === "delete")).toBe(true);
  });

  it("emits classification_low_confidence per section when any span is ambiguous", () => {
    const lookup: CorpusBaselineLookup = () => "Anything goes.";
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "Anything", source_index: 0 }),
        span({ kind: "ambiguous", text: "?????", source_index: 1 }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.outcomes.find((o) => o.section_id === "10.04.020")?.status).toBe(
      "classification_low_confidence",
    );
    expect(out.bills[0]?.parse_status).toBe("manual_review");
  });

  it("structural_change bills skip inline diff entirely (structural outcome per section)", () => {
    const lookup: CorpusBaselineLookup = () => "ignored";
    const r = result({
      bills: [
        bill({
          parse_status: "structural_change",
          structural_change_scope: "by adding Chapter 94C",
          section_outcomes: [
            { section_id: "10.04.020" as SectionId, status: "structural", detail: null },
          ],
        }),
      ],
      classified_spans: [span({ kind: "delete", text: "x" })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("structural_change");
    expect(out.outcomes.find((o) => o.section_id === "10.04.020")?.status).toBe("structural");
  });

  it("multi-section bills partition spans per section", () => {
    // Two partitions, two sections; each span's chrome_start identifies
    // which section it belongs to (the partition's chrome_range).
    const lookup: CorpusBaselineLookup = (_m, s) =>
      s === "10.04.020" ? "Section A baseline." : "Section B baseline.";
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-administrative",
        raw_section_id: "10.04.020",
        section_id: "10.04.020" as SectionId,
        candidates: ["10.04.020" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
      {
        module_id: "sf-administrative",
        raw_section_id: "10.04.030",
        section_id: "10.04.030" as SectionId,
        candidates: ["10.04.030" as SectionId],
        chrome_range: { start: 100, end: 200 },
      },
    ];
    const classifiedSpans = [
      span({ kind: "context", text: "Section A baseline", source_index: 0 }),
      span({ kind: "context", text: "Section B baseline", source_index: 1 }),
    ];
    const offsetMap: RunRange[][] = [
      [{ chrome_start: 10, chrome_end: 30 }], // source_index 0 → partition 0
      [{ chrome_start: 110, chrome_end: 130 }], // source_index 1 → partition 1
    ];
    const r = result({
      bills: [
        bill({
          section_outcomes: [
            { section_id: "10.04.020" as SectionId, status: "anchored", detail: null },
            { section_id: "10.04.030" as SectionId, status: "anchored", detail: null },
          ],
        }),
      ],
      section_partitions: partitions,
      classified_spans: classifiedSpans,
      run_offset_map: offsetMap,
    });
    const out = anchorTextDiff(r, lookup);
    const statusBySection = new Map(out.outcomes.map((o) => [o.section_id, o.status]));
    expect(statusBySection.get("10.04.020")).toBe("anchored");
    expect(statusBySection.get("10.04.030")).toBe("anchored");
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("body_only bills (no partitions) produce no outcomes and parse_status body_only", () => {
    const lookup: CorpusBaselineLookup = () => "baseline";
    const r = result({
      bills: [bill()],
      section_partitions: [],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.outcomes).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("body_only");
  });

  it("offsets walk through baseline contiguously (length-preserving)", () => {
    // Per-span offsets walk through the baseline in order; the sum of
    // delete + context anchor lengths equals the baseline length, and
    // each span's slice into baseline matches the diff hunk's text.
    const baseline =
      "First paragraph leading text.\nSecond paragraph adds more content.\nThird paragraph closes.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({
          kind: "context",
          text: "First paragraph leading text.\nSecond paragraph adds ",
          source_index: 0,
        }),
        span({ kind: "delete", text: "more ", source_index: 1 }),
        span({
          kind: "context",
          text: "content.\nThird paragraph closes.",
          source_index: 2,
        }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    let consumed = 0;
    for (const d of diff) {
      if (d.op === "insert") continue;
      expect(d.anchor.baseline_offset).toBe(consumed);
      expect(
        baseline.slice(
          d.anchor.baseline_offset,
          d.anchor.baseline_offset + d.anchor.baseline_length,
        ),
      ).toBe(d.text);
      consumed += d.anchor.baseline_length;
    }
    expect(consumed).toBe(baseline.length);
  });
});

describe("anchorTextDiff — partition behavior", () => {
  it("partial: one section anchored, one no_baseline → parse_status partial", () => {
    // Two-section bill where section B's baseline is missing from the
    // corpus. A diffs cleanly; B emits no_baseline.
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-administrative",
        raw_section_id: "A",
        section_id: "A" as SectionId,
        candidates: ["A" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
      {
        module_id: "sf-administrative",
        raw_section_id: "B",
        section_id: "B" as SectionId,
        candidates: ["B" as SectionId],
        chrome_range: { start: 100, end: 200 },
      },
    ];
    const lookup: CorpusBaselineLookup = (_m, sid) => (sid === "A" ? "Anchorable baseline." : null);
    const r = result({
      bills: [
        bill({
          section_outcomes: [
            { section_id: "A" as SectionId, status: "anchored", detail: null },
            { section_id: "B" as SectionId, status: "no_baseline", detail: null },
          ],
        }),
      ],
      section_partitions: partitions,
      classified_spans: [
        span({ kind: "context", text: "Anchorable baseline.", source_index: 0 }),
        span({ kind: "context", text: "irrelevant for B (no baseline)", source_index: 1 }),
      ],
      run_offset_map: [
        [{ chrome_start: 10, chrome_end: 20 }], // A
        [{ chrome_start: 110, chrome_end: 120 }], // B
      ],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.parse_status).toBe("partial");
    const statusBySection = new Map(
      out.bills[0]?.section_outcomes.map((o) => [o.section_id, o.status]),
    );
    expect(statusBySection.get("A" as SectionId)).toBe("anchored");
    expect(statusBySection.get("B" as SectionId)).toBe("no_baseline");
  });

  it("emits unresolved outcome when a partition has section_id === null", () => {
    const lookup: CorpusBaselineLookup = () => null;
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-administrative",
        raw_section_id: "999",
        section_id: null,
        candidates: ["999" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
    ];
    const r = result({
      bills: [
        bill({
          section_outcomes: [
            { section_id: "999" as SectionId, status: "unresolved", detail: null },
          ],
        }),
      ],
      section_partitions: partitions,
      classified_spans: [span({ kind: "delete", text: "x", source_index: 0 })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.bills[0]?.section_outcomes[0]?.status).toBe("unresolved");
  });

  it("spans land in exactly ONE partition (no cross-section duplication)", () => {
    // A span whose offset map range straddles two partitions (rare;
    // happens at a SEC. header boundary) lands in ONE partition by
    // the single-owner rule: the partition that owns the span's
    // start. The other partition has no spans for it.
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-administrative",
        raw_section_id: "A",
        section_id: "A" as SectionId,
        candidates: ["A" as SectionId],
        chrome_range: { start: 0, end: 50 },
      },
      {
        module_id: "sf-administrative",
        raw_section_id: "B",
        section_id: "B" as SectionId,
        candidates: ["B" as SectionId],
        chrome_range: { start: 50, end: 100 },
      },
    ];
    const lookup: CorpusBaselineLookup = (_m, sid) =>
      sid === "A" ? "Section A text." : "Section B text.";
    const r = result({
      bills: [
        bill({
          section_outcomes: [
            { section_id: "A" as SectionId, status: "anchored", detail: null },
            { section_id: "B" as SectionId, status: "anchored", detail: null },
          ],
        }),
      ],
      section_partitions: partitions,
      classified_spans: [
        // Span at chrome_start=49 straddles A→B boundary. Single-
        // owner rule attributes it to A.
        span({ kind: "context", text: "Section A text.", source_index: 0 }),
      ],
      run_offset_map: [[{ chrome_start: 49, chrome_end: 55 }]],
    });
    const out = anchorTextDiff(r, lookup);
    // Span attributed to A only. B has empty spans → diff is the full
    // baseline as a single delete (the honest representation of "no
    // bill body text for this section").
    expect(out.bills[0]?.text_diff.filter((s) => s.section_id === "A").length).toBeGreaterThan(0);
    const bSpans = out.bills[0]?.text_diff.filter((s) => s.section_id === "B") ?? [];
    expect(bSpans.every((s) => s.op === "delete")).toBe(true);
  });
});

describe("classifySectionAction", () => {
  it("matches whole-section delete with a single section", () => {
    const r = classifySectionAction(
      "Section 1. Article 8 of the Police Code is hereby amended by deleting Section 515, to read as follows:",
    );
    expect(r.kind).toBe("delete");
    if (r.kind === "delete") expect(r.section_ids).toEqual(["515"]);
  });

  it("matches whole-section delete with a multi-section list", () => {
    const r = classifySectionAction(
      "Section 1. Article 8 of the Police Code is hereby amended by deleting Sections 515 and 516, to read as follows:",
    );
    expect(r.kind).toBe("delete");
    if (r.kind === "delete") expect(r.section_ids).toEqual(["515", "516"]);
  });

  it("matches a serial-comma section list", () => {
    const r = classifySectionAction(
      "The Code is hereby amended by deleting Sections 10.04.020, 10.04.030, and 10.04.040, to read as follows:",
    );
    expect(r.kind).toBe("delete");
    if (r.kind === "delete") expect(r.section_ids).toEqual(["10.04.020", "10.04.030", "10.04.040"]);
  });

  it("matches whole-section add", () => {
    const r = classifySectionAction(
      "Section 1. The Administrative Code is hereby amended by adding Section 12X.5, to read as follows:",
    );
    expect(r.kind).toBe("add");
    if (r.kind === "add") expect(r.section_ids).toEqual(["12X.5"]);
  });

  it("matches add with 'a new Section' phrasing", () => {
    const r = classifySectionAction(
      "is hereby amended by adding a new Section 999, to read as follows:",
    );
    expect(r.kind).toBe("add");
    if (r.kind === "add") expect(r.section_ids).toEqual(["999"]);
  });

  it("classifies a standard inline amendment as inline (not wholesale)", () => {
    const r = classifySectionAction(
      "Section 1. The Police Code is hereby amended by revising Section 515 to read as follows:",
    );
    expect(r.kind).toBe("inline");
  });

  it("returns unknown for action verbs it does not recognize", () => {
    const r = classifySectionAction("Section 1. The bill does some other thing.");
    expect(r.kind).toBe("unknown");
  });
});

describe("anchorTextDiff — wholesale delete", () => {
  it("synthesizes a full-baseline delete span for a single-section repeal", () => {
    const baseline = "It shall be unlawful for any person to lend printed matter to any minor.";
    const lookup: CorpusBaselineLookup = (_m, sid) => (sid === "515" ? baseline : null);
    const billRecord = bill({
      module_id: "sf-police" as ModuleId,
      section_outcomes: [{ section_id: "515" as SectionId, status: "anchored", detail: null }],
      body: {
        preamble: "",
        closing: "",
        amendments: [
          {
            action:
              "Section 1. Article 8 of the Police Code is hereby amended by deleting Section 515, to read as follows:",
            target: { module_id: "sf-police" as ModuleId, raw_section_id: "515" },
            body: [],
          },
        ],
      },
    });
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-police" as ModuleId,
        raw_section_id: "515",
        section_id: "515" as SectionId,
        candidates: ["515" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
    ];
    const out = anchorTextDiff(
      result({ bills: [billRecord], section_partitions: partitions }),
      lookup,
    );
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(1);
    expect(diff[0]?.op).toBe("delete");
    expect(diff[0]?.text).toBe(baseline);
    expect(diff[0]?.section_id).toBe("515");
    expect(diff[0]?.anchor.baseline_offset).toBe(0);
    expect(diff[0]?.anchor.baseline_length).toBe(baseline.length);
    expect(out.bills[0]?.parse_status).toBe("ok");
    expect(out.outcomes.find((o) => o.section_id === "515")?.status).toBe("anchored");
  });

  it("emits one delete span per section_id for a multi-section repeal", () => {
    const baselines: Record<string, string> = {
      "515": "First section body text here.",
      "516": "Second section body text here.",
    };
    const lookup: CorpusBaselineLookup = (_m, sid) => baselines[sid] ?? null;
    const billRecord = bill({
      module_id: "sf-police" as ModuleId,
      section_outcomes: [
        { section_id: "515" as SectionId, status: "anchored", detail: null },
        { section_id: "516" as SectionId, status: "anchored", detail: null },
      ],
      body: {
        preamble: "",
        closing: "",
        amendments: [
          {
            action:
              "Section 1. Article 8 of the Police Code is hereby amended by deleting Sections 515 and 516, to read as follows:",
            target: { module_id: "sf-police" as ModuleId, raw_section_id: "515" },
            body: [],
          },
        ],
      },
    });
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-police" as ModuleId,
        raw_section_id: "515",
        section_id: "515" as SectionId,
        candidates: ["515" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
      {
        module_id: "sf-police" as ModuleId,
        raw_section_id: "516",
        section_id: "516" as SectionId,
        candidates: ["516" as SectionId],
        chrome_range: { start: 100, end: 200 },
      },
    ];
    const out = anchorTextDiff(
      result({ bills: [billRecord], section_partitions: partitions }),
      lookup,
    );
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(2);
    expect(diff.map((d) => d.section_id).sort()).toEqual(["515", "516"]);
    for (const d of diff) {
      expect(d.op).toBe("delete");
      expect(d.text).toBe(baselines[d.section_id]);
      expect(d.anchor.baseline_offset).toBe(0);
      expect(d.anchor.baseline_length).toBe((baselines[d.section_id] ?? "").length);
    }
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("records no_baseline outcome when corpus has no text for the section", () => {
    const lookup: CorpusBaselineLookup = () => null;
    const billRecord = bill({
      module_id: "sf-police" as ModuleId,
      section_outcomes: [{ section_id: "515" as SectionId, status: "no_baseline", detail: null }],
      body: {
        preamble: "",
        closing: "",
        amendments: [
          {
            action: "is hereby amended by deleting Section 515, to read as follows:",
            target: { module_id: "sf-police" as ModuleId, raw_section_id: "515" },
            body: [],
          },
        ],
      },
    });
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-police" as ModuleId,
        raw_section_id: "515",
        section_id: "515" as SectionId,
        candidates: ["515" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
    ];
    const out = anchorTextDiff(
      result({ bills: [billRecord], section_partitions: partitions }),
      lookup,
    );
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.outcomes.find((o) => o.section_id === "515")?.status).toBe("no_baseline");
  });
});

describe("anchorTextDiff — wholesale add", () => {
  it("surfaces classification_low_confidence when wholesale add targets a section already in the corpus", () => {
    // Pathological case: bill body says "amended by adding Section
    // X" but X is already in the corpus. Could be a data issue or a
    // parser miss on a paired delete clause. We don't synthesize
    // spans (a length-0 insert at offset 0 would silently prepend new
    // text in front of the existing baseline); instead the outcome
    // surfaces as classification_low_confidence for operator audit.
    const lookup: CorpusBaselineLookup = (_m, sid) =>
      sid === "12X.5" ? "Existing § 12X.5 baseline content." : null;
    const billRecord = bill({
      module_id: "sf-administrative",
      section_outcomes: [
        { section_id: "12X.5" as SectionId, status: "classification_low_confidence", detail: null },
      ],
      body: {
        preamble: "",
        closing: "",
        amendments: [
          {
            action:
              "Section 1. The Administrative Code is hereby amended by adding Section 12X.5, to read as follows:",
            target: { module_id: "sf-administrative", raw_section_id: "12X.5" },
            body: [
              { kind: "code_section_header", number: "12X.5", title: "Privacy Reporting." },
              { kind: "paragraph", text: "Each Department shall submit an annual report." },
            ],
          },
        ],
      },
    });
    const partitions: SectionPartitionEntry[] = [
      {
        module_id: "sf-administrative",
        raw_section_id: "12X.5",
        section_id: "12X.5" as SectionId, // EXISTS in corpus
        candidates: ["12X.5" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
    ];
    const out = anchorTextDiff(
      result({ bills: [billRecord], section_partitions: partitions }),
      lookup,
    );
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.outcomes.find((o) => o.section_id === "12X.5")?.status).toBe(
      "classification_low_confidence",
    );
    expect(out.bills[0]?.parse_status).toBe("manual_review");
  });
});

describe("anchorTextDiff — added_section detection (T4)", () => {
  it("classifies a wholesale add of an unresolved raw_section_id as added_section", () => {
    const lookup: CorpusBaselineLookup = () => null;
    const billRecord = bill({
      module_id: "sf-administrative",
      section_outcomes: [], // populated by anchorTextDiff
      body: {
        preamble: "",
        closing: "",
        amendments: [
          {
            action:
              "Section 1. The Administrative Code is hereby amended by adding a new Section 99X, to read as follows:",
            target: { module_id: "sf-administrative", raw_section_id: "99X" },
            body: [
              { kind: "code_section_header", number: "99X", title: "Brand New Section." },
              { kind: "paragraph", text: "Every department shall do thing X." },
            ],
          },
        ],
      },
    });
    const out = anchorTextDiff(
      result({
        bills: [billRecord],
        section_partitions: [],
        unresolved_sections: [
          {
            module_id: "sf-administrative",
            raw_section_id: "99X",
            candidates: ["99x" as SectionId],
          },
        ],
      }),
      lookup,
    );
    const oc = out.bills[0]?.section_outcomes ?? [];
    expect(oc).toHaveLength(1);
    expect(oc[0]?.section_id).toBe("99X");
    expect(oc[0]?.status).toBe("added_section");
    expect(out.bills[0]?.text_diff).toHaveLength(1);
    expect(out.bills[0]?.text_diff[0]?.op).toBe("insert");
    expect(out.bills[0]?.parse_status).toBe("ok");
  });
});
