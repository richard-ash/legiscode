import { describe, expect, it } from "vitest";
import { smoothReconstructedText } from "@/parser/bills/text-smoothing";

describe("smoothReconstructedText", () => {
  describe("paragraph break preservation", () => {
    it("keeps the break after a sentence ending in '.'", () => {
      const input = "First sentence.\nSecond paragraph.";
      expect(smoothReconstructedText(input)).toBe("First sentence.\nSecond paragraph.");
    });

    it("keeps the break after a sentence ending in ':'", () => {
      const input = "The following definitions apply:\n(a) First definition.";
      expect(smoothReconstructedText(input)).toBe(
        "The following definitions apply:\n(a) First definition.",
      );
    });

    it("keeps the break after a sentence ending in '?'", () => {
      const input = "What does this mean?\nIt means we move on.";
      expect(smoothReconstructedText(input)).toBe("What does this mean?\nIt means we move on.");
    });

    it("keeps the break after a sentence ending in '.\"' (smart quote close)", () => {
      const input = "“Affordable to a household.”\n“Next defined term.”";
      expect(smoothReconstructedText(input)).toBe(
        "“Affordable to a household.”\n“Next defined term.”",
      );
    });

    it("keeps the break after a sentence ending in '.\"' (straight quote close)", () => {
      const input = 'Quote ends here."\nNext paragraph.';
      expect(smoothReconstructedText(input)).toBe('Quote ends here."\nNext paragraph.');
    });
  });

  describe("wrap-induced break merging", () => {
    it("merges a break after a line with no terminator", () => {
      const input = "This sentence wraps across\ntwo visual lines.";
      expect(smoothReconstructedText(input)).toBe("This sentence wraps across two visual lines.");
    });

    it("merges when the next line starts with a continuation comma", () => {
      const input = "as defined in the Procedures Manual\n, as amended from time to time,";
      expect(smoothReconstructedText(input)).toBe(
        "as defined in the Procedures Manual, as amended from time to time,",
      );
    });

    it("merges when the next line starts with lowercase 'to' continuation", () => {
      const input = "a household can afford\nto pay based on an annual payment";
      expect(smoothReconstructedText(input)).toBe(
        "a household can afford to pay based on an annual payment",
      );
    });

    it("merges three wrapped lines into one sentence", () => {
      const input = "available financing\nor a rent that does not exceed 30%\nof a household.";
      expect(smoothReconstructedText(input)).toBe(
        "available financing or a rent that does not exceed 30% of a household.",
      );
    });

    it("merges trailing-and continuation", () => {
      const input = "recommended by MOHCD in the Procedures Manual, and\navailable financing.";
      expect(smoothReconstructedText(input)).toBe(
        "recommended by MOHCD in the Procedures Manual, and available financing.",
      );
    });
  });

  describe("alphabet header dropping", () => {
    it("drops a single capital letter line surrounded by breaks", () => {
      const input = "intro sentence:\nA\n“Affordable.”";
      expect(smoothReconstructedText(input)).toBe("intro sentence:\n“Affordable.”");
    });

    it("drops multiple alphabet headers in sequence", () => {
      const input = "intro:\nA\n“Alpha.”\nB\n“Beta.”";
      expect(smoothReconstructedText(input)).toBe("intro:\n“Alpha.”\n“Beta.”");
    });

    it("does NOT drop a single digit line (could be numbered list)", () => {
      const input = "items:\n1\nFirst item.";
      // "1" survives the alphabet-header filter; the merge then joins it
      // with the next line because "items:" → break kept, then "1" has no
      // terminator → merge with "First item." → "1 First item."
      expect(smoothReconstructedText(input)).toBe("items:\n1 First item.");
    });

    it("does NOT drop a multi-character line that happens to be capitals", () => {
      const input = "intro:\nABC\nbody.";
      expect(smoothReconstructedText(input)).toBe("intro:\nABC body.");
    });
  });

  describe("edge cases", () => {
    it("returns empty string unchanged", () => {
      expect(smoothReconstructedText("")).toBe("");
    });

    it("returns a single line unchanged", () => {
      expect(smoothReconstructedText("just one line")).toBe("just one line");
    });

    it("preserves a single line that is just punctuation", () => {
      expect(smoothReconstructedText(".")).toBe(".");
    });

    it("handles a section opener with subsection label after terminator", () => {
      // After a "." the break is preserved; the subsection label line stays
      // intact so parseNewBody's regex can recognize it.
      const input = "Each unit shall be sold:\n(i) Only to first-time homebuyer households.";
      expect(smoothReconstructedText(input)).toBe(
        "Each unit shall be sold:\n(i) Only to first-time homebuyer households.",
      );
    });

    it("preserves blank lines as paragraph boundaries", () => {
      // An explicit blank line resets merge state — the next line is
      // treated as a fresh paragraph start, not a continuation.
      const input = "first paragraph\n\nsecond paragraph";
      expect(smoothReconstructedText(input)).toBe("first paragraph\n\nsecond paragraph");
    });
  });

  describe("260538 §401 shape regression", () => {
    it("smooths the exact pattern that broke five times in PR #46", () => {
      // Reproduces the failure mode observed in build/modules/sf-planning/
      // bills/260538.json, §401 — every line wrap from the PDF became
      // its own paragraph break because the bill's line spacing exceeded
      // the 22pt threshold. Smoothing collapses this to two paragraphs:
      // the intro sentence and the full definition.
      const input = [
        "In addition to the specific definitions set forth in Section 102 and elsewhere in this",
        "Article 4, the following definitions shall govern interpretation of this Article:",
        "A",
        "“Affordable to a household.” A purchase price that a household can afford",
        "to pay based on an annual payment for all housing costs, as defined in the Procedures Manual",
        ", as amended from time to time,",
        "of 33% of the combined household annual gross income, assuming a down payment",
        "recommended by MOHCD in the Procedures Manual, and",
        "available financing, or a rent that does not exceed 30% of a household’s combined",
        "annual gross income.",
        "“Affordable to Qualifying Households.”",
      ].join("\n");

      const expected = [
        "In addition to the specific definitions set forth in Section 102 and elsewhere in this Article 4, the following definitions shall govern interpretation of this Article:",
        "“Affordable to a household.” A purchase price that a household can afford to pay based on an annual payment for all housing costs, as defined in the Procedures Manual, as amended from time to time, of 33% of the combined household annual gross income, assuming a down payment recommended by MOHCD in the Procedures Manual, and available financing, or a rent that does not exceed 30% of a household’s combined annual gross income.",
        "“Affordable to Qualifying Households.”",
      ].join("\n");

      expect(smoothReconstructedText(input)).toBe(expected);
    });
  });
});
