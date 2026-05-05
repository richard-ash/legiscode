import { describe, expect, it } from "vitest";
import { slugify } from "@/parser/slugify";

describe("slugify", () => {
  it("converts a basic label to a hyphenated slug", () => {
    expect(slugify("Article 1")).toBe("article-1");
  });

  it("strips ARTICLE/colon punctuation", () => {
    expect(slugify("ARTICLE 1:")).toBe("article-1");
  });

  it("strips DIVISION trailing period", () => {
    expect(slugify("DIVISION I.")).toBe("division-i");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("Article  1  --  Reserved")).toBe("article-1-reserved");
  });

  it("trims leading/trailing hyphens after substitution", () => {
    expect(slugify("...Article 1...")).toBe("article-1");
  });

  it("normalizes accented characters via NFKD", () => {
    expect(slugify("Café")).toBe("cafe");
    expect(slugify("naïve")).toBe("naive");
  });

  it("lowercases", () => {
    expect(slugify("TRANSPORTATION CODE")).toBe("transportation-code");
  });

  it("replaces filesystem-reserved characters with hyphens", () => {
    expect(slugify("§ Foo/Bar")).toBe("foo-bar");
    expect(slugify("a:b*c?d")).toBe("a-b-c-d");
  });

  it("suffixes Windows reserved device names with -x", () => {
    expect(slugify("Con")).toBe("con-x");
    expect(slugify("PRN")).toBe("prn-x");
    expect(slugify("aux")).toBe("aux-x");
    expect(slugify("nul")).toBe("nul-x");
    expect(slugify("COM1")).toBe("com1-x");
    expect(slugify("LPT9")).toBe("lpt9-x");
  });

  it("does not suffix names that merely contain reserved tokens", () => {
    expect(slugify("Concord")).toBe("concord");
    expect(slugify("PRNTING")).toBe("prnting");
  });

  it("throws on labels that produce empty slugs", () => {
    expect(() => slugify("...")).toThrow(/empty slug/);
    expect(() => slugify("   ")).toThrow(/empty slug/);
  });
});
