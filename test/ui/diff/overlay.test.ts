// v2 overlay walks DiffChunk[] in document order, mapping each chunk
// to a RenderBodySegment. No offset math, no gap fills — chunks are
// already sequential, equal/insert/delete adjacent in reading order.

import { describe, expect, it } from "vitest";
import type { DiffChunk, SectionId } from "@/types";
import { overlayDiffOnBaseline } from "@/ui/diff/overlay";

const SID = "test" as SectionId;

function chunk(op: DiffChunk["op"], text: string): DiffChunk {
  return { op, text, section_id: SID };
}

describe("overlayDiffOnBaseline (v2 — chunk renderer)", () => {
  it("returns the baseline as one text segment when no chunks are given", () => {
    expect(overlayDiffOnBaseline([], "Hello world.")).toEqual([
      { kind: "text", text: "Hello world." },
    ]);
  });

  it("returns nothing when both chunks and baseline are empty", () => {
    expect(overlayDiffOnBaseline([], "")).toEqual([]);
  });

  it("emits a single text segment for a verbatim equal chunk", () => {
    const baseline = "The committee meets quarterly.";
    expect(overlayDiffOnBaseline([chunk("equal", baseline)], baseline)).toEqual([
      { kind: "text", text: baseline },
    ]);
  });

  it("interleaves equal + insert + equal with the insert highlighted", () => {
    expect(
      overlayDiffOnBaseline(
        [
          chunk("equal", "The "),
          chunk("insert", "Advisory "),
          chunk("equal", "committee shall meet."),
        ],
        "The committee shall meet.",
      ),
    ).toEqual([
      { kind: "text", text: "The " },
      { kind: "diff_insert", text: "Advisory " },
      { kind: "text", text: "committee shall meet." },
    ]);
  });

  it("renders a delete chunk as struck", () => {
    expect(
      overlayDiffOnBaseline(
        [
          chunk("equal", "The "),
          chunk("delete", "Advisory "),
          chunk("equal", "committee shall meet."),
        ],
        "The Advisory committee shall meet.",
      ),
    ).toEqual([
      { kind: "text", text: "The " },
      { kind: "diff_delete", text: "Advisory " },
      { kind: "text", text: "committee shall meet." },
    ]);
  });

  it("splits text segments at \\n into paragraph_break markers", () => {
    expect(overlayDiffOnBaseline([], "First.\nSecond.")).toEqual([
      { kind: "text", text: "First." },
      { kind: "paragraph_break" },
      { kind: "text", text: "Second." },
    ]);
  });

  it("splits diff_delete chunks at newlines too", () => {
    expect(overlayDiffOnBaseline([chunk("delete", "DEL1\nDEL2")], "DEL1\nDEL2")).toEqual([
      { kind: "diff_delete", text: "DEL1" },
      { kind: "paragraph_break" },
      { kind: "diff_delete", text: "DEL2" },
    ]);
  });

  it("emits a wholesale rewrite as full-baseline delete then full insert", () => {
    // synthesizeWholesale's v2 output shape: one delete chunk for the
    // entire baseline followed by one insert chunk for the new body.
    expect(
      overlayDiffOnBaseline(
        [chunk("delete", "old text"), chunk("insert", "new content")],
        "old text",
      ),
    ).toEqual([
      { kind: "diff_delete", text: "old text" },
      { kind: "diff_insert", text: "new content" },
    ]);
  });

  it("renders adjacent inserts in source order (no offset reordering)", () => {
    // v2 chunks come from diffWords already in document order; the
    // renderer doesn't re-sort. "(a) Definition" stays in that order.
    expect(
      overlayDiffOnBaseline(
        [
          chunk("insert", "(a)"),
          chunk("equal", " "),
          chunk("insert", "Definition"),
          chunk("equal", "anything"),
        ],
        " anything",
      ),
    ).toEqual([
      { kind: "diff_insert", text: "(a)" },
      { kind: "text", text: " " },
      { kind: "diff_insert", text: "Definition" },
      { kind: "text", text: "anything" },
    ]);
  });
});
