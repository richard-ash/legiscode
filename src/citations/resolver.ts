// Citation resolution primitive. Pure function: given a citation and an
// existence oracle, return a discriminated `ResolutionResult` that the
// navigate seam (src/workbench/navigate.ts) consumes.
//
// Phase 3 — the runtime collapses to a single titleMap dereference once
// the citation target is a section-ref. Legacy internal / cross_module
// branches stay because Phase 2's transitional disk shape can still
// carry them for cites the binder couldn't bind; Phase 4 makes those
// branches unreachable from committed corpus data by failing the build
// on any unbindable cite. After Phase 4 the resolver could drop the
// legacy branches entirely; until then they remain as defense in depth.
//
// Verb-shaped result kinds per design D2 — consumers switch on
// `result.kind`, NOT on `citation.target.kind`. The branch between
// citation kinds lives once, here.
//
// Result kinds cover every UX outcome the dispatcher needs:
//   navigate-section     — open or activate a section tab
//   navigate-appendix    — open the appendix viewer (v1.1)
//   navigate-structural  — navigate to the structural node (TOC + first
//                          section under Article / Chapter / Division /
//                          Title)
//   module-not-installed — popover shows "{displayName} not downloaded";
//                          ⌘-click is a no-op (decided 2026-05-20)
//   scroll-only          — same-section subsection ref; scroll within
//                          the active tab instead of duplicating it
//   unresolvable         — bug fallback. With the Phase 4 gate in place
//                          section-not-found should never fire from
//                          committed corpus data; the renderer logs as
//                          console.error so dev catches drift.

import { type CorpusRef, parse as parseRef } from "@/corpus/refs";
import type { AppendixId, ModuleId } from "@/types";
import type { Citation, StructuralLevel } from "@/types/citation";
import { getModule } from "./module-registry";

export type ResolutionResult =
  | { kind: "navigate-section"; ref: CorpusRef; subsection?: string }
  | { kind: "navigate-appendix"; module: ModuleId; appendixId: AppendixId }
  | {
      kind: "navigate-structural";
      ref: CorpusRef;
      level: StructuralLevel;
      number: string;
    }
  | {
      kind: "module-not-installed";
      moduleId: ModuleId;
      displayName: string;
      label: string;
    }
  | { kind: "scroll-only"; subsection: string }
  | { kind: "unresolvable"; reason: UnresolvableReason };

export type UnresolvableReason =
  | "section-not-found"
  | "structural-not-found"
  | "vague-target"
  | "invalid-ref";

// Existence oracle. The renderer builds this once per corpus snapshot
// from App.tsx's titleMap + active tab, then feeds it to resolve()
// alongside each citation. resolve() does no IO and no React work.
//
// titleMap covers tree section leaves only — appendices and non-tree
// sections fall through. That's acceptable because internal /
// cross_module targets reference tree sections; appendix lookups skip
// the existence check (their data path is the appendix viewer's, not the
// section reader's).
export interface CorpusExistence {
  readonly citingModule: ModuleId;
  readonly installedModules: ReadonlySet<ModuleId>;
  /** CorpusRef of the section currently displayed; null when no tab is active. */
  readonly activeSection: CorpusRef | null;
  hasSection(module: string, section: string): boolean;
  /**
   * Look up a structural node (Article / Chapter / Division / Title) in
   * the citing module's tree by level + number. Returns a CorpusRef to a
   * representative section under that node (typically the first one), or
   * null when no matching node exists.
   */
  findStructural(level: StructuralLevel, number: string): CorpusRef | null;
}

export function resolve(citation: Citation, corpus: CorpusExistence): ResolutionResult {
  const target = citation.target;
  switch (target.kind) {
    case "internal":
      return resolveInternal(target, corpus);
    case "cross_module":
      return resolveCrossModule(citation, target, corpus);
    case "section-ref":
      return resolveSectionRef(citation, target, corpus);
    case "structural":
      return resolveStructural(target, corpus);
    case "vague":
      return { kind: "unresolvable", reason: "vague-target" };
    case "internal_appendix":
      return {
        kind: "navigate-appendix",
        module: corpus.citingModule,
        appendixId: target.appendix_id,
      };
  }
}

function resolveInternal(
  target: Extract<Citation["target"], { kind: "internal" }>,
  corpus: CorpusExistence,
): ResolutionResult {
  // Same-section subsection ref → scroll inside the active tab (decided
  // 2026-05-20: avoid opening a duplicate tab when the cite anchors back
  // to its own section).
  if (
    target.subsection &&
    !target.range &&
    corpus.activeSection &&
    corpus.activeSection.module === corpus.citingModule &&
    corpus.activeSection.section === target.section_id
  ) {
    return { kind: "scroll-only", subsection: target.subsection };
  }
  if (!corpus.hasSection(corpus.citingModule, target.section_id)) {
    return { kind: "unresolvable", reason: "section-not-found" };
  }
  return makeNavigateSection(
    corpus.citingModule,
    target.section_id,
    target.subsection,
    target.range,
  );
}

function resolveCrossModule(
  citation: Citation,
  target: Extract<Citation["target"], { kind: "cross_module" }>,
  corpus: CorpusExistence,
): ResolutionResult {
  if (!corpus.installedModules.has(target.module_id)) {
    const entry = getModule(target.module_id);
    return {
      kind: "module-not-installed",
      moduleId: target.module_id,
      displayName: entry?.display_name ?? target.module_id,
      label: citation.display_text,
    };
  }
  if (!corpus.hasSection(target.module_id, target.section_id)) {
    return { kind: "unresolvable", reason: "section-not-found" };
  }
  return makeNavigateSection(target.module_id, target.section_id, target.subsection, target.range);
}

// Phase 1 stub: section-ref targets only appear after the build-time
// binder lands in Phase 2 and the parser starts emitting them in Phase 3.
// The runtime contract — single titleMap lookup, no prefix-guessing — is
// what Phase 3 fleshes out. Until then, this branch is unreachable from
// committed corpus data; the schema admits the variant so downstream
// commits can populate it without a schema-level reshape.
function resolveSectionRef(
  citation: Citation,
  target: Extract<Citation["target"], { kind: "section-ref" }>,
  corpus: CorpusExistence,
): ResolutionResult {
  if (!corpus.installedModules.has(target.module_id)) {
    const entry = getModule(target.module_id);
    return {
      kind: "module-not-installed",
      moduleId: target.module_id,
      displayName: entry?.display_name ?? target.module_id,
      label: citation.display_text,
    };
  }
  if (!corpus.hasSection(target.module_id, target.anchor_id)) {
    return { kind: "unresolvable", reason: "section-not-found" };
  }
  return makeNavigateSection(target.module_id, target.anchor_id, target.subsection, target.range);
}

function resolveStructural(
  target: Extract<Citation["target"], { kind: "structural" }>,
  corpus: CorpusExistence,
): ResolutionResult {
  const ref = corpus.findStructural(target.level, target.number);
  if (!ref) {
    return { kind: "unresolvable", reason: "structural-not-found" };
  }
  return { kind: "navigate-structural", ref, level: target.level, number: target.number };
}

function makeNavigateSection(
  module: ModuleId,
  section: string,
  subsection: string | undefined,
  range: { from: string; to: string } | undefined,
): ResolutionResult {
  let ref: CorpusRef;
  try {
    ref = parseRef({ module, section });
  } catch {
    return { kind: "unresolvable", reason: "invalid-ref" };
  }
  // Range citations land at range.from with no subsection scroll
  // (design D7) — subsection on a ranged citation is structurally
  // invalid via the schema's refine, but defend in depth.
  if (range) return { kind: "navigate-section", ref };
  return subsection
    ? { kind: "navigate-section", ref, subsection }
    : { kind: "navigate-section", ref };
}
