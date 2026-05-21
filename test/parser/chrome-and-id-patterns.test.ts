// Editorial-chrome and id-extraction pattern coverage. Every chrome
// shape and every id-extraction edge case the SF AmLegal source surfaces
// has a focused inline-HTML test here so a regression in classifyRbox
// or id extraction fails LOUDLY at the parser layer — not only via the
// much larger production validation run.
//
// scripts/audit-classifier.ts re-runs the production-corpus audit to
// discover new chrome conventions; when one shows up, add it here.

import { describe, expect, it } from "vitest";
import { type ParsedModule, parseExport, validateCorpus } from "@/parser";
import type { JurisdictionManifest } from "@/types";

function makeManifest(
  extra: { id: string; codeTitle: string; jdAnchor: string }[],
): JurisdictionManifest {
  return {
    jurisdiction: "City and County of San Francisco",
    source: { format: "amlegal-html", path: "test/fixtures/inline" },
    parser_strategy: "sf-amlegal",
    modules: extra.map((m) => ({
      id: m.id,
      name: m.id,
      code_title: m.codeTitle,
      jd_anchor: m.jdAnchor,
      module_version: "2026.05.01",
      max_skip_count: 0,
      citation_patterns: [
        "(?<!§)§\\s*\\d+(?:\\.\\d+)*(?:\\([a-z0-9]+\\))*",
        "§§\\s*\\d+(?:\\.\\d+)*\\s*-\\s*\\d+(?:\\.\\d+)*",
      ],
      defined_term_patterns: ['"([^"]+)"\\s+means'],
    })),
  };
}

function html(...rboxes: string[]): Buffer {
  const body = rboxes.map((r) => `${r}\n<div class="clearfix"></div>`).join("\n");
  return Buffer.from(`<html><body>\n${body}\n</body></html>`);
}

// Code root for the test module. Slicer locates each module by its
// JD_<jd_anchor> anchor inside a Chapter-class rbox.
function root(jdAnchor: string, title: string): string {
  return `<div><div class="rbox Chapter"><div><a name="JD_${jdAnchor}" id="JD_${jdAnchor}" title="${jdAnchor}"></a>${title}</div></div></div>`;
}

function section(id: string, sectionId: string, heading: string, body: string): string {
  return `
    <div id="rid-${id}" class="Section toc-destination rbox"><h3><a name="JD_${sectionId}" id="JD_${sectionId}" title="${sectionId}"></a>SEC. ${sectionId}.  ${heading}</h3></div>
    <div id="rid-${id}-body" class="rbox Normal-Level"><div>${body}</div></div>`;
}

function parseSingleModule(buffer: Buffer): ParsedModule {
  const manifest = makeManifest([{ id: "test-mod", codeTitle: "Test Code", jdAnchor: "Test" }]);
  const modules = parseExport(buffer, manifest);
  if (modules.length !== 1 || !modules[0]) {
    throw new Error(`expected one parsed module, got ${modules.length}`);
  }
  return modules[0];
}

describe("chrome rbox patterns are classified consumed_by_parent", () => {
  it("New Ordinance Notice (Section-class, no JD anchor, no SEC. heading) is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>New Ordinance Notice</div></div>`,
      section("real", "1.1", "REAL SECTION.", "body text"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["1.1"]);
  });

  it("New Legislation Notice variant is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>New Legislation Notice</div></div>`,
      section("real", "2.1", "REAL SECTION.", "body text"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["2.1"]);
  });

  it("New Resolution Notice variant is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>New Resolution Notice</div></div>`,
      section("real", "3.1", "REAL SECTION.", "body text"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["3.1"]);
  });

  it("Bracketed caption (e.g. [DIGNITY FUND]) is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>[DIGNITY FUND]</div></div>`,
      section("real", "4.1", "REAL SECTION.", "body"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["4.1"]);
  });

  it("Year label (e.g. '2025') is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>2025</div></div>`,
      section("real", "5.1", "REAL SECTION.", "body"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["5.1"]);
  });

  it("Map-sheet header (sf-planning specific) is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>Zoning Use District ("ZN") Maps</div></div>`,
      section("real", "6.1", "REAL SECTION.", "body"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["6.1"]);
  });

  it("APPENDIX label without JD anchor is dropped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><div>APPENDIX M. - HIGH-RISE BUILDINGS</div></div>`,
      section("real", "7.1", "REAL SECTION.", "body"),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["7.1"]);
  });
});

describe("id extraction patterns parse correctly", () => {
  it("SEC. N. [REDESIGNATED.] heading produces clean id (no trailing period)", () => {
    // No JD anchor — heading-text fallback. Without the trailing-period
    // exclusion in HEADING_SEC_RE, the captured id was "23.7." with a
    // dangling period.
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section-Deleted toc-destination rbox"><h5>SEC. 23.7.  [REDESIGNATED.]</h5></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["23.7"]);
  });

  it("SEC. N. [REPEALED.] heading produces clean id", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section-Deleted toc-destination rbox"><h5>SEC. 28.13.  [REPEALED.]</h5></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["28.13"]);
  });

  it("JD_<id>Note<n>* anchor title gets ' Note <n>' stripped", () => {
    // stripJdAnchorSuffixes removes " Note 1" from "4.100.1 Note 1*" and
    // the `*` is then handled by normalizeSectionId; the resulting id is
    // the parent section "4.100.1".
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><h3><a name="JD_4.100.1Note1" id="JD_4.100.1Note1" title="4.100.1 Note 1*"></a>SEC. 4.100.1.  HEADING.</h3></div>
       <div class="rbox Normal-Level"><div>body</div></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["4.100.1"]);
  });

  it("JD_<id>-<n> anchor title gets '-<n>' stripped", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><h3><a name="JD_9.111-1" id="JD_9.111-1" title="9.111-1"></a>SEC. 9.111.  HEADING.</h3></div>
       <div class="rbox Normal-Level"><div>body</div></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    expect(result.sections.map((s) => s.id)).toEqual(["9.111"]);
  });

  it("parser self-validates against SECTION_ID_RE; non-conforming id is skipped with the real reason", () => {
    // When the parser DOES reach parseSectionElement (JD anchor present
    // OR SEC heading matches) but the resulting id fails SECTION_ID_RE,
    // the parser's self-validation catches it with a precise reason
    // rather than letting an invalid id leak to SectionFileSchema for
    // a less-specific failure. Synthetic case: comma-separated title
    // on a Section-class rbox produces a non-conforming id.
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section toc-destination rbox"><h3><a name="JD_x" id="JD_x" title="bad, id, with commas"></a>SEC. bad, id.  HEADING.</h3></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.sections).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.kind).toBe("parse");
    if (result.skipped[0]?.kind === "parse") {
      expect(result.skipped[0].reason).toContain("non-conforming section id");
      expect(result.skipped[0].reason).toContain("SECTION_ID_RE");
    }
  });
});

describe("Positive controls — parser produces expected structure", () => {
  it("plain-vanilla active section parses clean", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      section("a", "1.1", "PLAIN SECTION.", "Plain body text."),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    const sec = result.sections[0];
    expect(sec?.id).toBe("1.1");
    expect(sec?.editorial_status).toBe("active");
    expect(sec?.text).toContain("Plain body text");
  });

  it("redesignated section with body Link.Jump emits redirect_to", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div class="Section-Deleted toc-destination rbox"><h3><a name="JD_1.103" id="JD_1.103" title="1.103"></a>SEC. 1.103.  [Redesignated.]</h3></div>
       <div class="rbox Normal-Level"><div>This section was redesignated as <Link class="Jump" to="{{ pathname: '/codes/test', hash: '#JD_1.105' }}">Section 1.105</Link>.</div></div>`,
      section("target", "1.105", "TARGET SECTION.", "Body of target."),
    );
    const result = parseSingleModule(buffer);
    expect(result.skipped).toEqual([]);
    const sec = result.sections.find((s) => s.id === "1.103");
    expect(sec?.editorial_status).toBe("redesignated");
    expect(sec?.redirect_to).toBe("1.105");
  });

  it("intra-module citation pair both resolve via validateCorpus", () => {
    // Section 1.1 cites § 1.2; section 1.2 cites § 1.1. Both resolve
    // because both targets exist in the parsed sections.
    const buffer = html(
      root("Test", "TEST CODE"),
      section("a", "1.1", "SECTION ONE.", "See § 1.2 for details."),
      section("b", "1.2", "SECTION TWO.", "Refer back to § 1.1."),
    );
    const result = parseSingleModule(buffer);
    const validation = validateCorpus([result]);
    expect(validation.citations.unresolvedIntra).toEqual([]);
    expect(validation.citations.resolved).toBeGreaterThanOrEqual(2);
  });

  it("citation hierarchy walk: § X.Y.Z resolves via parent X.Y", () => {
    // No section "1.1.5" exists; cite to it should resolve via parent "1.1".
    const buffer = html(
      root("Test", "TEST CODE"),
      section("a", "1.1", "PARENT SECTION.", "Sub-content discussed."),
      section("b", "2.1", "OTHER SECTION.", "See § 1.1.5 for sub-content."),
    );
    const result = parseSingleModule(buffer);
    const validation = validateCorpus([result]);
    expect(validation.citations.unresolvedIntra).toEqual([]);
  });

  it("internal cites without an in-corpus anchor reclassify as vague (Phase 4)", () => {
    // Phase 4: the build-time binder reclassifies bindable-shape-but-
    // actually-unbindable cites as vague (renderer shows citation
    // chrome, ⌘-click is a no-op, no build failure). Replaces the
    // legacy demotion-to-cross-unresolved pattern that the gate
    // quietly leaned on. The gate now means "0 intra-unresolved" for
    // real.
    const buffer = html(
      root("Test", "TEST CODE"),
      section("a", "1.1", "SOLE SECTION.", "See § 99.99 for fictional reference."),
    );
    const result = parseSingleModule(buffer);
    const validation = validateCorpus([result]);
    expect(validation.citations.unresolvedIntra).toEqual([]);
    // Inspect the bound cite directly — the validator's report doesn't
    // surface vague cites by design (they're not unresolved, just
    // unnavigable).
    const sec = result.sections.find((s) => s.id === "1.1");
    const vague = sec?.citations.find((c) => c.target.kind === "vague");
    expect(vague?.target).toEqual({ kind: "vague", raw: expect.stringContaining("99.99") });
  });

  it("source-anchor TOC resolution: cite to deletion-stub anchor resolves", () => {
    // 99.1 is NOT a parsed section but its JD anchor exists in the
    // source as a deletion stub (inside body content). The TOC-anchor
    // lookup catches this.
    const buffer = html(
      root("Test", "TEST CODE"),
      section("a", "1.1", "ACTIVE SECTION.", "See § 99.1 for the repealed reference."),
      `<div class="rbox Normal-Level"><div><a name="JD_99.1" id="JD_99.1" title="99.1"></a>(repealed by Ord. 0123-25)</div></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.tocAnchors).toContain("99.1");
    const validation = validateCorpus([result]);
    expect(validation.citations.unresolvedIntra).toEqual([]);
  });

  it("bare-integer citation with no source anchor reclassifies as vague (Phase 4)", () => {
    // § 5270 is almost certainly an external code reference (CA Public
    // Resources, etc.) without a phrase prefix the registry could pick
    // up. Phase 4: binder reclassifies as vague rather than dumping
    // into unresolvedCross. Gate stays green.
    const buffer = html(
      root("Test", "TEST CODE"),
      section("a", "1.1", "ACTIVE SECTION.", "See § 5270 for external context."),
    );
    const result = parseSingleModule(buffer);
    const validation = validateCorpus([result]);
    expect(validation.citations.unresolvedIntra).toEqual([]);
    expect(validation.citations.unresolvedCross).toEqual([]);
    const sec = result.sections.find((s) => s.id === "1.1");
    const vague = sec?.citations.find((c) => c.target.kind === "vague");
    expect(vague?.target).toEqual({ kind: "vague", raw: expect.stringContaining("5270") });
  });
});

describe("editorial-status detection (case-insensitive)", () => {
  function deletedSection(rid: string, sectionId: string, classSuffix: string): string {
    return `
      <div id="rid-${rid}" class="${classSuffix} toc-destination rbox"><h3><a name="JD_${sectionId}" id="JD_${sectionId}" title="${sectionId}"></a>SEC. ${sectionId}.  [REPEALED.]</h3></div>
      <div id="rid-${rid}-body" class="rbox Normal-Level"><div>Editor's Note: section repealed.</div></div>`;
  }

  it("matches all-caps [REPEALED.] tombstones (Section-Deleted class)", () => {
    const buffer = html(root("Test", "TEST CODE"), deletedSection("a", "10.1", "Section-Deleted"));
    const result = parseSingleModule(buffer);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.editorial_status).toBe("repealed");
  });

  it("treats Subsection-Deleted (lowercase) as deleted", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      deletedSection("a", "10.1", "Subsection-Deleted"),
    );
    const result = parseSingleModule(buffer);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.editorial_status).toBe("repealed");
  });

  it("treats SubSection-Deleted (CamelCase) as deleted", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      deletedSection("a", "10.1", "SubSection-Deleted"),
    );
    const result = parseSingleModule(buffer);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.editorial_status).toBe("repealed");
  });

  it("matches all-caps [REDESIGNATED.] in heading", () => {
    const buffer = html(
      root("Test", "TEST CODE"),
      `<div id="rid-a" class="Section-Deleted toc-destination rbox"><h3><a name="JD_10.1" id="JD_10.1" title="10.1"></a>SEC. 10.1.  [REDESIGNATED.]</h3></div>
      <div id="rid-a-body" class="rbox Normal-Level"><div>Editor's Note: section redesignated.</div></div>`,
    );
    const result = parseSingleModule(buffer);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.editorial_status).toBe("redesignated");
  });
});

describe("multi-module TOC and cross-module citation", () => {
  it("two-module corpus: each module's TOC enumerates only its own sections", () => {
    const manifest = makeManifest([
      { id: "test-a", codeTitle: "Test A Code", jdAnchor: "TestA" },
      { id: "test-b", codeTitle: "Test B Code", jdAnchor: "TestB" },
    ]);
    const buffer = html(
      root("TestA", "TEST A CODE"),
      section("aa", "10.1", "A-SECTION.", "Body"),
      root("TestB", "TEST B CODE"),
      section("bb", "20.1", "B-SECTION.", "Body"),
    );
    const modules = parseExport(buffer, manifest);
    expect(modules.map((m) => m.module.id)).toEqual(["test-a", "test-b"]);
    expect(modules[0]?.sections.map((s) => s.id)).toEqual(["10.1"]);
    expect(modules[1]?.sections.map((s) => s.id)).toEqual(["20.1"]);
    const validation = validateCorpus(modules);
    expect(validation.coverage.missing).toEqual([]);
    expect(validation.coverage.covered).toBe(2);
  });
});
