import { describe, expect, it } from "vitest";
import {
  buildCandidatesByTerm,
  type Reader,
  resolveDefinitionForOccurrence,
} from "@/parser/resolve-definition";
import type { Definition } from "@/types";

function def(overrides: Partial<Definition> & Pick<Definition, "id">): Definition {
  return {
    term: "City",
    defined_in: "a-100",
    body_anchor: { start: 0, end: 4 },
    excerpt: '"City" means the City and County of San Francisco.',
    scope: { kind: "hierarchy", prefix: ["Administrative Code"] },
    extracted_by: "amlegal:pattern:quoted-means",
    ...overrides,
  };
}

describe("buildCandidatesByTerm", () => {
  it("groups Definitions by term", () => {
    const a = def({ id: "sf-admin/a-100#aaaaaaaa", term: "City" });
    const b = def({ id: "sf-admin/a-200#bbbbbbbb", term: "City", defined_in: "a-200" });
    const c = def({ id: "sf-admin/a-300#cccccccc", term: "Director", defined_in: "a-300" });
    const idx = buildCandidatesByTerm([a, b, c]);
    expect(idx.get("City")).toHaveLength(2);
    expect(idx.get("Director")).toHaveLength(1);
    expect(idx.get("missing")).toBeUndefined();
  });
});

describe("resolveDefinitionForOccurrence", () => {
  const reader: Reader = {
    id: "a-500",
    hierarchy: ["Administrative Code", "Article I", "Chapter 5"],
  };

  it("returns null when no candidates exist for the term", () => {
    const result = resolveDefinitionForOccurrence("Nope", reader, new Map());
    expect(result.winner).toBeNull();
    expect(result.dropped).toEqual([]);
  });

  it("returns null when no candidates are in scope", () => {
    const candidate = def({
      id: "sf-admin/a-100#aaaaaaaa",
      scope: { kind: "hierarchy", prefix: ["Different Code"] },
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([candidate]),
    );
    expect(result.winner).toBeNull();
  });

  it("returns the single in-scope candidate when only one matches", () => {
    const candidate = def({
      id: "sf-admin/a-100#aaaaaaaa",
      scope: { kind: "hierarchy", prefix: ["Administrative Code"] },
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([candidate]),
    );
    expect(result.winner?.id).toBe("sf-admin/a-100#aaaaaaaa");
    expect(result.dropped).toEqual([]);
  });

  it("hierarchy scope beats module scope (precedence rule 2)", () => {
    const moduleScoped = def({
      id: "sf-admin/a-1#aaaaaaaa",
      scope: { kind: "module" },
      defined_in: "a-1",
    });
    const hierarchyScoped = def({
      id: "sf-admin/a-200#bbbbbbbb",
      scope: { kind: "hierarchy", prefix: ["Administrative Code"] },
      defined_in: "a-200",
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([moduleScoped, hierarchyScoped]),
    );
    expect(result.winner?.id).toBe("sf-admin/a-200#bbbbbbbb");
    expect(result.dropped.map((d) => d.id)).toEqual(["sf-admin/a-1#aaaaaaaa"]);
  });

  it("longer hierarchy prefix beats shorter (precedence rule 3)", () => {
    const shallow = def({
      id: "sf-admin/a-100#aaaaaaaa",
      scope: { kind: "hierarchy", prefix: ["Administrative Code"] },
      defined_in: "a-100",
    });
    const deep = def({
      id: "sf-admin/a-200#bbbbbbbb",
      scope: { kind: "hierarchy", prefix: ["Administrative Code", "Article I"] },
      defined_in: "a-200",
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([shallow, deep]),
    );
    expect(result.winner?.id).toBe("sf-admin/a-200#bbbbbbbb");
    expect(result.dropped.map((d) => d.id)).toEqual(["sf-admin/a-100#aaaaaaaa"]);
  });

  it("tiebreaks by defined_in ascending when prefix lengths match", () => {
    const a = def({
      id: "sf-admin/a-200#aaaaaaaa",
      scope: { kind: "hierarchy", prefix: ["Administrative Code"] },
      defined_in: "a-200",
    });
    const b = def({
      id: "sf-admin/a-100#bbbbbbbb",
      scope: { kind: "hierarchy", prefix: ["Administrative Code"] },
      defined_in: "a-100",
    });
    const result = resolveDefinitionForOccurrence("City", reader, buildCandidatesByTerm([a, b]));
    expect(result.winner?.defined_in).toBe("a-100");
  });

  it("hierarchy with exact reader-prefix match wins", () => {
    const exactMatch = def({
      id: "sf-admin/a-100#aaaaaaaa",
      scope: {
        kind: "hierarchy",
        prefix: ["Administrative Code", "Article I", "Chapter 5"],
      },
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([exactMatch]),
    );
    expect(result.winner?.id).toBe("sf-admin/a-100#aaaaaaaa");
  });

  it("hierarchy prefix longer than reader hierarchy is out of scope", () => {
    const tooDeep = def({
      id: "sf-admin/a-100#aaaaaaaa",
      scope: {
        kind: "hierarchy",
        prefix: [
          "Administrative Code",
          "Article I",
          "Chapter 5",
          "Section Subdivision",
          "Extra Depth",
        ],
      },
    });
    const result = resolveDefinitionForOccurrence("City", reader, buildCandidatesByTerm([tooDeep]));
    expect(result.winner).toBeNull();
  });

  it("module-scoped candidate wins when no hierarchy candidates are in scope", () => {
    const moduleOnly = def({
      id: "sf-admin/a-1#aaaaaaaa",
      scope: { kind: "module" },
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([moduleOnly]),
    );
    expect(result.winner?.id).toBe("sf-admin/a-1#aaaaaaaa");
  });

  it("cross_module scope is treated as out-of-scope in L1-L3", () => {
    const crossModule = def({
      id: "sf-admin/a-100#aaaaaaaa",
      scope: { kind: "cross_module", module_id: "sf-charter" },
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      reader,
      buildCandidatesByTerm([crossModule]),
    );
    expect(result.winner).toBeNull();
  });

  it("reader at empty hierarchy still resolves module-scoped candidates", () => {
    const moduleOnly = def({
      id: "sf-admin/a-1#aaaaaaaa",
      scope: { kind: "module" },
    });
    const result = resolveDefinitionForOccurrence(
      "City",
      { id: "x", hierarchy: [] },
      buildCandidatesByTerm([moduleOnly]),
    );
    expect(result.winner?.id).toBe("sf-admin/a-1#aaaaaaaa");
  });
});
