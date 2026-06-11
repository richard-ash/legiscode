// read — the single read verb. Dispatches a path on the corpus
// filesystem (see types.ts for the path tree) to typed payloads.
//
// All reads are pure data lookups. The verifier counts section paths as
// fetched refs; bill/ordinance/definition paths don't fetch refs (they
// aren't sections in the citation invariant). See N18 / A3.

import type { Bill } from "@/types";
import { bodyToText } from "@/types";
import type { AiCorpusHandle } from "../../corpus-loader";
import { getBillsIndex } from "../bills-index";
import { getOrdinanceIndex } from "../ordinance-index";
import { extractCitedRefs } from "../reverse-index";
import { getReverseGraph } from "../reverse-index";
import type {
  AmendmentRef,
  ArticleSectionEntry,
  ArticleSummary,
  BillChangeEntry,
  CiterRef,
  DefinitionHit,
  DirectoryEntry,
  HistoryEntry,
  OrdinanceSummary,
  QualifiedRef,
  ReadInput,
  ReadResult,
  SessionBillSummary,
  ToolError,
} from "./types";

export interface ToolContext {
  readonly corpus: AiCorpusHandle;
  readonly turnId: number;
}

const HARD_CAP = 50;

export function runRead(input: ReadInput, ctx: ToolContext): ReadResult {
  const parts = splitPath(input.path);
  if (parts.length === 0) return readRoot(ctx);

  switch (parts[0]) {
    case "bills":
      return readBills(parts, ctx);
    case "modules":
      return readModules(parts, ctx);
    case "definitions":
      return readDefinitions(parts, ctx);
    case "ordinances":
      return readOrdinances(parts, ctx);
    default:
      return notFound(`Unknown root: "/${parts[0]}". Read "/" to list valid roots.`, ctx);
  }
}

// ─── Root ──────────────────────────────────────────────────────────────────

function readRoot(ctx: ToolContext): ReadResult {
  const entries: DirectoryEntry[] = [
    { path: "/bills", summary: "Session bills, newest first." },
    {
      path: "/modules",
      summary: `Installed code modules (${ctx.corpus.modules.length}).`,
    },
    { path: "/ordinances", summary: "Enacted ordinances, newest first." },
    {
      path: "/definitions/{term}",
      summary: "Definitions matching a term across every installed module.",
    },
  ];
  return {
    ok: true,
    kind: "directory",
    path: "/",
    entries,
    truncated: false,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

// ─── /bills ─────────────────────────────────────────────────────────────────

function readBills(parts: readonly string[], ctx: ToolContext): ReadResult {
  if (parts.length === 1) return listSessionBills(ctx);
  // parts.length >= 2 — parts[1] is defined.
  const fileNo = parts[1] as string;
  const bill = findBillByFileNo(ctx.corpus, fileNo);
  if (!bill) return notFound(`No bill with file_no=${fileNo}.`, ctx);
  if (parts.length === 2) return readBillMetadata(bill, ctx);
  switch (parts[2]) {
    case "proposed-text":
      if (parts.length !== 3) {
        return notFound(`Trailing segments after /bills/${fileNo}/proposed-text.`, ctx);
      }
      return readBillProposedText(bill, ctx);
    case "changes":
      if (parts.length === 3) return readBillChanges(bill, ctx);
      if (parts.length === 5) {
        return readBillSectionDiff(bill, parts[3] as string, parts[4] as string, ctx);
      }
      return notFound(
        `Path under /bills/${fileNo}/changes must be /bills/${fileNo}/changes or /bills/${fileNo}/changes/{module_id}/{section_id}.`,
        ctx,
      );
    default:
      return notFound(
        `Unknown subpath /${parts[2]} under /bills/${fileNo}. Try /bills/${fileNo}/proposed-text or /bills/${fileNo}/changes.`,
        ctx,
      );
  }
}

function listSessionBills(ctx: ToolContext): ReadResult {
  const all: SessionBillSummary[] = [];
  for (const mod of ctx.corpus.modules) {
    for (const bill of mod.sessionBills) {
      all.push({
        file_no: bill.file_no,
        module_id: mod.id,
        short_title: bill.short_title,
        long_title: bill.long_title,
        bill_status: bill.bill_status,
        legistar_status: bill.legistar_status,
        sponsor: bill.sponsor,
        introduced_at: bill.introduced_at,
        legistar_url: bill.legistar_url,
        affected_section_ids: uniqueSectionIds(bill.section_outcomes),
      });
    }
  }
  all.sort(byIntroducedDesc);
  const bills = all.slice(0, HARD_CAP);
  return {
    ok: true,
    kind: "bills-list",
    total: all.length,
    bills,
    truncated: all.length > bills.length,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readBillMetadata(bill: Bill, ctx: ToolContext): ReadResult {
  return {
    ok: true,
    kind: "bill",
    bill: {
      file_no: bill.file_no,
      module_id: bill.module_id,
      short_title: bill.short_title,
      long_title: bill.long_title,
      bill_status: bill.bill_status,
      legistar_status: bill.legistar_status,
      sponsor: bill.sponsor,
      introduced_at: bill.introduced_at,
      legistar_url: bill.legistar_url,
      parse_status: bill.parse_status,
      affected_section_ids: uniqueSectionIds(bill.section_outcomes),
      subpaths: {
        proposed_text: `/bills/${bill.file_no}/proposed-text`,
        changes: `/bills/${bill.file_no}/changes`,
      },
    },
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readBillProposedText(bill: Bill, ctx: ToolContext): ReadResult {
  const amendments = bill.body.amendments.map((amend) => ({
    action: amend.action,
    target: amend.target ? { ...amend.target } : null,
    text: ordinanceBlocksToText(amend.body),
  }));
  return {
    ok: true,
    kind: "bill-proposed-text",
    body: {
      file_no: bill.file_no,
      module_id: bill.module_id,
      preamble: bill.body.preamble,
      amendments,
      closing: bill.body.closing,
    },
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readBillChanges(bill: Bill, ctx: ToolContext): ReadResult {
  const changes: BillChangeEntry[] = bill.section_outcomes.map((outcome) => ({
    module_id: bill.module_id,
    section_id: outcome.section_id,
    status: outcome.status,
    detail: outcome.detail,
    path: `/bills/${bill.file_no}/changes/${bill.module_id}/${outcome.section_id}`,
  }));
  return {
    ok: true,
    kind: "bill-changes",
    file_no: bill.file_no,
    module_id: bill.module_id,
    changes,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readBillSectionDiff(
  bill: Bill,
  moduleId: string,
  sectionId: string,
  ctx: ToolContext,
): ReadResult {
  if (moduleId !== bill.module_id) {
    return notFound(`Bill ${bill.file_no} targets module ${bill.module_id}, not ${moduleId}.`, ctx);
  }
  const outcome = bill.section_outcomes.find((o) => o.section_id === sectionId);
  if (!outcome) {
    return notFound(
      `Bill ${bill.file_no} does not target section ${sectionId} in ${moduleId}.`,
      ctx,
    );
  }
  // baseline_text: current section text. Null when the bill adds a
  // brand-new section (no prior text exists).
  const baselineSection = ctx.corpus.getSection(moduleId, sectionId);
  const baselineText = baselineSection?.text ?? null;
  // proposed_text: rebuilt from new_bodies via bodyToText, the same
  // flattener the renderer uses.
  const newBody = bill.new_bodies.find((nb) => nb.section_id === sectionId);
  const proposedText = newBody ? bodyToText(newBody.body) : (baselineText ?? "");
  const chunks = bill.diff_chunks
    .filter((c) => c.section_id === sectionId)
    .map((c) => ({ kind: c.op, text: c.text }));
  // The diff payload includes baseline_text (current section text), so
  // reading this path satisfies the citation invariant for the target
  // section — the model can cite [module § section_id] in prose without
  // re-reading the section path separately.
  const fetchedRef = baselineSection
    ? [{ module_id: moduleId, section_id: baselineSection.id }]
    : [];
  return {
    ok: true,
    kind: "bill-section-diff",
    diff: {
      file_no: bill.file_no,
      module_id: moduleId,
      section_id: sectionId,
      status: outcome.status,
      baseline_text: baselineText,
      proposed_text: proposedText,
      chunks,
    },
    fetched: fetchedRef,
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

// ─── /modules ──────────────────────────────────────────────────────────────

function readModules(parts: readonly string[], ctx: ToolContext): ReadResult {
  if (parts.length === 1) return listModules(ctx);
  const moduleId = parts[1] as string;
  const mod = ctx.corpus.modules.find((m) => m.id === moduleId);
  if (!mod) return notFound(`Module ${moduleId} is not installed.`, ctx);
  if (parts.length === 2) return readModuleMetadata(mod.id, ctx);
  switch (parts[2]) {
    case "sections":
      if (parts.length < 4) {
        return notFound(
          `Path must be /modules/${moduleId}/sections/{section_id} — sections aren't browsable by listing. Use search() to discover ids.`,
          ctx,
        );
      }
      return readSectionPath(moduleId, parts.slice(3), ctx);
    case "articles":
      if (parts.length === 3) return readModuleArticles(moduleId, ctx);
      if (parts.length === 4) return readModuleArticle(moduleId, parts[3] as string, ctx);
      return notFound(
        `Path must be /modules/${moduleId}/articles or /modules/${moduleId}/articles/{article_id}.`,
        ctx,
      );
    case "definitions":
      if (parts.length < 4) {
        return notFound(`Path must be /modules/${moduleId}/definitions/{term}.`, ctx);
      }
      return readDefinitionsInModule(moduleId, parts.slice(3).join(" "), ctx);
    default:
      return notFound(
        `Unknown subpath /${parts[2]} under /modules/${moduleId}. Try /sections/{section_id}, /articles/{article_id}, or /definitions/{term}.`,
        ctx,
      );
  }
}

function readModuleArticles(moduleId: string, ctx: ToolContext): ReadResult {
  const mod = ctx.corpus.modules.find((m) => m.id === moduleId);
  if (!mod) return notFound(`Module ${moduleId} is not installed.`, ctx);
  const articles: ArticleSummary[] = mod.articles.map((a) => ({
    module_id: moduleId,
    article_id: a.id,
    title: a.title,
    parents: a.parents,
    section_count: a.sections.length,
    path: `/modules/${moduleId}/articles/${a.id}`,
  }));
  return {
    ok: true,
    kind: "articles-list",
    module_id: moduleId,
    articles,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readModuleArticle(moduleId: string, articleId: string, ctx: ToolContext): ReadResult {
  const mod = ctx.corpus.modules.find((m) => m.id === moduleId);
  if (!mod) return notFound(`Module ${moduleId} is not installed.`, ctx);
  // Case-insensitive lookup so the model isn't forced to roman-numeral-case
  // ("Article I" vs "Article i" vs "Article 1") — the article ids in the
  // index preserve source case but match leniently here.
  const wanted = articleId.toLowerCase();
  const article = mod.articles.find((a) => a.id.toLowerCase() === wanted);
  if (!article) {
    return notFound(
      `Module ${moduleId} has no article with id "${articleId}". Read /modules/${moduleId}/articles to list available articles.`,
      ctx,
    );
  }
  const sections: ArticleSectionEntry[] = article.sections.map((s) => ({
    section_id: s.section_id,
    display_label: s.display_label,
    title: s.title,
    editorial_status: s.editorial_status,
    path: `/modules/${moduleId}/sections/${s.section_id}`,
  }));
  return {
    ok: true,
    kind: "article-sections",
    module_id: moduleId,
    article_id: article.id,
    title: article.title,
    parents: article.parents,
    sections,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function listModules(ctx: ToolContext): ReadResult {
  const entries: DirectoryEntry[] = ctx.corpus.modules.map((m) => ({
    path: `/modules/${m.id}`,
    summary: `${m.name} — ${m.sections.length} sections`,
  }));
  return {
    ok: true,
    kind: "directory",
    path: "/modules",
    entries,
    truncated: false,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readModuleMetadata(moduleId: string, ctx: ToolContext): ReadResult {
  const mod = ctx.corpus.modules.find((m) => m.id === moduleId);
  if (!mod) return notFound(`Module ${moduleId} is not installed.`, ctx);
  return {
    ok: true,
    kind: "module",
    module: {
      module_id: mod.id,
      name: mod.name,
      code_title: mod.codeTitle,
      jurisdiction: mod.jurisdiction,
      section_count: mod.sections.length,
      definition_count: mod.definitions.length,
      session_bill_count: mod.sessionBills.length,
    },
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readSectionPath(moduleId: string, rest: readonly string[], ctx: ToolContext): ReadResult {
  // Caller guarantees rest.length >= 1.
  const sectionId = rest[0] as string;
  const section = ctx.corpus.getSection(moduleId, sectionId);
  if (!section) {
    return notFound(`Section ${sectionId} not found in module ${moduleId}.`, ctx);
  }
  if (rest.length === 1) return readSectionContent(moduleId, sectionId, ctx);
  switch (rest[1]) {
    case "cited-by":
      if (rest.length !== 2) {
        return notFound(`Trailing segments after .../cited-by.`, ctx);
      }
      return readSectionCiters(moduleId, sectionId, ctx);
    case "history":
      if (rest.length !== 2) return notFound(`Trailing segments after .../history.`, ctx);
      return readSectionHistory(moduleId, sectionId, ctx);
    case "amendments":
      if (rest.length !== 2) return notFound(`Trailing segments after .../amendments.`, ctx);
      return readSectionAmendments(moduleId, sectionId, ctx);
    default:
      return notFound(
        `Unknown sub-resource /${rest[1]} on ${sectionId}. Try /cited-by, /history, or /amendments.`,
        ctx,
      );
  }
}

function readSectionContent(moduleId: string, sectionId: string, ctx: ToolContext): ReadResult {
  const section = ctx.corpus.getSection(moduleId, sectionId);
  if (!section) {
    return notFound(`Section ${sectionId} not found in module ${moduleId}.`, ctx);
  }
  const citations: QualifiedRef[] = extractCitedRefs(section, moduleId).map((r) => ({
    module_id: r.module_id,
    section_id: r.section_id,
  }));
  return {
    ok: true,
    kind: "section",
    section: {
      module_id: moduleId,
      section_id: section.id,
      display_label: section.display_label,
      title: section.title,
      hierarchy: section.hierarchy,
      editorial_status: section.editorial_status,
      ...(section.redirect_to ? { redirect_to: section.redirect_to } : {}),
      text: section.text,
      citations,
      defined_terms: section.defined_terms,
    },
    fetched: [{ module_id: moduleId, section_id: section.id }],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readSectionCiters(moduleId: string, sectionId: string, ctx: ToolContext): ReadResult {
  const section = ctx.corpus.getSection(moduleId, sectionId);
  if (!section) {
    return notFound(`Section ${sectionId} not found in module ${moduleId}.`, ctx);
  }
  const graph = getReverseGraph(ctx.corpus);
  const citers = graph.citers(moduleId, sectionId);
  const out: CiterRef[] = citers.map((c) => ({
    module_id: c.module_id,
    section_id: c.section_id,
    display_label: c.display_label,
    title: c.title,
  }));
  return {
    ok: true,
    kind: "section-citers",
    target: { module_id: moduleId, section_id: sectionId },
    citers: out,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readSectionHistory(moduleId: string, sectionId: string, ctx: ToolContext): ReadResult {
  const section = ctx.corpus.getSection(moduleId, sectionId);
  if (!section) {
    return notFound(`Section ${sectionId} not found in module ${moduleId}.`, ctx);
  }
  const index = getOrdinanceIndex(ctx.corpus);
  const ordinances = index.bySection(moduleId, sectionId);
  const history: HistoryEntry[] = ordinances.map((ord) => ({
    year: ord.year,
    instrument_kind: "ordinance",
    instrument_number: ord.ordinance_number,
    file_number: ord.file_number,
    approved_at: ord.approved_at,
    effective_at: ord.effective_at,
  }));
  return {
    ok: true,
    kind: "section-history",
    target: { module_id: moduleId, section_id: sectionId },
    history,
    fetched: [{ module_id: moduleId, section_id: sectionId }],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function readSectionAmendments(moduleId: string, sectionId: string, ctx: ToolContext): ReadResult {
  const section = ctx.corpus.getSection(moduleId, sectionId);
  if (!section) {
    return notFound(`Section ${sectionId} not found in module ${moduleId}.`, ctx);
  }
  const index = getBillsIndex(ctx.corpus);
  const bills = index.forSection(moduleId, sectionId);
  const amendments: AmendmentRef[] = bills.map((b) => ({
    file_no: b.file_no,
    short_title: b.short_title,
    long_title: b.long_title,
    legistar_status: b.legistar_status,
    bill_status: b.bill_status,
    sponsor: b.sponsor,
    introduced_at: b.introduced_at,
    legistar_url: b.legistar_url,
  }));
  return {
    ok: true,
    kind: "section-amendments",
    target: { module_id: moduleId, section_id: sectionId },
    amendments,
    fetched: [{ module_id: moduleId, section_id: sectionId }],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

// ─── /definitions ──────────────────────────────────────────────────────────

function readDefinitions(parts: readonly string[], ctx: ToolContext): ReadResult {
  if (parts.length < 2) {
    return notFound(`Path must be /definitions/{term} — terms can contain spaces.`, ctx);
  }
  const term = parts.slice(1).join(" ");
  return findDefinitions(term, undefined, ctx);
}

function readDefinitionsInModule(moduleId: string, term: string, ctx: ToolContext): ReadResult {
  return findDefinitions(term, moduleId, ctx);
}

function findDefinitions(term: string, moduleId: string | undefined, ctx: ToolContext): ReadResult {
  const wanted = normalizeTerm(term);
  const matches: DefinitionHit[] = [];
  for (const mod of ctx.corpus.modules) {
    if (moduleId && mod.id !== moduleId) continue;
    for (const def of mod.definitions) {
      if (normalizeTerm(def.term) !== wanted) continue;
      matches.push({
        module_id: mod.id,
        section_id: def.defined_in,
        term: def.term,
        excerpt: def.excerpt,
        scope: def.scope,
      });
    }
  }
  const fetched = matches.map((m) => ({
    module_id: m.module_id,
    section_id: m.section_id,
  }));
  return {
    ok: true,
    kind: "definitions",
    term,
    ...(moduleId ? { module_id: moduleId } : {}),
    matches,
    fetched,
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

// ─── /ordinances ───────────────────────────────────────────────────────────

function readOrdinances(parts: readonly string[], ctx: ToolContext): ReadResult {
  let year: number | undefined;
  if (parts.length === 2) {
    const parsed = Number.parseInt(parts[1] as string, 10);
    if (Number.isNaN(parsed) || parsed < 1900 || parsed > 2200) {
      return notFound(`Year segment must be 1900-2200; got "${parts[1]}".`, ctx);
    }
    year = parsed;
  } else if (parts.length > 2) {
    return notFound(`Path must be /ordinances or /ordinances/{year}.`, ctx);
  }
  const index = getOrdinanceIndex(ctx.corpus);
  const result = index.recent({
    ...(year !== undefined ? { year } : {}),
    limit: HARD_CAP,
  });
  const ordinances: OrdinanceSummary[] = result.ordinances.map((ord) => ({
    ordinance_number: ord.ordinance_number,
    year: ord.year,
    file_number: ord.file_number,
    approved_at: ord.approved_at,
    effective_at: ord.effective_at,
    cited_in: ord.cited_in,
  }));
  return {
    ok: true,
    kind: "ordinances",
    total: result.total,
    ordinances,
    truncated: result.total > ordinances.length,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function splitPath(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "/") return [];
  return trimmed
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((p) => p.length > 0);
}

function findBillByFileNo(corpus: AiCorpusHandle, fileNo: string): Bill | null {
  for (const mod of corpus.modules) {
    for (const bill of mod.sessionBills) {
      if (bill.file_no === fileNo) return bill;
    }
  }
  return null;
}

function uniqueSectionIds(outcomes: readonly { section_id: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of outcomes) {
    if (seen.has(o.section_id)) continue;
    seen.add(o.section_id);
    out.push(o.section_id);
  }
  return out;
}

function byIntroducedDesc(
  a: { introduced_at: string | null; file_no: string },
  b: { introduced_at: string | null; file_no: string },
): number {
  const ai = a.introduced_at ?? "";
  const bi = b.introduced_at ?? "";
  if (ai !== bi) return bi.localeCompare(ai);
  return a.file_no.localeCompare(b.file_no);
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

type OrdinanceBlockInput =
  | { kind: "code_section_header"; number: string; title: string }
  | { kind: "subsection"; marker: string; body: readonly OrdinanceBlockInput[] }
  | { kind: "paragraph"; text: string };

function ordinanceBlocksToText(blocks: readonly OrdinanceBlockInput[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "code_section_header":
        out.push(`SEC. ${block.number}. ${block.title}`);
        break;
      case "subsection": {
        const inner = ordinanceBlocksToText(block.body);
        out.push(`(${block.marker}) ${inner}`);
        break;
      }
      case "paragraph":
        out.push(block.text);
        break;
    }
  }
  return out.join("\n\n");
}

function notFound(detail: string, ctx: ToolContext): ToolError {
  return {
    ok: false,
    reason: "not_found",
    detail,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}
