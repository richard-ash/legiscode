// v4 structured overlay — projects DiffChunks onto a baseline
// BodySegment[] for the Changes view's inline insert/delete marks.
// Proposed mode no longer routes through overlayStructured; the
// section view renders Proposed from Bill.new_bodies[i].body
// directly. See section-view.tsx for the mode dispatch.

import { describe, expect, it } from "vitest";
import { parseNewBody } from "@/parser/bills/parse-new-body";
import type { BodySegment, DiffChunk, SectionId } from "@/types";
import { bodyFromText, overlayStructured } from "@/ui/diff/overlay";

const SID = "test" as SectionId;

function chunk(op: DiffChunk["op"], text: string): DiffChunk {
  return { op, text, section_id: SID };
}

describe("overlayStructured — Changes mode", () => {
  it("emits an equal-only stream as plain text segments", () => {
    const body: BodySegment[] = [{ kind: "text", text: "The committee meets." }];
    expect(overlayStructured([chunk("equal", "The committee meets.")], body, "changes")).toEqual([
      { kind: "text", text: "The committee meets." },
    ]);
  });

  it("interleaves equal + insert + equal with the insert highlighted", () => {
    const body: BodySegment[] = [{ kind: "text", text: "The committee shall meet." }];
    expect(
      overlayStructured(
        [
          chunk("equal", "The "),
          chunk("insert", "Advisory "),
          chunk("equal", "committee shall meet."),
        ],
        body,
        "changes",
      ),
    ).toEqual([
      { kind: "text", text: "The " },
      { kind: "diff_insert", text: "Advisory " },
      { kind: "text", text: "committee shall meet." },
    ]);
  });

  it("emits a delete chunk in-place between equal chunks", () => {
    // Baseline: "The Advisory committee shall meet."
    const body: BodySegment[] = [{ kind: "text", text: "The Advisory committee shall meet." }];
    expect(
      overlayStructured(
        [
          chunk("equal", "The "),
          chunk("delete", "Advisory "),
          chunk("equal", "committee shall meet."),
        ],
        body,
        "changes",
      ),
    ).toEqual([
      { kind: "text", text: "The " },
      { kind: "diff_delete", text: "Advisory " },
      { kind: "text", text: "committee shall meet." },
    ]);
  });

  it("emits a wholesale rewrite as delete-then-insert when the baseline is the entire section", () => {
    // synthesizeWholesale's delete-only path: full baseline is
    // struck through, then the inserted body trails.
    const body: BodySegment[] = [{ kind: "text", text: "old text" }];
    expect(
      overlayStructured(
        [chunk("delete", "old text"), chunk("insert", "new content")],
        body,
        "changes",
      ),
    ).toEqual([
      { kind: "diff_delete", text: "old text" },
      { kind: "diff_insert", text: "new content" },
    ]);
  });

  it("preserves a baseline citation when the diff leaves it untouched", () => {
    const body: BodySegment[] = [
      { kind: "text", text: "See " },
      { kind: "citation", raw: "Section 14B.16", citation_index: 0 },
      { kind: "text", text: "." },
    ];
    const equalText = "See Section 14B.16.";
    const out = overlayStructured([chunk("equal", equalText)], body, "changes");
    expect(out).toContainEqual({ kind: "citation", raw: "Section 14B.16", citation_index: 0 });
  });

  it("preserves a baseline defined_term when the diff leaves it untouched", () => {
    const body: BodySegment[] = [
      { kind: "text", text: "the " },
      { kind: "defined_term", raw: "Fund", def_id: "fund-def" as never },
      { kind: "text", text: " was created." },
    ];
    const equalText = "the Fund was created.";
    const out = overlayStructured([chunk("equal", equalText)], body, "changes");
    expect(out.some((s) => s.kind === "defined_term")).toBe(true);
  });

  it("preserves subsection_label segments from baseline body", () => {
    const newText = "(a) First paragraph.\n(b) Second paragraph.";
    const baselineBody = [...parseNewBody(newText)];
    const out = overlayStructured([chunk("equal", newText)], baselineBody, "changes");
    expect(out).toContainEqual({ kind: "subsection_label", label: "(a)" });
    expect(out).toContainEqual({ kind: "subsection_label", label: "(b)" });
  });

  it("emits an inserted subsection at the trailing end as diff_insert", () => {
    // Baseline ends after (a); bill appends "(c) Third." past the
    // end. The trailing insert surfaces via flushTail.
    const baselineBody = [...parseNewBody("(a) First.")];
    const out = overlayStructured(
      [chunk("equal", "(a) First."), chunk("insert", "\n(c) Third.")],
      baselineBody,
      "changes",
    );
    expect(out.some((s) => s.kind === "subsection_label" && s.label === "(a)")).toBe(true);
    // The trailing inserted text becomes a diff_insert (split on \n
    // into diff_insert + paragraph_break).
    expect(out.some((s) => s.kind === "diff_insert")).toBe(true);
  });

  it("preserves paragraph_break markers across the diff stream", () => {
    const body: BodySegment[] = [
      { kind: "text", text: "First." },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second." },
    ];
    const out = overlayStructured([chunk("equal", "First.\nSecond.")], body, "changes");
    expect(out).toEqual([
      { kind: "text", text: "First." },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second." },
    ]);
  });
});

// Regression suite for the atomic-segment wrapper-survival rule.
// The walker re-emits the original citation / defined_term /
// subsection_label segment only when its baseline chars came
// entirely from equal chunks AND no inserts landed inside the span.
// A delete that hits any portion of the wrapper, or an insert that
// lands inside it, means the bill rewrote text within the
// annotation — wrapper drops, consumed children render directly with
// their diff marks.
//
// Origin: §401 of bill 260538 rendered "Sec. 401" citations resurrected
// inside post-amendment prose. Root cause documented in PR #47.
describe("overlayStructured — atomic segment survival", () => {
  it("drops the citation wrapper when its chars came from a delete chunk", () => {
    // Baseline: '(see Sec. 401 history note.)'
    // Bill deletes the whole parenthetical. The "Sec. 401" citation
    // is consumed entirely from a delete chunk.
    const body: BodySegment[] = [
      { kind: "text", text: "(see " },
      { kind: "citation", raw: "Sec. 401", citation_index: 0 },
      { kind: "text", text: " history note.)" },
    ];
    const out = overlayStructured(
      [chunk("delete", "(see Sec. 401 history note.)")],
      body,
      "changes",
    );
    // Citation wrapper must NOT survive — its chars were deleted.
    expect(out.some((s) => s.kind === "citation")).toBe(false);
  });

  it("drops the citation wrapper on mixed delete+equal coverage", () => {
    // Replicates the §401 §260538 pattern: the citation 'Sec. 401' spans
    //   del "Sec." + equal " " + del "401"
    // The lone space slipped through as an equal — the prior heuristic
    // (consumed.every text-kind) saw "all text" and resurrected the
    // wrapper. With hadDelete tracking, the delete is seen directly.
    const body: BodySegment[] = [{ kind: "citation", raw: "Sec. 401", citation_index: 0 }];
    const out = overlayStructured(
      [chunk("delete", "Sec."), chunk("equal", " "), chunk("delete", "401")],
      body,
      "changes",
    );
    expect(out.some((s) => s.kind === "citation")).toBe(false);
  });

  it("drops the citation wrapper when an insert lands inside its span", () => {
    // Baseline citation 'Section 102' kept char-for-char by equals, but
    // an insert lands in the middle. The wrapper conceptually no
    // longer wraps a coherent citation; render children with marks.
    const body: BodySegment[] = [{ kind: "citation", raw: "Section 102", citation_index: 0 }];
    const out = overlayStructured(
      [chunk("equal", "Section "), chunk("insert", "415 and "), chunk("equal", "102")],
      body,
      "changes",
    );
    expect(out.some((s) => s.kind === "citation")).toBe(false);
    expect(out.some((s) => s.kind === "diff_insert")).toBe(true);
  });

  it("keeps the citation wrapper when chars came entirely from equals AND no inserts crossed", () => {
    const body: BodySegment[] = [
      { kind: "text", text: "See " },
      { kind: "citation", raw: "Section 14B.16", citation_index: 0 },
      { kind: "text", text: "." },
    ];
    const out = overlayStructured([chunk("equal", "See Section 14B.16.")], body, "changes");
    expect(out).toContainEqual({ kind: "citation", raw: "Section 14B.16", citation_index: 0 });
  });

  it("drops a defined_term wrapper on mixed delete+equal coverage", () => {
    const body: BodySegment[] = [
      { kind: "defined_term", raw: "Fund", def_id: "fund-def" as never },
    ];
    const out = overlayStructured(
      [chunk("delete", "Fu"), chunk("equal", "n"), chunk("delete", "d")],
      body,
      "changes",
    );
    expect(out.some((s) => s.kind === "defined_term")).toBe(false);
  });

  it("drops a subsection_label wrapper when an insert lands inside it", () => {
    const body: BodySegment[] = [{ kind: "subsection_label", label: "(a)" }];
    const out = overlayStructured(
      [chunk("equal", "("), chunk("insert", "b"), chunk("equal", "a)")],
      body,
      "changes",
    );
    expect(out.some((s) => s.kind === "subsection_label")).toBe(false);
  });
});

describe("bodyFromText", () => {
  it("returns an empty array for empty input", () => {
    expect(bodyFromText("")).toEqual([]);
  });

  it("wraps plain text in a single segment", () => {
    expect(bodyFromText("Hello.")).toEqual([{ kind: "text", text: "Hello." }]);
  });

  it("splits at newlines into text + paragraph_break", () => {
    expect(bodyFromText("First.\nSecond.")).toEqual([
      { kind: "text", text: "First." },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second." },
    ]);
  });
});
