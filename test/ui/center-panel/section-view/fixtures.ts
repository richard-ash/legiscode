// Shared CorpusSectionView builder for the section-view subdirectory tests.
// SectionId/ModuleId/AppendixId are plain string types, not branded — no
// runtime parse needed inside renderer tests.

import type { CorpusSectionView } from "@/corpus/wire";
import type { BodySegment, Citation, SectionFile } from "@/types";

export function buildCorpusSectionView(
  overrides: {
    moduleId?: string;
    section?: Partial<SectionFile>;
    parents?: ReadonlyArray<{ code: string; name: string }>;
    definitions?: CorpusSectionView["definitions"];
  } = {},
): CorpusSectionView {
  const moduleId = overrides.moduleId ?? "sf-port";
  const sectionDefaults: SectionFile = {
    kind: "section",
    id: "1.1",
    title: "Definitions",
    text: "",
    citations: [],
    defined_terms: [],
    hierarchy: ["Port Code", "ARTICLE 1"],
    editorial_status: "active",
    body: [],
  };
  return {
    moduleId,
    section: { ...sectionDefaults, ...overrides.section },
    parents: overrides.parents ?? [
      { code: "Port Code", name: "Port Code" },
      { code: "ARTICLE 1", name: "" },
    ],
    prev: null,
    next: null,
    definitions: overrides.definitions ?? {},
  };
}

export function bodyText(text: string): BodySegment {
  return { type: "text", text };
}
export function bodyParaBreak(): BodySegment {
  return { type: "paragraph_break" };
}
export function bodyCitation(raw: string, citation_index: number): BodySegment {
  return { type: "citation", raw, citation_index };
}
export function bodyDefinedTerm(term: string): BodySegment {
  return { type: "defined_term", term };
}
export function bodySubsectionLabel(label: string): BodySegment {
  return { type: "subsection_label", label };
}
export function bodyFormat(
  style: "bold" | "italic" | "list" | "listItem",
  children: BodySegment[],
): BodySegment {
  return { type: "format", style, children };
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
export function citationExternal(display_text: string, raw: string): Citation {
  return { display_text, target: { kind: "external", raw } };
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
