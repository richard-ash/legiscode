// Binder + display-rules + suffix-form / multi-code / alpha-suffix
// extractor tests. Covers the four canonical p109 bug cases the
// refoundation chapter was opened to fix:
//
//   #1: "Section 102A of the Building Code" — suffix-form code phrase
//       sits AFTER the cite. Old extractor missed it. Bug A.
//   #2: "Section 109.0" (no code phrase) — internal cite to sf-plumbing's
//       p109 anchor; the trailing ".0" must strip during candidate
//       generation so "109.0" binds to "p109".
//   #3: "Section 102A of the Building Code" — alpha suffix "A" must
//       survive the regex (Bug B) so the candidate is "b102a" not "b102".
//   #4: "Section 110A, Table 1A-K — Penalties, Hearings — of the
//        Building Code" — suffix phrase sits ~10 words after the cite
//        with em-dash clauses between. Same Bug A, harder version.
//
// Multi-code paragraph correctness is tested separately (each cite
// scopes to its own nearest phrase, not the last-seen one).
//
// Display-rules unit tests live alongside because the binder's behavior
// is meaningful only with the candidates-for shape it consumes.

import { describe, expect, it } from "vitest";
import { type BindContext, bindCitation, buildAnchorIndex } from "@/parser/binder";
import { extractCitations } from "@/parser/citations";
import { candidatesFor } from "@/parser/display-rules";
import type { Citation, DisplayRules, ModuleConfig } from "@/types";

const CITATION_PATTERN =
  "(?:§§?|\\bSections?\\b|\\bSec\\.|\\bArticles?\\b|\\bChapters?\\b|\\bDivisions?\\b|\\bTitles?\\b|\\bsubsections?\\b|\\bsubdivisions?\\b)\\s*(?:\\d+(?:\\.\\d+)*[A-Za-z]?(?:\\([a-z0-9]+\\))*(?:-\\d+(?:\\.\\d+)*[A-Za-z]?)?|\\([a-z0-9]+\\)(?:\\([a-z0-9]+\\))*)";

function makeModule(id: string, code_title: string, display_rules?: DisplayRules): ModuleConfig {
  return {
    id,
    name: code_title,
    code_title,
    jd_anchor: id.replace(/^sf-/, "").replace(/^./, (c) => c.toUpperCase()),
    module_version: "2026.05.20",
    max_skip_count: 0,
    citation_patterns: [CITATION_PATTERN],
    defined_term_patterns: ['"([^"]+)"\\s+means'],
    ...(display_rules ? { display_rules } : {}),
  };
}

const sfPlumbing = makeModule("sf-plumbing", "Plumbing Code", {
  prefix: "p",
  extra_prefixes: [],
  alpha_suffix: false,
  strip_trailing_zero: true,
  override_regex: null,
});

const sfBuilding = makeModule("sf-building", "Building Code", {
  prefix: "b",
  extra_prefixes: ["g"],
  alpha_suffix: true,
  strip_trailing_zero: false,
  override_regex: null,
});

const sfPolice = makeModule("sf-police", "Police Code");
const sfCharter = makeModule("sf-charter", "Charter", {
  prefix: null,
  extra_prefixes: ["a", "d"],
  alpha_suffix: false,
  strip_trailing_zero: false,
  override_regex: null,
});

const allModules = [sfPlumbing, sfBuilding, sfPolice, sfCharter];

// ─── display-rules candidate generation ─────────────────────────────────────

describe("candidatesFor", () => {
  it("returns bare lookup when no rules are provided", () => {
    expect(candidatesFor("102")).toEqual(["102"]);
  });

  it("applies prefix as the primary candidate", () => {
    const cs = candidatesFor("109", sfPlumbing.display_rules);
    // strip_trailing_zero adds the inverse form too, so "109" generates
    // p109, p109.0, 109, 109.0.
    expect(cs).toContain("p109");
    expect(cs[0]).toBe("p109");
  });

  it("tries both '<x>' and '<x>.0' when strip_trailing_zero is true", () => {
    const cs = candidatesFor("109.0", sfPlumbing.display_rules);
    expect(cs).toContain("p109");
    expect(cs).toContain("p109.0");
  });

  it("preserves alpha suffix in the candidate when present in the ref", () => {
    const cs = candidatesFor("102A", sfBuilding.display_rules);
    expect(cs).toContain("b102a");
  });

  it("emits extra-prefix candidates after the primary prefix", () => {
    const cs = candidatesFor("4.201", sfBuilding.display_rules);
    expect(cs).toContain("b4.201");
    expect(cs).toContain("g4.201");
    expect(cs.indexOf("b4.201")).toBeLessThan(cs.indexOf("g4.201"));
  });

  it("emits bare + extra-prefix candidates when prefix is null (sf-charter)", () => {
    const cs = candidatesFor("8.559", sfCharter.display_rules);
    expect(cs).toContain("8.559");
    expect(cs).toContain("a8.559");
    expect(cs).toContain("d8.559");
  });

  it("orders bare BEFORE extra-prefix candidates so appendix anchors don't preempt the main code", () => {
    // sf-charter has extra_prefixes ['a','d']. The bare form must come
    // first; otherwise a cite like "Section 8.559" would bind to
    // appendix anchor a8.559 whenever both bare 8.559 and a8.559 exist
    // in the charter module (real case for the appendix overlay).
    const cs = candidatesFor("8.559", sfCharter.display_rules);
    expect(cs.indexOf("8.559")).toBeLessThan(cs.indexOf("a8.559"));
    expect(cs.indexOf("8.559")).toBeLessThan(cs.indexOf("d8.559"));
  });

  it("orders bare BEFORE extra-prefix even when a primary prefix is set (sf-building)", () => {
    // For sf-building (prefix: 'b', extra_prefixes: ['g']) candidate
    // order is: b4.201, 4.201, g4.201 — the primary 'b' prefix still
    // wins because the cite text drops it, but bare beats the 'g'
    // green-building appendix.
    const cs = candidatesFor("4.201", sfBuilding.display_rules);
    expect(cs.indexOf("b4.201")).toBeLessThan(cs.indexOf("4.201"));
    expect(cs.indexOf("4.201")).toBeLessThan(cs.indexOf("g4.201"));
  });

  it("uses override_regex group 1 as an additional candidate", () => {
    const rules: DisplayRules = {
      prefix: null,
      extra_prefixes: [],
      alpha_suffix: false,
      strip_trailing_zero: false,
      override_regex: "^article-(.+)$",
    };
    expect(candidatesFor("article-5", rules)).toContain("5");
  });
});

// ─── binder rewriting ──────────────────────────────────────────────────────

describe("bindCitation", () => {
  function makeCtx(
    citingModuleId: string,
    anchors: Record<string, readonly string[]>,
    rules: Record<string, DisplayRules | undefined>,
  ): BindContext {
    const anchorsByModule = new Map(
      Object.entries(anchors).map(([id, list]) => [id, buildAnchorIndex([], list)]),
    );
    const rulesByModule = new Map(Object.entries(rules));
    return { citingModuleId, anchorsByModule, rulesByModule };
  }

  it("rewrites an intra-module internal target to section-ref when it binds", () => {
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109", "p110"] },
      { "sf-plumbing": sfPlumbing.display_rules },
    );
    const before: Citation = {
      display_text: "Section 109.0",
      target: { kind: "internal", section_id: "109.0" },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "p109",
      module_id: "sf-plumbing",
    });
  });

  it("rewrites a cross_module target when the binder hits in the target module", () => {
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109"], "sf-building": ["b102a", "b110a"] },
      {
        "sf-plumbing": sfPlumbing.display_rules,
        "sf-building": sfBuilding.display_rules,
      },
    );
    const before: Citation = {
      display_text: "Section 102A",
      target: { kind: "cross_module", module_id: "sf-building", section_id: "102a" },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "b102a",
      module_id: "sf-building",
    });
  });

  it("reclassifies an unbindable internal target as vague (Phase 4)", () => {
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109"] },
      { "sf-plumbing": sfPlumbing.display_rules },
    );
    const before: Citation = {
      display_text: "Section 999",
      target: { kind: "internal", section_id: "999" },
    };
    const after = bindCitation(before, ctx);
    // D9: vague reclass preserves the original target so the validator
    // can bucket the cite by reason (here: vague_no_anchor).
    expect(after.target).toEqual({
      kind: "vague",
      raw: "Section 999",
      source_target: { kind: "internal", section_id: "999" },
    });
  });

  it("sibling fallback: internal cite resolves against the one sibling module that has it", () => {
    const ctx = makeCtx(
      "sf-administrative",
      {
        "sf-administrative": ["1.1"],
        "sf-charter": ["8.509"],
      },
      {
        "sf-administrative": undefined,
        "sf-charter": sfCharter.display_rules,
      },
    );
    const before: Citation = {
      display_text: "Section 8.509",
      target: { kind: "internal", section_id: "8.509" },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "8.509",
      module_id: "sf-charter",
    });
  });

  it("sibling fallback preserves the range upper bound", () => {
    // The direct tryBind path binds ranges; the sibling fallback must
    // mirror it, otherwise a ranged internal cite that resolves through
    // a sibling silently loses its upper bound.
    const ctx = makeCtx(
      "sf-administrative",
      {
        "sf-administrative": ["1.1"],
        "sf-charter": ["8.500", "8.509"],
      },
      {
        "sf-administrative": undefined,
        "sf-charter": sfCharter.display_rules,
      },
    );
    const before: Citation = {
      display_text: "Sections 8.500-8.509",
      target: {
        kind: "internal",
        section_id: "8.500",
        range: { from: "8.500", to: "8.509" },
      },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "8.500",
      module_id: "sf-charter",
      range: { from: "8.500", to: "8.509" },
    });
  });

  it("sibling fallback bails out when multiple modules match (ambiguous)", () => {
    const ctx = makeCtx(
      "sf-administrative",
      {
        "sf-administrative": ["1.1"],
        "sf-charter": ["8.509"],
        "sf-planning": ["8.509"],
      },
      {
        "sf-administrative": undefined,
        "sf-charter": sfCharter.display_rules,
        "sf-planning": undefined,
      },
    );
    const before: Citation = {
      display_text: "Section 8.509",
      target: { kind: "internal", section_id: "8.509" },
    };
    const after = bindCitation(before, ctx);
    // Ambiguous → reclassified as vague rather than guessing. D9
    // source_target preserved so the validator can bucket the cite.
    expect(after.target).toEqual({
      kind: "vague",
      raw: "Section 8.509",
      source_target: { kind: "internal", section_id: "8.509" },
    });
  });

  it("leaves a cross_module target intact when the target module is not in this build", () => {
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109"] },
      { "sf-plumbing": sfPlumbing.display_rules },
    );
    const before: Citation = {
      display_text: "Cal. Veh. Code § 22358",
      target: { kind: "cross_module", module_id: "ca-vehicle", section_id: "22358" },
    };
    const after = bindCitation(before, ctx);
    expect(after).toBe(before);
  });

  it("prefers bare charter section over appendix-prefix candidate when both exist", () => {
    // Codex-flagged [P1]: with sf-charter's `a`/`d` appendix prefixes,
    // a normal cite "Section 8.559" must bind to the bare charter
    // anchor 8.559 (when present), not to appendix anchor a8.559. The
    // candidate-order regression test above covers the unit; this one
    // wires the binder end-to-end against an anchor index containing
    // both forms.
    const ctx = makeCtx(
      "sf-charter",
      { "sf-charter": ["a8.559", "8.559", "d8.559"] },
      { "sf-charter": sfCharter.display_rules },
    );
    const before: Citation = {
      display_text: "Section 8.559",
      target: { kind: "internal", section_id: "8.559" },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "8.559",
      module_id: "sf-charter",
    });
  });

  it("falls back to extra_prefix only when bare anchor is absent", () => {
    // If bare 8.559 doesn't exist, the appendix anchor a8.559 wins —
    // that's the original reason extra_prefixes shipped. Verifies the
    // ordering fix doesn't break the bona fide appendix-cite case.
    const ctx = makeCtx(
      "sf-charter",
      { "sf-charter": ["a8.559"] },
      { "sf-charter": sfCharter.display_rules },
    );
    const before: Citation = {
      display_text: "Section 8.559",
      target: { kind: "internal", section_id: "8.559" },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "a8.559",
      module_id: "sf-charter",
    });
  });

  it("preserves the raw upper bound of a range when the to-anchor does not bind", () => {
    // Codex-flagged [P2]: collapsing range.to to the bound from-anchor
    // discards the citation's actual upper bound. Even when navigation
    // lands at range.from for v1, downstream resolver/display code
    // needs the original `to` to recover the range later.
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109"] },
      { "sf-plumbing": sfPlumbing.display_rules },
    );
    const before: Citation = {
      display_text: "Sections 109.0-109.5",
      target: {
        kind: "internal",
        section_id: "109.0",
        range: { from: "109.0", to: "109.5" },
      },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "p109",
      module_id: "sf-plumbing",
      range: { from: "p109", to: "109.5" },
    });
  });

  it("binds both ends of a range when both anchors exist in the target module", () => {
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109", "p110"] },
      { "sf-plumbing": sfPlumbing.display_rules },
    );
    const before: Citation = {
      display_text: "Sections 109.0-110.0",
      target: {
        kind: "internal",
        section_id: "109.0",
        range: { from: "109.0", to: "110.0" },
      },
    };
    const after = bindCitation(before, ctx);
    expect(after.target).toEqual({
      kind: "section-ref",
      anchor_id: "p109",
      module_id: "sf-plumbing",
      range: { from: "p109", to: "p110" },
    });
  });

  it("passes through structural, vague, and internal_appendix targets unchanged", () => {
    const ctx = makeCtx(
      "sf-plumbing",
      { "sf-plumbing": ["p109"] },
      { "sf-plumbing": sfPlumbing.display_rules },
    );
    for (const target of [
      { kind: "structural" as const, level: "article" as const, number: "5" },
      { kind: "vague" as const, raw: "the previous section" },
      { kind: "internal_appendix" as const, appendix_id: "article-10-appendix-a" },
    ]) {
      const before: Citation = { display_text: "x", target };
      expect(bindCitation(before, ctx).target).toBe(target);
    }
  });
});

// ─── canonical p109 extraction + binding cases ─────────────────────────────

describe("p109 acceptance — the four canonical cites bind correctly", () => {
  function extract(text: string): Citation[] {
    return extractCitations(text, sfPlumbing, {
      currentSectionId: "p109",
      jurisdictionModules: allModules,
    }).map((m) => m.citation);
  }

  it("cite #2: 'Section 109.0' alone resolves intra-module to sf-plumbing", () => {
    // Self-cite to the citing section's own id (typical inside p109).
    const cites = extract("Cost of work pursuant to this Section 109.0 shall be assessed.");
    const sectionRef = cites.find((c) => c.display_text === "Section 109.0");
    expect(sectionRef?.target).toEqual({
      kind: "internal",
      section_id: "109.0",
    });
  });

  it("cite #1/#3: 'Section 102A of the Building Code' binds via suffix-form to sf-building", () => {
    const cites = extract(
      "abate the condition in accordance with Section 102A of the Building Code.",
    );
    const target = cites.find((c) => c.display_text === "Section 102A")?.target;
    // Pre-binder: cross_module because nearest phrase is "Building Code"
    // post-cite, and alpha_suffix capture brought along the "A".
    expect(target).toEqual({
      kind: "cross_module",
      module_id: "sf-building",
      section_id: "102a",
    });
  });

  it("cite #4: 'Section 110A, Table 1A-K ... of the Building Code' survives intervening clauses", () => {
    // The plan calls this out as the hardest case: ten words and an
    // em-dash clause sit between cite and code phrase.
    const cites = extract(
      "See Section 110A, Table 1A-K - Penalties, Hearings - of the Building Code for the applicable fee.",
    );
    const target = cites.find((c) => c.display_text === "Section 110A")?.target;
    expect(target).toEqual({
      kind: "cross_module",
      module_id: "sf-building",
      section_id: "110a",
    });
  });

  it("does not attach a phrase to a preceding cite across a sentence boundary", () => {
    // Codex-flagged [P2]: a phrase that follows an unrelated cite in a
    // different sentence used to claim it across the period. Here
    // "Building Code" must NOT attach to "Section 109.0" because the
    // period between them ends a sentence and there's no "of the"
    // connector.
    const cites = extract("See Section 109.0 herein. The Building Code defines applicable terms.");
    const target = cites.find((c) => c.display_text === "Section 109.0")?.target;
    expect(target).toEqual({ kind: "internal", section_id: "109.0" });
  });

  it("does not attach a phrase to a following cite across a sentence boundary", () => {
    // Codex-flagged [P2] (round 2): symmetric to the preceding case.
    // "The Building Code defines terms. Section 102A applies ..." — the
    // phrase precedes the cite but lives in a different sentence, so
    // "Building Code" must NOT pull Section 102A cross-module. With the
    // following-cite guard absent, this cite would bind to sf-building
    // instead of staying intra-paragraph internal.
    const cites = extract("The Building Code defines terms. Section 102A applies in all cases.");
    const target = cites.find((c) => c.display_text === "Section 102A")?.target;
    expect(target?.kind).toBe("internal");
  });

  it("still attaches a phrase across the 'of the' connector", () => {
    // Negative regression for the sentence-boundary fix: a normal
    // "Section X of the Y Code" pattern must keep working. The
    // connector wins regardless of intervening punctuation.
    const cites = extract("Per Section 102A of the Building Code, the rule is...");
    const target = cites.find((c) => c.display_text === "Section 102A")?.target;
    expect(target).toEqual({
      kind: "cross_module",
      module_id: "sf-building",
      section_id: "102a",
    });
  });
});

// ─── Phase 4 gate: build fails on unbindable section-ref ───────────────────

describe("Phase 4 gate — validator rejects section-ref with missing anchor", () => {
  // Sanity test: a hand-crafted section-ref pointing at a sibling
  // anchor that doesn't exist surfaces as intra-unresolved. The build
  // gate (build-corpus.ts) refuses to ship a corpus with any
  // intra-unresolved cite — this is the "deliberate-failure fixture"
  // the refoundation plan asks for.
  it("validateCorpus reports intra-unresolved on a section-ref to a missing sibling anchor", async () => {
    const { validateCorpus } = await import("@/parser/validate-corpus");
    const minimalSection = (id: string, moduleId: string, targetAnchor: string) => ({
      kind: "section" as const,
      id,
      display_label: id,
      title: "Test",
      text: `Per Section ${targetAnchor}`,
      citations: [
        {
          display_text: `Section ${targetAnchor}`,
          target: {
            kind: "section-ref" as const,
            anchor_id: targetAnchor,
            module_id: moduleId,
          },
        },
      ],
      defined_terms: [],
      hierarchy: ["Test Code"],
      editorial_status: "active" as const,
      body: [],
    });
    const result = validateCorpus([
      {
        module: sfPlumbing,
        sections: [minimalSection("p109", "sf-building", "does-not-exist")],
        sectionPaths: {},
        appendices: [],
        ordinanceHistories: [],
        resolutionHistories: [],
        definitions: {},
        skipped: [],
        warnings: [],
        corpusEntryKinds: ["section"],
        tocAnchors: [],
      },
      {
        module: sfBuilding,
        sections: [], // empty — does-not-exist anchor genuinely missing
        sectionPaths: {},
        appendices: [],
        ordinanceHistories: [],
        resolutionHistories: [],
        definitions: {},
        skipped: [],
        warnings: [],
        corpusEntryKinds: ["section"],
        tocAnchors: [],
      },
    ]);
    expect(result.citations.unresolvedIntra).toHaveLength(1);
    expect(result.citations.unresolvedIntra[0]?.rawText).toBe("sf-building/does-not-exist");
  });
});

// ─── multi-code paragraph correctness ──────────────────────────────────────

describe("multi-code paragraph — each cite scopes to its nearest phrase", () => {
  it("two cross-module cites in one sentence resolve to two distinct modules", () => {
    // "Section 102 of the Building Code AND Section 50 of the Police
    // Code" must produce { sf-building, 102 } + { sf-police, 50 },
    // not both routing to whichever phrase came first.
    const text = "Per Section 102 of the Building Code and Section 50 of the Police Code.";
    const cites = extractCitations(text, sfPlumbing, {
      currentSectionId: "p109",
      jurisdictionModules: allModules,
    }).map((m) => m.citation);
    const building = cites.find((c) => c.display_text === "Section 102");
    const police = cites.find((c) => c.display_text === "Section 50");
    expect(building?.target).toEqual({
      kind: "cross_module",
      module_id: "sf-building",
      section_id: "102",
    });
    expect(police?.target).toEqual({
      kind: "cross_module",
      module_id: "sf-police",
      section_id: "50",
    });
  });

  it("internal cite mixed with cross-module cite in the same paragraph stays internal", () => {
    // "Section 109.0" precedes the code phrase but is closer to no
    // phrase at all (the citing module's own code_title is excluded
    // from the jurisdiction phrase set). It stays internal.
    const text = "See Section 109.0 herein and the procedures in Section 102 of the Building Code.";
    const cites = extractCitations(text, sfPlumbing, {
      currentSectionId: "p109",
      jurisdictionModules: allModules,
    }).map((m) => m.citation);
    expect(cites.find((c) => c.display_text === "Section 109.0")?.target).toEqual({
      kind: "internal",
      section_id: "109.0",
    });
    expect(cites.find((c) => c.display_text === "Section 102")?.target).toEqual({
      kind: "cross_module",
      module_id: "sf-building",
      section_id: "102",
    });
  });
});
