// Reconstruct the post-amendment text of a section by walking the
// bill PDF's classified spans in source order: include underlined
// (insert) and plain (context) runs, skip struck (delete) runs,
// substitute baseline content where the bill elides with "* * * *".
//
// This is the constructive half of the v2 architecture. v1 anchored
// each bill span to a baseline position via substring search, then
// rendered the spans positioned. The anchor-everything strategy made
// every classifier miss a potential silent data loss — the §901
// labels that demoted to context still anchored, but to wherever
// "“Carbon Removal”" first appeared (nowhere, because it's new), so
// the labels vanished. v2 sidesteps the problem: build a complete
// `newText` string, then let `diffWords(baseline, newText)` compute
// the alignment. Misclassified inserts that include the right text
// produce "no change" in the diff (harmless); only misclassified
// deletes leak into newText, surfacing as visible "insert" chunks
// the operator can debug instead of as silent drops.

import type { TextRun } from "@/parser/pdf/page-extractor";
import type { ClassifiedSpan } from "./classify-spans";
import { emitStructuralWhitespace } from "./emit-structural-whitespace";

/**
 * Walk the section's classified spans in source order and produce
 * the post-amendment text the bill draws. Caller supplies:
 *   - `runs` — the entire bill's TextRun[] (used to look up the
 *      original position of each span via `source_index`)
 *   - `spans` — the section's slice of classified spans, in source
 *      order (output of `partitionSpansBySection`)
 *   - `baseline` — the corpus section's pre-amendment text, used to
 *      substitute elision regions
 */
export function reconstructNewText(
  runs: readonly TextRun[],
  spans: readonly ClassifiedSpan[],
  baseline: string,
): string {
  let newText = "";
  let cursor = 0;
  let prevEmittedRun: TextRun | null = null;

  let i = 0;
  while (i < spans.length) {
    const span = spans[i];
    if (span === undefined) {
      i++;
      continue;
    }
    const run = runs[span.source_index];
    if (run === undefined) {
      i++;
      continue;
    }

    if (span.kind === "elision") {
      // Coalesce consecutive elision spans: SF Legistar splits
      // "* * * *" into four individual runs, each individually
      // elision-kind. The boundary logic only needs to know "an
      // elision happened here," not how many asterisks it was.
      let j = i + 1;
      while (j < spans.length && spans[j]?.kind === "elision") j++;

      // Substitute baseline content from the cursor up to where the
      // next non-elision context span lands. Probe the next CONTEXT
      // span specifically — insert text doesn't exist in baseline,
      // so using insert as a probe would produce no match.
      let probeText: string | null = null;
      for (let k = j; k < spans.length; k++) {
        const probe = spans[k];
        if (probe?.kind === "context") {
          probeText = probe.text;
          break;
        }
      }
      if (probeText !== null) {
        const probeStart = findStrippedStart(baseline, probeText, cursor);
        if (probeStart !== null) {
          newText += baseline.slice(cursor, probeStart);
          cursor = probeStart;
        }
      } else {
        // Elision with no following context (e.g. elision sits at the
        // end of the section). Substitute the rest of baseline.
        newText += baseline.slice(cursor);
        cursor = baseline.length;
      }
      i = j;
      continue;
    }

    if (span.kind === "delete") {
      // Skip the run; advance baseline cursor past the matched text
      // so subsequent context/elision lookups don't re-scan it.
      const advanced = advanceMatch(baseline, span.text, cursor);
      if (advanced !== null) cursor = advanced;
      i++;
      continue;
    }

    if (span.kind === "insert") {
      if (prevEmittedRun !== null) {
        newText += emitStructuralWhitespace(prevEmittedRun, run);
      }
      newText += span.text;
      prevEmittedRun = run;
      i++;
      continue;
    }

    if (span.kind === "context") {
      if (prevEmittedRun !== null) {
        newText += emitStructuralWhitespace(prevEmittedRun, run);
      }
      newText += span.text;
      prevEmittedRun = run;
      const advanced = advanceMatch(baseline, span.text, cursor);
      if (advanced !== null) cursor = advanced;
      i++;
      continue;
    }

    // ambiguous: skip without advancing baseline. The caller is
    // expected to short-circuit the whole section to
    // classification_low_confidence before reaching this path; this
    // branch exists only so the walk stays defensive.
    i++;
  }

  // Append baseline tail (bill ends before baseline does — typical
  // when a section's last change sits in the middle and the rest is
  // implicitly unchanged).
  newText += baseline.slice(cursor);
  return newText;
}

/**
 * Whitespace-tolerant `indexOf`-then-advance: skip past `text` in
 * `baseline` starting at `cursor`. Returns the position right after
 * the match, or null when the remainder contains no match. The
 * whitespace tolerance matters because PDF extraction reflows
 * paragraphs into runs joined by single spaces, while the corpus
 * baseline preserves the original line breaks; a literal indexOf
 * would miss every span longer than one line.
 */
function advanceMatch(baseline: string, text: string, cursor: number): number | null {
  const needle = stripWhitespace(text);
  if (needle.length === 0) return cursor;
  const result = findStrippedRange(baseline, needle, cursor);
  return result?.endExclusive ?? null;
}

/**
 * Find the start position in `baseline` (original coords) where
 * `text` first matches after `cursor`. Used by the elision branch
 * to locate the next context span's starting point so the elision's
 * baseline substitution stops there.
 */
function findStrippedStart(baseline: string, text: string, cursor: number): number | null {
  const needle = stripWhitespace(text);
  if (needle.length === 0) return cursor;
  const result = findStrippedRange(baseline, needle, cursor);
  return result?.start ?? null;
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

function findStrippedRange(
  baseline: string,
  needleStripped: string,
  cursor: number,
): { start: number; endExclusive: number } | null {
  // Build a parallel string of the baseline tail with whitespace
  // removed, plus a map from each stripped char back to its
  // original baseline index.
  let stripped = "";
  const idxMap: number[] = [];
  for (let i = cursor; i < baseline.length; i++) {
    const ch = baseline[i];
    if (ch === undefined) continue;
    if (!/\s/.test(ch)) {
      stripped += ch;
      idxMap.push(i);
    }
  }
  const hit = stripped.indexOf(needleStripped);
  if (hit === -1) return null;
  const lastStrippedIdx = hit + needleStripped.length - 1;
  const startOrig = idxMap[hit];
  const lastOrig = idxMap[lastStrippedIdx];
  if (startOrig === undefined || lastOrig === undefined) return null;
  return { start: startOrig, endExclusive: lastOrig + 1 };
}
