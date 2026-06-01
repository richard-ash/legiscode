// Body parser — turns chrome-stripped ordinance text plus a
// StructuralPassResult into an OrdinanceBody. This is the Layer 2
// follow-up to the spike at docs/spike-ordinance-body-parsing.md:
// instead of handing the renderer a flat `proposed_text` string, the
// pipeline now emits a structured document with preamble, per-AMEND
// sections, and closing boilerplate.
//
// **Architecture (locked):**
//
// - **One source of truth for the document skeleton (D2).** body-parser
//   doesn't re-detect AMEND action lines or SEC. headers; it slices
//   the chrome-stripped text using the offsets the structural pass
//   already produced. Its job is the tokenisation INSIDE a SEC.
//   range — paragraphs and paren subsection markers `(a)`, `(b)`,
//   `(1)`, `(2)`, …
//
// - **Parse-quality gate (A3).** If structural-pass identified N
//   `(group, section)` pairs, body-parser MUST emit a `section_header`
//   block for each. A mismatch throws synchronously at ingest. No
//   configurable threshold — legal corpus completeness is a hard gate
//   (see `project_legal_corpus_zero_skip`).
//
// - **Operator-only quality channel (A5).** Soft body-quality concerns
//   surface as `quality_warnings: string[]` for the operator log,
//   never as a 4th `parse_status` bucket — readers can't act on body
//   parser internals.
//
// - **Always renderable (D1).** When the structural pass found zero
//   groups, the parser emits `{ preamble: <all text>, sections: [],
//   closing: "" }`. The renderer always has something to show.

import type { OrdinanceBlock, OrdinanceBody } from "@/types";
import type { CodeGroup, StructuralPassResult } from "./structural-pass";
import { reflowParagraphs } from "./text-cleanup";

export type ParseBodyResult = {
  body: OrdinanceBody;
  /**
   * Soft body-quality concerns the operator should see — empty when
   * the parse looks clean. Examples: an AMEND group whose action-line
   * slice came out empty after reflow, or a SEC. with no body content.
   * Flows into the operator log alongside `unresolved_sections`.
   */
  quality_warnings: string[];
};

/**
 * Parse the chrome-stripped ordinance text into an OrdinanceBody using
 * the offsets the structural pass produced.
 *
 * @param chromeStripped output of `stripChrome(rawText)`. The offsets
 *   in `pass` must match this exact string (callers run both against
 *   the same input).
 * @param pass `runStructuralPass(chromeStripped, installed)`.
 *
 * Throws when the A3 parse-quality gate trips — the structural pass
 * found a SEC. header the body parser couldn't account for.
 */
export function parseBody(chromeStripped: string, pass: StructuralPassResult): ParseBodyResult {
  const warnings: string[] = [];

  // Fallback shape — structural pass found nothing actionable. The
  // whole document becomes preamble so the renderer can still surface
  // the cleaned ordinance text.
  if (pass.groups.length === 0) {
    return {
      body: {
        preamble: reflowParagraphs(chromeStripped).trim(),
        sections: [],
        closing: "",
      },
      quality_warnings: warnings,
    };
  }

  const preambleSlice = chromeStripped.slice(pass.preamble_range.start, pass.preamble_range.end);
  const closingSlice = chromeStripped.slice(pass.closing_range.start, pass.closing_range.end);
  const preamble = reflowParagraphs(preambleSlice).trim();
  const closing = reflowParagraphs(closingSlice).trim();

  let expectedHeaders = 0;
  let emittedHeaders = 0;
  const sections: OrdinanceBody["sections"] = [];

  for (const group of pass.groups) {
    expectedHeaders += group.sections.length;
    const result = parseGroup(chromeStripped, group, warnings);
    emittedHeaders += result.headersEmitted;
    sections.push(result.section);
  }

  // A3 parse-quality gate. The structural pass is the document
  // skeleton; if the body parser can't account for every SEC. header
  // it identified, the output would silently lose structural anchors
  // the renderer depends on. Throw rather than ship a partial body.
  if (emittedHeaders !== expectedHeaders) {
    throw new Error(
      `body-parser: parse-quality gate tripped — structural pass identified ${expectedHeaders} SEC. header(s) but body parser emitted ${emittedHeaders}`,
    );
  }

  return {
    body: { preamble, sections, closing },
    quality_warnings: warnings,
  };
}

type GroupParseResult = {
  section: OrdinanceBody["sections"][number];
  headersEmitted: number;
};

function parseGroup(text: string, group: CodeGroup, warnings: string[]): GroupParseResult {
  // Action line: from the group's start to the first SEC. header (or
  // the group's end if no SEC. headers are nested inside, e.g. a
  // chapter-creation group). Reflow so wrapped action lines become
  // one prose sentence.
  const actionEnd = group.sections[0]?.text_offset_start ?? group.text_offset_end;
  const action = reflowParagraphs(text.slice(group.text_offset_start, actionEnd)).trim();
  if (action.length === 0) {
    warnings.push(`group at offset ${group.text_offset_start}: empty action line after reflow`);
  }

  const target =
    group.module_id !== null && group.sections[0]
      ? {
          module_id: group.module_id,
          raw_section_id: group.sections[0].raw_id,
        }
      : null;

  const body: OrdinanceBlock[] = [];
  let headersEmitted = 0;

  if (group.sections.length === 0) {
    // Whole-chapter / new-chapter action: no SEC. headers nested
    // inside. Emit the group's body content (after the action line)
    // as paragraph + subsection blocks so the renderer surfaces the
    // chapter scope text.
    const tail = text.slice(actionEnd, group.text_offset_end);
    body.push(...tokenizeBody(tail));
  } else {
    for (const section of group.sections) {
      // Normalise the title: PDF column wrap can split a long SEC.
      // title across two lines (e.g. `REGULATING ISSUANCE OF BOOKS TO
      // MINORS BY CIRCULATING\nLIBRARIES.`). The structural pass
      // captures the wrapped form verbatim so its char offsets stay
      // aligned with the source; the body parser collapses internal
      // whitespace runs into single spaces for the rendered block.
      body.push({
        kind: "section_header",
        number: section.raw_id,
        title: section.title.replace(/\s+/g, " ").trim(),
      });
      headersEmitted += 1;
      // Section body slice: from immediately AFTER the header (title
      // included) to the next section's start. The leading whitespace /
      // newline is consumed by the tokenizer as a paragraph separator.
      const sectionBody = text.slice(section.text_offset_after_header, section.text_offset_end);
      const blocks = tokenizeBody(sectionBody);
      if (blocks.length === 0) {
        warnings.push(`SEC. ${section.raw_id}: no body content after the header line`);
      }
      body.push(...blocks);
    }
  }

  return {
    section: {
      action: action.length > 0 ? action : "(action line unavailable)",
      target,
      body,
    },
    headersEmitted,
  };
}

// Paren-marker `(a)` or `(1)` at the start of a logical line (allowing
// leading whitespace). Captures the marker letter/number so the
// emitted subsection block can carry it verbatim.
const SUBSECTION_MARKER_RE = /^\s*\(([a-z]+|\d+)\)\s+/i;

/**
 * Tokenize a section's body into paragraph + subsection blocks.
 *
 * Walks lines, treating blank lines as paragraph separators. A line
 * starting with `(a)` / `(1)` opens a new subsection; any subsequent
 * paragraphs belong to that subsection's body until the next marker
 * starts. The marker prefix is stripped from the captured text; the
 * marker itself is carried as the subsection's `marker` field.
 *
 * No nested-subsection handling in Layer 2 — `(a)(1)` style nesting
 * shows up rarely in the SF corpus, and the simple flat shape covers
 * the observed cases. Layer 3 (typography) can extend this.
 */
function tokenizeBody(text: string): OrdinanceBlock[] {
  const lines = text.split("\n");
  const output: OrdinanceBlock[] = [];
  let buffer: string[] = [];
  let currentSubsection: { marker: string; body: OrdinanceBlock[] } | null = null;

  const flushParagraph = (): void => {
    if (buffer.length === 0) return;
    const para = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (para.length === 0) return;
    const target = currentSubsection ? currentSubsection.body : output;
    target.push({ kind: "paragraph", text: para });
  };

  const closeSubsection = (): void => {
    if (currentSubsection === null) return;
    output.push({
      kind: "subsection",
      marker: currentSubsection.marker,
      body: currentSubsection.body,
    });
    currentSubsection = null;
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    const m = SUBSECTION_MARKER_RE.exec(line);
    if (m) {
      flushParagraph();
      closeSubsection();
      const marker = `(${m[1]})`;
      currentSubsection = { marker, body: [] };
      const rest = line.slice(m[0].length).trim();
      if (rest.length > 0) buffer.push(rest);
    } else {
      buffer.push(line);
    }
  }
  flushParagraph();
  closeSubsection();
  return output;
}
