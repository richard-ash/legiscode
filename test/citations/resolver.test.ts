import { describe, expect, it } from "vitest";
import { type CorpusExistence, resolve } from "@/citations/resolver";
import { parse as parseRef } from "@/corpus/refs";
import type { Citation } from "@/types";
import { CitationSchema } from "@/types/citation";
import type { ModuleId } from "@/types/identifiers";

function makeCorpus(opts: {
  citingModule: string;
  installedModules?: string[];
  sections?: Array<{ module: string; section: string }>;
  activeSection?: { module: string; section: string } | null;
  structuralIndex?: Record<string, { module: string; section: string }>;
}): CorpusExistence {
  const installed = new Set((opts.installedModules ?? [opts.citingModule]) as ModuleId[]);
  const idx = new Set((opts.sections ?? []).map((s) => `${s.module}::${s.section}`));
  return {
    citingModule: opts.citingModule as ModuleId,
    installedModules: installed,
    activeSection:
      opts.activeSection === undefined
        ? null
        : opts.activeSection === null
          ? null
          : parseRef({ module: opts.activeSection.module, section: opts.activeSection.section }),
    hasSection: (m, s) => idx.has(`${m}::${s}`),
    findStructural: (level, number) => {
      const key = `${level}:${number}`;
      const found = opts.structuralIndex?.[key];
      return found ? parseRef({ module: found.module, section: found.section }) : null;
    },
  };
}

function cite(target: Citation["target"], displayText = "§ N"): Citation {
  return CitationSchema.parse({ display_text: displayText, target });
}

describe("resolve — internal citations", () => {
  it("navigates to the section when it exists", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      sections: [{ module: "sf-municipal", section: "10.04.020" }],
    });
    const result = resolve(cite({ kind: "internal", section_id: "10.04.020" }), corpus);
    expect(result.kind).toBe("navigate-section");
  });

  it("carries subsection through to the navigate-section result", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      sections: [{ module: "sf-municipal", section: "10.04.020" }],
    });
    const result = resolve(
      cite({ kind: "internal", section_id: "10.04.020", subsection: "(a)" }),
      corpus,
    );
    expect(result).toMatchObject({ kind: "navigate-section", subsection: "(a)" });
  });

  it("returns unresolvable when the target section does not exist", () => {
    const corpus = makeCorpus({ citingModule: "sf-municipal" });
    const result = resolve(cite({ kind: "internal", section_id: "10.04.999" }), corpus);
    expect(result).toEqual({ kind: "unresolvable", reason: "section-not-found" });
  });
});

describe("resolve — same-section subsection scroll-only", () => {
  it("returns scroll-only when the cite anchors back to the active section", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      sections: [{ module: "sf-municipal", section: "10.04.020" }],
      activeSection: { module: "sf-municipal", section: "10.04.020" },
    });
    const result = resolve(
      cite({ kind: "internal", section_id: "10.04.020", subsection: "(a)" }, "subsection (a)"),
      corpus,
    );
    expect(result).toEqual({ kind: "scroll-only", subsection: "(a)" });
  });

  it("falls through to navigate-section when the active section is different", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      sections: [{ module: "sf-municipal", section: "10.04.020" }],
      activeSection: { module: "sf-municipal", section: "10.04.010" },
    });
    const result = resolve(
      cite({ kind: "internal", section_id: "10.04.020", subsection: "(a)" }),
      corpus,
    );
    expect(result.kind).toBe("navigate-section");
  });

  it("falls through to navigate-section when no active section is set", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      sections: [{ module: "sf-municipal", section: "10.04.020" }],
      activeSection: null,
    });
    const result = resolve(
      cite({ kind: "internal", section_id: "10.04.020", subsection: "(a)" }),
      corpus,
    );
    expect(result.kind).toBe("navigate-section");
  });
});

describe("resolve — cross_module citations", () => {
  it("navigates when the target module is installed and section exists", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      installedModules: ["sf-municipal", "ca-vehicle"],
      sections: [{ module: "ca-vehicle", section: "22358" }],
    });
    const result = resolve(
      cite({ kind: "cross_module", module_id: "ca-vehicle" as ModuleId, section_id: "22358" }),
      corpus,
    );
    expect(result.kind).toBe("navigate-section");
  });

  it("returns module-not-installed with the registry display name when the module isn't installed", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      installedModules: ["sf-municipal"],
    });
    const result = resolve(
      cite(
        { kind: "cross_module", module_id: "ca-vehicle" as ModuleId, section_id: "22358" },
        "Cal. Veh. Code § 22358",
      ),
      corpus,
    );
    expect(result).toEqual({
      kind: "module-not-installed",
      moduleId: "ca-vehicle",
      displayName: "California Vehicle Code",
      label: "Cal. Veh. Code § 22358",
    });
  });

  it("falls back to the raw module_id when the registry has no entry", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      installedModules: ["sf-municipal"],
    });
    const result = resolve(
      cite({ kind: "cross_module", module_id: "ca-unknown" as ModuleId, section_id: "1" }, "§ 1"),
      corpus,
    );
    expect(result).toMatchObject({
      kind: "module-not-installed",
      displayName: "ca-unknown",
    });
  });
});

describe("resolve — structural citations", () => {
  it("returns navigate-structural with a corpus ref when found", () => {
    const corpus = makeCorpus({
      citingModule: "sf-municipal",
      structuralIndex: {
        "article:5": { module: "sf-municipal", section: "5.100" },
      },
    });
    const result = resolve(cite({ kind: "structural", level: "article", number: "5" }), corpus);
    expect(result).toMatchObject({
      kind: "navigate-structural",
      level: "article",
      number: "5",
    });
  });

  it("returns unresolvable: structural-not-found when no matching node exists", () => {
    const corpus = makeCorpus({ citingModule: "sf-municipal" });
    const result = resolve(cite({ kind: "structural", level: "chapter", number: "999" }), corpus);
    expect(result).toEqual({ kind: "unresolvable", reason: "structural-not-found" });
  });
});

describe("resolve — appendix + vague", () => {
  it("internal_appendix → navigate-appendix", () => {
    const corpus = makeCorpus({ citingModule: "sf-municipal" });
    const result = resolve(
      cite({ kind: "internal_appendix", appendix_id: "article-1-appendix-a" } as never),
      corpus,
    );
    expect(result.kind).toBe("navigate-appendix");
  });

  it("vague → unresolvable", () => {
    const corpus = makeCorpus({ citingModule: "sf-municipal" });
    const result = resolve(cite({ kind: "vague", raw: "the section above" }), corpus);
    expect(result).toEqual({ kind: "unresolvable", reason: "vague-target" });
  });
});
