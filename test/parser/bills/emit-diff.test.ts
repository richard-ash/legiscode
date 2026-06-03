import { describe, expect, it } from "vitest";
import type { ClassifiedSpan } from "@/parser/bills/classify-spans";
import type { CorpusBaselineLookup } from "@/parser/bills/emit-diff";
import { anchorTextDiff, classifySectionAction } from "@/parser/bills/emit-diff";
import type { ParseBillResult } from "@/parser/bills/index";
import type { Bill, TextDiffSpan } from "@/types";

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
    affected_sections: ["10.04.020"],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    body: { preamble: "", sections: [], closing: "" },
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

function result(over: Partial<ParseBillResult>): ParseBillResult {
  return {
    bills: [bill()],
    unresolved_sections: [],
    body_quality_warnings: [],
    classified_spans: [],
    runs: [],
    ...over,
  };
}

describe("anchorTextDiff", () => {
  it("emits no diff when there is no baseline for the section", () => {
    const lookup: CorpusBaselineLookup = () => null;
    const r = result({
      classified_spans: [span({ kind: "context", text: "anything" })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.outcomes[0]?.status).toBe("no_baseline");
  });

  it("anchors a single insert span at offset 0 with length 0", () => {
    const lookup: CorpusBaselineLookup = () => "The current law remains.";
    const r = result({
      classified_spans: [span({ kind: "insert", text: "new clause" })],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(1);
    expect(diff[0]?.op).toBe("insert");
    expect(diff[0]?.anchor.baseline_length).toBe(0);
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("anchors a context span at its char offset in the baseline", () => {
    const baseline = "The committee shall meet quarterly.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [span({ kind: "context", text: "shall meet" })],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(1);
    expect(diff[0]?.op).toBe("context");
    const anchor = diff[0]?.anchor;
    expect(anchor).toBeDefined();
    // "shall meet" lives at offset 14 in the normalized baseline.
    expect(anchor?.baseline_offset).toBe(14);
    expect(anchor?.baseline_length).toBe(10);
  });

  it("anchors a delete + insert pair (the simple replacement case)", () => {
    const baseline = "The Advisory Committee shall provide input.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "The Advisory" }),
        span({ kind: "delete", text: "Committee" }),
        span({ kind: "insert", text: "Council" }),
        span({ kind: "context", text: "shall provide input" }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff: readonly TextDiffSpan[] = out.bills[0]?.text_diff ?? [];
    expect(diff.map((d) => d.op)).toEqual(["context", "delete", "insert", "context"]);
    expect(diff[1]?.anchor.baseline_length).toBeGreaterThan(0);
    expect(diff[2]?.anchor.baseline_length).toBe(0);
    expect(out.bills[0]?.parse_status).toBe("ok");
  });

  it("emits elision spans with baseline_length 0 (wildcard gaps)", () => {
    const baseline = "The committee shall meet quarterly to review reports.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "The committee" }),
        span({ kind: "elision", text: "*" }),
        span({ kind: "context", text: "review reports" }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff.map((d) => d.op)).toEqual(["context", "elision", "context"]);
    expect(diff[1]?.anchor.baseline_length).toBe(0);
  });

  it("fails alignment when delete text isn't in baseline", () => {
    const baseline = "Completely different text.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [span({ kind: "delete", text: "missing phrase" })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.outcomes[0]?.status).toBe("alignment_failed");
  });

  it("cascades to classification_low_confidence when any span is ambiguous", () => {
    const lookup: CorpusBaselineLookup = () => "Anything goes.";
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "Anything" }),
        span({ kind: "ambiguous", text: "?????" }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.outcomes[0]?.status).toBe("classification_low_confidence");
  });

  it("structural_change bills skip inline diff entirely (fallthrough outcome)", () => {
    const lookup: CorpusBaselineLookup = () => "ignored";
    const r = result({
      bills: [
        bill({
          parse_status: "structural_change",
          structural_change_scope: "by adding Chapter 94C",
        }),
      ],
      classified_spans: [span({ kind: "delete", text: "x" })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("structural_change");
    expect(out.outcomes[0]?.status).toBe("fallthrough");
  });

  it("multi-section bills anchor first section, fallthrough others (v1 scope)", () => {
    const lookup: CorpusBaselineLookup = (_m, s) =>
      s === "10.04.020" ? "Section A baseline." : "Section B baseline.";
    const r = result({
      bills: [bill({ affected_sections: ["10.04.020", "10.04.030"] })],
      classified_spans: [span({ kind: "context", text: "Section A baseline" })],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.outcomes.map((o) => o.status)).toEqual(["anchored", "fallthrough"]);
    expect(out.outcomes.map((o) => o.section_id)).toEqual(["10.04.020", "10.04.030"]);
  });

  it("ignores pure-whitespace context spans (they're not anchor checkpoints)", () => {
    const baseline = "Section text without filler.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "Section" }),
        span({ kind: "context", text: "   " }),
        span({ kind: "context", text: "text" }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    expect(out.bills[0]?.text_diff).toHaveLength(2);
  });

  it("bills with no affected sections produce no outcomes (nothing to anchor)", () => {
    const lookup: CorpusBaselineLookup = () => "baseline";
    const r = result({ bills: [bill({ affected_sections: [] })] });
    const out = anchorTextDiff(r, lookup);
    expect(out.outcomes).toEqual([]);
  });

  it("emits offsets into the ORIGINAL baseline (paragraph \\n preserved)", () => {
    // Regression: tokenStarts used to walk the whitespace-collapsed
    // baseline, so every paragraph `\n` in the original drifted the
    // anchor by one char per gap. SectionFile.text from bodyToText
    // embeds paragraph `\n`s — every multi-paragraph section is
    // affected. Fix: walk the original baseline directly.
    const baseline =
      "First paragraph leading text.\nSecond paragraph adds more content.\nThird paragraph closes.";
    const lookup: CorpusBaselineLookup = () => baseline;
    const r = result({
      classified_spans: [
        span({ kind: "context", text: "First paragraph" }),
        span({ kind: "delete", text: "more" }),
        span({ kind: "context", text: "closes" }),
      ],
    });
    const out = anchorTextDiff(r, lookup);
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(3);
    const ctx1 = diff[0];
    const del = diff[1];
    const ctx2 = diff[2];
    // Each anchor's offset must locate the span's text inside the
    // ORIGINAL baseline — including the `\n`.
    expect(ctx1?.anchor.baseline_offset).toBe(0);
    expect(
      baseline.slice(
        ctx1?.anchor.baseline_offset ?? 0,
        (ctx1?.anchor.baseline_offset ?? 0) + (ctx1?.anchor.baseline_length ?? 0),
      ),
    ).toBe("First paragraph");
    expect(
      baseline.slice(
        del?.anchor.baseline_offset ?? 0,
        (del?.anchor.baseline_offset ?? 0) + (del?.anchor.baseline_length ?? 0),
      ),
    ).toBe("more");
    // The baseline token "closes." includes the trailing period; the
    // anchor binds to the baseline's actual span (period included)
    // even though the bill text was just "closes". This is the right
    // semantic — reconstructCorpusAligned needs the baseline slice
    // for the BEFORE pane to read as the law actually reads.
    expect(
      baseline.slice(
        ctx2?.anchor.baseline_offset ?? 0,
        (ctx2?.anchor.baseline_offset ?? 0) + (ctx2?.anchor.baseline_length ?? 0),
      ),
    ).toBe("closes.");
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
      module_id: "sf-police",
      affected_sections: ["515"],
      body: {
        preamble: "",
        closing: "",
        sections: [
          {
            action:
              "Section 1. Article 8 of the Police Code is hereby amended by deleting Section 515, to read as follows:",
            target: { module_id: "sf-police", raw_section_id: "515" },
            body: [],
          },
        ],
      },
    });
    const out = anchorTextDiff(
      {
        bills: [billRecord],
        unresolved_sections: [],
        body_quality_warnings: [],
        classified_spans: [],
        runs: [],
      },
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
      module_id: "sf-police",
      affected_sections: ["515", "516"],
      body: {
        preamble: "",
        closing: "",
        sections: [
          {
            action:
              "Section 1. Article 8 of the Police Code is hereby amended by deleting Sections 515 and 516, to read as follows:",
            target: { module_id: "sf-police", raw_section_id: "515" },
            body: [],
          },
        ],
      },
    });
    const out = anchorTextDiff(
      {
        bills: [billRecord],
        unresolved_sections: [],
        body_quality_warnings: [],
        classified_spans: [],
        runs: [],
      },
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
      module_id: "sf-police",
      affected_sections: ["515"],
      body: {
        preamble: "",
        closing: "",
        sections: [
          {
            action: "is hereby amended by deleting Section 515, to read as follows:",
            target: { module_id: "sf-police", raw_section_id: "515" },
            body: [],
          },
        ],
      },
    });
    const out = anchorTextDiff(
      {
        bills: [billRecord],
        unresolved_sections: [],
        body_quality_warnings: [],
        classified_spans: [],
        runs: [],
      },
      lookup,
    );
    expect(out.bills[0]?.text_diff).toEqual([]);
    expect(out.bills[0]?.parse_status).toBe("manual_review");
    expect(out.outcomes.find((o) => o.section_id === "515")?.status).toBe("no_baseline");
  });
});

describe("anchorTextDiff — wholesale add", () => {
  it("synthesizes an insert span for a whole-section add", () => {
    const lookup: CorpusBaselineLookup = () => null;
    const billRecord = bill({
      module_id: "sf-administrative",
      affected_sections: ["12X.5"],
      body: {
        preamble: "",
        closing: "",
        sections: [
          {
            action:
              "Section 1. The Administrative Code is hereby amended by adding Section 12X.5, to read as follows:",
            target: { module_id: "sf-administrative", raw_section_id: "12X.5" },
            body: [
              { kind: "section_header", number: "12X.5", title: "Privacy Reporting." },
              { kind: "paragraph", text: "Each Department shall submit an annual report." },
            ],
          },
        ],
      },
    });
    const out = anchorTextDiff(
      {
        bills: [billRecord],
        unresolved_sections: [],
        body_quality_warnings: [],
        classified_spans: [],
        runs: [],
      },
      lookup,
    );
    const diff = out.bills[0]?.text_diff ?? [];
    expect(diff).toHaveLength(1);
    expect(diff[0]?.op).toBe("insert");
    expect(diff[0]?.section_id).toBe("12X.5");
    expect(diff[0]?.anchor.baseline_offset).toBe(0);
    expect(diff[0]?.anchor.baseline_length).toBe(0);
    expect(diff[0]?.text).toContain("Privacy Reporting");
    expect(diff[0]?.text).toContain("Each Department shall submit an annual report.");
    expect(out.bills[0]?.parse_status).toBe("ok");
  });
});
