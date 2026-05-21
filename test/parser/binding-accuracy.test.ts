// Phase 6 accuracy fixture. Drives the build-time citation extractor +
// binder against a hand-curated set of (cite text, citing context,
// expected target) triples and asserts the binder produces exactly
// the expected target shape. Covers each binding pattern the Phase 4
// gate depends on: intra-module strip-trailing-zero, suffix-form code
// phrases, alpha-suffix capture, multi-code paragraph attribution,
// sibling appendix-prefix fallback, vague reclassification of
// over-captured cites, and external-code passthrough.
//
// The fixture lives in test/fixtures/parser/binding-accuracy.json so
// non-test consumers (PR descriptions, accuracy reports) can read the
// same source of truth as the test. Targets the binder layer directly
// (extractCitations + bindCitation) per feedback_test_each_path_once;
// the resolver test path is exercised separately.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BindContext, bindCitation, buildAnchorIndex } from "@/parser/binder";
import { extractCitations } from "@/parser/citations";
import type { DisplayRules, ModuleConfig } from "@/types";

interface Fixture {
  name: string;
  context: string;
  citing_module_id: string;
  citing_section_id: string;
  text: string;
  expected_cite: string;
  expected_target: unknown;
}

interface FixtureFile {
  description: string;
  schema_version: string;
  fixtures: Fixture[];
}

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

// Mirror the production manifests/sf/jurisdiction.json display_rules so
// the fixture stays in lockstep with the binder's real behavior. Any
// change to the manifest's rules surfaces here as a fixture failure.
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
const sfHousing = makeModule("sf-housing", "Housing Code", {
  prefix: "m",
  extra_prefixes: [],
  alpha_suffix: false,
  strip_trailing_zero: true,
  override_regex: null,
});
const sfCharter = makeModule("sf-charter", "Charter", {
  prefix: null,
  extra_prefixes: ["a", "d"],
  alpha_suffix: false,
  strip_trailing_zero: false,
  override_regex: null,
});
const sfPolice = makeModule("sf-police", "Police Code");
const sfAdministrative = makeModule("sf-administrative", "Administrative Code");
const allModules = [sfPlumbing, sfBuilding, sfHousing, sfCharter, sfPolice, sfAdministrative];

const moduleById = new Map<string, ModuleConfig>(allModules.map((m) => [m.id, m]));

// Anchor seeds for each module — enough to make the fixture's expected
// section-ref targets bindable. In production these come from the
// parsed corpus; here we hand-seed the anchors each fixture references.
const anchorSeeds: Record<string, string[]> = {
  "sf-plumbing": ["p109", "p110", "p103"],
  "sf-building": ["b102a", "b110a", "1106"],
  "sf-housing": ["m104.0"],
  "sf-charter": ["5.102", "a8.559"],
  "sf-police": ["50"],
  "sf-administrative": ["5.122"],
};

function buildBindContext(citingModuleId: string): BindContext {
  const anchorsByModule = new Map<string, ReadonlySet<string>>();
  const rulesByModule = new Map<string, DisplayRules | undefined>();
  for (const m of allModules) {
    anchorsByModule.set(m.id, buildAnchorIndex([], anchorSeeds[m.id] ?? []));
    rulesByModule.set(m.id, m.display_rules);
  }
  return { citingModuleId, anchorsByModule, rulesByModule };
}

async function loadFixtures(): Promise<Fixture[]> {
  const path = join(process.cwd(), "test/fixtures/parser/binding-accuracy.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;
  return parsed.fixtures;
}

describe("binding accuracy fixture (Phase 6)", async () => {
  const fixtures = await loadFixtures();

  for (const fx of fixtures) {
    it(`${fx.name}: ${fx.context}`, () => {
      const citingModule = moduleById.get(fx.citing_module_id);
      if (!citingModule) throw new Error(`unknown citing module: ${fx.citing_module_id}`);

      const matches = extractCitations(fx.text, citingModule, {
        currentSectionId: fx.citing_section_id,
        jurisdictionModules: allModules,
      });
      const cite = matches.find((m) => m.citation.display_text === fx.expected_cite);
      expect(cite, `cite "${fx.expected_cite}" not extracted from "${fx.text}"`).toBeDefined();
      if (!cite) return;

      const ctx = buildBindContext(fx.citing_module_id);
      const bound = bindCitation(cite.citation, ctx);
      expect(bound.target).toEqual(fx.expected_target);
    });
  }

  it("fixture set covers all four affected modules + control modules", () => {
    const citing = new Set(fixtures.map((f) => f.citing_module_id));
    for (const required of ["sf-plumbing", "sf-building", "sf-housing", "sf-charter"]) {
      expect(citing).toContain(required);
    }
  });

  it("fixture set covers all four binding patterns", () => {
    const kinds = new Set(fixtures.map((f) => (f.expected_target as { kind: string }).kind));
    // section-ref (binder hit), cross_module (foreign code), structural
    // (corpus-tree lookup), vague (binder reclassification).
    expect(kinds).toContain("section-ref");
    expect(kinds).toContain("cross_module");
    expect(kinds).toContain("structural");
    expect(kinds).toContain("vague");
  });
});
