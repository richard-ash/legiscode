// Shared CorpusSectionView builder for the section-view subdirectory tests.
// SectionId/ModuleId/AppendixId are plain string types, not branded — no
// runtime parse needed inside renderer tests.

import type { CorpusSectionView } from "@/corpus/wire";
import type { BodySegment, Citation, SectionFile } from "@/types";

export function buildCorpusSectionView(
  overrides: {
    moduleId?: string;
    section?: Partial<SectionFile>;
    parents?: CorpusSectionView["parents"];
    definitions?: CorpusSectionView["definitions"];
  } = {},
): CorpusSectionView {
  const moduleId = overrides.moduleId ?? "sf-port";
  const sectionDefaults: SectionFile = {
    kind: "section",
    id: "1.1",
    display_label: "1.1",
    title: "Definitions",
    text: "",
    citations: [],
    defined_terms: [],
    hierarchy: ["Port Code", "Article 1"],
    editorial_status: "active",
    body: [],
    article: null,
  };
  return {
    moduleId,
    section: { ...sectionDefaults, ...overrides.section },
    parents: overrides.parents ?? [
      { code: "Port Code", name: "Port Code", sectionId: null },
      { code: "Article 1", name: "", sectionId: "1.1" },
    ],
    prev: null,
    next: null,
    definitions: overrides.definitions ?? {},
  };
}

export function bodyText(text: string): BodySegment {
  return { kind: "text", text };
}
export function bodyParaBreak(): BodySegment {
  return { kind: "paragraph_break" };
}
export function bodyCitation(raw: string, citation_index: number): BodySegment {
  return { kind: "citation", raw, citation_index };
}
// Post-L2b every defined_term segment carries a def_id and raw. The
// `term` argument is the canonical-term shorthand used to derive a
// stable test def_id (and the default raw when no override is given);
// it doesn't appear on the emitted segment because the schema removed
// the legacy term field.
export function bodyDefinedTerm(
  term: string,
  opts: { defId?: string; raw?: string } = {},
): BodySegment {
  return {
    kind: "defined_term",
    raw: opts.raw ?? term,
    def_id: opts.defId ?? testDefId(term),
  };
}

// Stable def_id helper for renderer fixtures. Mirrors the parser's
// canonical id format without importing the runtime parser code into a
// renderer test (keeps the test surface minimal).
export function testDefId(term: string): string {
  return `sf-test/test-def#${sha8Hex(term)}`;
}

// Tiny pure-JS sha8 helper for test fixtures — avoids importing node:crypto
// (some renderer tests run in jsdom). Polyfill-grade FNV-1a 32-bit twice
// is enough for fixture stability; collisions don't matter inside test
// vocabulary.
function sha8Hex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(4, "0") + h2.toString(16).padStart(4, "0")).slice(0, 8);
}

// Build a DefinitionView fixture for renderer tests. Mirrors the wire
// shape the loader projects via joinDefinitionsForSection.
export function testDefinitionView(
  term: string,
  opts: { excerpt?: string; first_use_section?: string } = {},
): CorpusSectionView["definitions"][string] {
  return {
    term,
    excerpt: opts.excerpt ?? `"${term}" means a thing.`,
    scope: { kind: "module" },
    first_use_section: opts.first_use_section ?? "test-def",
  };
}
export function bodySubsectionLabel(label: string): BodySegment {
  return { kind: "subsection_label", label };
}
export function bodyFormat(
  style: "bold" | "italic" | "list" | "listItem",
  children: BodySegment[],
): BodySegment {
  return { kind: "format", style, children };
}

export function citationInternal(display_text: string, section_id: string): Citation {
  return { display_text, target: { kind: "internal", section_id } };
}
export function citationCrossModule(
  display_text: string,
  module_id: string,
  section_id: string,
): Citation {
  return {
    display_text,
    target: { kind: "cross_module", module_id, section_id },
  };
}
export function citationStructural(
  display_text: string,
  level: "article" | "chapter" | "division" | "title",
  number: string,
): Citation {
  return { display_text, target: { kind: "structural", level, number } };
}
export function citationVague(display_text: string, raw: string): Citation {
  return { display_text, target: { kind: "vague", raw } };
}
export function citationInternalAppendix(display_text: string, appendix_id: string): Citation {
  return {
    display_text,
    target: { kind: "internal_appendix", appendix_id },
  };
}
