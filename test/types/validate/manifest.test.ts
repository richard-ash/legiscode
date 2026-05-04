import { describe, expect, it } from "vitest";
import {
  DistributedModuleManifestSchema,
  JurisdictionManifestSchema,
  ModuleConfigSchema,
} from "@/types";

const validModule = {
  id: "sf-transportation",
  name: "San Francisco Transportation Code",
  code_title: "Transportation Code",
  jd_anchor: "Transportation",
  module_version: "2026.05.01",
  citation_patterns: ["§\\s+\\d+(?:\\.\\d+)+"],
  defined_term_patterns: ['"([^"]+)"\\s+means'],
};

const validJurisdiction = {
  jurisdiction: "City and County of San Francisco",
  source: {
    format: "amlegal-html" as const,
    path: "test/fixtures/sf/source.html",
  },
  parser_strategy: "sf-amlegal",
  modules: [validModule],
};

describe("ModuleConfigSchema", () => {
  it("accepts a valid module config", () => {
    expect(ModuleConfigSchema.parse(validModule).id).toBe("sf-transportation");
  });

  it("requires code_title (no fallback)", () => {
    const { code_title: _omit, ...withoutTitle } = validModule;
    const result = ModuleConfigSchema.safeParse(withoutTitle);
    expect(result.success).toBe(false);
  });

  it("rejects code_title with surrounding whitespace", () => {
    const result = ModuleConfigSchema.safeParse({
      ...validModule,
      code_title: "  Transportation Code  ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects bad module_version format", () => {
    const result = ModuleConfigSchema.safeParse({ ...validModule, module_version: "v1" });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive min_section_count", () => {
    const result = ModuleConfigSchema.safeParse({ ...validModule, min_section_count: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts optional min_section_count", () => {
    const parsed = ModuleConfigSchema.parse({ ...validModule, min_section_count: 5 });
    expect(parsed.min_section_count).toBe(5);
  });

  it("defaults max_skip_count to 0 when omitted", () => {
    expect(ModuleConfigSchema.parse(validModule).max_skip_count).toBe(0);
  });

  it("accepts an explicit max_skip_count override", () => {
    expect(ModuleConfigSchema.parse({ ...validModule, max_skip_count: 5 }).max_skip_count).toBe(5);
  });

  it("rejects negative max_skip_count", () => {
    const result = ModuleConfigSchema.safeParse({ ...validModule, max_skip_count: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer max_skip_count", () => {
    const result = ModuleConfigSchema.safeParse({ ...validModule, max_skip_count: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields under strict()", () => {
    const result = ModuleConfigSchema.safeParse({ ...validModule, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("rejects source.path on a ModuleConfig (jurisdiction-level only)", () => {
    const result = ModuleConfigSchema.safeParse({
      ...validModule,
      source: { format: "amlegal-html", path: "x.html" },
    });
    expect(result.success).toBe(false);
  });
});

describe("JurisdictionManifestSchema — happy path", () => {
  it("accepts a valid jurisdiction manifest", () => {
    const parsed = JurisdictionManifestSchema.parse(validJurisdiction);
    expect(parsed.modules).toHaveLength(1);
  });

  it("accepts an optional source.snapshot_at", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { ...validJurisdiction.source, snapshot_at: "2026-05-02T22:58:00Z" },
    });
    expect(result.success).toBe(true);
  });
});

describe("JurisdictionManifestSchema — source config", () => {
  it("rejects an absolute source.path", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { ...validJurisdiction.source, path: "/tmp/source.html" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects source.path containing '..' segments", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { ...validJurisdiction.source, path: "../etc/passwd" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty source.path", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { ...validJurisdiction.source, path: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown source.format values", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { format: "made-up-format", path: "x.html" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields on source under strict()", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { ...validJurisdiction.source, extra: "no" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a snapshot_at without offset", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      source: { ...validJurisdiction.source, snapshot_at: "2026-05-02T22:58:00" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects the legacy flat text_source shape", () => {
    const result = JurisdictionManifestSchema.safeParse({
      jurisdiction: validJurisdiction.jurisdiction,
      source: "amlegal-export",
      text_source: "test/fixtures/sf/source.html",
      parser_strategy: validJurisdiction.parser_strategy,
      modules: validJurisdiction.modules,
    });
    expect(result.success).toBe(false);
  });
});

describe("JurisdictionManifestSchema — parser_strategy", () => {
  it("accepts lowercase-with-hyphens strategies", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      parser_strategy: "nyc-amlegal",
    });
    expect(result.success).toBe(true);
  });

  it("rejects parser_strategy with uppercase", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      parser_strategy: "SF-AmLegal",
    });
    expect(result.success).toBe(false);
  });

  it("rejects parser_strategy with leading hyphen or digit", () => {
    expect(
      JurisdictionManifestSchema.safeParse({ ...validJurisdiction, parser_strategy: "-sf" })
        .success,
    ).toBe(false);
    expect(
      JurisdictionManifestSchema.safeParse({ ...validJurisdiction, parser_strategy: "1-sf" })
        .success,
    ).toBe(false);
  });

  it("rejects an empty parser_strategy", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      parser_strategy: "",
    });
    expect(result.success).toBe(false);
  });

  it("requires parser_strategy", () => {
    const { parser_strategy: _omit, ...withoutStrategy } = validJurisdiction;
    const result = JurisdictionManifestSchema.safeParse(withoutStrategy);
    expect(result.success).toBe(false);
  });
});

describe("JurisdictionManifestSchema — jd_anchor cross-validation", () => {
  it("requires jd_anchor on every module when source.format is amlegal-html", () => {
    const { jd_anchor: _omit, ...moduleWithoutAnchor } = validModule;
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      modules: [moduleWithoutAnchor],
    });
    expect(result.success).toBe(false);
  });

  it("flags partial jd_anchor coverage as invalid for amlegal-html", () => {
    const { jd_anchor: _omit, ...moduleWithoutAnchor } = validModule;
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      modules: [validModule, { ...moduleWithoutAnchor, id: "sf-charter", code_title: "Charter" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("JurisdictionManifestSchema — modules[]", () => {
  it("rejects modules[] with duplicate module IDs", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      modules: [validModule, { ...validModule, code_title: "Other Code" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects modules[] with case-insensitive duplicate code_titles", () => {
    const result = JurisdictionManifestSchema.safeParse({
      ...validJurisdiction,
      modules: [validModule, { ...validModule, id: "sf-other", code_title: "TRANSPORTATION CODE" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty modules[]", () => {
    const result = JurisdictionManifestSchema.safeParse({ ...validJurisdiction, modules: [] });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields under strict()", () => {
    const result = JurisdictionManifestSchema.safeParse({ ...validJurisdiction, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("rejects the legacy single-module per-code shape", () => {
    const result = JurisdictionManifestSchema.safeParse({
      id: "sf-transportation",
      name: "...",
      jurisdiction: "...",
      module_version: "2026.05.01",
      source: { format: "amlegal-html", path: "x.html" },
      parser_strategy: "sf-amlegal",
      citation_patterns: [],
      defined_term_patterns: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("DistributedModuleManifestSchema", () => {
  const validDistributed = {
    id: "sf-transportation",
    name: "San Francisco Transportation Code",
    jurisdiction: "City and County of San Francisco",
    code_title: "Transportation Code",
    module_version: "2026.05.01",
    citation_patterns: ["§\\s+\\d+(?:\\.\\d+)+"],
    defined_term_patterns: ['"([^"]+)"\\s+means'],
  };

  it("accepts a valid distributed manifest", () => {
    expect(DistributedModuleManifestSchema.parse(validDistributed).id).toBe("sf-transportation");
  });

  it("rejects a distributed manifest carrying source", () => {
    const result = DistributedModuleManifestSchema.safeParse({
      ...validDistributed,
      source: { format: "amlegal-html", path: "x.html" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a distributed manifest carrying parser_strategy", () => {
    const result = DistributedModuleManifestSchema.safeParse({
      ...validDistributed,
      parser_strategy: "sf-amlegal",
    });
    expect(result.success).toBe(false);
  });

  it("requires jurisdiction", () => {
    const { jurisdiction: _omit, ...withoutJurisdiction } = validDistributed;
    const result = DistributedModuleManifestSchema.safeParse(withoutJurisdiction);
    expect(result.success).toBe(false);
  });
});
