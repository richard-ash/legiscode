import { describe, expect, it } from "vitest";
import {
  buildModuleDefinitions,
  buildSectionDefinitions,
  type SectionDefinitionContext,
} from "@/parser/definitions";
import type { DefinedTermMatch } from "@/parser/defined-terms";
import type { ModuleConfig, SectionFile } from "@/types";

const module: ModuleConfig = {
  id: "sf-housing",
  name: "SF Housing",
  code_title: "Housing Code",
  module_version: "2026.05.01",
  max_skip_count: 0,
  citation_patterns: [],
  defined_term_patterns: ['"([^"]+)"\\s+means'],
};

function makeSection(overrides: Partial<SectionFile> = {}): SectionFile {
  return {
    kind: "section",
    id: "h401",
    display_label: "§ 401",
    title: "Definitions",
    text: '"Apartment" means a dwelling unit.',
    citations: [],
    defined_terms: ["Apartment"],
    hierarchy: ["Housing Code", "Preface", "Chapter 4 Definitions"],
    editorial_status: "active",
    body: [{ type: "text", text: '"Apartment" means a dwelling unit.' }],
    ...overrides,
  };
}

function makeMatch(overrides: Partial<DefinedTermMatch> = {}): DefinedTermMatch {
  return {
    term: "Apartment",
    start: 1,
    end: 10,
    pattern_kind: "quoted-means",
    full_match_end: 17,
    ...overrides,
  };
}

describe("buildSectionDefinitions", () => {
  it("produces one Definition per unique term match", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection(),
      matches: [makeMatch()],
      globalDefinerSections: new Set(),
    };
    const defs = buildSectionDefinitions(ctx);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.term).toBe("Apartment");
    expect(defs[0]?.defined_in).toBe("h401");
    expect(defs[0]?.id).toMatch(/^sf-housing\/h401#[0-9a-f]{8}$/);
  });

  it("body_anchor points at the term position in section.text", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection(),
      matches: [makeMatch({ start: 1, end: 10 })],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.body_anchor).toEqual({ start: 1, end: 10 });
    // Term-substring invariant: text.slice(start, end) === term
    expect(makeSection().text.slice(1, 10)).toBe("Apartment");
  });

  it("excerpt is the paragraph containing the defining clause", () => {
    const text = "Some intro paragraph.\n\"Apartment\" means a dwelling unit.\nMore text after.";
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection({ text }),
      matches: [makeMatch({ start: 23, end: 32, full_match_end: 39 })],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.excerpt).toBe('"Apartment" means a dwelling unit.');
  });

  it("excerpt truncates long paragraphs with an ellipsis", () => {
    const longParagraph = `"Apartment" means ${"a very long description ".repeat(40)}.`;
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection({ text: longParagraph }),
      matches: [makeMatch({ start: 1, end: 10, full_match_end: 17 })],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.excerpt.endsWith("…")).toBe(true);
    expect(def?.excerpt.length).toBeLessThanOrEqual(500);
  });

  it("default scope is hierarchy with the definer's full chain", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection(),
      matches: [makeMatch()],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.scope).toEqual({
      kind: "hierarchy",
      prefix: ["Housing Code", "Preface", "Chapter 4 Definitions"],
    });
  });

  it("manifest-declared global definer sections emit module scope", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection({ id: "a-100" }),
      matches: [makeMatch()],
      globalDefinerSections: new Set(["a-100"]),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.scope).toEqual({ kind: "module" });
    expect(def?.extracted_by).toBe("manifest:declared-global");
  });

  it("non-global sections take extracted_by from the match's pattern_kind", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection(),
      matches: [makeMatch({ pattern_kind: "shall-mean" })],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.extracted_by).toBe("amlegal:pattern:shall-mean");
  });

  it("collapses same-term duplicates within a section, keeping the first match", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection({
        text: '"Apartment" means X. "Apartment" means Y.',
      }),
      matches: [
        makeMatch({ start: 1, end: 10, full_match_end: 17 }),
        makeMatch({ start: 22, end: 31, full_match_end: 38 }),
      ],
      globalDefinerSections: new Set(),
    };
    const defs = buildSectionDefinitions(ctx);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.body_anchor).toEqual({ start: 1, end: 10 });
  });

  it("canonicalizes the term and trims body_anchor when the raw capture has surrounding whitespace", () => {
    // Source text where the quote-bounded capture spans a soft line break:
    //
    //   …"
    //   Approval
    //   " means…
    //
    // The extractor returns term="\nApproval\n" with start/end covering
    // the full 10-char span. The Definition.term must canonicalize to
    // "Approval" (schema-clean), and body_anchor must shift inward so the
    // build-body-segments scanner's \bApproval\b hit aligns for self-
    // suppression.
    const text = 'Intro paragraph.\n"\nApproval\n" means a permit.\n';
    const rawStart = text.indexOf("\nApproval\n");
    const rawEnd = rawStart + "\nApproval\n".length;
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection({ text }),
      matches: [
        makeMatch({
          term: "\nApproval\n",
          start: rawStart,
          end: rawEnd,
          full_match_end: text.indexOf(" means") + " means".length,
        }),
      ],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    expect(def?.term).toBe("Approval");
    expect(def?.body_anchor.start).toBe(rawStart + 1);
    expect(def?.body_anchor.end).toBe(rawEnd - 1);
    expect(text.slice(def?.body_anchor.start, def?.body_anchor.end)).toBe("Approval");
  });

  it("collapses same-section duplicates that differ only in whitespace", () => {
    // Two raw matches: "Approval " (trailing space) and "\nApproval\n"
    // (newline-bracketed). Both canonicalize to "Approval"; dedup must
    // keep only the first.
    const text = 'Approval is one. "\nApproval\n" means another.';
    const firstStart = 0;
    const secondStart = text.indexOf("\nApproval\n");
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection({ text }),
      matches: [
        makeMatch({
          term: "Approval ",
          start: firstStart,
          end: firstStart + "Approval ".length,
          full_match_end: firstStart + "Approval is one.".length,
        }),
        makeMatch({
          term: "\nApproval\n",
          start: secondStart,
          end: secondStart + "\nApproval\n".length,
          full_match_end: text.indexOf(" means") + " means".length,
        }),
      ],
      globalDefinerSections: new Set(),
    };
    const defs = buildSectionDefinitions(ctx);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.term).toBe("Approval");
    expect(defs[0]?.body_anchor.start).toBe(firstStart);
    expect(defs[0]?.body_anchor.end).toBe(firstStart + "Approval".length);
  });

  it("hierarchy prefix is a defensive copy (mutating definition.scope doesn't leak)", () => {
    const ctx: SectionDefinitionContext = {
      moduleId: "sf-housing",
      section: makeSection(),
      matches: [makeMatch()],
      globalDefinerSections: new Set(),
    };
    const def = buildSectionDefinitions(ctx)[0];
    if (def?.scope.kind === "hierarchy") {
      def.scope.prefix.push("MUTATED");
    }
    expect(makeSection().hierarchy).toEqual([
      "Housing Code",
      "Preface",
      "Chapter 4 Definitions",
    ]);
  });
});

describe("buildModuleDefinitions", () => {
  it("aggregates Definition[] across sections, sorted by id", () => {
    const sectionA = makeSection({ id: "h401" });
    const sectionB = makeSection({ id: "h402", text: '"Tenant" means a person.' });
    const defs = buildModuleDefinitions(module, [
      {
        moduleId: "sf-housing",
        section: sectionA,
        matches: [makeMatch({ term: "Apartment" })],
        globalDefinerSections: new Set(),
      },
      {
        moduleId: "sf-housing",
        section: sectionB,
        matches: [makeMatch({ term: "Tenant", start: 1, end: 7, full_match_end: 14 })],
        globalDefinerSections: new Set(),
      },
    ]);
    expect(defs).toHaveLength(2);
    const sorted = [...defs.map((d) => d.id)].sort();
    expect(defs.map((d) => d.id)).toEqual(sorted);
  });

  it("rejects module-wide duplicate ids (extractor bug detection)", () => {
    // Forcing a duplicate by passing the same section twice. Same
    // (module, section, term) → same id, which is invalid at module
    // scope.
    const section = makeSection({ id: "h401" });
    expect(() =>
      buildModuleDefinitions(module, [
        {
          moduleId: "sf-housing",
          section,
          matches: [makeMatch()],
          globalDefinerSections: new Set(),
        },
        {
          moduleId: "sf-housing",
          section,
          matches: [makeMatch()],
          globalDefinerSections: new Set(),
        },
      ]),
    ).toThrow(/duplicate Definition\.id/);
  });
});
