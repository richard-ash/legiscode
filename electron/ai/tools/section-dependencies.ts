// /modules/{m}/sections/{s}/dependencies — composed dependency picture.
// One read replacing the separate cited-by, amendments, article, and
// definition lookups a "what connects to § X" question used to take.
//
// Everything here is assembled from indexes that already exist:
// outbound cites from the section's own citations, inbound citers from
// the reverse graph, definitions from the module definition lists,
// siblings from the article index, pending bills from the bills index.
//
// Fetch semantics match /history and /amendments: the target section
// counts as fetched; citers and siblings are listings and do not — the
// model still reads any section it wants to cite (N18).

import { getBillsIndex } from "../bills-index";
import { extractCitedRefs, getReverseGraph } from "../reverse-index";
import { normalizeTerm, type ToolContext } from "./read";
import type {
  AmendmentRef,
  DependencyCitation,
  DependencyDefinedTerm,
  ReadResult,
  SectionDependenciesPayload,
  ToolError,
} from "./types";

export function buildSectionDependencies(
  moduleId: string,
  sectionId: string,
  ctx: ToolContext,
): ReadResult {
  const section = ctx.corpus.getSection(moduleId, sectionId);
  if (!section) {
    return notFound(`Section ${sectionId} not found in module ${moduleId}.`, ctx);
  }

  const outbound: DependencyCitation[] = extractCitedRefs(section, moduleId).map((ref) => {
    const target = ctx.corpus.getSection(ref.module_id, ref.section_id);
    return {
      module_id: ref.module_id,
      section_id: ref.section_id,
      installed: target !== null,
      path: target ? `/modules/${ref.module_id}/sections/${target.id}` : null,
      display_label: target?.display_label ?? null,
      title: target?.title ?? null,
    };
  });

  const inbound = getReverseGraph(ctx.corpus)
    .citers(moduleId, sectionId)
    .map((c) => ({
      module_id: c.module_id,
      section_id: c.section_id,
      display_label: c.display_label,
      title: c.title,
      path: `/modules/${c.module_id}/sections/${c.section_id}`,
    }));

  const definedTermsUsed: DependencyDefinedTerm[] = section.defined_terms.map((term) => {
    const wanted = normalizeTerm(term);
    const definedIn: { module_id: string; section_id: string; path: string }[] = [];
    for (const mod of ctx.corpus.modules) {
      for (const def of mod.definitions) {
        if (normalizeTerm(def.term) !== wanted) continue;
        definedIn.push({
          module_id: mod.id,
          section_id: def.defined_in,
          path: `/modules/${mod.id}/sections/${def.defined_in}`,
        });
      }
    }
    return { term, defined_in: definedIn };
  });

  let article: SectionDependenciesPayload["article"] = null;
  if (section.article) {
    const mod = ctx.corpus.modules.find((m) => m.id === moduleId);
    const wanted = section.article.id.toLowerCase();
    const entry = mod?.articles.find((a) => a.id.toLowerCase() === wanted);
    if (entry) {
      article = {
        article_id: entry.id,
        title: entry.title,
        parents: entry.parents,
        siblings: entry.sections
          .filter((s) => s.section_id !== section.id)
          .map((s) => ({
            section_id: s.section_id,
            display_label: s.display_label,
            title: s.title,
            editorial_status: s.editorial_status,
            path: `/modules/${moduleId}/sections/${s.section_id}`,
          })),
      };
    }
  }

  const pendingBills: AmendmentRef[] = getBillsIndex(ctx.corpus)
    .forSection(moduleId, sectionId)
    .map((b) => ({
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
    kind: "section-dependencies",
    dependencies: {
      module_id: moduleId,
      section_id: section.id,
      display_label: section.display_label,
      title: section.title,
      editorial_status: section.editorial_status,
      outbound_citations: outbound,
      inbound_citers: inbound,
      defined_terms_used: definedTermsUsed,
      article,
      pending_bills: pendingBills,
    },
    fetched: [{ module_id: moduleId, section_id: section.id }],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
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
