# Ordinance Body Parsing — Layer 1 + Layer 2 Shipped

Companion to `docs/spike-pdf-typography-correlation.md` and
`docs/spike-ordinance-structural-anchoring.md`. Those two spikes
established (a) the structural pass that buckets a Legistar PDF into
`(module_id, section_id)` pairs and (b) the deferral of typography
decoding (insertion/deletion styling) for `text_diff`. This document
captures the **body-parsing work between them**: turning the extracted
PDF text into a readable, navigable document.

## Status

**Layers 1 and 2 shipped** in `feat/ordinance-text-parsing`. Layer 3
(typography colorization) remains deferred — it sits on top of Layer 2
as the spike doc originally described.

PR #36 (`feat/ordinance-ingestion`) shipped the initial `proposed_text`
string and the chrome-stripping pass at `text-cleanup.ts`. The current
work replaces `proposed_text` end-to-end with a structured
`Bill.body: OrdinanceBody`, parsed once by the pipeline and rendered as
a hierarchy of preamble / per-AMEND-section / closing blocks.

## What's in scope

Three layers, in order. Layer 1 and Layer 2 are shipped; Layer 3 is the
next milestone.

### Layer 1 — Paragraph reflow (shipped)

Collapse single newlines within a paragraph into spaces; keep blank
lines as paragraph separators. Identify structural-marker lines
(bracket-title, `Ordinance amending …` / `Be it ordained …` preamble,
`Section N.` action lines, nested `SEC. <id>. <TITLE>` headers,
`(a)`/`(b)`/`(1)`/`(2)` subsection markers, `APPROVED AS TO FORM`
signature opener) and insert a blank line before each. The existing
"blank line separates paragraphs" rule then carries the load.

**Where it lives:**

- `src/parser/bills/text-cleanup.ts` exposes `stripChrome` (chrome
  removal, line breaks preserved) and `reflowParagraphs` (paragraph
  joining with structural-marker breaks). `cleanupOrdinanceText` =
  `reflowParagraphs(stripChrome(text))` for callers that want the
  end-to-end pass.
- **No renderer change in Layer 1.** Reflow is a parser concern;
  the renderer migration happens once in Layer 2 (see below). This
  avoids the throwaway `<pre>` → `<p>` churn the original spec
  proposed.

**Tests:** `test/parser/bills/text-cleanup.test.ts` covers chrome
stripping (existing cases reflowed under the new rule) and the new
reflow surface — wrapped-paragraph join, blank-line preservation, the
"does NOT reflow into SEC. / subsection-marker / action-line" cases,
and the comma-separated sponsor-list regression seeded from file
260544.

### Layer 2 — Body structure parsing (shipped)

The body parser at `src/parser/bills/body-parser.ts` consumes the
chrome-stripped text plus the `StructuralPassResult` from
`structural-pass.ts` and emits an `OrdinanceBody`:

```ts
type OrdinanceBody = {
  preamble: string;             // text before the first AMEND group
  sections: Array<{
    action: string;             // "Section N. <Code> Code is hereby amended…"
    target: {
      module_id: ModuleId;
      raw_section_id: string;
    } | null;
    body: OrdinanceBlock[];
  }>;
  closing: string;              // text after the last AMEND group
};

type OrdinanceBlock =
  | { kind: "section_header"; number: string; title: string }
  | { kind: "subsection"; marker: string; body: OrdinanceBlock[] }
  | { kind: "paragraph"; text: string };
```

**Locked architectural decisions:**

- **D1 — `body` replaces `proposed_text` (no dual source of truth).**
  `Bill.proposed_text` is removed; the pipeline regenerates every
  Bill JSON end-to-end, so there's no migration boundary to preserve.
  The fallback shape — emitted when the structural pass found zero
  AMEND groups — is `{ preamble: <all cleaned text>, sections: [],
  closing: "" }`. `Bill.body` is always present and always
  renderable.

- **D2 — One source of truth for the document skeleton.** The body
  parser does NOT re-detect AMEND action lines or SEC. headers. It
  slices the chrome-stripped text using the offsets the structural
  pass already produced (`text_offset_start`, `text_offset_end`,
  `text_offset_after_header` on each section). Its job is tokenisation
  inside a SEC. range — paragraphs and paren subsection markers. New
  in T1: `StructuralPassResult.preamble_range` and
  `StructuralPassResult.closing_range` carve out the everything-before
  and everything-after slices that body-parser feeds back as plain
  prose strings.

- **D3 — Layer 1 is parser-only; the renderer migrates once in
  Layer 2.** `BillView` swaps `<pre className="lc-billview-proposed-body">`
  for a structured render: preamble paragraphs → for each section
  { action line, OrdinanceBlock[] } → closing paragraphs. The
  `white-space: pre-wrap` / `tab-size` rules are dropped; structured
  CSS classes (`.lc-billview-action`, `.lc-billview-section-header`,
  `.lc-billview-subsection`, `.lc-billview-paragraph`) replace them.

- **A3 — Parse-quality gate.** If the structural pass identified N
  `(group, section)` pairs, the body parser MUST emit a
  `section_header` block for each. A mismatch throws synchronously at
  ingest. No configurable threshold — per
  `project_legal_corpus_zero_skip` a SEC. that the renderer's section
  navigation depends on can never be silently dropped. The gate is
  defensive: today's walker emits one header per claimed section by
  construction, so it never trips on clean structural-pass output.
  Its value is catching future regressions where the walker grows a
  skip path.

- **A5 — Operator-only quality channel.** Soft body-quality concerns
  (an action line that came out empty after reflow; a SEC. with no
  body content) surface as `ParseBillResult.body_quality_warnings:
  string[]`, propagated to `SyncResult.body_warnings` so the
  `sync-bills` operator log shows the count next to
  `unresolved_sections`. They are never a fourth `parse_status`
  bucket — readers can't act on body parser internals.

- **C1 — Layer 2 subsection has no `lead_in` field.** SF ordinance
  `(a)` markers are followed by a bold-italic phrase
  (`Materials and Cleaning Thereof.`) and then body prose. Extracting
  the phrase as a separate field requires per-span font-style
  information that only Layer 3 (typography) supplies. Heuristics
  without that signal produce false positives (every subsection whose
  first sentence isn't a bold-italic label gets mislabeled), so
  Layer 2 emits `{ kind: "subsection"; marker; body }` — the
  bold-italic phrase shows up at the start of the first paragraph.
  Restoring `lead_in` is captured in TODOS.md and owned by the
  Layer 3 PR.

**Mandatory regression fix bundled in:** the inline-sponsor-reprint
regex in `text-cleanup.ts` now handles comma-separated name lists
(`Supervisors Wong; Sauter, Sherrill`) in addition to semicolon-only
lists. File 260544's SEC. 515 body carried this shape mid-sentence
under the old regex; the extended pattern strips the whole list and
the surrounding text rejoins cleanly. Test fixture lives in
`test/parser/bills/text-cleanup.test.ts`.

**Structural-pass robustness fix bundled in:** the `SECTION_HEADER_RE`
character class for titles now accepts en-dash (`–`), em-dash (`—`),
semicolon (`;`), and colon (`:`) in addition to the original
hyphen-minus, comma, ampersand, apostrophe, and parens. File 260545's
`SEC. 695. PERMIT REQUIRED – ENFORCEMENT.` title was silently missed by
the previous regex; the body parser would then attribute the SEC. 695
header to subsection `(g)`'s body. Catching every SEC. header is a
completeness requirement under
`project_legal_corpus_zero_skip` — there's no acceptable silent skip
threshold.

**Fixture conventions.** Body-parser fixtures live at
`test/parser/bills/fixtures/body-parser/<jurisdiction>-<file_no>.txt`
plus `.expected.json`. Per `project_tests_are_hermetic`, committed
chrome-stripped input + expected `OrdinanceBody` output, no network at
test time. Seed bills: `sf-police-260544` (two SEC. headers, comma
sponsor regression seed) and `sf-health-260545` (two AMEND groups,
subsections (a)–(g), en-dash title).

### Layer 3 — Typography colorization (the existing spike)

Still captured by `docs/spike-pdf-typography-correlation.md`. Decodes
underline-italic (insertions) and strikethrough-italic (deletions) from
PDF runs and emits the per-span `text_diff[]` that the renderer
colorizes. Sits on top of Layer 2's structure — the structured body
provides anchor points where span-level diff styling attaches.

**Dependency:** Layer 3 still depends on Layer 2 (now shipped).
Restoring `lead_in` on subsections happens as part of Layer 3, when
italic spans are available.

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

## When to pick up Layer 3

The natural trigger is the next "the typography decoder lets me see
insertions / deletions" milestone. Layer 3 brings:

- Subsection `lead_in` populated from italic spans (per C1 deferral).
- `Bill.text_diff[]` populated and rendered as colored insertion /
  deletion spans inside the existing OrdinanceBlock tree.
- `parse_status === "ok"` becomes a real bucket again (today every
  parse lands in `manual_review` because `text_diff` is empty).

The spike doc is the reference; this branch is the prerequisite.
