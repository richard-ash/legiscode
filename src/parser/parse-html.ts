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

// SpanRecord — a positioned format run inside a section's `text`. The
// span-table approach (CT1) lets the body-builder in pipeline.ts merge
// formatting with citation/defined-term annotations in a single pass
// against the same `text`. Format kinds:
//   - bold / italic   : <b>/<strong>, <i>/<em>
//   - list / listItem : <ul>/<ol> wraps, <li> per item
//   - paragraph_break : marks a \n in `text` that came from an rbox
//                       boundary (one rbox ≈ one paragraph in AmLegal)
//
// `start`/`end` index into the SECTION'S `text` (post-normalize), not
// the raw HTML. Empty/zero-length spans are not emitted.
//
// Whether to surface a kind: cheerio's flatten loses these, but the
// renderer needs them for visual fidelity. We don't surface every HTML
// tag — only the ones that meaningfully change rendering. Tags we walk
// through transparently: <a>, <InterCodeLink>, <Link>, <div>, <span>,
// <h1-h6>. Tags we DROP entirely (with their content): none right now;
// add as new fixtures surface them.
export type SpanFormat = "bold" | "italic" | "list" | "listItem" | "paragraph_break";

export interface SpanRecord {
  start: number;
  end: number;
  format: SpanFormat;
}

export interface ParsedSection {
  id: string;
  /**
   * Human-readable identifier the renderer shows in headings, tab
   * titles, and breadcrumbs ("109.0", "102A", "8.559"). Distinct from
   * `id`, which is the canonical lowercase anchor used for navigation
   * keys and on-disk filenames. Phase 5 splits identity from label so
   * `id` stops doing double duty.
   */
  display_label: string;
  title: string;
  text: string;
  /** Positioned format runs in `text`. Empty for [Reserved.] / [Repealed.] /
   * [Redesignated.] sections (those literals carry no formatting). Empty
   * for sections whose body source has no inline tags (the common case
   * in the test fixture). Populated when AmLegal HTML carries
   * <b>/<i>/<ul>/<li> markers around content in production corpora. */
  htmlSpans: SpanRecord[];
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

  // Subsection-class promotion lets citations like "§ 206.10" resolve.
  // The historical rule consumed any Subsection whose title wasn't
  // section-shaped (e.g. "Article 10, Appendix O, Sec. 1"). Pattern A
  // moves that decision to parseSectionElement: when the section turns
  // out to be inside an Appendix container, the long structural title
  // is exactly what we want to derive an id from. When it's NOT inside
  // an Appendix container, parseSectionElement's self-validation will
  // reject the non-conforming id and emit a skip with a clear reason.

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

// Pattern A: active Appendix container state. When set, subsequent
// Section emissions are inside this appendix's body and inherit a
// qualified id prefix derived from the container's anchor.
interface AppendixContainer {
  parent: { kind: "article" | "chapter"; number: number | string };
  letter: string;
  title: string;
  /** Slug used as the id prefix, e.g. "article10appendixb". Stable across
   *  AmLegal jurisdictions because it derives from publisher conventions
   *  (parent kind, parent number, appendix letter) not source text. */
  idSlug: string;
}

function buildAppendixContainer(
  meta: Extract<RboxClassification, { kind: "appendix" }>,
  parsed: ParsedAppendix,
): AppendixContainer {
  // idSlug shape: "article10appendixb", "chapter5appendixa". Concatenated
  // without separators because the components are all single tokens and
  // the existing SECTION_ID_RE only permits ./-/_ between alnum runs.
  // The final id form is "<idSlug>.<innerNum>" e.g. "article10appendixb.1".
  const idSlug = `${meta.parent.kind}${meta.parent.number}appendix${meta.letter}`;
  return {
    parent: meta.parent,
    letter: meta.letter,
    title: parsed.title,
    idSlug,
  };
}

// Pattern B: derive the anchor "key" for shared-anchor detection. Mirrors
// the parser's id-extraction precedence (title attr → name attr) but
// normalizes only enough to detect duplicates, not enough to be the
// final id. An anchor key that appears on >1 section in the same module
// indicates a source-anchor collision (sf-building's `JD_G5.106` ×6
// being the discovered case); those sections should fall back to
// heading-text section numbers instead of the anchor-derived id.
function formatAppendixHierarchyLabel(c: AppendixContainer): string {
  // Human-readable label that goes into section.hierarchy[]. Letter is
  // upper-cased for display; title is the AmLegal-supplied appendix
  // name (e.g. "Jackson Square Historic District"). Empty title falls
  // back to just the appendix designator.
  const letter = c.letter.toUpperCase();
  const parentWord = c.parent.kind === "article" ? "Article" : "Chapter";
  const base = `${parentWord} ${c.parent.number}, Appendix ${letter}`;
  return c.title ? `${base} - ${c.title}` : base;
}

function extractAnchorKey(el: cheerio.Cheerio<any>): string {
  const anchor = el.find("a[name^='JD_']").first();
  if (anchor.length === 0) return "";
  const titleAttr = (anchor.attr("title") ?? "").trim();
  if (titleAttr) return titleAttr.toLowerCase();
  const nameAttr = (anchor.attr("name") ?? "").trim();
  if (nameAttr.startsWith("JD_")) return nameAttr.slice(3).toLowerCase();
  return "";
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
  // Pattern A: track the active Appendix container so its inner Sections
  // (whether anchored as `JD_ArticleNAppendixXSec.M` or heading-text-only
  // `SEC. 1.`) get ids qualified by the container's slug, distinguishing
  // Section 1 of Jackson Square HD from Section 1 of Webster Street HD.
  // Cleared when a new Article/Chapter/Division marker is seen.
  let currentAppendix: AppendixContainer | null = null;

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

  // In-appendix tracking pre-pass: walk metas in order mirroring the
  // dispatcher's currentAppendix logic. Pattern A only rescues
  // anchored-but-non-section-shaped subsections when they sit inside
  // an Appendix container. Outside an appendix, those rboxes are
  // editorial commentary (PLANNING CODE - INTERPRETATIONS items with
  // titles like "Interp. Sec. 101.1") that the historical consume
  // rule absorbed into the parent's body. Without this, the parser
  // would fail SECTION_ID_RE on those titles and emit 169 spurious
  // skips into sf-planning.
  const inAppendix: boolean[] = new Array(metas.length).fill(false);
  {
    let cur: {
      letter: string;
      parent: { kind: "article" | "chapter"; number: number | string };
    } | null = null;
    for (let j = 0; j < metas.length; j++) {
      const m = metas[j];
      if (!m) continue;
      if (m.kind === "hierarchy_marker") cur = null;
      else if (m.kind === "appendix") cur = { letter: m.letter, parent: m.parent };
      if (cur) inAppendix[j] = true;
    }
  }
  for (let j = 0; j < metas.length; j++) {
    const m = metas[j];
    if (!m || m.kind !== "section" || inAppendix[j]) continue;
    const el = $(allRboxes[startIdx + j]);
    const clsTokens = ((el.get(0) as any)?.attribs?.class ?? "").split(/\s+/);
    const isSubsection = clsTokens.some((c: string) => /^(?:level-)?Sub[Ss]ection/.test(c));
    if (!isSubsection) continue;
    const anchor = el.find("a[name^='JD_']").first();
    const title = (anchor.attr("title") ?? "").trim();
    if (!title || SECTION_ID_RE.test(normalizeSectionId(title))) continue;
    metas[j] = {
      kind: "consumed_by_parent",
      reason: `subsection with non-section-shaped title "${title}"`,
    };
  }

  // Pattern B pre-pass: count JD anchor keys across all section-class
  // rboxes in this module. Any key appearing on >1 section means the
  // source itself is ambiguous (the `JD_G5.106` ×6 case in sf-building).
  // For those sections, parseSectionElement prefers the heading-text
  // section number over the anchor-derived id.
  const anchorKeyCounts = new Map<string, number>();
  for (let i = startIdx; i < endIdx; i++) {
    const m = metas[i - startIdx];
    if (m?.kind !== "section") continue;
    const key = extractAnchorKey($(allRboxes[i]));
    if (key) anchorKeyCounts.set(key, (anchorKeyCounts.get(key) ?? 0) + 1);
  }
  const sharedAnchorKeys = new Set<string>();
  for (const [key, count] of anchorKeyCounts) {
    if (count > 1) sharedAnchorKeys.add(key);
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

  function collectBody(startJ: number): {
    text: string;
    htmlSpans: SpanRecord[];
    elements: cheerio.Cheerio<any>[];
  } {
    const parts: string[] = [];
    const partSpans: SpanRecord[][] = [];
    const elements: cheerio.Cheerio<any>[] = [];
    for (let j = startJ; j < endIdx; j++) {
      const m = metas[j - startIdx];
      if (!m) break;
      if (isEntryBoundary(m)) break;
      const el = $(allRboxes[j]);
      elements.push(el);
      // GENERIC: walkRboxText produces the same flattened text that
      // cheerio's el.text() does, plus a list of format spans from
      // <b>/<i>/<ul>/<li> wrappers. Empty-content spans (e.g. <b></b>)
      // are dropped at the walker, so partSpans never carries
      // start === end entries.
      const { text: t, spans } = walkRboxText(el);
      if (/[A-Za-z0-9]/.test(t)) {
        parts.push(t);
        partSpans.push(spans);
      }
    }
    // Concatenate parts with "\n" separators, offsetting each rbox's
    // spans by the cumulative position. The "\n" separator itself is NOT
    // covered by any span here — paragraph_break spans are emitted by
    // the post-normalize pass on the surviving \n positions in the
    // final text.
    let text = "";
    const htmlSpans: SpanRecord[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) text += "\n";
      const baseOffset = text.length;
      text += parts[i] ?? "";
      for (const s of partSpans[i] ?? []) {
        htmlSpans.push({
          start: baseOffset + s.start,
          end: baseOffset + s.end,
          format: s.format,
        });
      }
    }
    return { text, htmlSpans, elements };
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
        // Article/Chapter/Division boundary terminates any active appendix
        // container; subsequent sections live under the new hierarchy node.
        currentAppendix = null;
        break;
      }
      case "section": {
        const body = collectBody(i + 1);
        const baseHierarchy = [codeTitle, currentDivision, currentArticleOrChapter].filter(
          (x): x is string => x != null && x.length > 0,
        );
        const hierarchy = currentAppendix
          ? [...baseHierarchy, formatAppendixHierarchyLabel(currentAppendix)]
          : baseHierarchy;
        const parsed = parseSectionElement(
          el,
          bound.module,
          lineMap,
          hierarchy,
          meta.editorial_status,
          body.text,
          body.htmlSpans,
          body.elements,
          currentAppendix,
          sharedAnchorKeys,
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
        // Pattern A: subsequent Section rboxes (until the next
        // Article/Chapter marker or appendix) are inside this container.
        currentAppendix = buildAppendixContainer(meta, parsed);
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

  // Pattern C post-pass: for any id that's still shared across multiple
  // sections after Pattern A and B applied, qualify by prepending the
  // immediate hierarchy parent's slug when those parents differ. The
  // discovered case is sf-planning's id="315" appearing in both
  // ARTICLE 3:ZONING PROCEDURES and PLANNING CODE - INTERPRETATIONS;
  // both sections have their own JD_315 anchor and heading "SEC. 315.",
  // so neither Pattern A nor B helps. The parent slug is the cheapest
  // honest disambiguator: it preserves identity provenance in the id
  // itself rather than requiring a side-channel.
  const byId = new Map<string, number[]>();
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s) continue;
    const arr = byId.get(s.id) ?? [];
    arr.push(i);
    byId.set(s.id, arr);
  }
  // Track the rewrite map for tocAnchors cleanup and redirect_to remap.
  // Keys are the OLD ids (raw, post-Pattern-A/B but pre-Pattern-C);
  // values are the set of NEW qualified ids those rewrote to. When old
  // → multiple new (the collision case), the redirect_to remap can't
  // pick one unambiguously and we leave it alone so a downstream resolver
  // surfaces the broken link rather than silently picking the wrong one.
  const idRewriteMap = new Map<string, Set<string>>();
  for (const [, indices] of byId) {
    if (indices.length < 2) continue;
    // Only qualify when the immediate hierarchy parent differs across
    // members. Same parent + same id is a genuine duplicate the
    // duplicate_section_ids gate must surface, not silently qualify.
    const parentSlugs = indices.map((i) => {
      const s = sections[i];
      const parent = s?.hierarchy[s.hierarchy.length - 1];
      return parent ? slugify(parent) : "";
    });
    const distinctParents = new Set(parentSlugs.filter((p) => p.length > 0));
    if (distinctParents.size < 2) continue;
    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k];
      const slug = parentSlugs[k];
      if (idx == null || !slug) continue;
      const s = sections[idx];
      if (!s) continue;
      // Prepend the parent slug. Validate it still passes SECTION_ID_RE;
      // if not (e.g. a parent slug starts with a digit-prefix that
      // would create an invalid sequence) the qualification is skipped
      // and the duplicate gate will surface the unresolved collision.
      const qualified = `${slug}.${s.id}`;
      if (SECTION_ID_RE.test(qualified)) {
        const oldId = s.id;
        sections[idx] = { ...s, id: qualified };
        const set = idRewriteMap.get(oldId) ?? new Set<string>();
        set.add(qualified);
        idRewriteMap.set(oldId, set);
      }
    }
  }

  // Pattern C followup: rewrite any section.redirect_to that pointed to
  // a now-qualified id. When a redesignated section's `#JD_<id>` link
  // targeted a section that Pattern C qualified, the redirect_to field
  // retains the old un-qualified id and runtime navigation breaks. When
  // multiple new qualified ids exist for the same old id (the actual
  // collision), the redirect_to is ambiguous; we leave it alone rather
  // than guess wrong, and a downstream link-resolution gate can surface
  // the dangling reference.
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s?.redirect_to) continue;
    const candidates = idRewriteMap.get(s.redirect_to);
    if (candidates && candidates.size === 1) {
      const [only] = candidates;
      if (only) sections[i] = { ...s, redirect_to: only };
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
  // Pattern C cleanup: remove raw anchor names whose corresponding
  // section.id was rewritten. Without this, the binder's anchor index
  // would still treat `315` as bindable even though no section has that
  // id anymore, and the runtime resolver would fail on a green-build
  // section-ref target. Match on normalized form so case/whitespace
  // discrepancies between source anchor names and normalized ids align.
  if (idRewriteMap.size > 0) {
    for (const oldId of idRewriteMap.keys()) {
      tocAnchorsSet.delete(oldId);
      tocAnchorsSet.delete(oldId.toLowerCase());
    }
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
//   - asterisk-suffix marker ("117.1*", "701.3*") was originally stripped
//     as a no-op editorial indicator, but T3a found 11 cases where the
//     asterisked form ("JD_117.1*") coexists with its bare twin
//     ("JD_117.1") as DISTINCT source sections. Encoding the asterisk
//     count as `-fnN` preserves the asterisk's disambiguating role
//     without breaking SECTION_ID_RE.
//   - art-infix ("1075.1 art 16") becomes "1075.1-art-16" so the dotted/
//     dashed identifier passes the validator
//   - whitespace collapses to single hyphen
//   - trailing "." (defensive — HEADING_SEC_RE excludes a trailing capture
//     dot, but a JD anchor title might still carry one)
function normalizeSectionId(rawId: string): string {
  return rawId
    .trim()
    .replace(/(\*+)$/, (_, asterisks: string) => `-fn${asterisks.length}`)
    .replace(/\.$/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .trim();
}

// Strip editorial suffixes from a JD_ anchor's title attribute before
// id normalization. Only the " Note <n>" suffix is editorial; the "-<n>"
// ordinal suffix is a load-bearing disambiguator the source uses to
// distinguish multiple sections that share the same dotted-number prefix
// (e.g. "16.9-2", "16.9-21", "16.9-29A"). Stripping the ordinal collapses
// 1,531 SF sections onto colliding ids and silently last-write-wins them
// at storage time — see test/parser/chrome-and-id-patterns.test.ts G1.
function stripJdAnchorSuffixes(rawTitle: string): string {
  return rawTitle.replace(/\s+Note\s*\d*\s*\*?$/i, "");
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
  bodyHtmlSpans: SpanRecord[],
  bodyElements: cheerio.Cheerio<any>[],
  containerAppendix: AppendixContainer | null,
  sharedAnchorKeys: Set<string>,
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
  const hasJdAnchor = anchorEl.length > 0;
  const anchorTitle = (anchorEl.attr("title") ?? "").trim();
  const anchorName = (anchorEl.attr("name") ?? "").trim();
  const anchorKey = anchorTitle
    ? anchorTitle.toLowerCase()
    : anchorName.startsWith("JD_")
      ? anchorName.slice(3).toLowerCase()
      : "";

  // Heading-text section number extraction. Used by:
  //  - Pattern A: as the inner-section number when this section lives
  //    inside an Appendix container
  //  - Pattern B: as the preferred id when the JD anchor is shared with
  //    another section in this module (sf-building's `JD_G5.106` ×6)
  //  - Final fallback: when no JD anchor exists at all
  const headingSecMatch = headingText.match(HEADING_SEC_RE);
  const headingSecNum = headingSecMatch?.[1]?.trim() ?? "";

  // === Unified id derivation, in precedence order ===
  //
  // Pattern A (Appendix container): when inside an appendix, qualify the
  // id with the container's slug so Sec. 1 of Jackson Square HD is
  // distinct from Sec. 1 of Webster Street HD. Use the heading-text
  // inner number when present (handles anchor-less Article 10 A-N AND
  // anchored Article 10 O-Q / Article 11 / Article 600 cases uniformly);
  // when heading text has no SEC.N token, parse the trailing Sec.N from
  // the anchor title (e.g. "Article 11, Appendix E, Sec. 1" → "1").
  let rawId = "";
  if (containerAppendix) {
    let innerNum = headingSecNum;
    if (!innerNum && anchorTitle) {
      const trailing = anchorTitle.match(/Sec\.\s*([\dA-Za-z.]+)\s*$/i);
      if (trailing?.[1]) innerNum = trailing[1];
    }
    if (innerNum) {
      rawId = `${containerAppendix.idSlug}.${innerNum}`;
    }
  }

  // Pattern B (shared anchor): the JD anchor is reused on >=2 sections
  // in this module, so it can't uniquely identify any of them. Prefer
  // the heading-text section number, which differs per section in the
  // discovered case (sf-building: SECTION 5.101 vs 5.103 vs 5.106 etc.).
  if (rawId === "" && anchorKey && sharedAnchorKeys.has(anchorKey) && headingSecNum) {
    rawId = headingSecNum;
  }

  // Default: anchor title attribute (current behavior preserved).
  if (rawId === "") {
    rawId = stripJdAnchorSuffixes(anchorTitle);
  }
  // D10 anchor-name fallback. When `title` is missing the disambiguator
  // we care about ("title=\"\" name=\"JD_16.9-2\"" is a real shape AmLegal
  // emits when the title attribute is dropped during their export step),
  // read the canonical id from the `name` attribute with the JD_ prefix
  // stripped. Must come BEFORE the heading-text fallback: heading text
  // typically reads "SEC. 16.9." without the disambiguator, so it would
  // truncate the id back to "16.9" and reintroduce the collision.
  if (rawId === "" && anchorName.startsWith("JD_")) {
    rawId = stripJdAnchorSuffixes(anchorName.slice(3).trim());
  }
  // Heading-text fallback (anchor-less section, no Appendix container).
  if (rawId === "" && headingSecNum) {
    rawId = headingSecNum;
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

  // display_label is the human-readable section number — what readers
  // see in headings, breadcrumbs, and tab labels ("109.0", "102A").
  // Prefer the heading text's section number ("SECTION 109.0 ...") when
  // available because AmLegal anchor titles often use a stripped form
  // ("P109" without ".0"); fall back to the anchor's rawId when the
  // heading doesn't expose one. The canonical id (used as the on-disk
  // filename and the runtime anchor lookup key) stays as the
  // lowercase JD_-stripped form derived below.
  const headingDisplayMatch = headingText.match(HEADING_SEC_RE);
  const displayLabel = headingDisplayMatch?.[1]?.trim() || rawId.trim();

  // Anchor-less tombstone disambiguation. A Section-Deleted rbox whose
  // heading reads "SEC. 23.7. [REDESIGNATED.]" but carries no JD anchor
  // of its own (the anchor lives only on the live section that took
  // over the number) collides at id-uniqueness time with the live
  // sibling. The renderer still wants the tombstone so readers see the
  // "moved to 23.10" pointer at the old location. Suffix `-orig`
  // disambiguates without losing semantic information; the tombstone
  // gets a stable on-disk path that cannot collide with the JD-anchored
  // section. Only the heading-text-fallback path (no JD anchor at all)
  // needs this — sections that DO have their own anchor are addressable
  // by anchor and never collide on this axis.
  //
  // We check heading text directly rather than the class-derived
  // editorial status because the SF AmLegal source frequently puts the
  // Section-Deleted class on the inner <h5> rather than the outer rbox
  // (e.g. rid 14067), so classifyRbox sees only the outer "level-Section"
  // classes and reports editorialFromClass = "active". The heading text
  // ("[REDESIGNATED.]" / "[REPEALED.]" / "[Reserved.]") is the
  // authoritative tombstone signal regardless of which DOM level the
  // editorial class lives on.
  const looksLikeTombstone =
    REDESIGNATED_RE.test(headingText) ||
    REPEALED_RE.test(headingText) ||
    RESERVED_RE.test(headingText);
  let normalizedId = normalizeSectionId(rawId);
  if (!hasJdAnchor && looksLikeTombstone) {
    normalizedId = `${normalizedId}-orig`;
  }
  const id = normalizedId;
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
  // Use the heading-text-derived section number (displayLabel) for title
  // extraction, not the canonical id. For Pattern A sections, id is the
  // qualified form `article10appendixb.1` but the heading reads "SEC. 1.
  // FINDINGS." — extractSectionTitle's "SEC. <id>." prefix regex would
  // miss against the qualified form and the title would retain the
  // "SEC. 1." prefix. displayLabel always matches what's actually in the
  // heading text when HEADING_SEC_RE matched.
  const title = extractSectionTitle(headingText, displayLabel || rawId);

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
  // For editorial-status placeholders ([Reserved.] etc.) htmlSpans is
  // empty — the literal carries no formatting. Active sections compute
  // both the normalized text AND the position-mapped span table in a
  // single pass so format runs index into the same `text` the renderer
  // displays.
  let finalSpans: SpanRecord[] = [];
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
    default: {
      finalTitle = title;
      const normalized = normalizeBodyTextWithSpans(bodyText, bodyHtmlSpans);
      finalText = normalized.text;
      // Append paragraph_break markers at every \n in the final text.
      // \n only appears at rbox boundaries that survived the empty-line
      // filter, so each is a real paragraph boundary.
      finalSpans = [...normalized.spans];
      for (let i = 0; i < finalText.length; i++) {
        if (finalText[i] === "\n") {
          finalSpans.push({ start: i, end: i + 1, format: "paragraph_break" });
        }
      }
      finalSpans.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
    }
  }

  const section: ParsedSection = {
    id,
    display_label: displayLabel,
    title: finalTitle,
    text: finalText,
    htmlSpans: finalSpans,
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

// Single-source through normalizeBodyTextWithSpans so the appendix /
// history body-text rules can never drift from section-text rules.
// (The text-fidelity snapshot only covers section bodies; without
// shared logic, an appendix-only normalizer change could go undetected
// for releases.)
function normalizeBodyText(s: string): string {
  return normalizeBodyTextWithSpans(s, []).text;
}

// GENERIC: tag-to-format mapping. The AmLegal HTML corpus uses standard
// inline tags for formatting; future jurisdictions may need different
// mappings, in which case this lives behind a parser-strategy switch
// per A5.
function tagToFormat(tag: string | undefined): Exclude<SpanFormat, "paragraph_break"> | null {
  switch (tag?.toLowerCase()) {
    case "b":
    case "strong":
      return "bold";
    case "i":
    case "em":
      return "italic";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listItem";
    default:
      return null;
  }
}

// GENERIC: walk a cheerio element subtree producing the concatenated
// text of all descendant text nodes (matching cheerio's .text()
// semantics) plus a positioned format-span list. Spans index into the
// returned `text` (pre-normalize). Empty-content spans (e.g. `<b></b>`)
// are dropped here so downstream code never sees a zero-length span.
//
// Other tags (<a>, <div>, <span>, <h1-h6>, <Link>, <InterCodeLink>) are
// transparent — their text contributes but no span is recorded. The
// renderer treats unrecognized inline runs as plain text.
//
// Exported for unit testing. Production callers use it via collectBody
// inside parseExport — there's no scenario where consumers need to walk
// individual cheerio elements.
export function walkRboxText(el: cheerio.Cheerio<any>): { text: string; spans: SpanRecord[] } {
  let text = "";
  const spans: SpanRecord[] = [];

  function visit(node: any): void {
    if (!node) return;
    // Cheerio's parse5-backed nodes use type "text" for text nodes and
    // "tag" for elements. Skip "comment", "cdata", "directive" — they
    // contribute no rendered text.
    if (node.type === "text") {
      text += node.data ?? "";
      return;
    }
    if (node.type !== "tag") return;
    const myFormat = tagToFormat(node.name);
    const start = text.length;
    for (const child of node.children ?? []) visit(child);
    const end = text.length;
    if (myFormat && end > start) {
      spans.push({ start, end, format: myFormat });
    }
  }

  for (const rootNode of el.toArray()) visit(rootNode as any);
  return { text, spans };
}

// GENERIC: position-aware variant of normalizeBodyText. Mirrors that
// function's behavior byte-for-byte (NBSP→space, run-collapse, per-line
// trim, drop empty lines, join with \n) while building a posMap that
// lets us remap raw-text spans into final-text positions.
//
// Why we can't reuse normalizeBodyText: that function operates on the
// entire string, so we'd lose position information at every step.
// Instead, we walk char-by-char tracking the final-text index for every
// raw-text index, then replay over rawSpans to produce finalSpans.
//
// LOAD-BEARING: the `text` returned here MUST equal what
// normalizeBodyText(rawText) would produce. The text-fidelity test in
// test/parser/text-fidelity.test.ts catches drift via the committed
// snapshot.
//
// Exported for unit testing.
export function normalizeBodyTextWithSpans(
  rawText: string,
  rawSpans: SpanRecord[],
): { text: string; spans: SpanRecord[] } {
  // posMap[rawIdx] = finalIdx, or -1 if the raw char was dropped.
  const posMap = new Array<number>(rawText.length).fill(-1);
  let finalText = "";

  const lines = rawText.split("\n");
  let rawCursor = 0;
  for (const line of lines) {
    // Step A: per-char NBSP→space + run-collapse over this line.
    let normalizedLine = "";
    const lineMap: number[] = [];
    let prevWasSpace = false;
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      // Whitespace classes that normalizeBodyText collapses: 0x20 space,
      // 0x09 tab, 0xa0 NBSP. (The original regex covered " " | "\t" |
      // " ".)
      const isWhitespace = code === 0x20 || code === 0x09 || code === 0xa0;
      if (isWhitespace) {
        if (prevWasSpace) {
          lineMap.push(-1);
        } else {
          normalizedLine += " ";
          lineMap.push(normalizedLine.length - 1);
          prevWasSpace = true;
        }
      } else {
        normalizedLine += line[i] ?? "";
        lineMap.push(normalizedLine.length - 1);
        prevWasSpace = false;
      }
    }

    // Step B: trim leading/trailing whitespace. After Step A, the only
    // whitespace in normalizedLine is single ASCII spaces.
    let firstNonSpace = 0;
    while (
      firstNonSpace < normalizedLine.length &&
      normalizedLine.charCodeAt(firstNonSpace) === 0x20
    ) {
      firstNonSpace++;
    }
    let lastNonSpace = normalizedLine.length - 1;
    while (lastNonSpace >= firstNonSpace && normalizedLine.charCodeAt(lastNonSpace) === 0x20) {
      lastNonSpace--;
    }

    if (firstNonSpace > lastNonSpace) {
      // Line is entirely whitespace — dropped per .filter(l => l.length > 0).
      // posMap entries for this line stay -1 (initialized above).
    } else {
      const trimmed = normalizedLine.slice(firstNonSpace, lastNonSpace + 1);
      const lineStartInFinal = finalText.length === 0 ? 0 : finalText.length + 1;
      if (finalText.length > 0) finalText += "\n";
      finalText += trimmed;
      for (let i = 0; i < line.length; i++) {
        const normIdx = lineMap[i] ?? -1;
        if (normIdx >= firstNonSpace && normIdx <= lastNonSpace) {
          posMap[rawCursor + i] = lineStartInFinal + (normIdx - firstNonSpace);
        }
      }
    }

    rawCursor += line.length + 1;
  }

  // Remap raw spans: each [start, end) → first/last surviving raw
  // position's mapped index. If no raw position in the span survived,
  // drop the span entirely (e.g. a <b> wrapping pure whitespace).
  const finalSpans: SpanRecord[] = [];
  for (const span of rawSpans) {
    let mappedStart = -1;
    for (let i = span.start; i < span.end && i < posMap.length; i++) {
      if (posMap[i] !== -1) {
        mappedStart = posMap[i] as number;
        break;
      }
    }
    let mappedEnd = -1;
    for (let i = Math.min(span.end, posMap.length) - 1; i >= span.start; i--) {
      if (posMap[i] !== -1) {
        mappedEnd = (posMap[i] as number) + 1;
        break;
      }
    }
    if (mappedStart === -1 || mappedEnd <= mappedStart) continue;
    finalSpans.push({ start: mappedStart, end: mappedEnd, format: span.format });
  }

  return { text: finalText, spans: finalSpans };
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
