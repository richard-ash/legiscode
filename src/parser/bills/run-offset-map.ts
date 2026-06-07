// Run-offset map. Threads `TextRun` indices through the lossy text
// transformations (`runsToText` → `stripChrome`) so the per-section
// partition in `anchorTextDiff` can map a classified-span back to its
// position in the chrome-stripped text the structural pass reasoned
// about.
//
// Why a separate module: the inverse mapping is non-trivial because
//
//   • `runsToText` injects synthetic whitespace (single space between
//     runs, `\n` after `has_eol` runs) — a run's content occupies a
//     contiguous sub-range of the raw text, but the gaps between runs
//     have no source run.
//   • `stripChrome` drops entire lines (page-margin line numbers,
//     footers, the typography legend) and strips inline patterns
//     (sponsor reprints) from surviving lines. A single source run can
//     therefore be split into 0, 1, or N surviving ranges in the
//     stripped text — never a single 1:1 range.
//
// The two-step pipeline below preserves both: `runsToTextWithOffsets`
// returns the raw text plus a single per-run range, and
// `stripChromeWithOffsets` then projects each run's range through the
// chrome strip into a list of surviving sub-ranges. Callers that only
// need the text use the existing `.text` wrappers; callers that need
// the offset map (today: `emit-diff`) call the with-offsets variants.

import type { TextRun } from "@/parser/pdf/page-extractor";

/**
 * One contiguous range of characters in the chrome-stripped text that
 * came from a single source `TextRun`. Endpoints are half-open
 * `[chrome_start, chrome_end)` so an empty range is `chrome_start ===
 * chrome_end`.
 */
export interface RunRange {
  chrome_start: number;
  chrome_end: number;
}

/**
 * Map from `TextRun` index → list of ranges in the chrome-stripped
 * text. The outer array has the same length as the input runs array.
 * A run that was fully stripped (e.g. its only line was a page-margin
 * number) yields an empty inner array. A run whose surviving content
 * was split across multiple strips (rare; happens when the inline
 * sponsor-reprint regex bisects a run's text) yields N > 1 ranges.
 */
export type RunOffsetMap = ReadonlyArray<ReadonlyArray<RunRange>>;

/**
 * Single contiguous range in the unstripped text. Returned by
 * `runsToTextWithOffsets` and consumed by `stripChromeWithOffsets`.
 */
interface RawRange {
  start: number;
  end: number;
}

/**
 * `runsToText` plus the per-run range in the resulting string. Each
 * run contributes one contiguous sub-range; the gaps between runs
 * (synthetic whitespace + newlines `runsToText` injects) have no
 * source-run owner.
 *
 * Mirrors `runsToText` in `page-extractor.ts` exactly — the existing
 * function should become a `.text` wrapper around this one once the
 * call sites are migrated.
 */
export function runsToTextWithOffsets(runs: readonly TextRun[]): {
  text: string;
  runRangesInRaw: ReadonlyArray<RawRange>;
} {
  const parts: string[] = [];
  const rawRanges: RawRange[] = [];
  let cursor = 0;
  // Track each gap so the final whitespace-collapse pass (the `[
  // \t]+\n` → `\n` collapse) can be projected back through the run
  // ranges. The collapse only affects gap characters, never run
  // content, so we can do the projection by walking the assembled
  // string and adjusting offsets where the collapse removes chars.
  for (const run of runs) {
    parts.push(run.text);
    const start = cursor;
    cursor += run.text.length;
    rawRanges.push({ start, end: cursor });
    if (run.has_eol) {
      parts.push("\n");
      cursor += 1;
    } else if (!run.text.endsWith(" ")) {
      parts.push(" ");
      cursor += 1;
    }
  }
  const joined = parts.join("");
  // `runsToText` applies `replace(/[ \t]+\n/g, "\n")` at the end. The
  // collapse only ever removes trailing whitespace IMMEDIATELY before
  // a `\n`; that whitespace lives either in run content (a run whose
  // text ends in `" "`) or in the synthetic-whitespace gap. Project
  // ranges through the collapse by walking the joined string and
  // adjusting endpoints when chars in their span are dropped.
  return collapseTrailingWhitespaceBeforeNewline(joined, rawRanges);
}

function collapseTrailingWhitespaceBeforeNewline(
  joined: string,
  rawRanges: readonly RawRange[],
): { text: string; runRangesInRaw: ReadonlyArray<RawRange> } {
  // Walk the joined string char-by-char, copying chars to `out` and
  // recording a `dropped: number` count per source index. The mapping
  // from source idx → output idx is monotone so we can project ranges
  // by reading the mapping at start/end.
  const TRAILING_WS = /[ \t]+\n/g;
  // Fast path: no match → no change.
  if (!TRAILING_WS.test(joined)) {
    return { text: joined, runRangesInRaw: rawRanges };
  }
  // Build a prefix-shift table: `shift[i]` = number of chars dropped
  // when projecting source index `i`. Reset the regex state because
  // `.test()` advanced lastIndex.
  TRAILING_WS.lastIndex = 0;
  const shift = new Int32Array(joined.length + 1);
  let cur = 0;
  let m: RegExpExecArray | null = TRAILING_WS.exec(joined);
  while (m !== null) {
    // Drop chars `m.index .. m.index + m[0].length - 1` (every char in
    // the match EXCEPT the trailing `\n`, which is at index `m.index +
    // m[0].length - 1`). Setting up the shift table is easier if we
    // populate up to `m.index`, then jump the cursor past the dropped
    // chars.
    for (; cur <= m.index; cur++) shift[cur] = shiftPrevDrops(shift, cur);
    const dropCount = m[0].length - 1; // every char except the trailing `\n`
    const dropStart = m.index;
    const dropEnd = m.index + dropCount; // exclusive
    for (let i = dropStart + 1; i <= dropEnd; i++) {
      shift[i] = shiftPrevDrops(shift, i - 1) + (i - dropStart);
    }
    // Skip past dropEnd in the outer prefix loop — the inner loop just
    // populated shift[dropEnd], and the outer loop's
    // `shift[cur] = shift[cur-1]` propagation would overwrite it.
    cur = dropEnd + 1;
    m = TRAILING_WS.exec(joined);
  }
  for (; cur <= joined.length; cur++) shift[cur] = shiftPrevDrops(shift, cur);

  const projected = rawRanges.map((r) => ({
    start: r.start - (shift[r.start] ?? 0),
    end: r.end - (shift[r.end] ?? 0),
  }));
  return { text: joined.replace(/[ \t]+\n/g, "\n"), runRangesInRaw: projected };
}

function shiftPrevDrops(shift: Int32Array, i: number): number {
  if (i === 0) return 0;
  return shift[i - 1] ?? 0;
}

// ── stripChrome with offsets ─────────────────────────────────────────

const PAGE_LINE_NUMBER = /^\s*\d{1,2}\s*$/;
const BOARD_FOOTER = /^BOARD OF SUPERVISORS\b/;
const FILE_NO_HEADER = /^FILE NO\.\s+\d+\s+ORDINANCE NO\b/;
// Lines that contain ONLY a sponsor reprint. `Supervisors? <Name>` is the
// original signature shape; bills co-introduced by the Mayor add a leading
// `Mayor <Name>;?` segment which can appear either with Supervisors
// following (handled inline below) or on its own line when the footer
// wraps. Matching standalone "Mayor <Name>" requires anchoring on end of
// line to avoid eating body prose like "by Mayor Lurie and the Board".
const SPONSOR_REPRINT = /^(?:Mayor [A-Z][A-Za-z'-]+;?\s*$|Supervisors? [A-Z])/;
const LEGEND_PREFIXES = [
  "NOTE:",
  "Additions to Codes",
  "Deletions to Codes",
  "Board amendment additions",
  "Board amendment deletions",
  "Asterisks (",
  "subsections or parts of tables",
];
// Sponsor block that appears inline (concatenated mid-line by document-
// order extraction when the footer's text-content stream slot precedes
// the body's). The optional `Mayor <Name>;` prefix captures co-sponsored
// bills; the original `Supervisors? <Name>, …` segment still anchors
// the match.
const INLINE_SPONSOR_REPRINT =
  /\s*(?:Mayor [A-Z][A-Za-z'-]+;\s+)?Supervisors? [A-Z][A-Za-z'-]+(?:[;,]\s+[A-Z][A-Za-z'-]+)*(?=\s|$)/g;
// Trailing "Mayor <Name>" that drifted to the end of a line by itself —
// the page-bottom footer slot on the next page lands here when the
// preceding page ends mid-sentence. Anchored on end-of-line so body
// prose ("Mayor Lurie introduced this …") survives.
const INLINE_MAYOR_TRAILING = /\s+Mayor [A-Z][A-Za-z'-]+(?=\s*(?:\n|$))/g;

/**
 * `stripChrome` plus the per-run multi-range projection through the
 * chrome strip. Returns the stripped text and an offset map indexed by
 * the same `TextRun` indices that `runsToTextWithOffsets` produced.
 *
 * Algorithm: build a char-level survival map over the raw text (1 if
 * the char survives chrome strip, 0 if dropped), compute a
 * monotonic source→stripped index translation, then project each
 * run's raw range into one or more contiguous surviving sub-ranges in
 * the stripped text.
 */
export function stripChromeWithOffsets(
  raw: string,
  runRangesInRaw: ReadonlyArray<RawRange>,
): { text: string; offsetMap: RunOffsetMap } {
  // First-pass: apply the inline sponsor-reprint strips with an explicit
  // survival mask over `raw`. The output `survived[i] === true` iff char
  // `raw[i]` survives this first transformation. Two passes run in
  // sequence — the Supervisors-anchored form catches the dominant
  // signature shape (with or without a co-sponsor Mayor prefix); the
  // trailing-Mayor form catches the rarer case where the footer wraps
  // such that only the Mayor name lands inline.
  const survivedInline = new Uint8Array(raw.length).fill(1);
  for (const re of [INLINE_SPONSOR_REPRINT, INLINE_MAYOR_TRAILING]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(raw);
    while (m !== null) {
      for (let i = m.index; i < m.index + m[0].length; i++) survivedInline[i] = 0;
      m = re.exec(raw);
    }
  }

  // Build the post-inline-strip text and a map from postInline index
  // back to raw index for the line-level pass to walk.
  const postInlineChars: string[] = [];
  const postInlineToRaw: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (survivedInline[i] === 1) {
      postInlineChars.push(raw[i] ?? "");
      postInlineToRaw.push(i);
    }
  }
  const postInline = postInlineChars.join("");

  // Line-pass survival mask over `postInline`.
  const survivedLine = new Uint8Array(postInline.length).fill(1);
  // Walk lines (split-by-\n preserving boundaries). For every line we
  // drop, zero out its chars in `survivedLine`. We keep \n separators
  // themselves UNLESS the line they terminate was dropped (then the
  // \n also goes — `kept.join("\n")` rebuilds the kept lines with one
  // \n between them).
  //
  // To match the line-collapse behavior of stripChrome (kept lines
  // join with \n; runs of dropped lines collapse), we instead build
  // the same "kept" array used by stripChrome, but for each char of
  // each kept line we record its surviving index in the final text.
  const lineStarts: number[] = [];
  const lineEnds: number[] = []; // exclusive of the \n
  {
    let s = 0;
    for (let i = 0; i < postInline.length; i++) {
      if (postInline[i] === "\n") {
        lineStarts.push(s);
        lineEnds.push(i);
        s = i + 1;
      }
    }
    lineStarts.push(s);
    lineEnds.push(postInline.length);
  }
  // Decide kept/dropped for each line; the rules mirror stripChrome.
  const keptLines: boolean[] = [];
  for (let li = 0; li < lineStarts.length; li++) {
    const start = lineStarts[li];
    const end = lineEnds[li];
    if (start === undefined || end === undefined) {
      keptLines.push(false);
      continue;
    }
    const line = postInline.slice(start, end);
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      keptLines.push(true); // blank line — keep (will collapse later)
      continue;
    }
    if (PAGE_LINE_NUMBER.test(trimmed)) {
      const n = Number(trimmed);
      if (n >= 1 && n <= 25) {
        keptLines.push(false);
        continue;
      }
    }
    if (BOARD_FOOTER.test(trimmed)) {
      keptLines.push(false);
      continue;
    }
    if (FILE_NO_HEADER.test(trimmed)) {
      keptLines.push(false);
      continue;
    }
    if (SPONSOR_REPRINT.test(trimmed)) {
      keptLines.push(false);
      continue;
    }
    if (LEGEND_PREFIXES.some((p) => trimmed.startsWith(p))) {
      keptLines.push(false);
      continue;
    }
    keptLines.push(true);
  }
  // Zero out dropped lines (including their trailing \n if it exists).
  for (let li = 0; li < keptLines.length; li++) {
    if (keptLines[li] === true) continue;
    const start = lineStarts[li];
    const end = lineEnds[li];
    if (start === undefined || end === undefined) continue;
    for (let i = start; i < end; i++) survivedLine[i] = 0;
    // Drop the trailing \n if present (it's at `end` if `end <
    // postInline.length`).
    if (end < postInline.length) survivedLine[end] = 0;
  }

  // Reconstruct stripped text from survivedLine, then apply the same
  // \n{3,}→\n\n collapse + trim that stripChrome does at the end.
  const strippedPreCollapse: string[] = [];
  const strippedToPostInline: number[] = [];
  for (let i = 0; i < postInline.length; i++) {
    if (survivedLine[i] === 1) {
      strippedPreCollapse.push(postInline[i] ?? "");
      strippedToPostInline.push(i);
    }
  }
  const preCollapse = strippedPreCollapse.join("");
  // Collapse runs of 3+ newlines to exactly 2; then trim. Build a
  // shift table over preCollapse for the projection.
  const collapsed = collapseNewlinesAndTrim(preCollapse);

  // Final mapping: rawIndex → strippedIndex (or -1 if not surviving).
  // Build the inverse of strippedToPostInline + postInlineToRaw + the
  // shifts from collapse.
  const finalRawToStripped = new Int32Array(raw.length).fill(-1);
  for (let si = 0; si < collapsed.text.length; si++) {
    const pre = collapsed.strippedIndexToPreCollapse[si] ?? -1;
    if (pre < 0) continue;
    const pi = strippedToPostInline[pre] ?? -1;
    if (pi < 0) continue;
    const ri = postInlineToRaw[pi] ?? -1;
    if (ri < 0) continue;
    finalRawToStripped[ri] = si;
  }

  // Project each run's raw range into the final stripped text. A range
  // becomes a list of contiguous sub-ranges over the surviving raw
  // indices in [run.start, run.end).
  const offsetMap: RunRange[][] = runRangesInRaw.map((rr) => {
    const subRanges: RunRange[] = [];
    let currentStart = -1;
    let prevStripped = -1;
    for (let ri = rr.start; ri < rr.end; ri++) {
      const si = finalRawToStripped[ri] ?? -1;
      if (si < 0) {
        if (currentStart >= 0) {
          subRanges.push({ chrome_start: currentStart, chrome_end: prevStripped + 1 });
          currentStart = -1;
        }
        continue;
      }
      if (currentStart < 0) {
        currentStart = si;
        prevStripped = si;
        continue;
      }
      // Contiguous (in source raw idx) chars may not stay contiguous
      // in stripped — if so, close the current sub-range and start a
      // new one. Stripped indices for surviving raw chars are
      // monotone-increasing but may skip (when intervening raw chars
      // got dropped), which signals a break in the run's footprint.
      if (si === prevStripped + 1) {
        prevStripped = si;
      } else {
        subRanges.push({ chrome_start: currentStart, chrome_end: prevStripped + 1 });
        currentStart = si;
        prevStripped = si;
      }
    }
    if (currentStart >= 0) {
      subRanges.push({ chrome_start: currentStart, chrome_end: prevStripped + 1 });
    }
    return subRanges;
  });

  return { text: collapsed.text, offsetMap };
}

function collapseNewlinesAndTrim(s: string): {
  text: string;
  strippedIndexToPreCollapse: ReadonlyArray<number>;
} {
  // Walk `s`, tracking how many consecutive `\n` we've seen. Emit
  // the char only when keeping is in scope per the `\n{3,}→\n\n` rule
  // (we keep the first two `\n`s in any run, drop the rest).
  const preMap: number[] = [];
  const out: string[] = [];
  let nlRun = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n") {
      nlRun++;
      if (nlRun <= 2) {
        out.push(ch);
        preMap.push(i);
      }
    } else {
      nlRun = 0;
      out.push(ch ?? "");
      preMap.push(i);
    }
  }
  // Trim: `.trim()` removes leading and trailing whitespace per
  // `\s` (which includes `\n`, `\r`, ` `, `\t`, `\f`, `\v`).
  const joined = out.join("");
  let leading = 0;
  while (leading < joined.length && /\s/u.test(joined[leading] ?? "")) leading++;
  let trailing = joined.length;
  while (trailing > leading && /\s/u.test(joined[trailing - 1] ?? "")) trailing--;
  const trimmed = joined.slice(leading, trailing);
  const trimmedMap = preMap.slice(leading, trailing);
  return { text: trimmed, strippedIndexToPreCollapse: trimmedMap };
}

/**
 * Convenience: do both passes in one call.
 *
 * Returns `text` = chrome-stripped text (same as the existing
 * `stripChrome(runsToText(runs))` composition) and `offsetMap` =
 * per-run ranges in that text. Most callers want this entry point —
 * the two-step variants exist for test isolation and for the rare
 * caller that needs the un-stripped intermediate text.
 */
export function computeRunOffsetMap(runs: readonly TextRun[]): {
  text: string;
  offsetMap: RunOffsetMap;
} {
  const { text: raw, runRangesInRaw } = runsToTextWithOffsets(runs);
  return stripChromeWithOffsets(raw, runRangesInRaw);
}
