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
//     4. Run `diffWordsWithSpace(baseline, newText)` to align (the
//        whitespace-significant variant — its byte-aligned output is
//        load-bearing for the structured overlay walker, see comment
//        at the diff call site). Map each chunk to a DiffChunk{op,
//        text, section_id}.
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

import { type Change, diffWordsWithSpace } from "diff";
import type {
  Bill,
  DiffChunk,
  ModuleId,
  NewBody,
  OrdinanceBlock,
  SectionId,
  SectionOutcome,
  SectionOutcomeStatus,
} from "@/types";
import { deriveParseStatus } from "@/types";
import type { ClassifiedSpan } from "./classify-spans";
import type { ParseBillResult, SectionPartitionEntry } from "./index";
import { parseNewBody } from "./parse-new-body";
import { reconstructNewText } from "./reconstruct";
import type { RunRange } from "./run-offset-map";
import { smoothReconstructedText } from "./text-smoothing";

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
    new_bodies: [] as NewBody[],
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
    const inlineNewBodies: NewBody[] = [];

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
          // new_body for an implicit rewrite is the concatenated
          // inserted text — the bill provides the entire post-
          // amendment content via its insert chunk.
          const insertChunk = rewrite.find((c) => c.op === "insert");
          inlineNewBodies.push({
            section_id: sid,
            body: insertChunk ? [...parseNewBody(insertChunk.text)] : [],
          });
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

      // The v2 inline path: reconstruct → normalize → diff → emit chunks.
      //
      // Whitespace normalization (collapseStructuralWhitespace) suppresses
      // PDF blank-line padding ("\n   \n" between paragraphs) before
      // diffing so we don't ship visible whitespace-only inserts in the
      // Changes view.
      //
      // diffWordsWithSpace (whitespace-significant) is load-bearing for
      // the structured overlay. The walker advances a basePos cursor by
      // chunk char count and slices from baseline at that cursor, so
      // chunk text MUST be byte-identical to baseline at the
      // corresponding span. The whitespace-insensitive diffWords variant
      // emits equal chunks using NEW text's whitespace pattern, which
      // shuffles surrounding whitespace between adjacent chunks and
      // drifts basePos by ±N chars per mismatch — the drift cascades
      // through every later chunk and produces mid-word truncation in
      // the rendered output (mortifying example: "consumption" became
      // "consumptiog" because the trailing 'n' got pulled into a delete
      // chunk's slice). diffWordsWithSpace coalesces same-op runs into
      // coarse chunks by default, so "fracture into word splinters"
      // isn't a concern.
      const rawNewText = reconstructNewText(parseResult.runs, sectionSpans, baseline);
      const newText = smoothReconstructedText(collapseStructuralWhitespace(rawNewText));
      const chunks = coalesceWhitespaceDiffs(diffWordsWithSpace(baseline, newText));
      // Offset invariant for the structured overlay: the sum of
      // equal+delete chunk char lengths MUST equal baseline.length. The
      // overlay walker advances a basePos cursor by chunk.text.length
      // and slices from baseline at that cursor; any drift cascades
      // into mid-word truncation in Changes/Proposed views. With
      // diffWordsWithSpace this holds by construction (every byte of
      // baseline appears in exactly one equal-or-delete chunk), but
      // verify here so a future regression (lib change, new
      // pre-diff transform) routes through the existing graceful-fail
      // path instead of silently shipping mangled overlays.
      const baseSpan = chunks.reduce((n, c) => (c.added === true ? n : n + c.value.length), 0);
      if (baseSpan !== baseline.length) {
        const detail = `offset invariant failed: sum(equal+delete)=${baseSpan} vs baseline.length=${baseline.length}`;
        inlineOutcomes.push({
          section_id: sid,
          status: "classification_low_confidence",
          detail,
        });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "classification_low_confidence",
          detail,
        });
        continue;
      }
      const hasChange = chunks.some((c) => c.added === true || c.removed === true);
      if (!hasChange) {
        // The bill's amendment block cites this section header but
        // reconstruction matched baseline exactly — common when a
        // parent section's header appears in the body (e.g. "Sec.
        // 413") while only sub-sections (§413.6) carry edits. Mark
        // as no_changes so the renderer can banner this without
        // claiming a non-existent diff.
        inlineOutcomes.push({
          section_id: sid,
          status: "no_changes",
          detail: "bill references this section but does not change it",
        });
        outcomes.push({
          file_no: bill.file_no,
          module_id: bill.module_id,
          section_id: sid,
          status: "no_changes",
          detail: "bill references this section but does not change it",
        });
        continue;
      }
      for (const c of chunks) {
        const op = c.added === true ? "insert" : c.removed === true ? "delete" : "equal";
        inlineChunks.push({ op, text: c.value, section_id: sid });
      }
      inlineNewBodies.push({ section_id: sid, body: [...parseNewBody(newText)] });
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
    bill.new_bodies = dedupeNewBodies([...wholesale.new_bodies, ...inlineNewBodies]);
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

/**
 * Collapse runs of whitespace that span a newline down to a single
 * newline. PDF reconstruction emits structural whitespace (vertical
 * gaps between runs) as `\n   \n`-style sequences; the corpus
 * baseline preserves only the canonical single-`\n` paragraph break.
 * Without this normalization, diffWords' equal chunks carry the
 * newText artifacts and break the structured overlay's char-count
 * alignment against baseline body. Non-newline whitespace (mid-line
 * spaces) is preserved — only whitespace runs that *contain* a
 * newline get collapsed.
 */
function collapseStructuralWhitespace(text: string): string {
  return text.replace(/[ \t]*\n[ \t\n]*/g, "\n");
}

/**
 * Coalesce adjacent pure-whitespace delete + insert pairs into a single
 * equal chunk that carries baseline's whitespace. PDF reconstruction
 * routinely wraps a baseline space to a newline at column boundaries,
 * which diffWordsWithSpace faithfully records as `del " " + ins "\n"`.
 * The overlay walker then renders the inserted newline as a phantom
 * paragraph break in Proposed mode (and the delete-space disappears, so
 * the visual effect is "this paragraph randomly got split in two").
 *
 * These pairs aren't substantive changes — they're whitespace
 * reformatting from the PDF reconstruction. Collapse them so the
 * Proposed/Changes views render the baseline's paragraph structure.
 * Uses baseline's whitespace (the delete's text) so the chunk text is
 * byte-identical to baseline at that span — preserves the offset
 * invariant.
 */
function coalesceWhitespaceDiffs(chunks: readonly Change[]): Change[] {
  const out: Change[] = [];
  let i = 0;
  while (i < chunks.length) {
    const c = chunks[i];
    const next = chunks[i + 1];
    if (c !== undefined && next !== undefined && isWhitespacePair(c, next)) {
      const baselineSide = c.removed === true ? c : next;
      out.push({
        value: baselineSide.value,
        count: baselineSide.value.length,
        added: false,
        removed: false,
      });
      i += 2;
      continue;
    }
    if (c !== undefined) out.push(c);
    i++;
  }
  return out;
}

function isWhitespacePair(a: Change, b: Change): boolean {
  const aIsDelWs = a.removed === true && /^\s+$/.test(a.value);
  const aIsInsWs = a.added === true && /^\s+$/.test(a.value);
  const bIsDelWs = b.removed === true && /^\s+$/.test(b.value);
  const bIsInsWs = b.added === true && /^\s+$/.test(b.value);
  return (aIsDelWs && bIsInsWs) || (aIsInsWs && bIsDelWs);
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

function dedupeNewBodies(entries: readonly NewBody[]): NewBody[] {
  // Parallel rule to dedupeOutcomes: the wholesale pass populates a
  // section's new_body and the inline pass skips it via
  // `wholesaleCovered`, so collisions are not expected in practice —
  // but a defensive dedupe (first-wins) keeps the invariant clean if
  // the partition tables ever drift.
  const seen = new Set<SectionId>();
  const out: NewBody[] = [];
  for (const e of entries) {
    if (seen.has(e.section_id)) continue;
    seen.add(e.section_id);
    out.push(e);
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
  new_bodies: NewBody[];
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
  const new_bodies: NewBody[] = [];
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
        // Rewrite: new_body comes from the inserted text (which is
        // the full replacement body). Empty insert → empty body.
        new_bodies.push({
          section_id: resolved,
          body: insertText.length > 0 ? [...parseNewBody(insertText)] : [],
        });
        outcomes.push({
          section_id: resolved,
          status: "anchored",
          detail: "whole-section rewrite",
        });
      } else {
        // Pure wholesale delete: no surviving body. Emit an empty
        // new_body so the refine's set-equality invariant holds for
        // anchored outcomes; the renderer's Proposed view treats an
        // empty body as "this section would be removed entirely."
        new_bodies.push({ section_id: resolved, body: [] });
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
        new_bodies.push({
          section_id: rawSid as SectionId,
          body: [...parseNewBody(insertText)],
        });
        outcomes.push({
          section_id: rawSid as SectionId,
          status: "added_section",
          detail: "bill adds a new section",
        });
      }
    }
  }

  return { chunks, new_bodies, outcomes };
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
