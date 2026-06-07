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

  it("extends a single decoration region across the whole run when no other regions compete", () => {
    // 10pt underline on a 30pt 4-char run (chars centered at 3.75,
    // 11.25, 18.75, 26.25). The underline covers only x 20..30, so just
    // the last glyph's center is explicitly inside. The earlier glyphs
    // fall into the run-start gap and inherit the only available
    // neighbor's kind — Legistar regularly draws decoration ops 1-3pt
    // shy of full glyph coverage, and cascading the section over that
    // is worse than trusting the single decoration we did see.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", text: "word", x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ bbox: { x: 20, y: 98, w: 10, h: 0.6 } })],
      META,
    );
    expect(result).toEqual([{ page: 1, text: "word", kind: "insert", source_index: 0 }]);
  });

  it("fills a small strike/underline gap by inheriting from the nearer side", () => {
    // Strike-then-underline with a 3pt gap (Legistar draws short
    // decoration ops at amendment boundaries). The boundary glyph
    // picks the closer kind via the midpoint of the gap.
    //   strike    [0..14]  → "Ee"
    //   gap       [14..17]
    //   underline [17..30] → "ach"
    // Per-glyph centers (6pt/char): 3, 9, 15, 21, 27.
    //  - "E" (3) explicit strike → delete
    //  - "e" (9) explicit strike → delete
    //  - "a" (15) gap, closer to strike edge 14 (Δ=1) than underline 17 (Δ=2) → delete
    //  - "c" (21) explicit underline → insert
    //  - "h" (27) explicit underline → insert
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", text: "Eeach", x: 0, y: 100, width: 30, height: 10 })],
      [
        mkOp({ bbox: { x: 0, y: 102, w: 14, h: 0.6 } }),
        mkOp({ bbox: { x: 17, y: 98, w: 13, h: 0.6 } }),
      ],
      META,
    );
    expect(result).toEqual([
      { page: 1, text: "Eea", kind: "delete", source_index: 0 },
      { page: 1, text: "ch", kind: "insert", source_index: 0 },
    ]);
  });

  it("ignores decoration on a different page", () => {
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", page: 1, x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ page: 2, bbox: { x: 0, y: 98, w: 30, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("ambiguous");
  });

  it("classifies italic-Times runs with zero width as context (zero-width control glyphs)", () => {
    // T3 lock: pdfjs surfaces zero-width control glyphs (soft hyphens,
    // ligature shims, etc.) as italic-Times runs with `width === 0`.
    // Treating them as `ambiguous` falsely cascades the whole section
    // to classification_low_confidence. They carry no diff content, so
    // they classify as context and get filtered out downstream.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", text: "​", width: 0, height: 10 })],
      [],
      META,
    );
    expect(result[0]?.kind).toBe("context");
  });

  it("splits an italic-Times run with side-by-side strike+underline into delete+insert sub-spans", () => {
    // SF Legistar typesets renumbering edits like `(3)(2)` as a single
    // italic-Times text-show op: the struck `(3)` (delete the old
    // number) is immediately followed by the underlined `(2)` (insert
    // the new number) — pdfjs hands us one TextRun spanning both. The
    // classifier used to flag this as ambiguous and the section
    // cascaded to classification_low_confidence. The sub-run splitter
    // separates the two halves at the decoration boundary so each
    // gets the correct insert/delete label and the section anchors
    // cleanly downstream.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", text: "(3)(2)", x: 0, y: 100, width: 30, height: 10 })],
      [
        // Strike on the first half (x 0-15) — `(3)` is deleted.
        mkOp({ bbox: { x: 0, y: 102, w: 15, h: 0.6 } }),
        // Underline on the second half (x 15-30) — `(2)` is inserted.
        mkOp({ bbox: { x: 15, y: 98, w: 15, h: 0.6 } }),
      ],
      META,
    );
    expect(result).toEqual([
      { page: 1, text: "(3)", kind: "delete", source_index: 0 },
      { page: 1, text: "(2)", kind: "insert", source_index: 0 },
    ]);
  });

  it("splits a strike→underline→strike run (overlapped-paren renumber) into three sub-spans", () => {
    // Ord. 260539 page 28: the lawyer renumbered subsection (5) → (2)
    // by overlapping the new parens with the old ones. Legistar typeset
    // it as one italic-Times run reading `(52)`: the leading `(5` is
    // struck (delete old number), the middle `2` is underlined (insert
    // new number), and the trailing `)` is struck (delete the closing
    // paren of the old `(5)`). The old splitAmbiguousRun rescue
    // expected exactly two decoration regions, one fully left of the
    // other, and cascaded the section to classification_low_confidence
    // on this three-region pattern. The boundary walker emits one
    // sub-span per kind region directly.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", text: "(52)", x: 0, y: 100, width: 30, height: 10 })],
      [
        mkOp({ bbox: { x: 0, y: 102, w: 15, h: 0.6 } }), // strike on "(5"
        mkOp({ bbox: { x: 15, y: 98, w: 7.5, h: 0.6 } }), // underline on "2"
        mkOp({ bbox: { x: 22.5, y: 102, w: 7.5, h: 0.6 } }), // strike on ")"
      ],
      META,
    );
    expect(result).toEqual([
      { page: 1, text: "(5", kind: "delete", source_index: 0 },
      { page: 1, text: "2", kind: "insert", source_index: 0 },
      { page: 1, text: ")", kind: "delete", source_index: 0 },
    ]);
  });

  it("classifies italic-Times runs whose text normalizes to empty as context (inter-glyph spaces)", () => {
    // SF Legistar typesets the space between two amendment words in the
    // same italic-Times font as the words themselves, but the underline
    // and strikethrough graphics ops are drawn under the GLYPHS, not
    // the inter-glyph space. A standalone " " run with width > 0 has no
    // decoration overlap and would otherwise fall through to ambiguous,
    // cascading the section. The run carries no diff payload, so it
    // classifies as context and gets filtered downstream.
    const result = classifySpans(
      [mkRun({ font_name: "f-amend", text: " ", x: 0, y: 100, width: 3, height: 10 })],
      [],
      META,
    );
    expect(result[0]?.kind).toBe("context");
  });

  it("classifies decoration on a non-italic-Times run as context (board-amendment limitation)", () => {
    // Board amendments (double-underlined / strikethrough Arial)
    // legitimately have decoration on non-italic-Times runs. Today
    // we short-circuit at the `isAmendmentClass` check and classify
    // them as context. The decoration is silently ignored — the
    // section will render WITHOUT the board-amendment span. Documented
    // limitation; feat/board-amendments will lift this.
    //
    // Tracking this as a test so a future change that revisits
    // board-amendment detection has a documented baseline.
    const result = classifySpans(
      [mkRun({ font_name: "f-context", x: 0, y: 100, width: 30, height: 10 })],
      [mkOp({ bbox: { x: 0, y: 98, w: 30, h: 0.6 } })],
      META,
    );
    expect(result[0]?.kind).toBe("context");
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
