// Build-time TextDiffSpan anchorer. Runs in `scripts/sync-bills.ts` after
// `parseBill` finishes; takes the classified spans the parser surfaced
// and binds each one to a (`baseline_offset`, `baseline_length`) pair
// inside the corpus section's baseline text. Per the locked plan's codex
// C1 + C5 + C7 + C8 refinements:
//
//   • C1 — runs in sync-bills, not parseBill. parseBill stays pure-PDF.
//   • C5 — the `anchor` field on TextDiffSpan is required; an anchor of
//          `(0, 0)` IS a real anchor (insertion at offset 0, length 0),
//          not a null sentinel.
//   • C7 — paragraph-anchored token scan. O(N) over normalized tokens,
//          paragraph boundaries the natural anchors. Elision spans are
//          treated as wildcard gaps (any length of baseline matches).
//   • C8 — per-section failure: a bill amending §A + §B can ship §A
//          fully anchored AND §B absent from `text_diff[]`. Renderer
//          falls back to manual_review for the absent section.
//
// ## Pipeline (ASCII)
//
//   ParseBillResult.classified_spans         (in source order)
//   ParseBillResult.runs                     (TextRun[] for page lookup)
//   bill.affected_sections                   (per-Bill, per-module)
//        │
//        ▼
//   anchorTextDiff(parseResult, baselineLookup)
//        │   for each (bill, section_id):
//        │     • partition spans into this section's slice
//        │     • normalize stated_before (context + delete) + baseline
//        │     • token-scan: every non-insert span must find its place
//        │       in the baseline at or after the running cursor
//        │     • elision spans → cursor jumps to next exact-match
//        │     • on success → emit TextDiffSpan[] with anchors
//        │     • on failure → section omitted from text_diff[]; cause
//        │       logged in outcomes[]
//        ▼
//   Bill records mutated in place; outcomes[] reports per-section status.
//
// ## v1 scope: single-section attribution
//
// SF Legistar PDFs encode each bill's redline content but don't expose
// a clean "this run belongs to that target section" mapping — the
// structural pass identifies AMEND groups by text offsets in
// chrome-stripped text, and re-correlating that back to TextRun
// indices through reflow + chrome-strip is non-trivial. For v1, this
// module attributes ALL classified spans to the FIRST affected section
// in `bill.affected_sections` and falls through every other section to
// manual_review. Multi-section bills are common but the renderer's
// manual_review fallback gracefully handles them.
//
// Follow-up (post-PR #12): per-section attribution. Tracked in
// TODOS.md alongside the existing L504 lead_in deferral.
//
// ## Whole-section repeal / add
//
// In addition to inline-amendment bills (typography decoder + token
// scan above), SF Legistar produces two simpler shapes the renderer
// must handle:
//
//   • whole-section delete — `is hereby amended by deleting
//     Section[s] X[, Y]`. The diff is "every char of section X gets
//     struck through." One delete span per section_id, anchored
//     against the FULL baseline range.
//   • whole-section add — `is hereby amended by adding Section X, to
//     read as follows: [body]`. The diff is "this whole section
//     appears." One insert span per added section_id, baseline empty,
//     anchored at (0, 0). Insert text comes from the bill body.
//
// These shapes don't use PDF underline/strikethrough decoration at
// all, so the typography decoder produces zero amendment spans. The
// wholesale classifier runs BEFORE the inline path and short-circuits
// it when any body.sections[i].action matches the delete/add verbs.
// Bills that mix wholesale + inline actions fall back to the inline
// path for the inline subset; the wholesale spans still ship.

import type { Bill, ModuleId, OrdinanceBlock, SectionId, TextDiffSpan } from "@/types";
import type { ParseBillResult } from "./index";
import type { ClassifiedSpan } from "./classify-spans";
import { normalize, tokenize } from "./normalize";

export type CorpusBaselineLookup = (
  moduleId: ModuleId,
  sectionId: SectionId,
) => string | null | undefined;

export type AnchorOutcomeStatus =
  | "anchored"
  | "alignment_failed"
  | "classification_low_confidence"
  | "no_baseline"
  | "fallthrough";

export type AnchorOutcome = {
  file_no: string;
  module_id: ModuleId;
  section_id: SectionId;
  status: AnchorOutcomeStatus;
  /** Human-readable cause for operator logs when status is not "anchored". */
  detail?: string;
};

export type AnchorTextDiffResult = {
  /** Mutated bills with `text_diff[]` populated for anchored sections. */
  bills: Bill[];
  /** One entry per (bill, affected_section) pair. */
  outcomes: AnchorOutcome[];
};

/**
 * Top-level entry point. Drives per-section anchoring across every bill
 * in `parseResult` and returns the updated bill records + an operator
 * log of per-section outcomes.
 */
export function anchorTextDiff(
  parseResult: ParseBillResult,
  baselineLookup: CorpusBaselineLookup,
): AnchorTextDiffResult {
  const outcomes: AnchorOutcome[] = [];
  const bills = parseResult.bills.map((b) => ({ ...b, text_diff: [] as TextDiffSpan[] }));

  for (const bill of bills) {
    if (bill.parse_status === "structural_change") {
      // No inline diff for structural changes — the renderer shows
      // structural_change_scope instead.
      for (const sid of bill.affected_sections) {
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "fallthrough",
          detail: "structural change — no inline diff",
        });
      }
      continue;
    }

    if (bill.affected_sections.length === 0) {
      continue;
    }

    // Wholesale-action path (whole-section delete or add). Runs before
    // the inline anchorer because delete/add bills have no PDF
    // underline/strikethrough decoration — the typography decoder
    // produces zero amendment spans, which would falsely look like
    // alignment_failed below. Each body.sections[i].action is matched
    // against the SF Legistar verb patterns; matches synthesize a
    // single delete or insert span per section_id.
    const wholesale = synthesizeWholesaleSpans(bill, baselineLookup);
    if (wholesale.spans.length > 0) {
      bill.text_diff = wholesale.spans;
      bill.parse_status = "ok";
      for (const o of wholesale.outcomes) outcomes.push(o);
      // Any affected_section not covered by a wholesale span (e.g. a
      // section the inline path would have handled) falls through.
      const covered = new Set(wholesale.spans.map((s) => s.section_id));
      for (const sid of bill.affected_sections) {
        if (!covered.has(sid)) {
          outcomes.push({
            file_no: bill.file_no,
            module_id: bill.module_id,
            section_id: sid,
            status: "fallthrough",
            detail: "wholesale action handled siblings; this section not matched",
          });
        }
      }
      continue;
    }
    for (const o of wholesale.outcomes) outcomes.push(o);

    // v1: anchor all classified spans against the FIRST affected
    // section. Secondary sections fall through to manual_review.
    const primarySection = bill.affected_sections[0];
    if (primarySection === undefined) continue;

    const baseline = baselineLookup(bill.module_id, primarySection);
    if (baseline === null || baseline === undefined || baseline.length === 0) {
      for (const sid of bill.affected_sections) {
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "no_baseline",
          detail: "corpus baseline not found for section",
        });
      }
      continue;
    }

    // Pull only the amendment-class + context + elision spans.
    // Context spans aren't strictly needed for the diff but they
    // provide anchor checkpoints during alignment.
    const sectionSpans = filterToAmendmentSpans(parseResult.classified_spans);

    // Reject early if any amendment span came through as "ambiguous"
    // — per the locked plan classify-spans treats ambiguous decoration
    // as a section-level failure cause.
    const ambiguousCount = sectionSpans.filter((s) => s.kind === "ambiguous").length;
    if (ambiguousCount > 0) {
      outcomes.push({
        file_no: bill.file_no,
        module_id: bill.module_id,
        section_id: primarySection,
        status: "classification_low_confidence",
        detail: `${ambiguousCount} ambiguous-decoration span(s)`,
      });
      for (const sid of bill.affected_sections.slice(1)) {
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "fallthrough",
          detail: "secondary section in multi-section bill (v1 scope)",
        });
      }
      continue;
    }

    const anchored = anchorAgainstBaseline(sectionSpans, baseline, primarySection);
    if (anchored.ok) {
      bill.text_diff = anchored.spans;
      outcomes.push({
        file_no: bill.file_no,
        module_id: bill.module_id,
        section_id: primarySection,
        status: "anchored",
      });
      // Flip parse_status to "ok" since text_diff is now non-empty.
      bill.parse_status = "ok";
    } else {
      outcomes.push({
        file_no: bill.file_no,
        module_id: bill.module_id,
        section_id: primarySection,
        status: "alignment_failed",
        detail: anchored.reason,
      });
    }

    for (const sid of bill.affected_sections.slice(1)) {
      outcomes.push({
        file_no: bill.file_no,
        module_id: bill.module_id,
        section_id: sid,
        status: "fallthrough",
        detail: "secondary section in multi-section bill (v1 scope)",
      });
    }
  }

  return { bills, outcomes };
}

function filterToAmendmentSpans(spans: readonly ClassifiedSpan[]): ClassifiedSpan[] {
  // Keep insert + delete + elision (the diff content) and context spans
  // whose text is non-empty after normalization (they're our anchor
  // points in the baseline scan).
  const out: ClassifiedSpan[] = [];
  for (const s of spans) {
    if (s.kind === "ambiguous") {
      out.push(s);
      continue;
    }
    if (s.kind === "context" && normalize(s.text).length === 0) {
      // Pure whitespace context — don't bother anchoring.
      continue;
    }
    out.push(s);
  }
  return out;
}

type AnchorResult = { ok: true; spans: TextDiffSpan[] } | { ok: false; reason: string };

/**
 * Paragraph-anchored token scan. Walks classified spans in source
 * order, advancing a cursor through the baseline as context + delete
 * spans match. Insert spans don't consume baseline. Elision spans
 * jump the cursor forward to the next matching anchor span.
 *
 * Match logic uses normalized tokens (whitespace-collapsed, NFC); the
 * baseline_offset / baseline_length pair on each output span captures
 * a char-level range in the (un-normalized) baseline.
 */
function anchorAgainstBaseline(
  spans: readonly ClassifiedSpan[],
  baseline: string,
  sectionId: SectionId,
): AnchorResult {
  const baselineNorm = normalize(baseline);
  if (baselineNorm.length === 0) {
    return { ok: false, reason: "baseline normalized to empty string" };
  }

  // Build a char-offset map: tokenStarts[k] = start char offset of the
  // k-th normalized token in the ORIGINAL `baseline` (not the normalized
  // form). The renderer + applyToBaseline slice the original baseline,
  // so offsets must index into it directly — every paragraph `\n` or
  // doubled whitespace run in the baseline would otherwise shift the
  // anchors by one char per gap (corpus section text from `bodyToText`
  // embeds paragraph `\n`s, so this is the common case, not the edge).
  const baselineTokens = tokenize(baseline);
  const tokenStarts: number[] = [];
  let walk = 0;
  for (const tok of baselineTokens) {
    // Skip any whitespace in the original baseline (newline, tab, NBSP,
    // doubled space — anything `\s` matches) so the next token's
    // position is found in original-string coordinates.
    while (walk < baseline.length && /\s/u.test(baseline[walk] ?? "")) walk++;
    // Each baseline token's first char must be a non-whitespace char in
    // the original; if not (e.g. the baseline starts with punctuation
    // that NFC normalization dropped), fall through but the anchor will
    // still point at the correct *position* because tokenize() is total
    // and normalize() preserves all non-whitespace chars.
    tokenStarts.push(walk);
    walk += tok.length;
  }

  const out: TextDiffSpan[] = [];
  let cursor = 0; // index into baselineTokens
  let pendingElision = false;

  for (const span of spans) {
    const text = span.text;
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;

    if (span.kind === "elision") {
      // Wildcard gap. Cursor will jump to wherever the next anchor
      // span matches.
      pendingElision = true;
      const offset = cursorToOffset(cursor, tokenStarts, baseline.length);
      out.push({
        op: "elision",
        text,
        section_id: sectionId,
        anchor: { baseline_offset: offset, baseline_length: 0 },
      });
      continue;
    }

    if (span.kind === "insert") {
      // No baseline consumption.
      const offset = cursorToOffset(cursor, tokenStarts, baseline.length);
      out.push({
        op: "insert",
        text,
        section_id: sectionId,
        anchor: { baseline_offset: offset, baseline_length: 0 },
      });
      pendingElision = false;
      continue;
    }

    // delete or context — must match baseline tokens starting at or
    // after `cursor`. An elision earlier in the run means we accept
    // the FIRST match >= cursor (the elision swallowed the gap).
    const minCursor = cursor;
    const matchIdx = findTokenRun(baselineTokens, tokens, minCursor, pendingElision);
    if (matchIdx < 0) {
      return {
        ok: false,
        reason: `token run "${tokens.slice(0, 5).join(" ")}…" not found in baseline (cursor ${cursor})`,
      };
    }
    const matchStart = tokenStarts[matchIdx];
    const lastTokenIdx = matchIdx + tokens.length - 1;
    const lastTokenStart = tokenStarts[lastTokenIdx];
    const lastToken = baselineTokens[lastTokenIdx];
    if (matchStart === undefined || lastTokenStart === undefined || lastToken === undefined) {
      return {
        ok: false,
        reason: `token-offset map missing entry at idx ${matchIdx}`,
      };
    }
    const matchEnd = lastTokenStart + lastToken.length;
    out.push({
      op: span.kind === "delete" ? "delete" : "context",
      text,
      section_id: sectionId,
      anchor: { baseline_offset: matchStart, baseline_length: matchEnd - matchStart },
    });
    cursor = matchIdx + tokens.length;
    pendingElision = false;
  }

  if (out.length === 0) {
    return { ok: false, reason: "no classified spans for this section" };
  }

  return { ok: true, spans: out };
}

function cursorToOffset(
  cursor: number,
  tokenStarts: readonly number[],
  baselineLength: number,
): number {
  if (cursor >= tokenStarts.length) return baselineLength;
  const v = tokenStarts[cursor];
  return v ?? 0;
}

/**
 * Find the first index in `haystack` (>= minIdx) where `needle` tokens
 * appear consecutively, comparing via `tokenEq` (case- and edge-
 * punctuation-insensitive). Returns -1 if absent.
 */
function findTokenRun(
  haystack: readonly string[],
  needle: readonly string[],
  minIdx: number,
  // wildcardOk is true when an elision span just made the gap-before-this
  // span an "any number of tokens may intervene" jump. The bound is the
  // same in both modes; the flag is reserved for future logic that
  // tightens the constraint when wildcardOk is false (e.g. limiting to
  // "this span is the very next anchor"). Today both modes behave the
  // same way — first hit at or after minIdx wins.
  _wildcardOk: boolean,
): number {
  if (needle.length === 0) return -1;
  const first = needle[0];
  if (first === undefined) return -1;
  outer: for (let i = minIdx; i <= haystack.length - needle.length; i++) {
    if (!tokenEq(haystack[i], first)) continue;
    for (let j = 1; j < needle.length; j++) {
      if (!tokenEq(haystack[i + j], needle[j])) continue outer;
    }
    return i;
  }
  return -1;
}

// Word-edge punctuation: the corpus's baseline text often carries
// trailing periods, commas, colons, parens, etc., while the PDF text-
// run boundary that produced a classified span may not. Two-step
// compare: strip leading + trailing non-alphanumeric, lowercase, then
// equality.
const WORD_EDGE = /^[^\p{L}\p{N}$§]+|[^\p{L}\p{N}$§]+$/gu;

function tokenEq(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.replace(WORD_EDGE, "").toLowerCase() === b.replace(WORD_EDGE, "").toLowerCase();
}

// ── Wholesale-action classifier ───────────────────────────────────────

type WholesaleAction =
  | { kind: "delete"; section_ids: string[] }
  | { kind: "add"; section_ids: string[] }
  | { kind: "inline" }
  | { kind: "unknown" };

const SECTION_LIST = "([\\w.,\\s-]+?)";

// "amended by deleting Section X" / "deleting Sections X and Y" /
// "deleting Sections X, Y, and Z". Stops at the next clause boundary
// ("to read", "of the", period, end of string).
const DELETE_RE = new RegExp(
  `\\bamended\\s+by\\s+deleting\\s+Sections?\\s+${SECTION_LIST}(?:\\s*,?\\s*to\\s+read\\s+as\\s+follows|\\s*,?\\s*of\\s+the\\b|\\.(?=\\s|$)|$)`,
  "i",
);

// "amended by adding Section X" / "adding a new Section X" / list form.
const ADD_RE = new RegExp(
  `\\bamended\\s+by\\s+adding\\s+(?:a\\s+new\\s+)?Sections?\\s+${SECTION_LIST}(?:\\s*,?\\s*to\\s+read\\s+as\\s+follows|\\s*,?\\s*of\\s+the\\b|\\.(?=\\s|$)|$)`,
  "i",
);

// "amended to read as follows" / "amended by revising Section X" —
// the standard inline-amendment phrasing. Don't match wholesale here.
const INLINE_RE = /\b(?:amended\s+to\s+read|by\s+revising\s+Sections?\s+)/i;

export function classifySectionAction(action: string): WholesaleAction {
  const del = action.match(DELETE_RE);
  if (del && del[1] !== undefined) {
    const ids = parseSectionList(del[1]);
    if (ids.length > 0) return { kind: "delete", section_ids: ids };
  }
  const add = action.match(ADD_RE);
  if (add && add[1] !== undefined) {
    const ids = parseSectionList(add[1]);
    if (ids.length > 0) return { kind: "add", section_ids: ids };
  }
  if (INLINE_RE.test(action)) return { kind: "inline" };
  return { kind: "unknown" };
}

// "515 and 516" → ["515", "516"]
// "515, 516, and 517" → ["515", "516", "517"]
// "10.04.020" → ["10.04.020"]
function parseSectionList(raw: string): string[] {
  return raw
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[A-Za-z]?\d/.test(s));
}

type WholesaleResult = {
  spans: TextDiffSpan[];
  outcomes: AnchorOutcome[];
};

function synthesizeWholesaleSpans(
  bill: Bill,
  baselineLookup: CorpusBaselineLookup,
): WholesaleResult {
  const spans: TextDiffSpan[] = [];
  const outcomes: AnchorOutcome[] = [];
  const affectedSet = new Set<string>(bill.affected_sections);

  for (const bodySection of bill.body.sections) {
    const cls = classifySectionAction(bodySection.action);
    if (cls.kind !== "delete" && cls.kind !== "add") continue;

    for (const rawSid of cls.section_ids) {
      // Only emit for sections the structural pass already flagged as
      // affected; anything else is a parser/regex mismatch we don't
      // want to silently invent text_diff for.
      if (!affectedSet.has(rawSid)) continue;
      const sid = rawSid as SectionId;

      if (cls.kind === "delete") {
        const baseline = baselineLookup(bill.module_id, sid);
        if (baseline === null || baseline === undefined || baseline.length === 0) {
          outcomes.push({
            file_no: bill.file_no,
            module_id: bill.module_id,
            section_id: sid,
            status: "no_baseline",
            detail: "wholesale delete — corpus baseline missing",
          });
          continue;
        }
        spans.push({
          op: "delete",
          text: baseline,
          section_id: sid,
          anchor: { baseline_offset: 0, baseline_length: baseline.length },
        });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "anchored",
          detail: "whole-section delete",
        });
      } else {
        // add
        const insertText = extractAddedSectionText(bodySection.body, rawSid);
        if (insertText.length === 0) {
          outcomes.push({
            file_no: bill.file_no,
            module_id: bill.module_id,
            section_id: sid,
            status: "alignment_failed",
            detail: "wholesale add — bill body for this section is empty",
          });
          continue;
        }
        spans.push({
          op: "insert",
          text: insertText,
          section_id: sid,
          anchor: { baseline_offset: 0, baseline_length: 0 },
        });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "anchored",
          detail: "whole-section add",
        });
      }
    }
  }

  return { spans, outcomes };
}

// Slice the OrdinanceBlock subtree belonging to a single section out
// of the AMEND group's body. body.sections[i].body is a flat list that
// may interleave multiple section_header blocks when one AMEND group
// adds several sections — walk until the next section_header or end.
function extractAddedSectionText(blocks: readonly OrdinanceBlock[], sectionNumber: string): string {
  const collected: OrdinanceBlock[] = [];
  let inside = false;
  for (const b of blocks) {
    if (b.kind === "section_header") {
      if (b.number === sectionNumber) {
        inside = true;
        collected.push(b);
        continue;
      }
      if (inside) break;
    }
    if (inside) collected.push(b);
  }
  return ordinanceBlocksToText(collected);
}

function ordinanceBlocksToText(blocks: readonly OrdinanceBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "section_header":
        parts.push(`§${b.number} ${b.title}`);
        break;
      case "paragraph":
        parts.push(b.text);
        break;
      case "subsection":
        parts.push(`(${b.marker})`);
        parts.push(ordinanceBlocksToText(b.body));
        break;
    }
  }
  return parts.join("\n").trim();
}
