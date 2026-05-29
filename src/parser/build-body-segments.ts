// Body-segment merge algorithm (CT1, CT2, CT4).
//
// Input: a section's normalized `text`, the format span table from
// parse-html (htmlSpans), the position-bearing citation list, the
// module-wide defined-term dictionary, and (later) subsection-label
// matches. Output: a BodySegment[] tree where format runs wrap nested
// citation/defined_term/text leaves per the schema.
//
// Why this lives in pipeline territory (CT1): citations and defined
// terms are extracted in pipeline.ts via the same extractor calls that
// produce SectionFile.citations and .defined_terms. Building body[] in
// parse-html.ts would require a SECOND extraction pass over the text,
// risking index drift (codex CT2). The single source of truth is
// pipeline.ts → buildBodySegments.
//
// Overlap precedence (CQ2): citation > defined_term, strict. When a
// defined-term match overlaps a citation match at any character, the
// defined_term is dropped — no fallback. If a citation classification
// FAILS (the regex matched but classifyMatch couldn't categorize), the
// caller upstream emits a `text` segment instead of citation, and we
// never see it here.
//
// Format wrapping (CQ2): format spans nest INSIDE around primary
// annotations, not the other way around. `<b>§ 1.01</b>` becomes
// `format(bold) > citation > text "§ 1.01"`. The renderer applies CSS
// from the outer format(bold) and the citation child renders as a link
// inside the bolded run.

import type { Citation, Definition, DefinitionId, SectionId } from "@/types";
import type { SpanRecord } from "./parse-html";
import type { GlossaryRecognizer } from "./recognize";
import { buildCandidatesByTerm, resolveDefinitionForOccurrence } from "./resolve-definition";

// A primary annotation — the non-format spans that tile `text`. Each
// has a position range; gaps between primaries become `text` segments
// at emit time. defined_term primaries start with just `term` (from
// the occurrence scanner); the per-occurrence resolver pass attaches
// def_id + raw (or drops the primary to a text gap when unresolved or
// self-suppressed).
type Primary =
  | { kind: "citation"; start: number; end: number; raw: string; citation_index: number }
  | {
      kind: "defined_term";
      start: number;
      end: number;
      term: string;
      def_id?: DefinitionId;
      raw?: string;
      candidates_dropped?: DefinitionId[];
    }
  | { kind: "subsection_label"; start: number; end: number; label: string }
  | { kind: "paragraph_break"; start: number; end: number };

// Internal representation matching the BodySegment schema. We avoid
// importing the BodySegment type from @/types here to keep the
// algorithm decoupled from zod runtime; the export at the bottom
// produces values that conform to BodySegmentSchema.
type Segment =
  | { type: "text"; text: string }
  | { type: "citation"; raw: string; citation_index: number }
  | {
      type: "defined_term";
      raw: string;
      def_id: DefinitionId;
      candidates_dropped?: DefinitionId[];
    }
  | { type: "subsection_label"; label: string }
  | { type: "paragraph_break" }
  | { type: "format"; style: "bold" | "italic" | "list" | "listItem"; children: Segment[] };

export interface UnresolvedReferenceReport {
  /** The matched term text. */
  term: string;
  /** Reader section the occurrence is in. */
  reader_section: SectionId;
  /** Surface text at the occurrence (== term for L1-L3; differs when
   * morphology lands post-L3). */
  raw_text: string;
  /** Paragraph-bounded text around the occurrence — enough context for
   * an operator to judge whether the occurrence really should resolve. */
  surrounding_excerpt: string;
  /** Definition ids that share this term but were out of scope. Lets
   * the operator spot scope-attribution misses (e.g., a "City" definer
   * exists but its hierarchy doesn't cover this reader). */
  out_of_scope_candidate_ids: DefinitionId[];
}

export interface BuildBodySegmentsInput {
  /** Normalized section text. Spans index into this string. */
  text: string;
  /** Format + paragraph_break spans from parse-html's walker. Already
   * mapped through normalizeBodyTextWithSpans, so positions are valid
   * in `text`. */
  htmlSpans: readonly SpanRecord[];
  /** Citations with their start/end positions in `text`. The
   * `citation_index` per match must already point into the section's
   * citations[] array (caller computes via Citation[] index lookup). */
  citationMatches: readonly {
    citation: Citation;
    start: number;
    end: number;
    citation_index: number;
  }[];
  /**
   * Canonical Definition[] for the entire module. Per-occurrence
   * resolution (L2a) consults this index to find the in-scope
   * Definition for each defined_term occurrence, attaches def_id to
   * the emitted segment, and records dropped runner-up candidates.
   */
  moduleDefinitions: readonly Definition[];
  /**
   * The module's glossary recognizer (case-sensitive longest-match trie
   * + capitalised-extent guard), built ONCE per module by the caller and
   * reused across every section — never rebuilt per section. Produces the
   * defined_term spans that this builder resolves and tiles.
   */
  glossaryRecognizer: GlossaryRecognizer;
  /**
   * Reader section context — id for self-suppression, hierarchy chain
   * for the precedence rule.
   */
  readerSection: { id: SectionId; hierarchy: readonly string[] };
  /**
   * Called once per defined_term occurrence that has no in-scope
   * Definition. Caller aggregates these into unresolved_references.json
   * per module so the operator-driven coverage report can audit them.
   */
  onUnresolvedReference?: (report: UnresolvedReferenceReport) => void;
}

// Subsection label detection: paragraph-leading `(a)`, `(b)(2)`,
// `(B)(1)(i)`, etc. followed by an uppercase letter. We accept both
// alphabetic and alphanumeric labels because AmLegal mixes them. The
// label matches at the start of `text` or right after a \n
// (paragraph_break) — never mid-paragraph.
const SUBSECTION_LABEL_RE = /(?:^|\n)(\s*((?:\([A-Za-z0-9]+\))+)\s+)(?=[A-Z])/g;

function findSubsectionLabels(text: string): Primary[] {
  const out: Primary[] = [];
  for (const match of text.matchAll(SUBSECTION_LABEL_RE)) {
    const fullStart = match.index ?? 0;
    const fullMatch = match[0] ?? "";
    const label = match[2] ?? "";
    if (!label) continue;
    // match.index points at the start of the full match — which is `^`
    // (zero-width, so == fullStart) OR the `\n` character that opens
    // the alternation. Compute the label's start by finding it inside
    // the full-match substring; this naturally skips past the `\n` and
    // any leading whitespace.
    const labelStart = fullStart + fullMatch.indexOf(label);
    out.push({
      kind: "subsection_label",
      start: labelStart,
      end: labelStart + label.length,
      label,
    });
  }
  return out;
}

// Resolve overlapping primaries per CQ2: citation > defined_term,
// strict (no fallback). subsection_label and paragraph_break are
// point/line-leading and don't overlap with citation/defined_term in
// practice; we keep them through the resolver for symmetry but they
// never lose to anything.
function resolveOverlaps(primaries: Primary[]): Primary[] {
  // Sort by start ascending; on tie, longer wins (citation usually
  // longer than a defined_term in the same span).
  primaries.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Primary[] = [];
  for (const p of primaries) {
    const last = out[out.length - 1];
    if (!last || last.end <= p.start) {
      out.push(p);
      continue;
    }
    // Overlap with `last`. Apply CQ2.
    const lastIsCitation = last.kind === "citation";
    const pIsCitation = p.kind === "citation";
    if (lastIsCitation) {
      // Citation already wins; drop p.
      continue;
    }
    if (pIsCitation && last.kind === "defined_term") {
      // Citation > defined_term — replace.
      out[out.length - 1] = p;
      continue;
    }
    if (last.kind === "defined_term" && p.kind === "defined_term") {
      // Two defined-term matches overlap (same term repeated, or
      // longer-term swallows shorter): keep the longer/earlier one.
      // Already in the right order (we sorted longest-first within
      // start ties), so drop p.
      continue;
    }
    // paragraph_break / subsection_label vs anything: in practice these
    // are positioned at well-separated points (\n positions, paragraph
    // leaders) and don't overlap citations or defined-terms. If we do
    // see a contained overlap, drop p; otherwise pass it through. No
    // trimming — the leaf-builder downstream tolerates the unusual case.
    if (p.start >= last.start && p.end <= last.end) continue;
    out.push(p);
  }
  return out;
}

// Tile `text[0, text.length)` with primary spans + text gaps. Each
// emitted leaf has a [start, end) range in text.
interface PositionedLeaf {
  start: number;
  end: number;
  segment: Segment;
}

function buildPrimaryLeaves(text: string, primaries: Primary[]): PositionedLeaf[] {
  const out: PositionedLeaf[] = [];
  let cursor = 0;
  for (const p of primaries) {
    if (p.start > cursor) {
      out.push({
        start: cursor,
        end: p.start,
        segment: { type: "text", text: text.slice(cursor, p.start) },
      });
    }
    switch (p.kind) {
      case "citation":
        out.push({
          start: p.start,
          end: p.end,
          segment: { type: "citation", raw: p.raw, citation_index: p.citation_index },
        });
        break;
      case "defined_term": {
        // After resolveDefinedTermOccurrences, every defined_term primary
        // that survived has def_id + raw populated; the unresolved/
        // self-suppressed ones were dropped to text gaps upstream.
        if (p.def_id === undefined || p.raw === undefined) continue;
        const segment: Segment = { type: "defined_term", raw: p.raw, def_id: p.def_id };
        if (p.candidates_dropped !== undefined && p.candidates_dropped.length > 0) {
          segment.candidates_dropped = p.candidates_dropped;
        }
        out.push({ start: p.start, end: p.end, segment });
        break;
      }
      case "subsection_label":
        out.push({
          start: p.start,
          end: p.end,
          segment: { type: "subsection_label", label: p.label },
        });
        break;
      case "paragraph_break":
        out.push({
          start: p.start,
          end: p.end,
          segment: { type: "paragraph_break" },
        });
        break;
    }
    cursor = p.end;
  }
  if (cursor < text.length) {
    out.push({
      start: cursor,
      end: text.length,
      segment: { type: "text", text: text.slice(cursor) },
    });
  }
  return out;
}

// Wrap leaves with format spans to produce a nested BodySegment[].
// Format spans nest INSIDE around primary leaves: `<b>§1.01</b>` →
// format(bold).children = [citation §1.01]. When a format span splits
// a text leaf, the text leaf is split at the boundary.
//
// Input format spans must NOT include paragraph_break (those tile as
// primaries, not wrappers). They're filtered upstream.
function wrapWithFormatSpans(
  leaves: PositionedLeaf[],
  formatSpans: readonly SpanRecord[],
): Segment[] {
  // No format spans → flatten leaves to segments.
  if (formatSpans.length === 0) return leaves.map((l) => l.segment);

  // Build a format tree: spans sorted by start asc, end desc (outer
  // before inner). Insert into a tree where each node's range
  // contains all its children's ranges.
  type FormatNode = {
    start: number;
    end: number;
    style: "bold" | "italic" | "list" | "listItem";
    children: FormatNode[];
  };
  const sortedFormats = [...formatSpans].sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: FormatNode[] = [];
  function insert(parents: FormatNode[], span: SpanRecord): void {
    if (span.format === "paragraph_break") return; // defensive; caller filters
    for (const p of parents) {
      if (p.start <= span.start && p.end >= span.end) {
        insert(p.children, span);
        return;
      }
    }
    parents.push({
      start: span.start,
      end: span.end,
      style: span.format as "bold" | "italic" | "list" | "listItem",
      children: [],
    });
  }
  for (const s of sortedFormats) insert(roots, s);

  // Recursive emitter: within [scopeStart, scopeEnd), produce segments
  // by walking leaves overlapping that range and applying format nodes
  // whose ranges fall within scope.
  function emit(scopeStart: number, scopeEnd: number, formatNodes: FormatNode[]): Segment[] {
    const out: Segment[] = [];
    let cursor = scopeStart;
    // Walk format nodes and leaves in unified order.
    let formatIdx = 0;
    while (cursor < scopeEnd) {
      const nextFormat = formatNodes[formatIdx];
      if (nextFormat && nextFormat.start <= cursor) {
        // Emit this format wrapper. Recurse into its scope.
        const childSegs = emit(
          Math.max(cursor, nextFormat.start),
          Math.min(scopeEnd, nextFormat.end),
          nextFormat.children,
        );
        out.push({
          type: "format",
          style: nextFormat.style,
          children: childSegs,
        });
        cursor = Math.min(scopeEnd, nextFormat.end);
        formatIdx++;
        continue;
      }
      // Determine the next boundary: either the start of the next
      // format node, or scopeEnd.
      const nextBoundary = nextFormat ? Math.min(scopeEnd, nextFormat.start) : scopeEnd;
      // Emit leaves (and leaf-fragments) in [cursor, nextBoundary).
      for (const leaf of leaves) {
        if (leaf.end <= cursor) continue;
        if (leaf.start >= nextBoundary) break;
        const fragStart = Math.max(cursor, leaf.start);
        const fragEnd = Math.min(nextBoundary, leaf.end);
        if (fragEnd <= fragStart) continue;
        out.push(sliceSegment(leaf, fragStart, fragEnd));
      }
      cursor = nextBoundary;
    }
    return out;
  }

  return emit(0, leaves[leaves.length - 1]?.end ?? 0, roots);
}

// Slice a positioned leaf to a sub-range. For text segments, this
// produces a sub-text segment. Non-text leaves (citation, defined_term,
// paragraph_break, subsection_label) are atomic and never partially
// sliced: filterFormatSpansCrossingPrimaries upstream guarantees a
// format span either contains a non-text primary fully or doesn't
// overlap it, so the only fragRange this function ever sees for a
// non-text leaf is the leaf's full range.
function sliceSegment(leaf: PositionedLeaf, fragStart: number, fragEnd: number): Segment {
  if (leaf.start === fragStart && leaf.end === fragEnd) return leaf.segment;
  if (leaf.segment.type === "text") {
    const offset = fragStart - leaf.start;
    const length = fragEnd - fragStart;
    return { type: "text", text: leaf.segment.text.slice(offset, offset + length) };
  }
  // Unreachable given the upstream filter; the early-return above covers
  // the legitimate full-range case.
  return leaf.segment;
}

// Drop format spans that partially cover a non-text primary's range —
// e.g., `§ <b>10.04.020</b>` where bold [2,11] crosses citation [0,11].
// Without this filter, sliceSegment is forced to return the whole
// citation twice (once outside the format wrapper, once inside),
// breaking the body-text roundtrip invariant. Losing the bold styling
// on the rare partial-bold case is preferable to producing a tree that
// double-emits the citation. Whole-cite formatting (bold span fully
// contains citation) is unaffected — that goes through the
// fully-contains branch and wraps the citation atomically.
function filterFormatSpansCrossingPrimaries(
  formatSpans: readonly SpanRecord[],
  primaries: readonly Primary[],
): SpanRecord[] {
  return formatSpans.filter((span) => {
    for (const p of primaries) {
      const overlaps = span.start < p.end && span.end > p.start;
      if (!overlaps) continue;
      const fullyContains = span.start <= p.start && span.end >= p.end;
      if (!fullyContains) return false;
    }
    return true;
  });
}

// MAX_EXCERPT_LENGTH duplicated from definitions.ts intentionally —
// the unresolved-reference surrounding excerpt has the same shape and
// budget as the canonical Definition excerpt. Two callers, one
// constant; per the feedback_test_each_path_once rule each module
// tests its own bound rather than sharing a dependency for a
// single-purpose helper.
const MAX_EXCERPT_LENGTH = 500;

function paragraphExcerpt(text: string, from: number, to: number): string {
  const prevNewline = text.lastIndexOf("\n", Math.max(0, from - 1));
  const paragraphStart = prevNewline === -1 ? 0 : prevNewline + 1;
  const nextNewline = text.indexOf("\n", to);
  const paragraphEnd = nextNewline === -1 ? text.length : nextNewline;
  let excerpt = text.slice(paragraphStart, paragraphEnd).trim();
  if (excerpt.length > MAX_EXCERPT_LENGTH) {
    excerpt = `${excerpt.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
  }
  return excerpt;
}

// Run the per-occurrence resolver over defined_term primaries. For each
// match:
//   - winner exists, self-suppression NOT triggered → attach
//     def_id/raw/candidates_dropped to the primary, keep it
//   - winner exists, self-suppression triggered → drop the primary
//     (the canonical defining clause renders as plain text, per §9 L9)
//   - no winner → drop the primary, fire onUnresolvedReference
//
// Dropped primaries leave a gap that buildPrimaryLeaves fills with a
// text segment.
function resolveDefinedTermOccurrences(
  primaries: Primary[],
  text: string,
  moduleDefinitions: readonly Definition[],
  readerSection: { id: SectionId; hierarchy: readonly string[] },
  onUnresolvedReference: ((report: UnresolvedReferenceReport) => void) | undefined,
): Primary[] {
  const candidatesByTerm = buildCandidatesByTerm(moduleDefinitions);
  const out: Primary[] = [];
  for (const p of primaries) {
    if (p.kind !== "defined_term") {
      out.push(p);
      continue;
    }
    const result = resolveDefinitionForOccurrence(
      p.term,
      { id: readerSection.id, hierarchy: readerSection.hierarchy },
      candidatesByTerm,
    );
    if (result.winner === null) {
      // Unresolved: out-of-scope or no candidates. Emit an audit row
      // (text gap fills in via buildPrimaryLeaves), drop the primary.
      const allCandidatesForTerm = candidatesByTerm.get(p.term) ?? [];
      onUnresolvedReference?.({
        term: p.term,
        reader_section: readerSection.id,
        raw_text: text.slice(p.start, p.end),
        surrounding_excerpt: paragraphExcerpt(text, p.start, p.end),
        out_of_scope_candidate_ids: allCandidatesForTerm.map((c) => c.id),
      });
      continue;
    }
    // Self-suppression: the canonical defining clause at body_anchor
    // renders as plain text (§9 L9). Other occurrences of the same
    // term in the same section stay tagged.
    if (
      result.winner.defined_in === readerSection.id &&
      p.start === result.winner.body_anchor.start &&
      p.end === result.winner.body_anchor.end
    ) {
      continue;
    }
    const annotated: Primary = {
      kind: "defined_term",
      start: p.start,
      end: p.end,
      term: p.term,
      raw: text.slice(p.start, p.end),
      def_id: result.winner.id,
    };
    if (result.dropped.length > 0) {
      annotated.candidates_dropped = result.dropped.map((d) => d.id);
    }
    out.push(annotated);
  }
  return out;
}

export function buildBodySegments(input: BuildBodySegmentsInput): Segment[] {
  const {
    text,
    htmlSpans,
    citationMatches,
    moduleDefinitions,
    glossaryRecognizer,
    readerSection,
    onUnresolvedReference,
  } = input;
  if (text.length === 0) return [];

  // Step 1: collect all primary annotations.
  const primaries: Primary[] = [];
  for (const c of citationMatches) {
    primaries.push({
      kind: "citation",
      start: c.start,
      end: c.end,
      raw: c.citation.display_text,
      citation_index: c.citation_index,
    });
  }
  // Defined-term spans come from the module glossary recognizer: a
  // case-sensitive longest-match trie with the capitalised-extent guard
  // already applied (a name inside a longer proper name is suppressed).
  // Per-occurrence scope resolution still runs in Step 2.5.
  for (const span of glossaryRecognizer.recognizeTerms(text)) {
    if (span.kind !== "defined_term") continue;
    primaries.push({ kind: "defined_term", start: span.start, end: span.end, term: span.term });
  }
  for (const sl of findSubsectionLabels(text)) {
    primaries.push(sl);
  }
  for (const span of htmlSpans) {
    if (span.format === "paragraph_break") {
      primaries.push({ kind: "paragraph_break", start: span.start, end: span.end });
    }
  }

  // Step 2: resolve overlaps per CQ2.
  const resolved = resolveOverlaps(primaries);

  // Step 2.5 (L2a): per-occurrence definition resolution. Drops
  // unresolved and self-suppressed defined_term primaries; attaches
  // def_id/raw/candidates_dropped to those that resolve cleanly.
  // Dropped primaries leave gaps that buildPrimaryLeaves fills with
  // text segments — the canonical clause in a definer section
  // therefore renders as plain text per §9 L9.
  const withResolution = resolveDefinedTermOccurrences(
    resolved,
    text,
    moduleDefinitions,
    readerSection,
    onUnresolvedReference,
  );

  // Step 3: build leaf list (primary + text gaps).
  const leaves = buildPrimaryLeaves(text, withResolution);

  // Step 4: wrap with format spans (everything except paragraph_break).
  // Filter out format spans that cross non-text primary boundaries —
  // those would force sliceSegment to double-emit the primary segment.
  const formatOnly = htmlSpans.filter((s) => s.format !== "paragraph_break");
  const safeFormats = filterFormatSpansCrossingPrimaries(formatOnly, withResolution);
  return wrapWithFormatSpans(leaves, safeFormats);
}
