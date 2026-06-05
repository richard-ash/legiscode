// Build-time diff-chunk emitter. Runs in `scripts/sync-bills.ts`
// after `parseBill` finishes; produces the renderer-facing
// `diff_chunks` array per bill by walking each touched section
// through the v2 reconstruct-then-diff pipeline.
//
// v2 architecture (replaces the v1 anchor-context strategy):
//
//   For each (bill, target_section):
//     1. Bucket the section's classified spans via run_offset_map +
//        chrome_range intersection (partitionSpansBySection).
//     2. Reject early on ambiguous-decoration spans:
//        classification_low_confidence.
//     3. Reconstruct the post-amendment newText by walking the
//        section's runs/spans in source order, including inserts
//        and contexts, skipping deletes, substituting baseline at
//        elisions, and emitting structural whitespace from PDF
//        position deltas.
//     4. Run `diffWords(baseline, newText)` to align. Map each
//        chunk to a DiffChunk{op, text, section_id}.
//
// Wholesale-action bills (`amending Section X to read as follows`,
// `by deleting Section Y`, `by adding Section Z`) still route to
// `synthesizeWholesale`, which emits delete+insert chunk pairs
// directly without reconstructing — there's no surviving baseline
// to align against.
//
// Per-section failure is local. A bill amending §A + §B can ship §A
// fully chunked AND §B as classification_low_confidence /
// no_baseline. The bill's parse_status is derived from the
// per-section breakdown.

import { diffWords } from "diff";
import type {
  Bill,
  DiffChunk,
  ModuleId,
  OrdinanceBlock,
  SectionId,
  SectionOutcome,
  SectionOutcomeStatus,
} from "@/types";
import { deriveParseStatus } from "@/types";
import type { ClassifiedSpan } from "./classify-spans";
import type { ParseBillResult, SectionPartitionEntry } from "./index";
import { reconstructNewText } from "./reconstruct";
import type { RunRange } from "./run-offset-map";

export type CorpusBaselineLookup = (
  moduleId: ModuleId,
  sectionId: SectionId,
) => string | null | undefined;

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
  /** Mutated bills with `diff_chunks[]` populated for anchored sections. */
  bills: Bill[];
  /** One entry per (bill, target_section) pair. */
  outcomes: AnchorOutcome[];
};

/**
 * Top-level entry point. Drives per-section reconstruction + diffing
 * across every bill in `parseResult` and returns the updated bill
 * records + an operator log of per-section outcomes.
 */
export function anchorTextDiff(
  parseResult: ParseBillResult,
  baselineLookup: CorpusBaselineLookup,
): AnchorTextDiffResult {
  const outcomes: AnchorOutcome[] = [];
  const bills = parseResult.bills.map((b) => ({
    ...b,
    section_outcomes: [...b.section_outcomes],
    diff_chunks: [] as DiffChunk[],
  }));

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

    // Wholesale-action path (whole-section delete or add). Runs
    // before the inline path because some bills mix wholesale and
    // inline actions in the same body.
    const wholesaleOutcomes: SectionOutcome[] = [];
    const wholesaleChunks: DiffChunk[] = [];
    const wholesale = synthesizeWholesale(bill, partitions, baselineLookup, parseResult);
    for (const chunk of wholesale.chunks) wholesaleChunks.push(chunk);
    for (const o of wholesale.outcomes) {
      wholesaleOutcomes.push({
        section_id: o.section_id,
        status: o.status,
        detail: o.detail ?? null,
      });
      outcomes.push({ ...o, file_no: bill.file_no, module_id: bill.module_id });
    }

    const wholesaleCovered = new Set<string>(wholesaleOutcomes.map((o) => o.section_id));
    const inlinePartitions = partitions.filter((p) => {
      const probeKey = p.section_id ?? p.raw_section_id;
      return !wholesaleCovered.has(probeKey);
    });

    const inlineOutcomes: SectionOutcome[] = [];
    const inlineChunks: DiffChunk[] = [];

    const spansBySection = partitionSpansBySection(
      parseResult.classified_spans,
      parseResult.run_offset_map,
      inlinePartitions,
    );

    for (const partition of inlinePartitions) {
      if (partition.section_id === null) {
        const baseDetail = `raw section id "${partition.raw_section_id}" did not resolve against the module's section index`;
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

      // Ambiguous-decoration spans short-circuit the whole section.
      // The diff would be wrong if we guessed at insert-vs-delete;
      // the manual-review banner is the correct outcome.
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

      // Implicit wholesale rewrite: the section's bill spans don't
      // include any context — every run is underlined-insert. The
      // bill is replacing the section entirely. Route to the same
      // delete+insert pair the wholesale path would emit; without
      // this, reconstruct would produce a newText that is just the
      // concatenated inserts, and diffWords would align against the
      // entire baseline as a delete — same outcome, but the explicit
      // pair carries the "whole-section rewrite" detail.
      const contextCount = sectionSpans.filter((s) => s.kind === "context").length;
      if (sectionSpans.length > 0 && contextCount === 0) {
        const rewrite = buildImplicitRewriteChunks(bill, partition.raw_section_id, sid, baseline);
        if (rewrite !== null) {
          for (const chunk of rewrite) inlineChunks.push(chunk);
          inlineOutcomes.push({
            section_id: sid,
            status: "anchored",
            detail: "implicit wholesale rewrite",
          });
          outcomes.push({
            file_no: bill.file_no,
            module_id: bill.module_id,
            section_id: sid,
            status: "anchored",
            detail: "implicit wholesale rewrite",
          });
          continue;
        }
      }

      // The v2 inline path: reconstruct → diff → emit chunks.
      const newText = reconstructNewText(parseResult.runs, sectionSpans, baseline);
      const chunks = diffWords(baseline, newText);
      for (const c of chunks) {
        const op = c.added === true ? "insert" : c.removed === true ? "delete" : "equal";
        inlineChunks.push({ op, text: c.value, section_id: sid });
      }
      inlineOutcomes.push({ section_id: sid, status: "anchored", detail: null });
      outcomes.push({
        file_no: bill.file_no,
        module_id: bill.module_id,
        section_id: sid,
        status: "anchored",
      });
    }

    bill.section_outcomes = dedupeOutcomes([...wholesaleOutcomes, ...inlineOutcomes]);
    bill.diff_chunks = [...wholesaleChunks, ...inlineChunks];
    bill.parse_status = deriveParseStatus(bill.section_outcomes, false);
  }

  return { bills, outcomes };
}

/**
 * Bucket classified spans into per-section slices via the run-offset
 * map. A span belongs to a section when its first surviving range's
 * `chrome_start` falls inside the partition's `chrome_range`.
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
  // inline). Keep the FIRST occurrence — the wholesale pass runs first
  // and short-circuits the inline path for sections it covers.
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
 * Build the delete + insert chunk pair for an implicit wholesale
 * rewrite — the section's bill spans never anchored as context, so
 * the entire baseline is being replaced. Returns null when no
 * amendment body carries this section's header (the section is
 * referenced in the partition but has no replacement text in the
 * bill).
 */
function buildImplicitRewriteChunks(
  bill: Bill,
  rawSectionId: string,
  resolvedSectionId: SectionId,
  baseline: string,
): DiffChunk[] | null {
  for (const amendment of bill.body.amendments) {
    const insertText = extractAddedSectionText(amendment.body, rawSectionId);
    if (insertText.length === 0) continue;
    return [
      { op: "delete", text: baseline, section_id: resolvedSectionId },
      { op: "insert", text: insertText, section_id: resolvedSectionId },
    ];
  }
  return null;
}

// ── Wholesale-action classifier ───────────────────────────────────────

type WholesaleAction =
  | { kind: "delete"; section_ids: string[] }
  | { kind: "add"; section_ids: string[] }
  | {
      kind: "composite";
      delete_ids: string[];
      add_ids: string[];
    }
  | { kind: "inline" }
  | { kind: "unknown" };

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
  chunks: DiffChunk[];
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
  const chunks: DiffChunk[] = [];
  const outcomes: WholesaleResult["outcomes"] = [];

  const resolvedByRaw = new Map<string, SectionId>();
  for (const p of partitions) {
    if (p.section_id !== null) {
      resolvedByRaw.set(p.raw_section_id, p.section_id);
      resolvedByRaw.set(p.section_id, p.section_id);
    }
  }

  const unresolvedRaws = new Set<string>();
  for (const u of parseResult.unresolved_sections) {
    if (u.module_id === bill.module_id) unresolvedRaws.add(u.raw_section_id);
  }

  for (const amendment of bill.body.amendments) {
    const cls = classifySectionAction(amendment.action);
    if (cls.kind === "inline" || cls.kind === "unknown") continue;

    const deleteIds =
      cls.kind === "delete" ? cls.section_ids : cls.kind === "composite" ? cls.delete_ids : [];
    const addIds =
      cls.kind === "add" ? cls.section_ids : cls.kind === "composite" ? cls.add_ids : [];
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
      chunks.push({ op: "delete", text: baseline, section_id: resolved });
      if (rewriteIds.has(rawSid)) {
        const insertText = extractAddedSectionText(amendment.body, rawSid);
        if (insertText.length > 0) {
          chunks.push({ op: "insert", text: insertText, section_id: resolved });
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
      if (rewriteIds.has(rawSid)) continue;
      const resolved = resolvedByRaw.get(rawSid);
      if (resolved !== undefined) {
        outcomes.push({
          section_id: resolved,
          status: "classification_low_confidence",
          detail: "wholesale add targets a section that already exists in the corpus",
        });
        continue;
      }

      if (unresolvedRaws.has(rawSid)) {
        const insertText = extractAddedSectionText(amendment.body, rawSid);
        if (insertText.length === 0) continue;
        chunks.push({ op: "insert", text: insertText, section_id: rawSid as SectionId });
        outcomes.push({
          section_id: rawSid as SectionId,
          status: "added_section",
          detail: "bill adds a new section",
        });
      }
    }
  }

  return { chunks, outcomes };
}

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
        parts.push(b.marker);
        parts.push(ordinanceBlocksToText(b.body));
        break;
    }
  }
  return parts.join("\n").trim();
}
