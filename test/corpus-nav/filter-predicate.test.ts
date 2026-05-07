import { describe, expect, it } from "vitest";
import type { CorpusTreeNode } from "@/corpus/wire";
import { alwaysTrue, and, or, prefixMatch } from "@/corpus-nav";

function node(code: string, name = ""): CorpusTreeNode {
  return { id: `${code}::${name}`, code, name, kind: "section" };
}

describe("filter-predicate", () => {
  it("alwaysTrue matches everything", () => {
    expect(alwaysTrue(node("§ 1.1", "Definitions"))).toBe(true);
    expect(alwaysTrue(node(""))).toBe(true);
  });

  it("and(...) matches when every predicate matches", () => {
    const p = and(
      (n) => n.code.startsWith("§"),
      (n) => n.name.length > 0,
    );
    expect(p(node("§ 1.1", "Definitions"))).toBe(true);
    expect(p(node("§ 1.1", ""))).toBe(false);
    expect(p(node("ARTICLE 1", "Section"))).toBe(false);
  });

  it("and() with zero predicates is alwaysTrue", () => {
    expect(and()(node("anything"))).toBe(true);
  });

  it("or(...) matches when any predicate matches", () => {
    const p = or(
      (n) => n.code.startsWith("§"),
      (n) => n.name.includes("ARTICLE"),
    );
    expect(p(node("§ 1.1", ""))).toBe(true);
    expect(p(node("ARTICLE 1", ""))).toBe(false); // code, not name
    expect(p(node("Chapter", "ARTICLE 2"))).toBe(true);
  });

  it("or() with zero predicates is alwaysTrue", () => {
    expect(or()(node("anything"))).toBe(true);
  });

  describe("prefixMatch", () => {
    it("empty buffer matches everything", () => {
      const p = prefixMatch("");
      expect(p(node("§ 1.1", "Definitions"))).toBe(true);
    });

    it("matches against the section number token", () => {
      const p = prefixMatch("1");
      expect(p(node("§ 1.1", "Definitions"))).toBe(true);
      expect(p(node("§ 2.1", "Other"))).toBe(false);
    });

    it("matches against a name token (case-insensitive)", () => {
      const p = prefixMatch("c");
      expect(p(node("§ 1.2", "Commission"))).toBe(true);
      expect(p(node("§ 1.1", "Definitions"))).toBe(false);
    });

    it("matches against the code token (case-insensitive)", () => {
      const p = prefixMatch("a");
      expect(p(node("ARTICLE 1", ""))).toBe(true);
    });

    it("multi-character buffer narrows the match", () => {
      const p = prefixMatch("comm");
      expect(p(node("§ 1.2", "Commission"))).toBe(true);
      expect(p(node("§ 1.3", "Powers"))).toBe(false);
    });

    it("does not substring-match — it prefix-matches per token", () => {
      const p = prefixMatch("mission");
      expect(p(node("§ 1.2", "Commission"))).toBe(false);
    });
  });
});
