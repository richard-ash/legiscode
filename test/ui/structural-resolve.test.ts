// findStructuralRef regression tests. The structural-resolver maps a
// `Chapter N` / `Article N` cite onto a (module, section) leaf by
// walking the corpus tree. Codex-flagged [P2]: the original
// implementation used three-way startsWith with an undelimited bare
// prefix that let "Chapter 1" match "CHAPTER 10". This file pins the
// fix: bare matchers are exact-equality, delimited matchers stay
// startsWith.

import { describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import { findStructuralRef } from "@/ui/App";

function chapter(code: string, sectionId: string, sectionTitle = "Title"): CorpusTreeNode {
  return {
    id: `mod::${code}`,
    code,
    name: "",
    kind: "chapter",
    kids: [
      {
        id: `mod::${sectionId}`,
        code: sectionId,
        name: sectionTitle,
        kind: "section",
        ref: { moduleId: "mod", sectionId },
      },
    ],
  };
}

function tree(...chapters: CorpusTreeNode[]): CorpusTreeNode[] {
  return [
    {
      id: "mod",
      code: "Test Code",
      name: "Test",
      kind: "code",
      kids: chapters,
    },
  ];
}

describe("findStructuralRef — chapter / article matching", () => {
  it("matches a delimited 'CHAPTER 1:' label", () => {
    const t = tree(chapter("CHAPTER 1: Air Pollution", "1.01"));
    const ref = findStructuralRef(t, "mod", "chapter", "1");
    expect(ref?.section).toBe("1.01");
  });

  it("matches a bare 'CHAPTER 1' label with no trailing prose", () => {
    const t = tree(chapter("CHAPTER 1", "1.01"));
    const ref = findStructuralRef(t, "mod", "chapter", "1");
    expect(ref?.section).toBe("1.01");
  });

  it("does NOT match 'CHAPTER 1' against 'CHAPTER 10'", () => {
    // Codex-flagged [P2]: undelimited bare-prefix startsWith would have
    // let CHAPTER 1 claim CHAPTER 10. The exact-match fix rejects it.
    const t = tree(chapter("CHAPTER 10: Buildings", "10.01"));
    const ref = findStructuralRef(t, "mod", "chapter", "1");
    expect(ref).toBeNull();
  });

  it("does NOT match 'CHAPTER 1' against 'CHAPTER 11'", () => {
    const t = tree(chapter("CHAPTER 11: Zoning", "11.01"));
    const ref = findStructuralRef(t, "mod", "chapter", "1");
    expect(ref).toBeNull();
  });

  it("picks 'CHAPTER 1' when both CHAPTER 1 and CHAPTER 10 exist", () => {
    // The DFS stack ordering means CHAPTER 10 may be tried first; the
    // exact-match guard ensures CHAPTER 1 still wins for the "1" query.
    const t = tree(chapter("CHAPTER 1: Intro", "1.01"), chapter("CHAPTER 10: Detail", "10.01"));
    const ref = findStructuralRef(t, "mod", "chapter", "1");
    expect(ref?.section).toBe("1.01");
  });

  it("maps arabic input to a Roman article label ('5' → 'ARTICLE V')", () => {
    const t = tree(chapter("ARTICLE V - Special Provisions", "5.001"));
    const ref = findStructuralRef(t, "mod", "article", "5");
    expect(ref?.section).toBe("5.001");
  });

  it("does NOT match 'ARTICLE V' against 'ARTICLE VI' or 'ARTICLE VIII'", () => {
    // Same Codex concern in Roman form: V is a prefix of VI / VII / VIII.
    // The delimited / exact split must reject those collisions.
    const t = tree(
      chapter("ARTICLE VI - Other", "6.001"),
      chapter("ARTICLE VIII - Other", "8.001"),
    );
    const ref = findStructuralRef(t, "mod", "article", "5");
    expect(ref).toBeNull();
  });
});
