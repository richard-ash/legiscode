import { describe, expect, it } from "vitest";
import { parseNewBody } from "@/parser/bills/parse-new-body";
import { type BodySegment, bodyToText } from "@/types";

// Roundtrip invariant: bodyToText(parseNewBody(t)) === t.
// This is the same invariant SectionFileSchema enforces on disk; the
// structured-diff overlay relies on it for character-level alignment.
describe("parseNewBody", () => {
  it("returns empty array for empty text", () => {
    expect(parseNewBody("")).toEqual([]);
  });

  it("returns a single text segment for plain prose with no markers", () => {
    expect(parseNewBody("The committee shall meet quarterly.")).toEqual([
      { kind: "text", text: "The committee shall meet quarterly." },
    ]);
  });

  it("recognizes a leading subsection label", () => {
    const out = parseNewBody("(a) First paragraph text.");
    expect(out).toEqual<readonly BodySegment[]>([
      { kind: "subsection_label", label: "(a)" },
      { kind: "text", text: " First paragraph text." },
    ]);
    expect(bodyToText(out)).toBe("(a) First paragraph text.");
  });

  it("recognizes a subsection label after a paragraph break", () => {
    const out = parseNewBody("Intro paragraph.\n(b) Second paragraph.");
    expect(out).toEqual<readonly BodySegment[]>([
      { kind: "text", text: "Intro paragraph." },
      { kind: "paragraph_break" },
      { kind: "subsection_label", label: "(b)" },
      { kind: "text", text: " Second paragraph." },
    ]);
    expect(bodyToText(out)).toBe("Intro paragraph.\n(b) Second paragraph.");
  });

  it("recognizes multi-level subsection labels", () => {
    const out = parseNewBody("(a)(1) Compound label.");
    expect(out).toEqual<readonly BodySegment[]>([
      { kind: "subsection_label", label: "(a)(1)" },
      { kind: "text", text: " Compound label." },
    ]);
  });

  it("ignores parenthesized text that isn't a paragraph-leading label", () => {
    // The label regex requires (^|\n) on the left and an uppercase
    // letter on the right. "see (a)" mid-sentence doesn't qualify.
    const out = parseNewBody("The Commission (a) shall act.");
    expect(out).toEqual<readonly BodySegment[]>([
      { kind: "text", text: "The Commission (a) shall act." },
    ]);
  });

  it("splits multiple paragraphs and labels in one pass", () => {
    const text = "(a) First section.\n(b) Second section.\n(c)(1) Subordinate item.";
    const out = parseNewBody(text);
    expect(bodyToText(out)).toBe(text);
    expect(
      out.filter((s) => s.kind === "subsection_label").map((s) => (s as { label: string }).label),
    ).toEqual(["(a)", "(b)", "(c)(1)"]);
  });

  it("handles consecutive paragraph breaks without emitting empty text segments", () => {
    const out = parseNewBody("First.\n\nSecond.");
    expect(out).toEqual<readonly BodySegment[]>([
      { kind: "text", text: "First." },
      { kind: "paragraph_break" },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second." },
    ]);
    expect(bodyToText(out)).toBe("First.\n\nSecond.");
  });

  it("preserves the roundtrip on real SF Administrative §10.100-317 fixture", () => {
    // Trimmed extract from build/modules/sf-administrative/bills/260598.json
    // (reconstructed newText for section 10.100-317).
    const newText =
      "(a) Establishment of Fund. The San Francisco Bonding and Financial Assistance Program is created.\n" +
      "(b) Use of Fund. The City may expend monies in said Fund.\n" +
      "(c) The Controller in consultation with the City's Risk Manager shall annually set a contribution rate.";
    const out = parseNewBody(newText);
    expect(bodyToText(out)).toBe(newText);
    const labels = out
      .filter((s) => s.kind === "subsection_label")
      .map((s) => (s as { label: string }).label);
    expect(labels).toEqual(["(a)", "(b)", "(c)"]);
  });
});
