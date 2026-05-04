// biome-ignore-all lint/suspicious/noExplicitAny: cheerio's parse5 backend
// exposes node objects (with startIndex / attribs) that aren't surfaced by
// cheerio's TypeScript types. Casting through `any` is the standard escape
// hatch for source-position-aware traversal in cheerio. PoC accepts this;
// the round-12 rewrite can wrap a typed adapter if it matters.

import * as cheerio from "cheerio";
import type {
  JurisdictionManifest,
  ModuleConfig,
  SkippedEntry,
  UnresolvedInterCodeLinkWarning,
} from "@/types";
import { SECTION_ID_RE } from "@/types";
import { slugify } from "./slugify";

export type { UnresolvedInterCodeLinkWarning };

// AmLegal HTML walker (PoC, round 11). Single entry point:
//
//   parseExport(buffer, jurisdiction) — slices a full-jurisdiction AmLegal
//                                       HTML export on JD_<CodeRoot> anchors,
//                                       walks each module's region in
//                                       document order maintaining a
//                                       hierarchy stack, emits one
//                                       ModuleParseResult per declared
//                                       module.
//
// AmLegal HTML structure (observed): rboxes are flat siblings (Article,
// Chapter, Division, Section, Normal-Level), each wrapped in an outer
// <div>. Hierarchy is recovered from document order, not DOM ancestry —
// the most recent Article/Chapter/Division wrapper before a Section
// determines that section's hierarchy stack.
//
// PoC scope: structural parse only. ParsedSection.text is rendered text
// (no markup) so the existing extractCitations regex pipeline keeps
// working unchanged. parseInterCodeLinks demonstrates the editorial-graph
// value-add as a separate capability for the round-12 rewrite.

export interface ParsedSection {
  id: string;
  title: string;
  text: string;
  hierarchy: string[];
  hierarchy_slugs: string[];
  source_location: { line: number };
  editorial_status: "active" | "reserved" | "repealed" | "redesignated";
  redirect_to?: string;
}

export interface ParsedAppendix {
  id: string;
  parent: { kind: "article" | "chapter"; number: number | string };
  letter: string;
  title: string;
  body: string;
  source_location: { line: number };
}

export interface ParsedHistory {
  instrument_kind: "ordinance" | "resolution";
  id: string;
  year: number;
  module_id: string;
  body: string;
  source_location: { line: number };
}

export interface ParseResult {
  sections: ParsedSection[];
  appendices: ParsedAppendix[];
  ordinanceHistories: ParsedHistory[];
  resolutionHistories: ParsedHistory[];
  skipped: SkippedEntry[];
  /**
   * Total rboxes the dispatcher saw inside the module's slice. Used by
   * the round-12 0% skip gate's accounting audit: emitted entries +
   * skipped + consumed_by_parent + hierarchy_marker must equal this.
   */
  totalRboxesProcessed: number;
  /** Rboxes silently absorbed into the prior entry's body via collectBody. */
  consumedByParentCount: number;
  /** Article / Chapter / Division marker rboxes (no body, no entry emission). */
  hierarchyMarkerCount: number;
  /**
   * Every `<a name="JD_<id>">` anchor inside the module's bound, with the
   * "JD_" prefix stripped. Includes anchors that are NOT promoted to
   * sections (deletion-marker stubs, Note sub-elements, paragraph
   * subscripts), so the citation gate can resolve a citation to a
   * section that exists in the source as an anchor even when the parser
   * doesn't emit it as a queryable section. See validate-corpus.ts.
   */
  tocAnchors: string[];
}

export interface ModuleParseResult {
  module: ModuleConfig;
  result: ParseResult;
  /** Inclusive line range (1-indexed) within the original HTML buffer. */
  sliceMeta: { startLine: number; endLine: number };
}

export class ParseAbortError extends Error {
  readonly diagnostic: string;
  constructor(diagnostic: string) {
    super(diagnostic);
    this.name = "ParseAbortError";
    this.diagnostic = diagnostic;
  }
}

interface SliceBound {
  module: ModuleConfig;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

function getStartIndex(node: any): number {
  return typeof node?.startIndex === "number" ? node.startIndex : 0;
}

function buildLineMap(text: string): number[] {
  // Cumulative byte-offset of the START of each line. lineMap[i] = offset of
  // the first character of (1-indexed) line i+1. lineMap[0] = 0 always.
  const map: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) map.push(i + 1);
  }
  return map;
}

function offsetToLine(offset: number, lineMap: number[]): number {
  // Returns 1-indexed line number. Binary search for largest lineMap entry
  // <= offset.
  let lo = 0;
  let hi = lineMap.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((lineMap[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function sliceJurisdiction(
  $: cheerio.CheerioAPI,
  jurisdiction: JurisdictionManifest,
  lineMap: number[],
  totalLength: number,
): SliceBound[] {
  // Find the unique <a name="JD_<jd_anchor>"> for each declared module.
  // (InterCodeLink elements with destinationId="JD_<X>" reference the
  // anchor but don't declare it, so the selector is naturally unique.)
  const bounds: SliceBound[] = [];

  for (const module of jurisdiction.modules) {
    const anchorName = `JD_${module.jd_anchor}`;
    const matches = $(`a[name="${anchorName}"]`);
    if (matches.length === 0) {
      throw new ParseAbortError(
        `slicer: module "${module.id}" with jd_anchor "${module.jd_anchor}" ` +
          `(<a name="${anchorName}">) not found in source`,
      );
    }
    if (matches.length > 1) {
      throw new ParseAbortError(
        `slicer: module "${module.id}" jd_anchor "${module.jd_anchor}" matched ` +
          `${matches.length} times (must appear exactly once)`,
      );
    }
    const startOffset = getStartIndex(matches.get(0));
    bounds.push({
      module,
      startOffset,
      endOffset: -1,
      startLine: offsetToLine(startOffset, lineMap),
      endLine: -1,
    });
  }

  bounds.sort((a, b) => a.startOffset - b.startOffset);

  for (let i = 0; i < bounds.length; i++) {
    const cur = bounds[i];
    if (!cur) continue;
    const next = bounds[i + 1];
    cur.endOffset = next ? next.startOffset - 1 : totalLength - 1;
    cur.endLine = offsetToLine(cur.endOffset, lineMap);
  }

  return bounds;
}

// RboxClassification is a tagged union over what kind of corpus entry (or
// non-entry) a single rbox represents. The dispatcher in
// parseModuleFromBound switches on `kind` and routes to the right parser
// path. Anything that doesn't classify as a known kind becomes "unknown"
// and trips the round-12 0% skip gate so we never silently drop content.
type RboxClassification =
  | {
      kind: "section";
      classes: Set<string>;
      editorial_status: "active" | "reserved" | "repealed" | "redesignated";
    }
  | {
      kind: "appendix";
      parent: { kind: "article" | "chapter"; number: number | string };
      letter: string;
      rawTitle: string;
    }
  | { kind: "ordinance_history"; year: number; rawTitle: string }
  | { kind: "resolution_history"; year: number; rawTitle: string }
  | { kind: "hierarchy_marker"; level: "Article" | "Chapter" | "Division" }
  | { kind: "consumed_by_parent"; reason: string }
  | { kind: "unknown"; reason: string };

const APPENDIX_TITLE_RE = /^(article|ch\.|chapter)\s+(\d+|[a-z]+)\s*,?\s*appendix\s+([a-z]+)$/i;
const ORDINANCE_TITLE_RE = /^(\d{4})\s+ordinances$/i;
const RESOLUTION_TITLE_RE = /^(\d{4})\s+resolutions$/i;
const PARAGRAPH_SUBSCRIPT_RE = /^\d+\([a-z]\)$/;

function classifyRbox(el: cheerio.Cheerio<any>): RboxClassification {
  const cls: string = (el.get(0) as any)?.attribs?.class ?? "";
  const classes = new Set<string>(cls.split(/\s+/).filter((s: string) => s.length > 0));
  const has = (c: string) => classes.has(c);
  // Some codes (Charter, Transportation) use bare "Article" / "Chapter" /
  // "Section". Others (Administrative, Health, deeper code structures) use
  // "level-Article" / "level-Section" / "level-SubSection" plus suffixes
  // like "-NewOrd" or "-Deleted". Match any token starting with the level
  // name as a normalization.
  const hasLevel = (level: string) => {
    for (const c of classes) {
      if (c === level || c === `level-${level}`) return true;
      if (c.startsWith(`${level}-`) || c.startsWith(`level-${level}-`)) return true;
    }
    return false;
  };

  if (hasLevel("Article")) return { kind: "hierarchy_marker", level: "Article" };
  if (hasLevel("Chapter")) return { kind: "hierarchy_marker", level: "Chapter" };
  if (hasLevel("Division") || has("Division---Deleted")) {
    return { kind: "hierarchy_marker", level: "Division" };
  }

  // Section detection: explicit Section/level-Section, plus -NewOrd and
  // -Deleted variants. Subsection / SubSection variants are ALSO promoted —
  // legally a citation to "§ 206.10" refers to a subsection that has its
  // own substantive provision; the corpus-level citation gate requires
  // those targets to resolve. AmLegal uses both lowercase ("Subsection")
  // and CamelCase ("SubSection") spellings depending on the module.
  let isSectionLike = false;
  for (const c of classes) {
    if (c === "Section" || c === "level-Section") isSectionLike = true;
    else if (c === "Section-NewOrd" || c === "level-Section-NewOrd") isSectionLike = true;
    else if (c === "Section-Deleted" || c === "level-Section-Deleted") isSectionLike = true;
    else if (c === "Subsection" || c === "level-Subsection") isSectionLike = true;
    else if (c === "Subsection-NewOrd" || c === "level-Subsection-NewOrd") isSectionLike = true;
    else if (c === "Subsection-Deleted" || c === "level-Subsection-Deleted") isSectionLike = true;
    else if (c === "SubSection" || c === "level-SubSection") isSectionLike = true;
    else if (c === "SubSection-NewOrd" || c === "level-SubSection-NewOrd") isSectionLike = true;
    else if (c === "SubSection-Deleted" || c === "level-SubSection-Deleted") isSectionLike = true;
  }
  if (!isSectionLike) {
    // Non-entry-emitting rboxes (Normal-Level body paragraphs, Currency
    // headers, NewOrdNotice editorial banners, image-only spacers, etc.)
    // are body continuation of whichever entry preceded them. The body-
    // collection step in parseModuleFromBound consumes them; the
    // dispatcher emits nothing.
    return { kind: "consumed_by_parent", reason: `non-entry rbox: "${cls}"` };
  }

  // Match every -Deleted variant the section-like classifier above promotes:
  // Section, Subsection (lowercase), and SubSection (CamelCase) — with their
  // level- prefixes. AmLegal emits both casings depending on the module.
  const isDeleted =
    has("Section-Deleted") ||
    has("level-Section-Deleted") ||
    has("Subsection-Deleted") ||
    has("level-Subsection-Deleted") ||
    has("SubSection-Deleted") ||
    has("level-SubSection-Deleted");

  // Sub-classify Section-like rboxes by the JD_ anchor's title attribute.
  // Real-data raw_id buckets: ~189 "<year> <ordinances|resolutions>",
  // ~32 appendix titles, paragraph subscripts, asterisk-marked sections,
  // art-infix sections, plus the substantive Section majority.
  const anchorEl = el.find("a[name^='JD_']").first();
  const rawTitle = (anchorEl.attr("title") ?? "").trim();

  // Editorial chrome rule: a Section-classed rbox with NEITHER a JD_ anchor
  // descendant NOR a SEC. heading is editorial chrome (New Ordinance Notice,
  // bracketed caption, year label, map-sheet header, appendix label without
  // anchor). Real legal sections always have at least one of those id signals;
  // if neither is present, the rbox is structural/editorial content that
  // shares the Section CSS class for visual styling.
  //
  // Audit-verified against the 56,824-line SF AmLegal snapshot via
  // scripts/audit-classifier.ts: 87 at-risk rboxes, all chrome (zero
  // ARTICLE/CHAPTER/DIVISION-style content uses this signature).
  if (anchorEl.length === 0) {
    const headingText = rboxLabelText(el);
    if (!HEADING_SEC_RE.test(headingText)) {
      return {
        kind: "consumed_by_parent",
        reason: "section-classed editorial chrome (no id signal)",
      };
    }
  }

  if (rawTitle) {
    const ordinanceMatch = rawTitle.match(ORDINANCE_TITLE_RE);
    if (ordinanceMatch?.[1]) {
      return { kind: "ordinance_history", year: Number(ordinanceMatch[1]), rawTitle };
    }
    const resolutionMatch = rawTitle.match(RESOLUTION_TITLE_RE);
    if (resolutionMatch?.[1]) {
      return { kind: "resolution_history", year: Number(resolutionMatch[1]), rawTitle };
    }
    const appendixMatch = rawTitle.match(APPENDIX_TITLE_RE);
    if (appendixMatch?.[1] && appendixMatch[2] && appendixMatch[3]) {
      const parentKindRaw = appendixMatch[1].toLowerCase();
      const parentKind: "article" | "chapter" = parentKindRaw === "article" ? "article" : "chapter";
      const numRaw = appendixMatch[2];
      const number: number | string = /^\d+$/.test(numRaw) ? Number(numRaw) : numRaw.toLowerCase();
      return {
        kind: "appendix",
        parent: { kind: parentKind, number },
        letter: appendixMatch[3].toLowerCase(),
        rawTitle,
      };
    }
    if (PARAGRAPH_SUBSCRIPT_RE.test(rawTitle)) {
      return {
        kind: "consumed_by_parent",
        reason: `paragraph subscript "${rawTitle}" lives inside a parent Section's body`,
      };
    }
  }

  // Subsection-class promotion lets citations like "§ 206.10" resolve, but
  // only when the JD anchor's title is a section-shaped id. Subsection
  // rboxes whose title is a structural label (e.g., "Article 10, Appendix
  // O, Sec. 1" — sf-planning's appendix items) aren't valid citation
  // targets; they get absorbed into the parent's body. Without this
  // discrimination, those rboxes flow to parseSectionElement which fails
  // self-validation with a non-conforming id.
  if (rawTitle) {
    const isSubsection = (() => {
      for (const c of classes) {
        if (c === "Subsection" || c === "level-Subsection") return true;
        if (c === "Subsection-NewOrd" || c === "level-Subsection-NewOrd") return true;
        if (c === "Subsection-Deleted" || c === "level-Subsection-Deleted") return true;
        if (c === "SubSection" || c === "level-SubSection") return true;
        if (c === "SubSection-NewOrd" || c === "level-SubSection-NewOrd") return true;
        if (c === "SubSection-Deleted" || c === "level-SubSection-Deleted") return true;
      }
      return false;
    })();
    if (isSubsection && !SECTION_ID_RE.test(normalizeSectionId(rawTitle))) {
      return {
        kind: "consumed_by_parent",
        reason: `subsection with non-section-shaped title "${rawTitle}"`,
      };
    }
  }

  // Default: it's a substantive Section (or Section that needs heading-text
  // fallback because rawTitle is empty). The Section parser path handles
  // both cases plus asterisk / art-infix normalization.
  let editorial_status: "active" | "reserved" | "repealed" | "redesignated" = "active";
  if (isDeleted) {
    // In SF AmLegal, the [Reserved.] and [Repealed.] heading text disambiguate
    // these. "REDESIGNATED" or a Link.Jump in the body also signals a
    // redesignated tombstone. Conservative default for any -Deleted variant
    // is "reserved" — the parser path refines based on heading text.
    editorial_status = "reserved";
  }
  return { kind: "section", classes, editorial_status };
}

function rboxLabelText(el: cheerio.Cheerio<any>): string {
  // Hierarchy rboxes have shape:
  //   <div class="rbox Article">
  //     <AnnotationDrawer .../>
  //     <div>ARTICLE I: EXISTENCE AND POWERS</div>
  //   </div>
  // The label is the first non-AnnotationDrawer child div's text. Some
  // decorative rboxes contain only punctuation (em-dashes, separators);
  // those produce empty/junk slugs downstream, so we treat anything
  // without at least one alnum char as "no label".
  const childDivs = el.children("div");
  const raw = (childDivs.length === 0 ? el.text() : childDivs.first().text()).trim();
  if (!/[A-Za-z0-9]/.test(raw)) return "";
  return raw;
}

function parseModuleFromBound(
  $: cheerio.CheerioAPI,
  allRboxes: any[],
  rboxOffsets: number[],
  bound: SliceBound,
  lineMap: number[],
): ParseResult {
  const sections: ParsedSection[] = [];
  const appendices: ParsedAppendix[] = [];
  const ordinanceHistories: ParsedHistory[] = [];
  const resolutionHistories: ParsedHistory[] = [];
  const skipped: SkippedEntry[] = [];

  const codeTitle = bound.module.code_title;
  let currentDivision: string | null = null;
  let currentArticleOrChapter: string | null = null;

  // Binary search for first rbox with offset >= bound.startOffset.
  let lo = 0;
  let hi = rboxOffsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((rboxOffsets[mid] ?? 0) < bound.startOffset) lo = mid + 1;
    else hi = mid - 1;
  }
  const startIdx = lo;
  let endIdx = allRboxes.length;
  for (let i = startIdx; i < allRboxes.length; i++) {
    if (getStartIndex(allRboxes[i]) > bound.endOffset) {
      endIdx = i;
      break;
    }
  }

  // Pre-classify every rbox in the slice once. The dispatcher reads from
  // this array; the body-collection step below also consults it to decide
  // when to stop accumulating continuation text.
  const metas: RboxClassification[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    metas.push(classifyRbox($(allRboxes[i])));
  }

  // A rbox is a "boundary" when it terminates the body of a preceding
  // entry. Sections, appendices, histories, and hierarchy markers all
  // bound. consumed_by_parent and unknown rboxes are NOT boundaries —
  // their content can flow into the prior parent's body.
  const isEntryBoundary = (m: RboxClassification): boolean =>
    m.kind === "section" ||
    m.kind === "appendix" ||
    m.kind === "ordinance_history" ||
    m.kind === "resolution_history" ||
    m.kind === "hierarchy_marker";

  function collectBody(startJ: number): { text: string; elements: cheerio.Cheerio<any>[] } {
    const parts: string[] = [];
    const elements: cheerio.Cheerio<any>[] = [];
    for (let j = startJ; j < endIdx; j++) {
      const m = metas[j - startIdx];
      if (!m) break;
      if (isEntryBoundary(m)) break;
      const el = $(allRboxes[j]);
      elements.push(el);
      const t = el.text();
      if (/[A-Za-z0-9]/.test(t)) parts.push(t);
    }
    return { text: parts.join("\n"), elements };
  }

  for (let i = startIdx; i < endIdx; i++) {
    const meta = metas[i - startIdx];
    if (!meta) continue;
    const el = $(allRboxes[i]);

    switch (meta.kind) {
      case "hierarchy_marker": {
        const label = rboxLabelText(el);
        if (meta.level === "Division") {
          if (label) currentDivision = label;
          currentArticleOrChapter = null;
        } else if (label) {
          currentArticleOrChapter = label;
        }
        break;
      }
      case "section": {
        const body = collectBody(i + 1);
        const hierarchy = [codeTitle, currentDivision, currentArticleOrChapter].filter(
          (x): x is string => x != null && x.length > 0,
        );
        const parsed = parseSectionElement(
          el,
          bound.module,
          lineMap,
          hierarchy,
          meta.editorial_status,
          body.text,
          body.elements,
        );
        if (parsed.kind === "ok") {
          sections.push(parsed.section);
        } else {
          skipped.push(parsed.entry);
        }
        break;
      }
      case "appendix": {
        const body = collectBody(i + 1);
        const parsed = parseAppendixElement(el, meta, lineMap, body.text);
        appendices.push(parsed);
        break;
      }
      case "ordinance_history":
      case "resolution_history": {
        const body = collectBody(i + 1);
        const parsed = parseHistoryElement(
          el,
          meta.kind === "ordinance_history" ? "ordinance" : "resolution",
          meta.year,
          bound.module.id,
          lineMap,
          body.text,
        );
        if (meta.kind === "ordinance_history") {
          ordinanceHistories.push(parsed);
        } else {
          resolutionHistories.push(parsed);
        }
        break;
      }
      case "consumed_by_parent": {
        // Silently absorbed by the prior parent's body via collectBody. No
        // emission here; commit on the 0% gate (round-12) will audit that
        // every consumed_by_parent rbox actually had a parent.
        break;
      }
      case "unknown": {
        const node = el.get(0) as any;
        const line = offsetToLine(getStartIndex(node), lineMap);
        skipped.push({
          kind: "parse",
          source_location: { line },
          reason: meta.reason,
        });
        break;
      }
    }
  }

  if (bound.module.min_section_count != null && sections.length < bound.module.min_section_count) {
    throw new ParseAbortError(
      `parser: module "${bound.module.id}" produced ${sections.length} sections, ` +
        `min_section_count is ${bound.module.min_section_count}`,
    );
  }

  // Rbox-accounting audit: every rbox the dispatcher saw must be either
  // emitted as an entry, recorded as a skip, consumed by a parent, or a
  // hierarchy marker. A drift here means the classifier missed a case.
  // Defense against future refactors silently dropping content.
  const totalRboxesProcessed = endIdx - startIdx;
  let consumedByParentCount = 0;
  let hierarchyMarkerCount = 0;
  for (const m of metas) {
    if (m.kind === "consumed_by_parent") consumedByParentCount++;
    else if (m.kind === "hierarchy_marker") hierarchyMarkerCount++;
  }
  const accountedFor =
    sections.length +
    appendices.length +
    ordinanceHistories.length +
    resolutionHistories.length +
    skipped.length +
    consumedByParentCount +
    hierarchyMarkerCount;
  if (accountedFor !== totalRboxesProcessed) {
    throw new ParseAbortError(
      `parser accounting mismatch in module "${bound.module.id}": ` +
        `${totalRboxesProcessed} rboxes seen, ${accountedFor} accounted for ` +
        `(sections=${sections.length}, appendices=${appendices.length}, ` +
        `ordinances=${ordinanceHistories.length}, resolutions=${resolutionHistories.length}, ` +
        `skipped=${skipped.length}, consumed=${consumedByParentCount}, ` +
        `markers=${hierarchyMarkerCount})`,
    );
  }

  // Collect every JD anchor inside the module's bound (rbox-level OR nested
  // inside body content like deletion-marker stubs / Note sub-elements).
  // The citation gate uses this to resolve cites to anchors that exist in
  // source but the parser doesn't emit as queryable sections.
  const tocAnchorsSet = new Set<string>();
  for (let i = startIdx; i < endIdx; i++) {
    const el = $(allRboxes[i]);
    el.find("a[name^='JD_']").each((_idx, anchorNode) => {
      const name = (anchorNode as { attribs?: Record<string, string> }).attribs?.name ?? "";
      if (name.startsWith("JD_")) {
        const id = name.slice(3);
        if (id.length > 0) tocAnchorsSet.add(id);
      }
    });
  }

  return {
    sections,
    appendices,
    ordinanceHistories,
    resolutionHistories,
    skipped,
    totalRboxesProcessed,
    consumedByParentCount,
    hierarchyMarkerCount,
    tocAnchors: Array.from(tocAnchorsSet),
  };
}

type SectionParse = { kind: "ok"; section: ParsedSection } | { kind: "skip"; entry: SkippedEntry };

// Normalize a raw section id from AmLegal into the slug shape that
// SectionIdSchema accepts. Handles the round-11 skip-bucket edge cases:
//   - asterisk-suffix marker ("117.1*", "701.3*") is stripped (editorial
//     footnote indicator that doesn't change the canonical id)
//   - art-infix ("1075.1 art 16") becomes "1075.1-art-16" so the dotted/
//     dashed identifier passes the validator
//   - whitespace collapses to single hyphen
//   - trailing "." (defensive — HEADING_SEC_RE excludes a trailing capture
//     dot, but a JD anchor title might still carry one)
function normalizeSectionId(rawId: string): string {
  return rawId
    .trim()
    .replace(/\*$/, "")
    .replace(/\.$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .trim();
}

// Strip editorial suffixes from a JD_ anchor's title attribute before
// id normalization. " Note", " Note 1", "-1" suffix on a Section-class
// rbox's anchor title indicates a sub-element of the parent section,
// not a section root — but when AmLegal does emit one as a Section-class
// rbox, the unstripped title turns into a non-conforming id (e.g.
// "28.11-note-1") that pollutes the section namespace. Verified surface:
// 2 cases in the production SF AmLegal snapshot.
function stripJdAnchorSuffixes(rawTitle: string): string {
  return rawTitle.replace(/\s+Note\s*\d*\s*\*?$/i, "").replace(/-\d+\s*\*?$/, "");
}

// Capture allows a `.` only when followed by alnum / `*` / `-` — so a
// trailing `.` (before whitespace, end-of-string, or `[`) stays outside
// the capture. A naive regex ate the trailing `.` from headings like
// "SEC. 23.7.  [REDESIGNATED.]" and produced an invalid id "23.7.".
const HEADING_SEC_RE =
  /SEC(?:TION)?\.?\s+((?:[\dA-Za-z*-]|\.(?=[\dA-Za-z*-]))+(?:\s+art\s+[\d.A-Za-z]+)?)/i;
const REDESIGNATED_RE = /\bredesignated\b/i;
const REPEALED_RE = /\brepealed\b/i;
const RESERVED_RE = /\breserved\b/i;

function parseSectionElement(
  sectionEl: cheerio.Cheerio<any>,
  _module: ModuleConfig,
  lineMap: number[],
  hierarchy: string[],
  editorialFromClass: "active" | "reserved" | "repealed" | "redesignated",
  bodyText: string,
  bodyElements: cheerio.Cheerio<any>[],
): SectionParse {
  const node = sectionEl.get(0) as any;
  const line = offsetToLine(getStartIndex(node), lineMap);

  // The section's ID anchor is the first <a name="JD_*"> descendant. The
  // anchor's title= attribute is canonical when present (e.g. "1.100",
  // "A8.566"). When absent (Section-NewOrd variants and a small tail of
  // anchorless sections), fall back to extracting the id from heading text.
  const anchorEl = sectionEl.find("a[name^='JD_']").first();
  const heading = sectionEl.find("h1, h2, h3, h4, h5, h6").first();
  const headingText = (heading.length > 0 ? heading.text() : sectionEl.text()).trim();

  let rawId = stripJdAnchorSuffixes((anchorEl.attr("title") ?? "").trim());
  if (rawId === "") {
    const headingMatch = headingText.match(HEADING_SEC_RE);
    if (headingMatch?.[1]) {
      rawId = headingMatch[1].trim();
    }
  }
  if (rawId === "") {
    return {
      kind: "skip",
      entry: {
        kind: "parse",
        source_location: { line },
        reason: "section has no JD_* anchor and no extractable id in heading text",
      },
    };
  }

  const id = normalizeSectionId(rawId);
  // Self-validate against the canonical regex before returning. Without
  // this, an id-extraction bug surfaces only via the downstream
  // SectionFileSchema round-trip with a less-specific reason. Co-locate
  // the format check at the parser layer where the *real* root cause lives.
  if (!SECTION_ID_RE.test(id)) {
    return {
      kind: "skip",
      entry: {
        kind: "parse",
        raw_id: rawId,
        source_location: { line },
        reason: `parser produced non-conforming section id "${id}" from raw "${rawId}"; expected dotted/dashed lowercase per SECTION_ID_RE`,
      },
    };
  }
  const title = extractSectionTitle(headingText, rawId);

  // Refine editorial status from heading text. The class signature only
  // says "Section-Deleted" without disambiguating reserved / repealed /
  // redesignated; the heading text or body cross-reference does.
  let editorialStatus = editorialFromClass;
  let redirectTo: string | undefined;
  if (editorialStatus !== "active") {
    if (REPEALED_RE.test(headingText)) editorialStatus = "repealed";
    else if (REDESIGNATED_RE.test(headingText) || REDESIGNATED_RE.test(bodyText)) {
      editorialStatus = "redesignated";
      // Extract the redirect target from a body <Link class="Jump"> whose
      // to= attribute carries `hash: '#JD_<section-id>'`. .text() doesn't
      // include the hash, so we read the attribute directly.
      for (const bodyEl of bodyElements) {
        const link = bodyEl.find("Link.Jump, Link[class*=Jump]").first();
        const to = link.attr("to") ?? "";
        const m = to.match(/#JD_([\w.-]+)/);
        if (m?.[1]) {
          const candidate = normalizeSectionId(m[1]);
          if (candidate !== id) {
            redirectTo = candidate;
            break;
          }
        }
      }
    } else if (RESERVED_RE.test(headingText) || RESERVED_RE.test(bodyText)) {
      editorialStatus = "reserved";
    }
  }

  let finalTitle: string;
  let finalText: string;
  switch (editorialStatus) {
    case "reserved":
      finalTitle = "[Reserved.]";
      finalText = "[Reserved.]";
      break;
    case "repealed":
      finalTitle = "[Repealed.]";
      finalText = "[Repealed.]";
      break;
    case "redesignated":
      finalTitle = title || "[Redesignated.]";
      finalText = "[Redesignated.]";
      break;
    default:
      finalTitle = title;
      finalText = normalizeBodyText(bodyText);
  }

  const section: ParsedSection = {
    id,
    title: finalTitle,
    text: finalText,
    hierarchy,
    hierarchy_slugs: hierarchy.map(slugify),
    source_location: { line },
    editorial_status: editorialStatus,
  };
  if (redirectTo) section.redirect_to = redirectTo;
  return { kind: "ok", section };
}

function parseAppendixElement(
  appendixEl: cheerio.Cheerio<any>,
  classification: Extract<RboxClassification, { kind: "appendix" }>,
  lineMap: number[],
  bodyText: string,
): ParsedAppendix {
  const node = appendixEl.get(0) as any;
  const line = offsetToLine(getStartIndex(node), lineMap);
  const heading = appendixEl.find("h1, h2, h3, h4, h5, h6").first();
  const headingText = (heading.length > 0 ? heading.text() : "").trim();
  const title = extractAppendixTitle(headingText, classification.rawTitle);
  const id = `${classification.parent.kind}-${classification.parent.number}-appendix-${classification.letter}`;
  return {
    id,
    parent: classification.parent,
    letter: classification.letter,
    title,
    body: normalizeBodyText(bodyText),
    source_location: { line },
  };
}

function extractAppendixTitle(headingText: string, rawTitle: string): string {
  if (!headingText) return rawTitle;
  // Strip a leading "APPENDIX X." or "APPENDIX X -" prefix from heading text.
  const stripped = headingText.replace(/^APPENDIX\s+[A-Z]+[\s.\-:—]*/i, "").trim();
  return stripped || headingText;
}

function parseHistoryElement(
  historyEl: cheerio.Cheerio<any>,
  instrumentKind: "ordinance" | "resolution",
  year: number,
  moduleId: string,
  lineMap: number[],
  bodyText: string,
): ParsedHistory {
  const node = historyEl.get(0) as any;
  const line = offsetToLine(getStartIndex(node), lineMap);
  const id = instrumentKind === "ordinance" ? `${year}-ordinances` : `${year}-resolutions`;
  return {
    instrument_kind: instrumentKind,
    id,
    year,
    module_id: moduleId,
    body: normalizeBodyText(bodyText),
    source_location: { line },
  };
}

function extractSectionTitle(headingText: string, rawId: string): string {
  // Most common: "SEC. <id>.  <TITLE>." — strip "SEC. <id>. " prefix and
  // trailing ".".
  const escapedId = rawId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const secPrefixed = new RegExp(`^SEC\\.\\s+${escapedId}\\.\\s*(.*?)\\.?\\s*$`, "i");
  const m = headingText.match(secPrefixed);
  if (m?.[1]) return m[1].trim();
  // Older Charter shape: "<id>  <TITLE>" — strip leading id.
  if (headingText.toUpperCase().startsWith(rawId.toUpperCase())) {
    return headingText.slice(rawId.length).trim().replace(/\.$/, "").trim();
  }
  // Fallback: use the heading text as-is, minus trailing period.
  return headingText.replace(/\.$/, "").trim();
}

function normalizeBodyText(s: string): string {
  return s
    .split("\n")
    .map((line) =>
      line
        .replace(/ /g, " ")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

export function parseExport(
  input: Buffer | Uint8Array,
  jurisdiction: JurisdictionManifest,
): ModuleParseResult[] {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(input);
  const lineMap = buildLineMap(text);

  const $ = cheerio.load(text, {
    xml: false,
    sourceCodeLocationInfo: true,
  } as cheerio.CheerioOptions);

  const bounds = sliceJurisdiction($, jurisdiction, lineMap, text.length);
  if (bounds.length === 0) return [];

  // Index all .rbox elements once by document offset. Each per-module walk
  // binary-searches into this list to find its starting position.
  const allRboxes: any[] = [];
  $("div.rbox").each((_idx: number, node: any) => {
    allRboxes.push(node);
  });
  // cheerio yields elements in document order, so startIndex is monotonic.
  const rboxOffsets = allRboxes.map(getStartIndex);

  const results: ModuleParseResult[] = [];
  for (const bound of bounds) {
    const result = parseModuleFromBound($, allRboxes, rboxOffsets, bound, lineMap);
    results.push({
      module: bound.module,
      result,
      sliceMeta: { startLine: bound.startLine, endLine: bound.endLine },
    });
  }

  return results;
}

// Editorial cross-code citation graph extracted from <InterCodeLink> elements.
//
// Real-data shape (verified against the SF AmLegal export, 2026-05-03):
//
//   <InterCodeLink
//     infobasePath="L:\CA\San Francisco\Municipal Codes\Folio\Web\Building.nfo"
//     destinationId="JD_1.234"
//     styleName="Jump"
//     linkPrefix="/codes/san_francisco/latest/">
//
// destinationId is "JD_<section-id>" for section-targeted links (~80% of the
// real-data 2,681 InterCodeLinks) or "JD_<ModuleAnchor>" for whole-module
// pointers (~20%). Module identity comes from the basename of infobasePath
// (".nfo" stripped) — that string matches the manifest's jd_anchor field.
//
// Resolution algorithm:
//   1. Build jd_anchor → module_id lookup from the jurisdiction manifest.
//   2. basename(infobasePath, ".nfo") → target_module_id.
//   3. Strip "JD_" prefix from destinationId. If the remainder matches a
//      known jd_anchor, classify as targetKind: "module". Otherwise treat
//      as targetKind: "section" and store the normalized section id.
//
// Resolved edges power the references.json `cited_by` arrays. Edges that
// can't be resolved (foreign module not in the manifest set) emit a warning
// but are non-fatal — they're either a manifest gap to fill or a genuinely
// out-of-scope reference.
export interface InterCodeLinkEdge {
  sourceModuleId: string;
  sourceSectionId: string;
  targetModuleId: string;
  targetKind: "section" | "module";
  targetSectionId: string | null;
  rawDestinationId: string;
  rawInfobasePath: string;
  linkText: string;
}

export interface InterCodeLinkExtractionResult {
  edges: InterCodeLinkEdge[];
  warnings: UnresolvedInterCodeLinkWarning[];
}

function basenameWithoutExt(filePath: string, ext: string): string {
  if (!filePath) return "";
  // AmLegal uses Windows-style paths in infobasePath; handle both separators.
  const lastSep = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  const file = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  if (ext && file.toLowerCase().endsWith(ext.toLowerCase())) {
    return file.slice(0, file.length - ext.length);
  }
  return file;
}

export function parseInterCodeLinks(
  input: Buffer | Uint8Array,
  jurisdiction: JurisdictionManifest,
): InterCodeLinkExtractionResult {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(input);
  const $ = cheerio.load(text, {
    xml: false,
    sourceCodeLocationInfo: true,
  } as cheerio.CheerioOptions);

  const bounds = sliceJurisdiction($, jurisdiction, buildLineMap(text), text.length);
  const edges: InterCodeLinkEdge[] = [];
  const warnings: UnresolvedInterCodeLinkWarning[] = [];

  // jd_anchor → module_id index. Operator-curated jd_anchors on the manifest
  // make this the authoritative cross-code routing table.
  const anchorToModule = new Map<string, string>();
  for (const m of jurisdiction.modules) {
    if (m.jd_anchor) anchorToModule.set(m.jd_anchor, m.id);
  }
  const knownAnchors = new Set(anchorToModule.keys());

  const allRboxes: any[] = [];
  $("div.rbox").each((_idx: number, node: any) => {
    allRboxes.push(node);
  });

  for (const bound of bounds) {
    let currentSectionId: string | null = null;
    for (const node of allRboxes) {
      const startOffset = getStartIndex(node);
      if (startOffset < bound.startOffset) continue;
      if (startOffset > bound.endOffset) break;

      const el = $(node);
      const cls = (node.attribs?.class ?? "") as string;
      if (/\bSection\b/.test(cls)) {
        const rawId = (el.find("a[name^='JD_']").first().attr("title") ?? "").trim();
        if (rawId) currentSectionId = normalizeSectionId(rawId);
      }
      if (currentSectionId == null) continue;

      const sourceSectionId = currentSectionId;
      el.find("InterCodeLink").each((_j: number, linkNode: any) => {
        const $link = $(linkNode);
        const destinationId = $link.attr("destinationid") ?? $link.attr("destinationId") ?? "";
        const infobasePath = $link.attr("infobasepath") ?? $link.attr("infobasePath") ?? "";
        if (!destinationId) return;

        const targetAnchor = basenameWithoutExt(infobasePath, ".nfo");
        const targetModuleId = anchorToModule.get(targetAnchor);
        if (!targetModuleId) {
          warnings.push({
            sourceModuleId: bound.module.id,
            sourceSectionId,
            rawInfobasePath: infobasePath,
            rawDestinationId: destinationId,
            reason: targetAnchor
              ? `infobasePath anchor "${targetAnchor}" is not declared in the jurisdiction manifest`
              : `<InterCodeLink> has no infobasePath attribute`,
          });
          return;
        }

        const destSuffix = destinationId.startsWith("JD_") ? destinationId.slice(3) : destinationId;
        const isModuleLevel = knownAnchors.has(destSuffix);
        const targetKind: "section" | "module" = isModuleLevel ? "module" : "section";
        const targetSectionId = isModuleLevel ? null : normalizeSectionId(destSuffix);

        edges.push({
          sourceModuleId: bound.module.id,
          sourceSectionId,
          targetModuleId,
          targetKind,
          targetSectionId,
          rawDestinationId: destinationId,
          rawInfobasePath: infobasePath,
          linkText: $link.text(),
        });
      });
    }
  }

  return { edges, warnings };
}
