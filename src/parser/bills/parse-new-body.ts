// parseNewBody — build a structured BodySegment[] from the reconstructed
// post-amendment text of a section.
//
// This is the lightweight counterpart to the corpus body builder
// (src/parser/build-body-segments.ts). The corpus pipeline has access to
// citation matches, definitions, and the module-wide glossary recognizer;
// for the post-amendment text of a bill we do not have those inputs
// reliably (an inserted phrase may reference a new section number that
// resolves nowhere). v1 emits a structural subset:
//
//   • text             — plain prose
//   • subsection_label — paragraph-leading "(a)", "(b)(2)", … markers
//                        (same regex the corpus body builder uses)
//   • paragraph_break  — '\n' boundaries between paragraphs
//
// The roundtrip invariant `bodyToText(body) === newText` holds — the
// section-file schema's refine asserts this on disk-loaded sections, and
// the same property lets the structured diff overlay align its diff_chunks
// to the new_body segment ranges byte-for-byte.
//
// Future passes can layer citations and defined-term occurrences on top
// without changing the output shape — the BodySegment union already
// accepts those kinds. Until then, citations in inserted text render as
// plain prose; baseline citations the bill leaves untouched are surfaced
// by the renderer via the baseline section's body[], not new_body.

import type { BodySegment } from "@/types";

// Match the regex in build-body-segments.ts so a label that the corpus
// pass would recognize is also recognized here. Kept as a literal (not
// imported) so the two parsers stay self-contained — drift surfaces as
// a fixture-level failure, not a hidden cross-file coupling.
const SUBSECTION_LABEL_RE = /(?:^|\n)(\s*((?:\([A-Za-z0-9]+\))+)\s+)(?=[A-Z])/g;

/**
 * Parse `newText` into a flat BodySegment[]. The body re-flattens
 * byte-for-byte: `bodyToText(parseNewBody(t)) === t` for every input.
 */
export function parseNewBody(newText: string): readonly BodySegment[] {
  if (newText.length === 0) return [];

  // Pass 1 — locate subsection labels. We collect (start, end, label)
  // triples and then tile the text with subsection_label + text leaves.
  const labels: Array<{ start: number; end: number; label: string }> = [];
  for (const match of newText.matchAll(SUBSECTION_LABEL_RE)) {
    const fullStart = match.index ?? 0;
    const fullMatch = match[0] ?? "";
    const label = match[2] ?? "";
    if (!label) continue;
    const labelStart = fullStart + fullMatch.indexOf(label);
    labels.push({ start: labelStart, end: labelStart + label.length, label });
  }

  // Pass 2 — tile text[0, length) with subsection_label leaves + text
  // gaps. Within each text gap, split on \n into paragraph_break
  // markers so the renderer can pick up paragraph boundaries.
  const out: BodySegment[] = [];
  let cursor = 0;
  for (const l of labels) {
    if (l.start > cursor) emitTextWithBreaks(out, newText.slice(cursor, l.start));
    out.push({ kind: "subsection_label", label: l.label });
    cursor = l.end;
  }
  if (cursor < newText.length) emitTextWithBreaks(out, newText.slice(cursor));
  return out;
}

function emitTextWithBreaks(out: BodySegment[], slice: string): void {
  if (slice.length === 0) return;
  const parts = slice.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: "paragraph_break" });
    const piece = parts[i];
    if (piece !== undefined && piece.length > 0) {
      out.push({ kind: "text", text: piece });
    }
  }
}
