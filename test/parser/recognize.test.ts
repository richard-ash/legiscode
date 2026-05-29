import { describe, expect, it } from "vitest";
import {
  arbitrate,
  buildGlossaryRecognizer,
  capitalizedExtentEnd,
  type Span,
} from "@/parser/recognize";

// Pull the tagged term strings out of recognizeTerms output, in order.
function tags(terms: Iterable<string>, text: string): string[] {
  const rec = buildGlossaryRecognizer(terms);
  return rec
    .recognizeTerms(text)
    .filter((s): s is Extract<Span, { kind: "defined_term" }> => s.kind === "defined_term")
    .map((s) => s.term);
}

describe("glossary trie — recognition", () => {
  it("tags a single-word term on word boundaries", () => {
    expect(tags(["Person"], "A Person walked in.")).toEqual(["Person"]);
  });

  it("does not tag inside a larger word (Person ⊄ Personal)", () => {
    expect(tags(["Person"], "Personal effects belong to no Person here.")).toEqual(["Person"]);
  });

  it("is case-sensitive — each term matches only at its defined case", () => {
    // "City" defined capitalised; lower-case "city" prose must not tag.
    expect(tags(["City"], "The City told the city council.")).toEqual(["City"]);
  });

  it("prefers the longest match (multi-word term wins over its head)", () => {
    expect(
      tags(["Director", "Director of Transportation"], "The Director of Transportation signed."),
    ).toEqual(["Director of Transportation"]);
  });

  it("drops a later overlapping term once the longer one is taken", () => {
    // "public works" wins at offset 0; "works commission" overlaps and is
    // never reached — same result the old longest-first tiler produced.
    // Lower-case terms isolate the overlap behavior from the capitalised
    // guard (a trailing "Commission" would otherwise suppress the head).
    expect(tags(["public works", "works commission"], "public works commission met.")).toEqual([
      "public works",
    ]);
  });

  it("★ preserves lower-case terms — the trie recognises, not capitalisation", () => {
    // The arch decision hinges on this: a lower-case defined term is a
    // dictionary entry matched verbatim, with no capitalised extent and
    // therefore no guard.
    expect(tags(["fiscal year"], "Each fiscal year the budget resets.")).toEqual(["fiscal year"]);
    expect(
      tags(
        ["affordable housing", "minority person"],
        "affordable housing for each minority person",
      ),
    ).toEqual(["affordable housing", "minority person"]);
  });
});

describe("capitalised-extent guard — the ① fix", () => {
  it("suppresses a name highlighted inside a longer proper name", () => {
    // "Department" inside "Department of Emergency Management" → the
    // extent is longer and not itself a term → suppress.
    expect(tags(["Department"], "the Department of Emergency Management shall act")).toEqual([]);
  });

  it("still tags the bare name when it stands alone", () => {
    expect(tags(["Department"], "Department members shall be paid.")).toEqual(["Department"]);
  });

  it("tags a standalone name even when the same name appears in a bigger one nearby", () => {
    // (b)-style sentence: first "Department" stands alone (next word is the
    // `and` wall), second is inside the longer name and suppressed.
    expect(
      tags(
        ["Department"],
        "services from the Department and the Department of Emergency Management",
      ),
    ).toEqual(["Department"]);
  });

  it("suppresses City inside City Charter (adjacency)", () => {
    expect(tags(["City"], "under Section A8.400 of the City Charter and")).toEqual([]);
  });

  it("treats `and` as a wall (does not extend across it)", () => {
    // "City" then "and County" — `and` walls the extent, so the extent
    // equals the match and City tags.
    expect(tags(["City"], "the City and County of San Francisco")).toEqual(["City"]);
  });

  it("never examines a sentence-initial capital that is not a glossary hit", () => {
    // "Requested" is capitalised but not a term — it produces no span and
    // does not affect the real "Department" hit beside it.
    expect(tags(["Department"], "Requested services from the Department.")).toEqual(["Department"]);
  });

  it("does not merge two capitals across a possessive 's (D5)", () => {
    // "Mayor's Office" — no whitespace before 's, so the extent stops at
    // "Mayor"; the term tags rather than being swallowed by a longer name.
    expect(tags(["Mayor"], "the Mayor's Office of Housing approved")).toEqual(["Mayor"]);
  });
});

describe("capitalizedExtentEnd — extent grammar", () => {
  // pos is the end offset of the leading Capitalized word.
  it("adjacency extends across consecutive Capitalized words", () => {
    const text = "Board of Supervisors Rules";
    // leading word "Board" ends at 5.
    expect(text.slice(0, capitalizedExtentEnd(text, 5))).toBe("Board of Supervisors Rules");
  });

  it("bridges `of the` to the next Capital", () => {
    const text = "Office of the Treasurer today";
    expect(text.slice(0, capitalizedExtentEnd(text, 6))).toBe("Office of the Treasurer");
  });

  it("stops at the `and` wall", () => {
    const text = "City and County";
    expect(text.slice(0, capitalizedExtentEnd(text, 4))).toBe("City");
  });

  it("does not bridge `of` followed by a lower-case word", () => {
    const text = "Department of operations";
    expect(text.slice(0, capitalizedExtentEnd(text, 10))).toBe("Department");
  });

  it("stops at a possessive 's (no whitespace before it)", () => {
    const text = "Mayor's Office";
    expect(capitalizedExtentEnd(text, 5)).toBe(5); // "Mayor" — extent does not grow
  });

  it("does not bridge `of the` followed by a lower-case word", () => {
    const text = "Office of the building permit";
    // "Office" ends at 6; the `the` is consumed but the next word is
    // lower-case, so the extent does not grow past "Office".
    expect(text.slice(0, capitalizedExtentEnd(text, 6))).toBe("Office");
  });

  it("stops at a newline (paragraph break is not an inline space)", () => {
    const text = "Department\nOf Something";
    expect(capitalizedExtentEnd(text, 10)).toBe(10);
  });
});

describe("arbitrate — overlap tiling", () => {
  const cite = (start: number, end: number, raw: string, idx: number): Span => ({
    kind: "citation",
    start,
    end,
    raw,
    citation_index: idx,
  });
  const term = (start: number, end: number, t: string): Span => ({
    kind: "defined_term",
    start,
    end,
    term: t,
  });

  it("citation outranks an overlapping defined_term", () => {
    const out = arbitrate([term(4, 11, "Section"), cite(4, 16, "Section 1.01", 0)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("citation");
  });

  it("keeps non-overlapping spans in start order", () => {
    const out = arbitrate([term(20, 26, "Person"), cite(0, 12, "Section 1.01", 0)]);
    expect(out.map((s) => s.kind)).toEqual(["citation", "defined_term"]);
  });

  it("passes a paragraph_break through alongside primaries", () => {
    const brk: Span = { kind: "paragraph_break", start: 12, end: 13 };
    const out = arbitrate([cite(0, 12, "Section 1.01", 0), brk, term(13, 19, "Person")]);
    expect(out.map((s) => s.kind)).toEqual(["citation", "paragraph_break", "defined_term"]);
  });

  it("replaces an already-placed defined_term when a citation overlaps it", () => {
    // The term sorts first (lower start) and is placed; the overlapping
    // citation then arrives and must replace it. This is the branch that
    // keeps citation_index in sync when a term span leads into a cite.
    const out = arbitrate([term(2, 9, "Section"), cite(5, 14, "Section 1.01", 0)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("citation");
  });

  it("never drops a citation (citation_index stays in sync)", () => {
    // Two citations plus an overlapping term: both citations survive.
    const out = arbitrate([
      cite(0, 12, "Section 1.01", 0),
      term(6, 12, "1.01"),
      cite(20, 32, "Section 2.02", 1),
    ]);
    const cites = out.filter((s) => s.kind === "citation");
    expect(cites.map((c) => (c.kind === "citation" ? c.citation_index : -1))).toEqual([0, 1]);
  });
});
