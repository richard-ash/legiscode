import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBody } from "@/parser/bills/body-parser";
import type { InstalledModule } from "@/parser/bills/scope-filter";
import { runStructuralPass, type StructuralPassResult } from "@/parser/bills/structural-pass";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "body-parser");

const SF_MODULES: InstalledModule[] = [
  { id: "sf-administrative", code_title: "Administrative Code" },
  { id: "sf-health", code_title: "Health Code" },
  { id: "sf-police", code_title: "Police Code" },
];

describe("parseBody — fallback shape", () => {
  it("returns the whole text as preamble when the structural pass found zero groups", () => {
    const text = "Some prose with no AMEND structure at all.";
    const pass = runStructuralPass(text, SF_MODULES);
    const { body, quality_warnings } = parseBody(text, pass);
    expect(body.sections).toHaveLength(0);
    expect(body.preamble).toBe(text);
    expect(body.closing).toBe("");
    expect(quality_warnings).toHaveLength(0);
  });
});

describe("parseBody — preamble / sections / closing split", () => {
  it("tokenises action lines, SEC. headers, and a closing block", () => {
    const text = [
      "[Health Code - Hello]",
      "Be it ordained by the People of the City and County of San Francisco:",
      "Section 1. Article 8 of the Health Code is hereby amended by deleting Section 407, to read as follows:",
      "SEC. 407. CONVEYANCE OF BREAD.",
      "It shall be unlawful for any person to carry bread.",
      "Section 2. Scope of Ordinance. Boilerplate scope text follows.",
    ].join("\n");
    const pass = runStructuralPass(text, SF_MODULES);
    const { body } = parseBody(text, pass);
    expect(body.preamble).toContain("[Health Code - Hello]");
    expect(body.preamble).toContain("Be it ordained by");
    expect(body.sections).toHaveLength(1);
    const first = body.sections[0];
    expect(first?.action).toContain("Section 1. Article 8 of the Health Code");
    expect(first?.target).toEqual({ module_id: "sf-health", raw_section_id: "407" });
    expect(first?.body).toEqual([
      { kind: "section_header", number: "407", title: "CONVEYANCE OF BREAD." },
      {
        kind: "paragraph",
        text: "It shall be unlawful for any person to carry bread.",
      },
    ]);
    expect(body.closing).toContain("Section 2. Scope of Ordinance.");
  });

  it("makes target null when the AMEND group's module_id couldn't be resolved", () => {
    const text = [
      "Section 1. The Labor and Employment Code is hereby amended by revising Section 5.0:",
      "SEC. 5.0. LEAVE PROTECTIONS.",
      "Body text.",
    ].join("\n");
    const pass = runStructuralPass(text, SF_MODULES);
    const { body } = parseBody(text, pass);
    expect(body.sections[0]?.target).toBeNull();
  });
});

describe("parseBody — subsection tokenisation", () => {
  it("captures `(a)` / `(b)` markers as subsection blocks containing paragraph children", () => {
    const text = [
      "Section 1. Article 8 of the Health Code is hereby amended by deleting Section 694, to read as follows:",
      "SEC. 694. WIPING RAGS.",
      "(a)  Materials and Cleaning Thereof. It shall be unlawful to sell.",
      "(b)  Definition. Wiping rags are cloths used for cleaning.",
    ].join("\n");
    const pass = runStructuralPass(text, SF_MODULES);
    const { body } = parseBody(text, pass);
    expect(body.sections[0]?.body).toEqual([
      { kind: "section_header", number: "694", title: "WIPING RAGS." },
      {
        kind: "subsection",
        marker: "(a)",
        body: [
          {
            kind: "paragraph",
            text: "Materials and Cleaning Thereof. It shall be unlawful to sell.",
          },
        ],
      },
      {
        kind: "subsection",
        marker: "(b)",
        body: [
          {
            kind: "paragraph",
            text: "Definition. Wiping rags are cloths used for cleaning.",
          },
        ],
      },
    ]);
  });

  it("captures `(1)` / `(2)` numeric markers the same way as alpha markers", () => {
    const text = [
      "Section 1. The Health Code is hereby amended by revising Section 100, to read as follows:",
      "SEC. 100. NUMBERED LIST.",
      "(1)  First numbered item.",
      "(2)  Second numbered item.",
    ].join("\n");
    const pass = runStructuralPass(text, SF_MODULES);
    const { body } = parseBody(text, pass);
    const blocks = body.sections[0]?.body ?? [];
    const markers = blocks
      .filter((b): b is Extract<typeof b, { kind: "subsection" }> => b.kind === "subsection")
      .map((b) => b.marker);
    expect(markers).toEqual(["(1)", "(2)"]);
  });
});

describe("parseBody — A3 parse-quality gate", () => {
  it("throws when group.sections claims more SEC. headers than the parser can emit", () => {
    // Hand-build a StructuralPassResult that claims two SEC. headers
    // in a group, but trigger an internal miscount by leaving the
    // group's section list with an entry whose offsets sit OUTSIDE
    // the text. The walker emits one header per claimed section, so
    // to organically trip the gate we need an external mismatch —
    // simulated by mutating `group.sections` between expected-count
    // accrual and emission, achieved here by passing a Proxy whose
    // length differs across reads.
    let firstRead = true;
    const phantomSection = {
      raw_id: "100",
      title: "ONE.",
      text_offset_start: 0,
      text_offset_after_header: 14,
      text_offset_end: 14,
    };
    const sectionsProxy = new Proxy([phantomSection, phantomSection], {
      get(target, prop, receiver) {
        if (prop === "length") {
          // First read (expectedHeaders accumulation) sees 2 entries;
          // second read (the for-of iteration) sees 1, so the parser
          // emits only one header and the gate trips at the end.
          const n = firstRead ? 2 : 1;
          firstRead = false;
          return n;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const text = "SEC. 100. ONE.\nBody.\n";
    const tampered: StructuralPassResult = {
      groups: [
        {
          ordinance_section_number: "1",
          code_name: "Health Code",
          module_id: "sf-health",
          text_offset_start: 0,
          text_offset_end: text.length,
          sections: sectionsProxy as unknown as never,
        },
      ],
      preamble_range: { start: 0, end: 0 },
      closing_range: { start: text.length, end: text.length },
      has_structural_action: false,
      structural_action_text: null,
    };
    expect(() => parseBody(text, tampered)).toThrow(/parse-quality gate/);
  });
});

describe("parseBody — committed corpus fixtures", () => {
  it("matches sf-police-260544.expected.json", async () => {
    const text = await readFile(join(FIXTURE_DIR, "sf-police-260544.txt"), "utf8");
    const expected = JSON.parse(
      await readFile(join(FIXTURE_DIR, "sf-police-260544.expected.json"), "utf8"),
    );
    const pass = runStructuralPass(text, SF_MODULES);
    const result = parseBody(text, pass);
    expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
  });

  it("matches sf-health-260545.expected.json", async () => {
    const text = await readFile(join(FIXTURE_DIR, "sf-health-260545.txt"), "utf8");
    const expected = JSON.parse(
      await readFile(join(FIXTURE_DIR, "sf-health-260545.expected.json"), "utf8"),
    );
    const pass = runStructuralPass(text, SF_MODULES);
    const result = parseBody(text, pass);
    expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
  });
});
