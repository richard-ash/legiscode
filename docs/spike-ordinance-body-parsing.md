# Ordinance Body Parsing — Deferred Follow-Up

Companion to `docs/spike-pdf-typography-correlation.md` and
`docs/spike-ordinance-structural-anchoring.md`. Those two spikes
established (a) the structural pass that buckets a Legistar PDF into
`(module_id, section_id)` pairs and (b) the deferral of typography
decoding (insertion/deletion styling) for `text_diff`. This document
captures the **body-parsing work that sits between them**: turning the
extracted PDF text into a readable, navigable document.

## Status

**Deferred.** PR #36 (`feat/ordinance-ingestion`) ships a `proposed_text`
string on every `Bill` row, with a cleanup pass (`text-cleanup.ts`) that
strips known PDF chrome (page line numbers, "BOARD OF SUPERVISORS  Page
N" footers, sponsor reprints, the "FILE NO. NNNNNN" header, the
typography legend). The renderer drops the cleaned text into a single
`<pre>` block with `white-space: pre-wrap`.

That ships the data, but not the reading experience. PDFs wrap text at
~80 characters; those line breaks are preserved by the extractor and
re-emitted as hard breaks in the `<pre>` block. A paragraph that should
reflow to the reading column instead stair-steps at an invisible 80-char
ruler. Subsection structure (`SEC. 407.`, `(a)`, `(b)`, `(c)`, "Section
1. Article 8...") is encoded only as text — no headings, no indentation
hierarchy, no navigation surface.

This branch tracks the work to fix that.

## Scope

Three layers, in order. Each is independently shippable.

### Layer 1 — Paragraph reflow (~30 min)

Collapse single newlines within a paragraph into spaces; keep blank
lines as paragraph separators. Render the result as `<p>` elements
instead of a `<pre>` block.

**Where it lives:**
- `src/parser/bills/text-cleanup.ts` — extend `cleanupOrdinanceText`
  (or add a sibling `reflowParagraphs`) so the output is paragraph-
  delimited prose, not preserved-line-break text.
- `src/ui/center-panel/bill-view/bill-view.tsx` — replace the `<pre
  className="lc-billview-proposed-body">` with a `<p>`-per-paragraph
  render. Drop the `pre-wrap` / `tab-size` styling from
  `src/styles/bills.css`.

**Test fixture target:** the existing `test/parser/bills/text-cleanup.test.ts`
suite. Add a "reflows paragraph line breaks into spaces" case using a
real-shaped fixture (5-line wrapped paragraph in, single flowing
paragraph out).

**Risk:** the line-break-vs-paragraph-break heuristic is the load-
bearing call. Likely "two consecutive newlines means paragraph break;
single newline inside a paragraph means wrap." Verify against the
existing `sf-health/260545` and `sf-police/260544` saved bills before
shipping.

### Layer 2 — Body structure parsing (~half-day)

Detect ordinance body structure and emit a hierarchical document
model instead of a flat string. Target structures (SF Legistar
template):

- **Action lines:** `Section 1. Article 8 of the Health Code is hereby
  amended by deleting Section 407, to read as follows:`
- **Section headers:** `SEC. 407. CONVEYANCE OF BREAD, ETC., THROUGH
  PUBLIC STREETS.` (uppercase, period-terminated, often followed by a
  newline)
- **Subsection markers:** `(a)  Materials and Cleaning Thereof.`,
  `(b)  Definition.`, `(c)  Sterilization.` (paren letter + bold-style
  inline lead-in)
- **Numbered list items:** rare in this corpus but should be handled
  (`(1)`, `(2)`, ...)
- **Closing clauses:** `Be it ordained by the People of the City and
  County of San Francisco:`, signature blocks (Mayor / City Attorney /
  Department head).

**Output shape (proposal — refine when picking up):**

```ts
type OrdinanceBody = {
  preamble: string;           // long_title + "Be it ordained..."
  sections: Array<{
    action: string;           // "Section 1. Article 8..."
    target: {                 // parsed from action
      module_id: ModuleId;
      raw_section_id: string;
    } | null;
    body: OrdinanceBlock[];
  }>;
  closing: string;            // signature block + boilerplate
};

type OrdinanceBlock =
  | { kind: "section_header"; number: string; title: string }
  | { kind: "subsection"; marker: string; lead_in: string; body: string }
  | { kind: "paragraph"; text: string };
```

**Where it lives:**
- New module: `src/parser/bills/body-parser.ts` — pure function from
  cleaned text → `OrdinanceBody`.
- `src/types/bill.ts` — add `body: OrdinanceBody | null` to `Bill`,
  alongside the existing `proposed_text` (keep the raw string for v1
  back-compat and graceful fallback).
- `src/ui/center-panel/bill-view/bill-view.tsx` — when `body` is
  present, render the structured form; fall back to the Layer 1
  paragraph-reflowed text when the body parser couldn't make sense of
  the input.
- CSS in `src/styles/bills.css` — `.lc-billview-section-header`,
  `.lc-billview-subsection`, `.lc-billview-paragraph`.

**Test target:** new `test/parser/bills/body-parser.test.ts` with
end-to-end fixtures from the saved sf-health and sf-police bills.

**Risk:** the parser has to be conservative. If a paragraph doesn't
match a known structure, emit `kind: "paragraph"` and move on — never
silently drop content. The `parse_status` enum gets a fourth bucket if
we need to surface "body parser couldn't structure this" to the
renderer, but defaulting to "render as flat paragraphs" should be
enough for the long tail.

### Layer 3 — Typography colorization (the existing spike)

Already captured by `docs/spike-pdf-typography-correlation.md`.
Decodes underline-italic (insertions) and strikethrough-italic
(deletions) from PDF runs and emits the per-span `text_diff[]` that
the renderer colorizes. Sits on top of Layer 2's structure — without a
hierarchical body, there's nowhere coherent to attach span-level
diff styling.

**Dependency:** Layer 3 should not start before Layer 2 lands. The
spike doc treats Layer 3 as the next renderer milestone after
`proposed_text`; this branch makes Layer 2 the actual prerequisite.

## Out of scope (explicitly)

- **PDF version diffing.** When a bill is amended between versions,
  Legistar generates a new redline. We do not yet have a "show me the
  diff between v2 and v3 of the same matter" surface; that's a
  separate problem.
- **Cross-jurisdiction template drift.** This whole document is
  SF-Legistar-specific. CA Assembly / US Congress will surface
  different chrome patterns, different action-line vocabulary,
  different section-marker conventions. Add new
  `<jurisdiction>-text-cleanup.ts` modules when those jurisdictions
  become real requirements, per `feedback_text_parsing_load_bearing`.
- **PDF positioning preservation.** If a section is laid out in
  columns or has tables, we don't try to recover the original visual
  layout. The output is reading-order text.

## When to pick this up

The natural trigger is "the user reaction to the bill view is 'I
can't read this.'" That reaction surfaced on PR #36; the staff-eng
call was that paragraph reflow + body structure parsing is real
follow-up work, not a same-PR polish. Layer 1 is independently
shippable as a quick win; Layer 2 is the bulk of the value; Layer 3
follows.

The spec is here. The branch name is the reminder.
