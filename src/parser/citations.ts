// Single-module encapsulation: this file IS the citation extractor. A
// future swap to a richer iterative pipeline edits this file only;
// consumers see the same { extractCitations } surface and migration is
// invisible.
//
// Strategy: scan section text in paragraph chunks. Within each paragraph
// we track code-phrase occurrences (both external — California Vehicle
// Code, U.S.C. — and jurisdiction-internal — sibling sf-* code titles
// like "Building Code", "Police Code"). Each cite scopes to the
// *nearest* phrase in the same paragraph, preceding or following: this
// is the Phase 2 suffix-form fix for the canonical p109 failure
//   "Section 110A, Table 1A-K ... of the Building Code"
// where the code phrase sits ten words past the cite. Multi-code
// paragraphs also resolve correctly because each cite picks its own
// closest phrase, not the most-recent one. Cites with no phrase in
// scope are internal. The active phrase set resets at every paragraph
// boundary (\n in the section text per parse-html.ts's text contract).
//
// classifyMatch branches on the cite's prefix word:
//   §, §§, Section, Sec., Sections           → section-level
//   Article, Chapter, Division, Title        → structural
//   subsection, subdivision                  → intra-section (anchored
//                                              to currentSectionId)
//
// External-code phrase recognition is delegated to
// src/citations/module-registry.ts; jurisdiction-internal phrases come
// from the optional `jurisdictionModules` extract option. The
// build-time binder (binder.ts) consumes the resulting targets and
// rewrites them as section-refs where the anchor map says they bind.

import { findAllPhraseOccurrences } from "@/citations/module-registry";
import type { Citation, CitationTarget, ModuleConfig } from "@/types";
import { type ModuleId, SectionIdSchema } from "@/types";
import type { StructuralLevel } from "@/types/citation";

function looksLikeSectionId(value: string): boolean {
  return SectionIdSchema.safeParse(value).success;
}

type SectionPrefix = "section";
type StructuralPrefix = StructuralLevel; // "article" | "chapter" | "division" | "title"
type SubsectionPrefix = "subsection";

type PrefixKind = SectionPrefix | StructuralPrefix | SubsectionPrefix;

interface PrefixSplit {
  readonly kind: PrefixKind;
  readonly numberText: string;
}

const STRUCTURAL_PREFIXES: ReadonlyArray<{ word: RegExp; kind: PrefixKind }> = [
  { word: /^Articles?$/i, kind: "article" },
  { word: /^Chapters?$/i, kind: "chapter" },
  { word: /^Divisions?$/i, kind: "division" },
  { word: /^Titles?$/i, kind: "title" },
];

function splitPrefix(matched: string): PrefixSplit | null {
  const trimmed = matched.trim();

  // §§ before §: avoid the §§ match being misclassified as a single §
  if (trimmed.startsWith("§§")) {
    return { kind: "section", numberText: trimmed.slice(2).trim() };
  }
  if (trimmed.startsWith("§")) {
    return { kind: "section", numberText: trimmed.slice(1).trim() };
  }

  const wordMatch = trimmed.match(/^([A-Za-z]+)\.?\s+(.+)$/);
  if (!wordMatch) return null;
  const word = wordMatch[1];
  const rest = wordMatch[2];
  if (!word || !rest) return null;
  const lower = word.toLowerCase();

  if (lower === "sec" || lower === "section" || lower === "sections") {
    return { kind: "section", numberText: rest };
  }
  if (
    lower === "subsection" ||
    lower === "subsections" ||
    lower === "subdivision" ||
    lower === "subdivisions"
  ) {
    return { kind: "subsection", numberText: rest };
  }
  for (const sp of STRUCTURAL_PREFIXES) {
    if (sp.word.test(word)) return { kind: sp.kind, numberText: rest };
  }
  return null;
}

// Alpha suffix capture (Phase 2 — Bug B fix). AmLegal anchors for SF
// Building chapter 1A series are spelled JD_B102A / JD_B110A with a
// trailing capital letter; the cite text says "Section 102A". The old
// regex `\d+(?:\.\d+)*` dropped the letter and produced section_id
// "102", leaving "A" stranded in the next text segment. We capture the
// letter inside the section_id so the binder's display-rules evaluator
// can produce the correctly-shaped anchor candidate (e.g. "b102a"). The
// captured letter is lowercased to satisfy SectionIdSchema.
//
// D8 — `-N` ordinal disambiguators. The SF source uses `JD_16.9-2` /
// `JD_16.9-29A` as canonical section anchors; the parser now preserves
// them into section.id (T3a). Citation extraction has to bind to those
// ids:
//   - Single-section: "Section 16.9-2" must produce section_id "16.9-2",
//     not the legacy "16.9" + stranded "-2".
//   - Single-section with subsection: "Section 16.9-2(a)" must produce
//     section_id "16.9-2" + subsection "(a)".
//   - Range with explicit "to" / em-dash / en-dash: "Sections 16.9-2 to
//     16.9-29A" parses as a range whose operands carry their `-N` suffix.
//   - Range with implicit hyphen ("Sections 10.04.020-10.04.030"): still
//     supported, but only when both operands have the same dot depth.
//     This rules out misparsing "16.9-2" as range 16.9..2 (depth 1 vs
//     depth 0) while keeping legitimate `10.04.020-10.04.030` (both
//     depth 2) intact.
const SECTION_REF_OPERAND_RE = /\d+(?:\.\d+)*[a-z]?(?:-\d+[a-z]?)?/i;
const EXPLICIT_RANGE_RE = new RegExp(
  `^(${SECTION_REF_OPERAND_RE.source})\\s*(?:to|[\\u2013\\u2014])\\s*(${SECTION_REF_OPERAND_RE.source})$`,
  "i",
);
// Implicit-hyphen range allows ONLY operands that lack the `-N`
// disambiguator suffix — the suffix is the very thing we are trying to
// avoid misreading as a range delimiter.
const IMPLICIT_HYPHEN_RANGE_RE = /^(\d+(?:\.\d+)*[a-z]?)\s*-\s*(\d+(?:\.\d+)*[a-z]?)$/i;
const SINGLE_SECTION_RE = /^(\d+(?:\.\d+)*[a-z]?(?:-\d+[a-z]?)?)((?:\([a-z0-9]+\))*)$/i;

function dotDepth(operand: string): number {
  let count = 0;
  for (let i = 0; i < operand.length; i++) {
    if (operand.charCodeAt(i) === 46) count += 1; // '.'
  }
  return count;
}

function classifySection(
  numberText: string,
  activeModuleId: ModuleId | null,
): CitationTarget | null {
  // 1) Explicit range — "to", en-dash (–), or em-dash (—). Operands may
  //    carry a `-N` ordinal because the delimiter is unambiguous.
  const explicitRange = numberText.match(EXPLICIT_RANGE_RE);
  if (explicitRange?.[1] && explicitRange[2]) {
    return buildRange(explicitRange[1], explicitRange[2], activeModuleId);
  }

  // 2) Implicit-hyphen range — only when both operands share the same
  //    dot depth (e.g. "10.04.020-10.04.030" both depth 2). This is the
  //    legacy AmLegal range form. Mismatched depths fall through to
  //    single-section interpretation, which is how "16.9-2" lands as
  //    section_id "16.9-2" instead of a misparsed range from 16.9 to 2.
  const implicitHyphenRange = numberText.match(IMPLICIT_HYPHEN_RANGE_RE);
  if (implicitHyphenRange?.[1] && implicitHyphenRange[2]) {
    const fromOperand = implicitHyphenRange[1];
    const toOperand = implicitHyphenRange[2];
    if (dotDepth(fromOperand) === dotDepth(toOperand)) {
      const built = buildRange(fromOperand, toOperand, activeModuleId);
      if (built) return built;
    }
    // Same-dot-depth check failed (or operands didn't validate). Fall
    // through to single-section so "16.9-2" parses cleanly.
  }

  // 3) Single section, possibly with `-N` disambiguator and/or
  //    subsection paren groups.
  const singleMatch = numberText.match(SINGLE_SECTION_RE);
  if (singleMatch?.[1]) {
    const sectionId = singleMatch[1].toLowerCase();
    const subsection = singleMatch[2];
    if (!looksLikeSectionId(sectionId)) return null;
    if (activeModuleId) {
      return {
        kind: "cross_module",
        module_id: activeModuleId,
        section_id: sectionId,
        ...(subsection ? { subsection } : {}),
      };
    }
    return {
      kind: "internal",
      section_id: sectionId,
      ...(subsection ? { subsection } : {}),
    };
  }
  return null;
}

function buildRange(
  fromRaw: string,
  toRaw: string,
  activeModuleId: ModuleId | null,
): CitationTarget | null {
  const from = fromRaw.toLowerCase();
  const to = toRaw.toLowerCase();
  if (!looksLikeSectionId(from) || !looksLikeSectionId(to)) return null;
  if (activeModuleId) {
    return {
      kind: "cross_module",
      module_id: activeModuleId,
      section_id: from,
      range: { from, to },
    };
  }
  return { kind: "internal", section_id: from, range: { from, to } };
}

function classifyStructural(level: StructuralLevel, numberText: string): CitationTarget | null {
  const m = numberText.match(/^(\d+(?:\.\d+)*)\s*$/);
  if (!m?.[1]) return null;
  return { kind: "structural", level, number: m[1] };
}

function classifySubsection(
  numberText: string,
  currentSectionId: string | null,
): CitationTarget | null {
  if (!currentSectionId) return null;
  const m = numberText.match(/^(\([a-z0-9]+\)(?:\([a-z0-9]+\))*)\s*$/);
  if (!m?.[1]) return null;
  if (!looksLikeSectionId(currentSectionId)) return null;
  return { kind: "internal", section_id: currentSectionId, subsection: m[1] };
}

function classifyMatch(
  matched: string,
  activeModuleId: ModuleId | null,
  currentSectionId: string | null,
): CitationTarget | null {
  const prefix = splitPrefix(matched);
  if (!prefix) return null;
  switch (prefix.kind) {
    case "section":
      return classifySection(prefix.numberText, activeModuleId);
    case "article":
    case "chapter":
    case "division":
    case "title":
      return classifyStructural(prefix.kind, prefix.numberText);
    case "subsection":
      return classifySubsection(prefix.numberText, currentSectionId);
  }
}

// Phase 2 — phrase-to-cite global assignment within a paragraph. Each
// code phrase claims its single nearest unowned cite (before OR after),
// not the other way round. Without this assignment direction the
// canonical "See Section 109.0 herein and the procedures in Section 102
// of the Building Code." paragraph wrongly attaches "Building Code" to
// BOTH cites — but the phrase is only attached to one (the closer cite
// 102, leaving 109.0 internal as the reader expects).
//
// This fixes:
//   Bug A (suffix-form): "Section 110A of the Building Code" — the
//          code phrase sits after the cite; old "last phrase before"
//          logic returned null.
//   Multi-code paragraph: "Section 102 of the Building Code and
//          Section 50 of the Police Code" — each cite picks its own
//          nearest, not the last-seen one.
//   Spurious attachment: a stray code-phrase reference in the same
//          paragraph doesn't drag an earlier internal cite cross-module.
//
// Iteration order: phrases left-to-right, each takes its nearest
// unassigned cite. Distance is the gap between the phrase's nearest
// edge and the cite's nearest edge; overlap (shouldn't happen with
// deduped phrases) is skipped.
//
// Sentence-boundary guard for the preceding match: a phrase must be
// connected to its claimed preceding cite by either an "of/in/from/
// under (the)" connector at the phrase boundary, or by living in the
// same sentence. Without this guard, text like "See Section 109.0
// herein. The Building Code defines ..." would attach "Building Code"
// to 109.0 across the period and silently turn an internal cite into
// a cross-module cite.
function isAttachableSpan(span: string): boolean {
  // Connector right before the phrase: "of the X Code", "in the Y Code",
  // "under the Z Code", "from the W Code". Trailing whitespace before
  // the phrase counts as part of the span.
  if (/\b(of|in|from|under)\s+(the\s+)?$/i.test(span)) return true;
  // No connector: require same-sentence containment. A sentence
  // terminator ([.!?;] followed by whitespace) or a blank line breaks
  // the attachment. Require a lowercase letter before the terminator so
  // legal abbreviation periods ("U.S.C.", "Cal.", "Sec.") that follow
  // an uppercase letter aren't misread as sentence ends.
  return !/(?:[a-z])[.!?;]\s|\n\s*\n/.test(span);
}

function assignPhrasesToCites(
  paragraph: string,
  phrases: readonly { start: number; end: number; module_id: ModuleId }[],
  cites: readonly { start: number; end: number }[],
): ReadonlyMap<number, ModuleId> {
  const assignments = new Map<number, ModuleId>();
  for (const p of phrases) {
    // Two-stage preference: PRECEDING cite first (the standard
    // "Section X of the Y Code" suffix-form pattern), then FOLLOWING
    // cite as fallback (the "Cal. Veh. Code § X" prefix-form pattern,
    // mostly external codes). The bias matches how legal English
    // attaches code phrases to citations; without it, pure-distance
    // assignment in "Section 102 of the Building Code and Section 50"
    // would attach "Building Code" to the closer-by-chars cite (50)
    // instead of the one it actually modifies (102).
    let bestPreceding = -1;
    let bestPrecedingDist = Number.POSITIVE_INFINITY;
    let bestFollowing = -1;
    let bestFollowingDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < cites.length; i++) {
      if (assignments.has(i)) continue;
      const c = cites[i];
      if (!c) continue;
      if (c.end <= p.start) {
        if (!isAttachableSpan(paragraph.slice(c.end, p.start))) continue;
        const distance = p.start - c.end;
        if (distance < bestPrecedingDist) {
          bestPrecedingDist = distance;
          bestPreceding = i;
        }
      } else if (c.start >= p.end) {
        if (!isAttachableSpan(paragraph.slice(p.end, c.start))) continue;
        const distance = c.start - p.end;
        if (distance < bestFollowingDist) {
          bestFollowingDist = distance;
          bestFollowing = i;
        }
      }
    }
    const winner = bestPreceding >= 0 ? bestPreceding : bestFollowing;
    if (winner >= 0) assignments.set(winner, p.module_id);
  }
  return assignments;
}

// Phase 2 — jurisdiction-internal code-phrase tracker. Sister modules
// inside the same AmLegal export ("Building Code", "Police Code") are
// not in the external module registry (which covers CA + Federal); for
// the binder to bind cross-module cites to sf-building/sf-police we
// have to look up each sibling module's code_title in the paragraph
// text. Phrase matching is word-boundary, case-insensitive, hits the
// whole code_title verbatim. The citing module's own code_title is
// excluded so an internal reference to "of the Plumbing Code" inside
// sf-plumbing doesn't self-classify as cross_module.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findJurisdictionPhrases(
  text: string,
  citingModuleId: ModuleId,
  modules: readonly ModuleConfig[],
): { start: number; end: number; module_id: ModuleId }[] {
  const out: { start: number; end: number; module_id: ModuleId }[] = [];
  for (const m of modules) {
    if (m.id === citingModuleId) continue;
    if (!m.code_title) continue;
    const re = new RegExp(`\\b${escapeRegExp(m.code_title)}\\b`, "gi");
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      out.push({ start: match.index, end: match.index + match[0].length, module_id: m.id });
    }
  }
  return out;
}

export class CitationPatternError extends Error {
  constructor(
    readonly pattern: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CitationPatternError";
  }
}

// Position-bearing extraction result. Per A1 in the feat-parse-html-ast
// design, the canonical extractor returns the position triples needed by
// the pipeline's body-segment builder; callers that only need the bare
// Citation[] shape (e.g. SectionFile.citations) map via `.citation`.
export interface CitationMatch {
  citation: Citation;
  /** Inclusive start index in the input text. */
  start: number;
  /** Exclusive end index in the input text. */
  end: number;
}

export interface ExtractOptions {
  /**
   * Section ID of the section whose text is being extracted. Used to
   * anchor bare subsection refs ("subsection (a)") to the citing section.
   * Optional so call sites with no section context can still extract
   * (non-section refs only).
   */
  readonly currentSectionId?: string;
  /**
   * Sibling modules in the citing module's jurisdiction. Each module's
   * code_title becomes a phrase pattern the extractor searches for
   * inside paragraph text — when "of the Building Code" appears near a
   * cite, the cite scopes to sf-building. The citing module's own
   * code_title is excluded inside findJurisdictionPhrases so self-
   * references don't classify as cross_module. Optional so legacy
   * callers (unit tests, sandboxed extraction) still work with the
   * external CA + Federal registry alone.
   */
  readonly jurisdictionModules?: readonly ModuleConfig[];
}

export function extractCitations(
  text: string,
  module: ModuleConfig,
  options: ExtractOptions = {},
): CitationMatch[] {
  if (!text) return [];

  // Compile module patterns once. The case-insensitive flag is fixed at
  // this layer because manifest authors write `Sections?` and expect
  // "Section" / "section" / "SECTION" all to match.
  const regexes: RegExp[] = [];
  for (const patternStr of module.citation_patterns) {
    try {
      regexes.push(new RegExp(patternStr, "gi"));
    } catch (cause) {
      throw new CitationPatternError(
        patternStr,
        `module.citation_patterns entry "${patternStr}" is not a valid regex: ${(cause as Error).message}`,
        { cause },
      );
    }
  }

  const matches: CitationMatch[] = [];
  const seen = new Set<string>();
  const currentSectionId = options.currentSectionId ?? null;
  const siblingModules = options.jurisdictionModules ?? [];

  // Walk paragraph-by-paragraph so the code-phrase scope resets at
  // paragraph boundaries (per the parse-html text contract: each \n
  // demarcates a paragraph break).
  let paragraphStart = 0;
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      paragraphStart += 1; // skip the \n we split on
      continue;
    }

    // Merge external code phrases (CA/Federal registry) with sibling
    // SF code titles. Both feed the same global phrase-to-cite
    // assignment so each phrase claims its single nearest cite, not
    // the other way round. Phrases are kept sorted by start offset for
    // stable iteration.
    const externalPhrases = findAllPhraseOccurrences(paragraph);
    const internalPhrases = findJurisdictionPhrases(paragraph, module.id, siblingModules);
    const codePhrases = [...externalPhrases, ...internalPhrases].sort((a, b) => a.start - b.start);

    // Pass 1: locate every cite-shaped span in the paragraph so we can
    // run phrase-to-cite assignment globally before classification.
    interface RawCite {
      display_text: string;
      start: number;
      end: number;
    }
    const rawCites: RawCite[] = [];
    const localSeen = new Set<string>();
    for (const regex of regexes) {
      for (const m of paragraph.matchAll(regex)) {
        const display_text = m[0];
        const offsetInPara = m.index ?? 0;
        const dedupeKey = `${offsetInPara}:${display_text}`;
        if (localSeen.has(dedupeKey)) continue;
        localSeen.add(dedupeKey);
        rawCites.push({
          display_text,
          start: offsetInPara,
          end: offsetInPara + display_text.length,
        });
      }
    }
    rawCites.sort((a, b) => a.start - b.start);

    // Pass 2: assign phrases to cites globally, then classify each
    // cite using its assigned phrase (if any).
    const phraseAssignment = assignPhrasesToCites(paragraph, codePhrases, rawCites);
    for (let i = 0; i < rawCites.length; i++) {
      const cite = rawCites[i];
      if (!cite) continue;
      const offsetInText = paragraphStart + cite.start;
      const dedupeKey = `${offsetInText}:${cite.display_text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const activeModule = phraseAssignment.get(i) ?? null;
      const target = classifyMatch(cite.display_text, activeModule, currentSectionId);
      if (!target) continue;
      matches.push({
        citation: { display_text: cite.display_text, target },
        start: offsetInText,
        end: offsetInText + cite.display_text.length,
      });
    }

    paragraphStart += paragraph.length + 1;
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}
