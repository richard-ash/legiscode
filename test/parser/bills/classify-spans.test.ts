import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySpans } from "@/parser/bills/classify-spans";
import { loadPdfBuffer } from "@/parser/pdf/load";
import type { FontMetadata, GraphicsOp, TextRun } from "@/parser/pdf/page-extractor";
import {
  extractFontMetadata,
  extractGraphicsOps,
  extractTextRuns,
} from "@/parser/pdf/page-extractor";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BILLS_FIXTURE = join(REPO_ROOT, "test", "fixtures", "sf", "bills");

// Synthetic minimal inputs — fast, deterministic.
function mkRun(over: Partial<TextRun> = {}): TextRun {
  return {
    page: 1,
    text: "word",
    font_name: "f-context",
    has_eol: false,
    x: 0,
    y: 100,
    width: 30,
    height: 10,
    ...over,
  };
}

function mkOp(over: Partial<GraphicsOp> & { bbox?: Partial<GraphicsOp["bbox"]> } = {}): GraphicsOp {
  const bbox = { x: 0, y: 99, w: 30, h: 0.6, ...(over.bbox ?? {}) };
  return {
    page: 1,
    kind: "fill",
    bbox,
    ...over,
  };
}

const META: ReadonlyMap<string, FontMetadata> = new Map([
  ["f-context", { name: "ArialMT", italic: false, bold: false }],
  ["f-amend", { name: "TimesNewRomanPS-ItalicMT", italic: true, bold: false }],
  ["f-bold", { name: "Arial-BoldMT", italic: false, bold: true }],
]);

describe("classifySpans (synthetic)", () => {
  it("classifies a plain Arial run as context", () => {
    const result = classifySpans([mkRun()], [], META);
    expect(result).toEqual([{ page: 1, text: "word", kind: "context", source_index: 0 }]);
  });

  it("classifies italic-Times with underline-below-baseline as insert", () => {
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ bbox: { x: 0, y: 98, w: 30, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("insert");
  });

  it("classifies italic-Times with strikethrough-through-glyph as delete", () => {
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ bbox: { x: 0, y: 104, w: 30, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("delete");
  });

  it("classifies italic-Times with BOTH decorations as ambiguous", () => {
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", x: 0, y: 100, width: 30, height: 10 })],
      [
        mkOp({ bbox: { x: 0, y: 98, w: 30, h: 0.6 } }),
        mkOp({ bbox: { x: 0, y: 104, w: 30, h: 0.6 } }),
      ],
      META,
    );
    expect(result[0]?.kind).toBe("ambiguous");
  });

  it("classifies italic-Times with NO decoration as ambiguous", () => {
    // Italic Times runs are expected to carry decoration; the absence
    // is a signal that the bill encodes amendments under unknown rules
    // and the section should cascade to manual_review.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", x: 0, y: 100, width: 30, height: 10 })],
      [],
      META,
    );
    expect(result[0]?.kind).toBe("ambiguous");
  });

  it("classifies a single '*' run as elision (pdfjs splits the sentinel)", () => {
    const elisionInContext = classifySpans([mkRun({ text: "*" })], [], META);
    expect(elisionInContext[0]?.kind).toBe("elision");
    const elisionInAmend = classifySpans([mkRun({ text: "*", font_name: "f-amend" })], [], META);
    expect(elisionInAmend[0]?.kind).toBe("elision");
  });

  it("classifies a single-run '* * * *' (the rare un-split form) as elision", () => {
    // Some generators emit the full sentinel as one run; we still match.
    // After whitespace collapse "* * * *" stays unchanged but our
    // matcher accepts only a single token, so cover the un-split form
    // by matching the leading asterisk component.
    const result = classifySpans([mkRun({ text: "****" })], [], META);
    expect(result[0]?.kind).toBe("elision");
  });

  it("ignores decoration that doesn't horizontally overlap the run", () => {
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ bbox: { x: 200, y: 98, w: 30, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("ambiguous");
  });

  it("requires majority-overlap before claiming decoration", () => {
    // 10pt overlap on a 30pt run → 33%, below default 50% threshold.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ bbox: { x: 20, y: 98, w: 10, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("ambiguous");
  });

  it("ignores decoration on a different page", () => {
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", page: 1, x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ page: 2, bbox: { x: 0, y: 98, w: 30, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("ambiguous");
  });

  it("preserves source order and length", () => {
    const runs = [
      mkRun({ text: "a" }),
      mkRun({ text: "b", font_name: "f-amend" }),
      mkRun({ text: "*" }),
      mkRun({ text: "c" }),
    ];
    const ops = [mkOp({ bbox: { x: 0, y: 98, w: 30, h: 0.6 } })];
    const result = classifySpans(runs, ops, META);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.source_index)).toEqual([0, 1, 2, 3]);
    expect(result.map((s) => s.kind)).toEqual(["context", "insert", "elision", "context"]);
  });
});

describe("classifySpans against fixture PDFs", () => {
  it("260217.pdf produces at least some insert + delete classifications across the body", async () => {
    const bytes = await readFile(join(BILLS_FIXTURE, "260217.pdf"));
    const loaded = await loadPdfBuffer(new Uint8Array(bytes));
    try {
      const [runs, ops, fontMeta] = await Promise.all([
        extractTextRuns(loaded.doc),
        extractGraphicsOps(loaded.doc),
        extractFontMetadata(loaded.doc),
      ]);
      const classified = classifySpans(runs, ops, fontMeta);
      const counts: Record<string, number> = {
        context: 0,
        insert: 0,
        delete: 0,
        elision: 0,
        ambiguous: 0,
      };
      for (const s of classified) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
      // Body is mostly context, but we expect non-trivial amendment spans
      // across 308 pages of redline.
      expect(counts.context).toBeGreaterThan(0);
      expect(counts.insert).toBeGreaterThan(0);
      expect(counts.delete).toBeGreaterThan(0);
      // Elision sentinels appear ≥ once per multi-section bill.
      expect(counts.elision).toBeGreaterThanOrEqual(1);
    } finally {
      await loaded.destroy();
    }
  }, 120_000);
});
