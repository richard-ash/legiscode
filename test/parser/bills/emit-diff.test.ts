import { describe, expect, it } from "vitest";
import type { ClassifiedSpan } from "@/parser/bills/classify-spans";
import type { CorpusBaselineLookup } from "@/parser/bills/emit-diff";
import { anchorTextDiff, classifySectionAction } from "@/parser/bills/emit-diff";
import type { ParseBillResult, SectionPartitionEntry } from "@/parser/bills/index";
import type { RunRange } from "@/parser/bills/run-offset-map";
import type { Bill, ModuleId, SectionId } from "@/types";

// Default partition: a single section covering an effectively-infinite
// chrome range. This is the common-case shape for unit tests that
// don't exercise partition edges — every classified span lands in this
// one section. Tests that DO exercise partition edges build their own.
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
    diff_chunks: [],
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

// Default offset map: each span maps to a single range in the
// section's chrome range. Tests can override by passing their own.
function defaultOffsetMap(
  spans: readonly ClassifiedSpan[],
): ReadonlyArray<ReadonlyArray<RunRange>> {
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
  const moduleId = defaultBill.module_id;
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
    expect(out.bills[0]?.diff_chunks).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.outcomes.find((o) => o.section_id === "10.04.020")?.status).toBe("no_baseline");
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
    expect(out.bills[0]?.diff_chunks).toEqual([]);
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
    expect(out.bills[0]?.diff_chunks).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("structural_change");
    expect(out.outcomes.find((o) => o.section_id === "10.04.020")?.status).toBe("structural");
  });

  it("multi-section bills partition spans per section", () => {
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
      [{ chrome_start: 10, chrome_end: 30 }],
      [{ chrome_start: 110, chrome_end: 130 }],
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
    // Each section's only span is a context span whose text matches
    // baseline exactly — reconstruction produces a newText identical
    // to baseline, so diffWords emits no insert/delete chunks and
    // the outcome downgrades to no_changes. Both sections still
    // count as renderable, so parse_status derives to "ok".
    expect(statusBySection.get("10.04.020")).toBe("no_changes");
    expect(statusBySection.get("10.04.030")).toBe("no_changes");
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
});

describe("anchorTextDiff — partition behavior", () => {
  it("partial: one section anchored, one no_baseline → parse_status partial", () => {
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
        [{ chrome_start: 10, chrome_end: 20 }],
        [{ chrome_start: 110, chrome_end: 120 }],
      ],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.parse_status).toBe("partial");
    const statusBySection = new Map(
      out.bills[0]?.section_outcomes.map((o) => [o.section_id, o.status]),
    );
    // Section A's only span matches baseline exactly → no_changes
    // (still renderable). Section B has no baseline → no_baseline.
    // Mix yields partial.
    expect(statusBySection.get("A" as SectionId)).toBe("no_changes");
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
  it("synthesizes a full-baseline delete chunk for a single-section repeal", () => {
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
    const chunks = out.bills[0]?.diff_chunks ?? [];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.op).toBe("delete");
    expect(chunks[0]?.text).toBe(baseline);
    expect(chunks[0]?.section_id).toBe("515");
    expect(out.bills[0]?.parse_status).toBe("ok");
    expect(out.outcomes.find((o) => o.section_id === "515")?.status).toBe("anchored");
  });

  it("emits one delete chunk per section_id for a multi-section repeal", () => {
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
    const chunks = out.bills[0]?.diff_chunks ?? [];
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.section_id).sort()).toEqual(["515", "516"]);
    for (const c of chunks) {
      expect(c.op).toBe("delete");
      expect(c.text).toBe(baselines[c.section_id]);
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
    expect(out.bills[0]?.diff_chunks).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.outcomes.find((o) => o.section_id === "515")?.status).toBe("no_baseline");
  });
});

describe("anchorTextDiff — wholesale add", () => {
  it("surfaces classification_low_confidence when wholesale add targets a section already in the corpus", () => {
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
        section_id: "12X.5" as SectionId,
        candidates: ["12X.5" as SectionId],
        chrome_range: { start: 0, end: 100 },
      },
    ];
    const out = anchorTextDiff(
      result({ bills: [billRecord], section_partitions: partitions }),
      lookup,
    );
    expect(out.bills[0]?.diff_chunks).toEqual([]);
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
      section_outcomes: [],
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
    expect(out.bills[0]?.diff_chunks).toHaveLength(1);
    expect(out.bills[0]?.diff_chunks[0]?.op).toBe("insert");
    expect(out.bills[0]?.parse_status).toBe("ok");
  });
});
