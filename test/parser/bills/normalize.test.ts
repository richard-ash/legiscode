import { describe, expect, it } from "vitest";
import { normalize, tokenize } from "@/parser/bills/normalize";

describe("normalize", () => {
  it("collapses internal whitespace runs to single spaces", () => {
    expect(normalize("foo   bar\t\tbaz")).toBe("foo bar baz");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalize("   leading and trailing   ")).toBe("leading and trailing");
  });

  it("treats newlines, tabs, and non-breaking space as whitespace", () => {
    expect(normalize("foo\nbar\r\nbaz\tqux quux")).toBe("foo bar baz qux quux");
  });

  it("returns empty string for an empty input", () => {
    expect(normalize("")).toBe("");
  });

  it("returns empty string for a whitespace-only input", () => {
    expect(normalize("   \n\t  ")).toBe("");
  });

  it("applies NFC: composed and decomposed variants collapse to the same form", () => {
    // é can be U+00E9 (composed) or e + U+0301 (decomposed). NFC picks
    // the composed form; both inputs must normalize to the same string.
    const composed = "café";
    const decomposed = "café";
    expect(normalize(composed)).toBe(normalize(decomposed));
  });

  it("is idempotent: normalize(normalize(x)) === normalize(x)", () => {
    const inputs = [
      "",
      "   ",
      "single",
      "two words",
      "many   spaces   between   words",
      "  leading\nmiddle\ttrailing  ",
      "café müller naïve",
      "café müller naïve",
      'SEC. 5.1-1. "Advisory Body" shall mean…',
      "* * * *",
    ];
    for (const x of inputs) {
      const once = normalize(x);
      const twice = normalize(once);
      expect(twice).toBe(once);
    }
  });
});

describe("tokenize", () => {
  it("splits normalized text on single spaces", () => {
    expect(tokenize("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("normalizes before splitting", () => {
    expect(tokenize("  foo\n\tbar   baz  ")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns an empty array for empty / whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("preserves elision sentinel as separate tokens", () => {
    expect(tokenize("foo * * * * bar")).toEqual(["foo", "*", "*", "*", "*", "bar"]);
  });
});
