// Sources-block parser. Single shared parser consumed by BOTH the
// verifier (validates the model didn't list refs it never fetched) and
// the renderer (turns each entry into a clickable chip). One regex,
// two consumers, zero drift — per D3.
//
// Block shape (Markdown, per F2 design):
//
//   **Sources**
//   - [sf-planning § 106] — Zoning Map Incorporated Herein
//   - [sf-planning § 105] — Zoning Map
//   - [Bill #260543] — Police Code Penalty
//
// Tolerated variants:
//   - heading "**Sources**", "**Sources:**", or "## Sources" / "### Sources"
//   - list markers `-` or `*` (Markdown both)
//   - title separator " — " (em dash), " – " (en dash), " - " (hyphen),
//     or ": " (colon); the title itself is optional
//   - extra blank lines between items
//
// ReDoS guard: every regex used here is linear-time (no nested
// quantifiers); input above MAX_INPUT_LENGTH skips parsing entirely
// and returns the not-present sentinel. The cap soaks operator-pasted
// or model-runaway inputs — production prose stays well under it.

/** Hard cap on input length. Real assistant prose is in single-digit KB. */
const MAX_INPUT_LENGTH = 50_000;

/** Matches the Sources heading line. Anchored to a line start in the
 *  multiline string so a literal "Sources" in body prose can't trigger
 *  a false positive. Linear-time — no nested quantifiers. */
const HEADING_RE = /^(?:\*\*Sources(?::)?\*\*|#{2,6}\s+Sources(?::)?)\s*$/im;

/** Each list item: `- [ref]` or `- [ref] — title`. Linear-time. */
const ITEM_RE = /^[-*]\s+\[([^\]\n]{1,256})\](?:\s*[—–:-]\s*(.{0,512}?))?\s*$/;

/** Bill ref inside the brackets: `Bill #260543`. */
const BILL_REF_RE = /^Bill\s*#(\d{3,12})$/i;

/** Section ref inside the brackets: `module-id § section-id`. */
const SECTION_REF_RE = /^([a-z][a-z0-9-]{0,80})\s*§\s*([a-z0-9][a-z0-9._-]{0,80})$/i;

export type SourceEntryKind = "section" | "bill" | "unknown";

export interface SourceEntry {
  /** Verbatim bracketed string from the block ("[module § id]" or "[Bill #N]"). */
  display: string;
  kind: SourceEntryKind;
  /** Section refs only — null on bills/unknown. */
  module_id: string | null;
  section_id: string | null;
  /** Bill refs only — null on sections/unknown. */
  file_no: string | null;
  /** Optional title text after the dash separator; empty when absent. */
  title: string;
  /** Char offset in the input where the line starts. Renderer uses this
   *  to slice the heading out of prose before rendering the body. */
  startIndex: number;
  /** Char offset just past the line end (exclusive). */
  endIndex: number;
}

export interface ParsedSourcesBlock {
  /** True when a Sources heading was found. */
  present: boolean;
  /** Char offset of the heading in `text` (-1 when not present). */
  headingStart: number;
  /** Char offset just past the last block line (-1 when not present). */
  blockEnd: number;
  entries: readonly SourceEntry[];
}

/**
 * Parse the Sources block at the END of an assistant answer (it's a
 * trailing section by convention). Returns present=false when no heading
 * is found.
 *
 * The block extends from the heading down through consecutive list items
 * and blank lines; the first non-blank non-list-item line terminates it.
 * Unparseable bracket contents (neither section nor bill shape) are kept
 * as `kind: "unknown"` entries so the renderer can still surface them as
 * plain-text chips and the verifier can flag them.
 */
export function parseSourcesBlock(text: string): ParsedSourcesBlock {
  if (text.length === 0 || text.length > MAX_INPUT_LENGTH) {
    return { present: false, headingStart: -1, blockEnd: -1, entries: [] };
  }
  const headingMatch = HEADING_RE.exec(text);
  if (!headingMatch || headingMatch.index === undefined) {
    return { present: false, headingStart: -1, blockEnd: -1, entries: [] };
  }
  const headingStart = headingMatch.index;
  const afterHeadingIdx = headingStart + headingMatch[0].length;
  const entries: SourceEntry[] = [];
  let cursor = afterHeadingIdx;
  let blockEnd = afterHeadingIdx;

  while (cursor < text.length) {
    // Advance past a leading \n.
    if (text[cursor] === "\n") {
      cursor += 1;
      continue;
    }
    const nextNewline = text.indexOf("\n", cursor);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(cursor, lineEnd);
    if (line.trim() === "") {
      cursor = lineEnd + 1;
      continue;
    }
    const itemMatch = ITEM_RE.exec(line);
    if (!itemMatch) {
      // First non-blank non-item line ends the block. Don't consume it.
      break;
    }
    const refStr = (itemMatch[1] ?? "").trim();
    const titleStr = (itemMatch[2] ?? "").trim();
    const display = `[${refStr}]`;
    let entry: SourceEntry;
    const billMatch = BILL_REF_RE.exec(refStr);
    if (billMatch?.[1]) {
      entry = {
        display,
        kind: "bill",
        module_id: null,
        section_id: null,
        file_no: billMatch[1],
        title: titleStr,
        startIndex: cursor,
        endIndex: lineEnd,
      };
    } else {
      const sectionMatch = SECTION_REF_RE.exec(refStr);
      if (sectionMatch?.[1] && sectionMatch[2]) {
        entry = {
          display,
          kind: "section",
          module_id: sectionMatch[1].toLowerCase(),
          section_id: sectionMatch[2].toLowerCase(),
          file_no: null,
          title: titleStr,
          startIndex: cursor,
          endIndex: lineEnd,
        };
      } else {
        entry = {
          display,
          kind: "unknown",
          module_id: null,
          section_id: null,
          file_no: null,
          title: titleStr,
          startIndex: cursor,
          endIndex: lineEnd,
        };
      }
    }
    entries.push(entry);
    blockEnd = lineEnd;
    cursor = lineEnd + 1;
  }

  return {
    present: true,
    headingStart,
    blockEnd,
    entries,
  };
}

/**
 * Slice the assistant prose into the body (everything before the
 * Sources block) and the block (the heading + items). Used by the
 * renderer to render the two regions differently — inline citations
 * in the body, chip grid in the block.
 *
 * When the block is absent the full text is the body and `block` is
 * an empty string.
 */
export function splitProseAndSources(text: string): { body: string; block: string } {
  const parsed = parseSourcesBlock(text);
  if (!parsed.present) return { body: text, block: "" };
  // Trim trailing whitespace off the body — the heading was preceded by
  // a blank line by convention.
  return {
    body: text.slice(0, parsed.headingStart).replace(/\s+$/, ""),
    block: text.slice(parsed.headingStart, parsed.blockEnd),
  };
}
