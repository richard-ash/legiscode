import { describe, expect, it } from "vitest";
import type { TextRun } from "@/parser/pdf/page-extractor";
import {
  computeRunOffsetMap,
  runsToTextWithOffsets,
  stripChromeWithOffsets,
} from "@/parser/bills/run-offset-map";

function run(over: Partial<TextRun> & { text: string }): TextRun {
  return {
    page: 1,
    font_name: "ArialMT",
    has_eol: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...over,
  };
}

describe("runsToTextWithOffsets", () => {
  it("returns one contiguous range per run, with synthetic spaces between non-EOL runs", () => {
    const runs = [run({ text: "hello" }), run({ text: "world" })];
    const { text, runRangesInRaw } = runsToTextWithOffsets(runs);
    expect(text).toBe("hello world ");
    // Run 0: "hello" lives at [0, 5); gap " " at [5, 6).
    expect(runRangesInRaw[0]).toEqual({ start: 0, end: 5 });
    // Run 1: "world" lives at [6, 11); trailing " " at [11, 12).
    expect(runRangesInRaw[1]).toEqual({ start: 6, end: 11 });
  });

  it("emits a newline after runs with has_eol", () => {
    const runs = [run({ text: "line1", has_eol: true }), run({ text: "line2" })];
    const { text, runRangesInRaw } = runsToTextWithOffsets(runs);
    expect(text).toBe("line1\nline2 ");
    expect(runRangesInRaw[0]).toEqual({ start: 0, end: 5 });
    expect(runRangesInRaw[1]).toEqual({ start: 6, end: 11 });
  });

  it("does NOT inject a space after a run whose text already ends in a space", () => {
    const runs = [run({ text: "hello " }), run({ text: "world" })];
    const { text, runRangesInRaw } = runsToTextWithOffsets(runs);
    expect(text).toBe("hello world ");
    expect(runRangesInRaw[0]).toEqual({ start: 0, end: 6 });
    expect(runRangesInRaw[1]).toEqual({ start: 6, end: 11 });
  });

  it("collapses trailing whitespace before a synthetic newline (matches runsToText)", () => {
    // Run ends with a space, then has_eol → "abc " + "\n". The post-
    // assembly collapse `[ \t]+\n → \n` drops the trailing space.
    const runs = [run({ text: "abc ", has_eol: true }), run({ text: "def" })];
    const { text, runRangesInRaw } = runsToTextWithOffsets(runs);
    expect(text).toBe("abc\ndef ");
    // Run 0's end shifts left by one when the trailing space drops.
    expect(runRangesInRaw[0]).toEqual({ start: 0, end: 3 });
    expect(runRangesInRaw[1]).toEqual({ start: 4, end: 7 });
  });

  it("produces empty ranges for empty-text runs", () => {
    const runs = [run({ text: "" }), run({ text: "hi" })];
    const { text, runRangesInRaw } = runsToTextWithOffsets(runs);
    expect(text).toBe(" hi ");
    expect(runRangesInRaw[0]).toEqual({ start: 0, end: 0 });
  });
});

describe("stripChromeWithOffsets", () => {
  it("yields a single range per run when no chrome is present", () => {
    const raw = "Hello world";
    const ranges = [{ start: 0, end: 5 }];
    const { text, offsetMap } = stripChromeWithOffsets(raw, ranges);
    expect(text).toBe("Hello world");
    expect(offsetMap[0]).toEqual([{ chrome_start: 0, chrome_end: 5 }]);
  });

  it("drops PDF line-number lines entirely (run gets zero ranges)", () => {
    // Two runs: a page-margin "1" line and a body line.
    const raw = "1\nBody text.";
    const ranges = [
      { start: 0, end: 1 }, // the "1"
      { start: 2, end: 12 }, // "Body text."
    ];
    const { text, offsetMap } = stripChromeWithOffsets(raw, ranges);
    expect(text).toBe("Body text.");
    expect(offsetMap[0]).toEqual([]); // entirely stripped
    expect(offsetMap[1]).toEqual([{ chrome_start: 0, chrome_end: 10 }]);
  });

  it("strips inline sponsor reprints (run becomes empty or split)", () => {
    // A single "run" whose text contains a sponsor reprint. The
    // regex matches and drops "Supervisors Wong; Sauter", leaving
    // the surrounding text.
    const raw = "before Supervisors Wong; Sauter after";
    const ranges = [{ start: 0, end: raw.length }];
    const { text, offsetMap } = stripChromeWithOffsets(raw, ranges);
    expect(text).toBe("before after");
    // The run's footprint maps to two contiguous sub-ranges (one
    // before the strip, one after, on either side of the dropped span).
    const ranges0 = offsetMap[0] ?? [];
    expect(ranges0).toHaveLength(2);
    expect(ranges0[0]).toEqual({ chrome_start: 0, chrome_end: 6 }); // "before"
    expect(ranges0[1]).toEqual({ chrome_start: 6, chrome_end: 12 }); // " after"
  });

  it("preserves trailing newlines per stripChrome semantics", () => {
    // stripChrome trims trailing whitespace globally; here our input
    // has body text + a trailing footer line that gets stripped.
    const raw = "Body\nBOARD OF SUPERVISORS Page 1";
    const ranges = [
      { start: 0, end: 4 }, // "Body"
      { start: 5, end: 32 }, // the footer line
    ];
    const { text, offsetMap } = stripChromeWithOffsets(raw, ranges);
    expect(text).toBe("Body");
    expect(offsetMap[0]).toEqual([{ chrome_start: 0, chrome_end: 4 }]);
    expect(offsetMap[1]).toEqual([]);
  });

  it("keeps real section numbers (≥26) — not chrome", () => {
    const raw = "SEC. 100.\n26\nbody";
    const ranges = [
      { start: 0, end: 9 }, // SEC. 100.
      { start: 10, end: 12 }, // "26"
      { start: 13, end: 17 }, // body
    ];
    const { text, offsetMap } = stripChromeWithOffsets(raw, ranges);
    // 26 looks like a line number but stripChrome keeps it because
    // numbers > 25 aren't page-margin chrome. (The line-number test
    // is `>=1 && <=25`.)
    // Wait — the existing stripChrome regex matches `\d{1,2}` so 26
    // does match the pattern; the numeric guard says "if n >= 1 && n
    // <= 25" then drop. 26 fails the guard → kept.
    expect(text.includes("26")).toBe(true);
    expect(offsetMap[1]?.length).toBe(1);
  });
});

describe("computeRunOffsetMap (end-to-end)", () => {
  it("matches `stripChrome(runsToText(runs))` for the body text", () => {
    const runs = [
      run({ text: "Section 1.", has_eol: true }),
      run({ text: "1", has_eol: true }), // line-number chrome
      run({ text: "Body text.", has_eol: true }),
    ];
    const { text, offsetMap } = computeRunOffsetMap(runs);
    // Line-number "1" is stripped; the two body lines remain.
    expect(text).toBe("Section 1.\nBody text.");
    expect(offsetMap[0]).toEqual([{ chrome_start: 0, chrome_end: 10 }]); // Section 1.
    expect(offsetMap[1]).toEqual([]); // entirely stripped
    expect(offsetMap[2]).toEqual([{ chrome_start: 11, chrome_end: 21 }]); // Body text.
  });

  it("preserves the offset map across the trailing-whitespace-before-newline collapse", () => {
    const runs = [
      run({ text: "abc ", has_eol: true }), // " " gets collapsed by `[ \t]+\n → \n`
      run({ text: "def" }),
    ];
    const { text, offsetMap } = computeRunOffsetMap(runs);
    expect(text).toBe("abc\ndef");
    expect(offsetMap[0]).toEqual([{ chrome_start: 0, chrome_end: 3 }]);
    expect(offsetMap[1]).toEqual([{ chrome_start: 4, chrome_end: 7 }]);
  });
});
