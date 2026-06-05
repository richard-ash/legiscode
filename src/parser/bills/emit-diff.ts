// Build-time TextDiffSpan anchorer. Runs in `scripts/sync-bills.ts`
// after `parseBill` finishes; takes the classified spans the parser
// surfaced and binds each one to a (`baseline_offset`,
// `baseline_length`) pair inside the corpus section's baseline text.
//
// Invariants:
//
//   • Lives in sync-bills, not parseBill. parseBill stays pure-PDF.
//   • The `anchor` field on TextDiffSpan is required; an anchor of
//     `(0, 0)` IS a real anchor (insertion at offset 0, length 0),
//     not a null sentinel.
//   • diff-against-baseline. The classifier gives us context / insert /
//     delete / elision spans per source PDF run. We compute the bill's
//     intended new text by concatenating context + insert spans, then
//     run a word-level diff against the corpus baseline. Each hunk
//     becomes a TextDiffSpan with offset/length into the original
//     baseline. The bill's strike/underline marks inform `newText`;
//     they don't drive the anchor scan directly.
//   • Per-section partition. The parser's `section_partitions` carry
//     the chrome-text range each target section's body lives in;
//     `run_offset_map` projects each classified span's source run
//     into the same chrome-text. A span belongs to a section if any
//     of its ranges intersects that section's range. Spans whose
//     ranges fall outside every section's range are unattributed
//     (typically pre-amble or boilerplate prose between AMEND groups).
//   • Per-section failure is local. A bill amending §A + §B can ship
//     §A fully anchored AND §B as classification_low_confidence /
//     no_baseline. The bill's parse_status is derived from the
//     per-section breakdown.
//
// ## Pipeline (ASCII)
//
//   ParseBillResult.classified_spans         (in source order)
//   ParseBillResult.runs                     (TextRun[] for page lookup)
//   ParseBillResult.run_offset_map           (run idx → ranges in chrome text)
//   ParseBillResult.section_partitions       (per-target chrome ranges)
//        │
//        ▼
//   anchorTextDiff(parseResult, baselineLookup)
//        │   build per-section span buckets via run_offset_map +
//        │   chrome_range intersection. For each (bill, partition):
//        │     • bucket classified_spans into this section's slice
//        │     • short-circuit on ambiguous → classification_low_confidence
//        │     • compute newText = ⨁(context + insert spans)
//        │     • diffWords(baseline, newText) → hunks
//        │     • emit TextDiffSpan[] mapped to baseline offsets
//        ▼
//   Bill records mutated in place; section_outcomes carries the per-
//   section breakdown; parse_status is derived from section_outcomes.

import { diffWords } from "diff";
import type {
  Bill,
  ModuleId,
  OrdinanceBlock,
  SectionId,
  SectionOutcome,
  SectionOutcomeStatus,
  TextDiffSpan,
} from "@/types";
import { deriveParseStatus } from "@/types";
import type { ClassifiedSpan } from "./classify-spans";
import type { ParseBillResult, SectionPartitionEntry } from "./index";
import type { RunRange } from "./run-offset-map";

export type CorpusBaselineLookup = (
  moduleId: ModuleId,
  sectionId: SectionId,
) => string | null | undefined;

// AnchorOutcome — operator log row per (bill, section). The
// status set MATCHES SectionOutcomeStatus exactly so the same value
// can flow into both the on-disk Bill.section_outcomes and the
// operator-facing log stream.
export type AnchorOutcomeStatus = SectionOutcomeStatus;

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
  /** One entry per (bill, target_section) pair. */
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
  const bills = parseResult.bills.map((b) => ({
    ...b,
    section_outcomes: [...b.section_outcomes],
    text_diff: [] as TextDiffSpan[],
  }));

  // Pre-bucket section partitions by module so we don't quadratic-scan
  // for each bill.
  const partitionsByModule = new Map<ModuleId, SectionPartitionEntry[]>();
  for (const p of parseResult.section_partitions) {
    const list = partitionsByModule.get(p.module_id) ?? [];
    list.push(p);
    partitionsByModule.set(p.module_id, list);
  }

  for (const bill of bills) {
    // Structural-action bills: no inline diff is meaningful. Emit one
    // "structural" outcome per identified section so the renderer can
    // surface "this bill restructures the chapter and touches §A, §B."
    if (bill.parse_status === "structural_change") {
      const partitions = partitionsByModule.get(bill.module_id) ?? [];
      const newOutcomes: SectionOutcome[] = [];
      for (const p of partitions) {
        if (p.section_id === null) continue;
        newOutcomes.push({ section_id: p.section_id, status: "structural", detail: null });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: p.section_id,
          status: "structural",
          detail: "structural change — no inline diff",
        });
      }
      bill.section_outcomes = dedupeOutcomes(newOutcomes);
      bill.parse_status = deriveParseStatus(bill.section_outcomes, true);
      continue;
    }

    const partitions = partitionsByModule.get(bill.module_id) ?? [];

    // Wholesale-action path (whole-section delete or add). Runs before
    // the inline path AND before the body_only short-circuit because
    // T4 added_section detection runs through this path: a bill with
    // an `add` action on a raw_section_id that didn't resolve produces
    // an `added_section` outcome HERE, not in any partition loop.
    // Each body.amendments[i].action is matched against the SF Legistar
    // verb patterns; matches synthesize a single delete or insert span
    // per section_id.
    const wholesaleOutcomes: SectionOutcome[] = [];
    const wholesaleSpans: TextDiffSpan[] = [];
    const wholesale = synthesizeWholesale(bill, partitions, baselineLookup, parseResult);
    for (const span of wholesale.spans) wholesaleSpans.push(span);
    for (const o of wholesale.outcomes) {
      wholesaleOutcomes.push({
        section_id: o.section_id,
        status: o.status,
        detail: o.detail ?? null,
      });
      outcomes.push({ ...o, file_no: bill.file_no, module_id: bill.module_id });
    }

    // For the inline path, exclude partitions that the wholesale path
    // already produced an outcome for. Null-section_id partitions
    // (unresolved raw_ids) get an unresolved outcome here UNLESS T4's
    // wholesale path already classified them as added_section.
    const wholesaleCovered = new Set<string>(wholesaleOutcomes.map((o) => o.section_id));
    const inlinePartitions = partitions.filter((p) => {
      const probeKey = p.section_id ?? p.raw_section_id;
      return !wholesaleCovered.has(probeKey);
    });

    const inlineOutcomes: SectionOutcome[] = [];
    const inlineSpans: TextDiffSpan[] = [];

    // Per-section partition of classified spans via the run-offset map.
    const spansBySection = partitionSpansBySection(
      parseResult.classified_spans,
      parseResult.run_offset_map,
      inlinePartitions,
    );

    for (const partition of inlinePartitions) {
      if (partition.section_id === null) {
        const baseDetail = `raw section id "${partition.raw_section_id}" did not resolve against the module's section index`;
        // When the same candidates resolve in a different installed
        // module, the structural pass mis-routed this header. The
        // operator log distinguishes routing failures from genuine
        // corpus gaps so we don't chase ghosts when the real bug is
        // an unmatched `Section N. <Code> Code is hereby amended…` line
        // upstream.
        const detail = partition.orphan_in_module
          ? `${baseDetail} — but candidate(s) [${partition.candidates.join(", ")}] resolve in module "${partition.orphan_in_module}"; structural pass likely missed an ord-section boundary`
          : baseDetail;
        const unresolvedOutcome: SectionOutcome = {
          section_id: (partition.candidates[0] ?? partition.raw_section_id) as SectionId,
          status: "unresolved",
          detail,
        };
        inlineOutcomes.push(unresolvedOutcome);
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: unresolvedOutcome.section_id,
          status: "unresolved",
          detail: unresolvedOutcome.detail ?? undefined,
        });
        continue;
      }
      const sid = partition.section_id;
      const sectionSpans = spansBySection.get(sid) ?? [];
      const baseline = baselineLookup(bill.module_id, sid);
      if (baseline === null || baseline === undefined || baseline.length === 0) {
        inlineOutcomes.push({
          section_id: sid,
          status: "no_baseline",
          detail: "corpus baseline not found for section",
        });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "no_baseline",
          detail: "corpus baseline not found for section",
        });
        continue;
      }

      // Reject ambiguous-decoration amendment spans early. Per D9 truth
      // table, ambiguous spans get treated as classification_low_confidence
      // for the WHOLE section (the diff would be wrong if we forced
      // a decision); ambiguous spans on context (no decoration on a
      // non-italic-Times run, which classify-spans pegs as ambiguous
      // for the false-context board-amendment pattern at :143) are
      // intentionally still rejected — we'd rather show the manual-
      // review banner than a wrong diff.
      const ambiguousCount = sectionSpans.filter((s) => s.kind === "ambiguous").length;
      if (ambiguousCount > 0) {
        inlineOutcomes.push({
          section_id: sid,
          status: "classification_low_confidence",
          detail: `${ambiguousCount} ambiguous-decoration span(s)`,
        });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "classification_low_confidence",
          detail: `${ambiguousCount} ambiguous-decoration span(s)`,
        });
        continue;
      }

      const diffSpans = diffAgainstBaseline(sectionSpans, baseline, sid);
      for (const span of diffSpans) inlineSpans.push(span);
      inlineOutcomes.push({ section_id: sid, status: "anchored", detail: null });
      outcomes.push({
        file_no: bill.file_no,
        module_id: bill.module_id,
        section_id: sid,
        status: "anchored",
      });
    }

    bill.section_outcomes = dedupeOutcomes([...wholesaleOutcomes, ...inlineOutcomes]);
    bill.text_diff = [...wholesaleSpans, ...inlineSpans];
    bill.parse_status = deriveParseStatus(bill.section_outcomes, false);
  }

  return { bills, outcomes };
}

/**
 * Bucket classified spans into per-section slices via the run-offset
 * map. A span's source run can produce multiple ranges in the
 * chrome-stripped text (when stripChrome bisects a run); a section
 * "owns" the span when the span's first surviving range starts inside
 * the section's `chrome_range`. Spans whose ranges fall outside every
 * section's range are dropped.
 *
 * Deterministic single-owner rule: a span lands in EXACTLY ONE
 * partition (the one whose chrome_range contains the start of the
 * span's first range). Spans that straddle a section header are rare;
 * when they happen, they land in the section that owns the start of
 * the span. Section B's diff is built from the spans attributed to B,
 * so a stray span from A's prose only pollutes B's newText (not the
 * whole-section anchor cascade the previous token walker had).
 */
export function partitionSpansBySection(
  classifiedSpans: readonly ClassifiedSpan[],
  runOffsetMap: ReadonlyArray<ReadonlyArray<RunRange>>,
  partitions: readonly SectionPartitionEntry[],
): Map<SectionId, ClassifiedSpan[]> {
  const out = new Map<SectionId, ClassifiedSpan[]>();
  for (const span of classifiedSpans) {
    const ranges = runOffsetMap[span.source_index] ?? [];
    if (ranges.length === 0) continue;
    const firstRange = ranges[0];
    if (firstRange === undefined) continue;
    const probe = firstRange.chrome_start;
    // Find the partition whose chrome_range contains the span's
    // starting char. Walking partitions in declared order means the
    // FIRST match wins on a tie — partitions are emitted by the
    // structural pass in document order so "first" is "earlier
    // section header in the bill body."
    for (const partition of partitions) {
      if (partition.section_id === null) continue;
      const r = partition.chrome_range;
      if (probe < r.start || probe >= r.end) continue;
      const sid = partition.section_id;
      const list = out.get(sid) ?? [];
      list.push(span);
      out.set(sid, list);
      break;
    }
  }
  return out;
}

function dedupeOutcomes(outcomes: readonly SectionOutcome[]): SectionOutcome[] {
  // Two passes may emit outcomes for the same section_id (wholesale +
  // inline). Keep the FIRST occurrence — the wholesale pass is
  // authoritative because it runs first and short-circuits the inline
  // path for sections it covers.
  const seen = new Set<SectionId>();
  const out: SectionOutcome[] = [];
  for (const o of outcomes) {
    if (seen.has(o.section_id)) continue;
    seen.add(o.section_id);
    out.push(o);
  }
  return out;
}

/**
 * Diff the bill's intended new text against the baseline.
 *
 * Strategy: the classifier already separated context (unchanged
 * baseline text the bill reprints), insert (underlined new text), and
 * delete (struck baseline text the bill drops). The bill's intended
 * new section text is the concatenation of context + insert spans in
 * source order. We word-diff that against the baseline; each hunk
 * maps directly to a TextDiffSpan.
 *
 * Why not walk tokens against baseline? Inline alignment requires the
 * bill body to track baseline token-for-token; PDF redline drawings
 * regularly break that assumption (run merges, decoration boundaries,
 * substantial rewrites). Diffing the *result* against the source is
 * robust to the drawing's shape: jsdiff figures out the edits, we
 * just translate them into our TextDiffSpan vocabulary.
 *
 * Elision: the "* * * *" sentinel marks "unchanged baseline omitted
 * from the bill body." We skip it when building newText so it doesn't
 * appear in the diff output. The renderer pre-overlays the baseline
 * elsewhere, so any baseline region the bill omits naturally surfaces
 * as a delete hunk in the diff. Future work could lift elision into a
 * dedicated wildcard hunk; for now, treating it as "not in newText"
 * is the conservative call.
 */
function diffAgainstBaseline(
  spans: readonly ClassifiedSpan[],
  baseline: string,
  sectionId: SectionId,
): TextDiffSpan[] {
  const newText = spans
    .filter((s) => s.kind === "context" || s.kind === "insert")
    .map((s) => s.text)
    .join("");

  const hunks = diffWords(baseline, newText);
  const out: TextDiffSpan[] = [];
  let baselineOffset = 0;

  for (const hunk of hunks) {
    if (hunk.added) {
      out.push({
        op: "insert",
        text: hunk.value,
        section_id: sectionId,
        anchor: { baseline_offset: baselineOffset, baseline_length: 0 },
      });
    } else if (hunk.removed) {
      out.push({
        op: "delete",
        text: hunk.value,
        section_id: sectionId,
        anchor: { baseline_offset: baselineOffset, baseline_length: hunk.value.length },
      });
      baselineOffset += hunk.value.length;
    } else {
      out.push({
        op: "context",
        text: hunk.value,
        section_id: sectionId,
        anchor: { baseline_offset: baselineOffset, baseline_length: hunk.value.length },
      });
      baselineOffset += hunk.value.length;
    }
  }

  return out;
}

// ── Wholesale-action classifier ───────────────────────────────────────

type WholesaleAction =
  | { kind: "delete"; section_ids: string[] }
  | { kind: "add"; section_ids: string[] }
  | {
      /**
       * Multi-clause action that contains BOTH delete and add clauses
       * (and may also revise other sections inline). The synthesizer
       * processes delete_ids and add_ids; sections in their intersection
       * are wholesale rewrites (delete baseline + insert new body).
       */
      kind: "composite";
      delete_ids: string[];
      add_ids: string[];
    }
  | { kind: "inline" }
  | { kind: "unknown" };

// Clause-level patterns that find delete/add clauses ANYWHERE in the
// action text (not just immediately after "amended by"). Earlier bills
// always opened delete/add with `amended by`, but Transportation Code
// rewrites (260449) emit composite actions like `… amended by revising
// Sections 6.1 … and by adding Section 6.18 deleting Sections 6.2-6.18,
// and by adding Sections 6.2-6.10 to read as follows: …` where the
// delete clause has no `amended by` prefix and several add clauses are
// chained. Loose matching catches every clause; the boundary lookahead
// stops at the next clause delimiter (`and by`, `deleting`, the
// closing `to read as follows`, or `of the <Code>` tail).
const CLAUSE_BOUNDARY =
  "(?=\\s+and\\s+by\\s+|\\s+deleting\\s+|\\s*,?\\s*to\\s+read\\s+as\\s+follows|\\s*,?\\s+of\\s+the\\b|\\.(?=\\s|$)|$)";

const DELETE_CLAUSE_RE = new RegExp(
  `\\bdeleting\\s+Sections?\\s+([\\w.,\\s-]+?)${CLAUSE_BOUNDARY}`,
  "gi",
);

const ADD_CLAUSE_RE = new RegExp(
  `\\b(?:by\\s+)?adding\\s+(?:a\\s+new\\s+)?Sections?\\s+([\\w.,\\s-]+?)${CLAUSE_BOUNDARY}`,
  "gi",
);

const INLINE_RE = /\b(?:amended\s+to\s+read|by\s+revising\s+Sections?\s+)/i;

function collectClauseIds(re: RegExp, action: string): string[] {
  re.lastIndex = 0;
  const ids: string[] = [];
  let m: RegExpExecArray | null = re.exec(action);
  while (m !== null) {
    if (m[1] !== undefined) {
      for (const id of parseSectionList(m[1])) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    m = re.exec(action);
  }
  return ids;
}

export function classifySectionAction(action: string): WholesaleAction {
  const deleteIds = collectClauseIds(DELETE_CLAUSE_RE, action);
  const addIds = collectClauseIds(ADD_CLAUSE_RE, action);
  if (deleteIds.length > 0 && addIds.length > 0) {
    return { kind: "composite", delete_ids: deleteIds, add_ids: addIds };
  }
  if (deleteIds.length > 0) return { kind: "delete", section_ids: deleteIds };
  if (addIds.length > 0) return { kind: "add", section_ids: addIds };
  if (INLINE_RE.test(action)) return { kind: "inline" };
  return { kind: "unknown" };
}

function parseSectionList(raw: string): string[] {
  return raw
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[A-Za-z]?\d/.test(s));
}

type WholesaleResult = {
  spans: TextDiffSpan[];
  outcomes: Array<{
    section_id: SectionId;
    status: AnchorOutcomeStatus;
    detail?: string;
  }>;
};

function synthesizeWholesale(
  bill: Bill,
  partitions: readonly SectionPartitionEntry[],
  baselineLookup: CorpusBaselineLookup,
  parseResult: ParseBillResult,
): WholesaleResult {
  const spans: TextDiffSpan[] = [];
  const outcomes: WholesaleResult["outcomes"] = [];

  // Build a quick lookup: raw_section_id (from bill body) → resolved
  // SectionId (from the partition, only for THIS bill's module).
  const resolvedByRaw = new Map<string, SectionId>();
  for (const p of partitions) {
    if (p.section_id !== null) {
      resolvedByRaw.set(p.raw_section_id, p.section_id);
      // Also accept the resolved id verbatim (some bills cite the
      // corpus-tree form directly).
      resolvedByRaw.set(p.section_id, p.section_id);
    }
  }

  // T4: bill-body add actions on raw_ids that didn't resolve get the
  // `added_section` outcome. Walk amendments first.
  const unresolvedRaws = new Set<string>();
  for (const u of parseResult.unresolved_sections) {
    if (u.module_id === bill.module_id) unresolvedRaws.add(u.raw_section_id);
  }

  for (const amendment of bill.body.amendments) {
    const cls = classifySectionAction(amendment.action);
    if (cls.kind === "inline" || cls.kind === "unknown") continue;

    // Normalize to (deleteIds, addIds) — composite mode carries both
    // populated; plain delete/add modes carry exactly one.
    const deleteIds =
      cls.kind === "delete" ? cls.section_ids : cls.kind === "composite" ? cls.delete_ids : [];
    const addIds =
      cls.kind === "add" ? cls.section_ids : cls.kind === "composite" ? cls.add_ids : [];
    // Sections appearing in BOTH lists are wholesale rewrites — the
    // bill deletes the old text and inserts replacement text under
    // the same section id. Two spans + a single "rewrite" outcome.
    const rewriteIds = new Set<string>(deleteIds.filter((id) => addIds.includes(id)));

    for (const rawSid of deleteIds) {
      const resolved = resolvedByRaw.get(rawSid);
      if (resolved === undefined) continue;
      const baseline = baselineLookup(bill.module_id, resolved);
      if (baseline === null || baseline === undefined || baseline.length === 0) {
        outcomes.push({
          section_id: resolved,
          status: "no_baseline",
          detail: "wholesale delete — corpus baseline missing",
        });
        continue;
      }
      spans.push({
        op: "delete",
        text: baseline,
        section_id: resolved,
        anchor: { baseline_offset: 0, baseline_length: baseline.length },
      });
      if (rewriteIds.has(rawSid)) {
        // Pair with an insert span below; emit a single combined outcome.
        const insertText = extractAddedSectionText(amendment.body, rawSid);
        if (insertText.length > 0) {
          spans.push({
            op: "insert",
            text: insertText,
            section_id: resolved,
            anchor: { baseline_offset: baseline.length, baseline_length: 0 },
          });
        }
        outcomes.push({
          section_id: resolved,
          status: "anchored",
          detail: "whole-section rewrite",
        });
      } else {
        outcomes.push({
          section_id: resolved,
          status: "anchored",
          detail: "whole-section delete",
        });
      }
    }

    for (const rawSid of addIds) {
      if (rewriteIds.has(rawSid)) continue; // handled in the delete loop
      const resolved = resolvedByRaw.get(rawSid);
      if (resolved !== undefined) {
        // add against a section that ALREADY exists in the corpus
        // (and isn't part of a paired delete) is pathological — the
        // bill is creating something that already exists. Either a
        // data inconsistency or a parser miss on the paired delete
        // clause. Surface as classification_low_confidence so the
        // operator audits; we don't synthesize spans here because a
        // length-0 insert at offset 0 would silently prepend the new
        // text in front of the existing baseline.
        outcomes.push({
          section_id: resolved,
          status: "classification_low_confidence",
          detail: "wholesale add targets a section that already exists in the corpus",
        });
        continue;
      }

      // Not resolved against any installed section. If the bill is an
      // ADD and the raw id was unresolved, this is the added_section
      // case (T4): the bill creates the section.
      if (unresolvedRaws.has(rawSid)) {
        const insertText = extractAddedSectionText(amendment.body, rawSid);
        if (insertText.length === 0) {
          // The bill body parser produced no text for this section.
          // Leave the outcome unemitted; the inline loop will surface
          // it as `unresolved` via the null-section_id partition path.
          continue;
        }
        spans.push({
          op: "insert",
          text: insertText,
          section_id: rawSid as SectionId,
          anchor: { baseline_offset: 0, baseline_length: 0 },
        });
        outcomes.push({
          section_id: rawSid as SectionId,
          status: "added_section",
          detail: "bill adds a new section",
        });
      }
    }
  }

  return { spans, outcomes };
}

// Slice the OrdinanceBlock subtree belonging to a single section out
// of the AMEND group's body.
function extractAddedSectionText(blocks: readonly OrdinanceBlock[], sectionNumber: string): string {
  const collected: OrdinanceBlock[] = [];
  let inside = false;
  for (const b of blocks) {
    if (b.kind === "code_section_header") {
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
      case "code_section_header":
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
