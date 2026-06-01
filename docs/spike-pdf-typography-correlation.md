# PDF Typography Correlation — Day-0 Spike Addendum

Companion to `docs/spike-ordinance-structural-anchoring.md`. The earlier
spike validated that SF Legistar ordinance redline PDFs can be
deterministically bucketed into `(module_id, section_id)` pairs via a
text-pattern structural pass. This addendum records the v1 typography-
decode decision: **deferred to a follow-up PR**, with `parse_status:
"manual_review"` carrying the per-bill verdict in the interim.

## Status

**Deferred for v1.** The parser ships the structural pass only:
identify which (module, sections) each bill touches, emit one `Bill`
per touched module with `affected_sections` populated and
`text_diff: []`. Per-span underline/strikethrough decoding lives with
the inline-diff renderer PR (see the locked plan, "Renderer-scope
expansion" section).

## What this means for `parse_status`

The 3-bucket enum from the structural-anchoring spike maps as follows
in v1:

| Bucket               | v1 condition                                                                          | Renderer surface                                            |
| -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ok`                 | Reserved. v1 never emits this; the follow-up inline-diff PR will.                      | (n/a)                                                       |
| `manual_review`      | AMEND ordinance-section identified; structural pass succeeded; text_diff[] empty.     | Banner + Impact card + bill-detail body show "see PDF" CTA. |
| `structural_change`  | Whole-chapter creation / repeal pattern matched in the document.                       | Prominent "Open original PDF →" CTA above the section list. |

The renderer treats `manual_review` as the v1 default for Class A
bills; the Pass-2 state table for the renderer covers all five surfaces
of this case. `feedback_no_placeholder_ui` is honored: surfaces hide
entirely when no bills are loaded, but render normally when bills are
present even with `parse_status: "manual_review"`.

## Why deferred

Three reasons, in priority order:

1. **First user value lives upstream.** Knowing *which* sections a
   pending bill touches is the policy-analyst's primary need; *what*
   the diff says is secondary. The structural pass delivers the first
   without depending on the second. Shipping the structural pass to
   the renderer right now means the operator and analyst journeys
   (Journey A and B in the design plan) land in v1; the city-attorney
   PDF-pivot journey (Journey C) also lands because every
   `manual_review` card carries the "Open original PDF" affordance.

2. **The decoder's correctness is empirically gated.** The
   structural-anchoring spike validated 100% structural recall on the
   3-PDF + 4-HTML corpus. The typography decoder needs a separate
   labelled corpus (hand-annotated insertion/deletion spans across
   20+ PDFs) before any "≥95% precision" claim. Building that corpus
   is the gating work for the inline-diff PR; doing it inside this PR
   blows the scope.

3. **The shipping unit is testable end-to-end.** The fetcher, parser,
   writer, loader, and renderer all become testable end-to-end with
   the structural pass alone — committed fixture PDFs flow through
   the pipeline to per-module `Bill` files that the renderer
   consumes. The deferred decoder slots in later with no schema
   change (text_diff[] grows non-empty; parse_status flips to "ok"
   for cleanly-decoded bills).

## Corpus-wide manual_review budget

Per the Codex amendment to the original spike framing
(corpus-wide budget replaces per-PDF precision), v1's budget is
**100% manual_review on Class A bills with no structural action**.
This is the planned v1 baseline, not a regression: the typography
decoder hasn't run yet, so every parsable Class A bill defaults to
manual_review. The follow-up PR will tighten this budget toward the
spike's target as inline-diff decoding lands.

The 2 committed fixture PDFs produce:

| Fixture       | parse_status         | Reason                                       |
| ------------- | -------------------- | -------------------------------------------- |
| `260217.pdf`  | `manual_review` × N  | Multi-code amendment; structural pass only.  |
| `260296.pdf`  | `structural_change`  | "by adding Chapter 94C" pattern matched.     |

(N = number of touched_modules identified by the title classifier
that intersect with installed modules.)

## What the deferred PR needs

When the inline-diff PR lands:

1. **A labelled corpus** of 20+ pending-bill PDFs with hand-annotated
   `TextDiffSpan[]` ground truth (per the Codex amendment #7
   wording). Re-use `260217.pdf` + `260296.pdf` from this PR's
   fixtures as the seed set.
2. **`src/parser/bills/classify-spans.ts`** — position-correlate
   pdfjs `getOperatorList()` graphics ops (constructPath + stroke)
   against text-run baselines, discriminate underline (insertion) vs
   strikethrough (deletion).
3. **`src/parser/bills/emit-diff.ts`** — emit `TextDiffSpan[]` with
   `section_id` per span; pass elision sentinels (`* * * *`) through
   as `op: "context"` literal spans (per C3 lock in the plan).
4. **`src/parser/bills/italic.ts`** — font-name → italic flag,
   gated by the page-1 NOTE block invariant (any PDF missing the
   standard SF redline NOTE falls through to `manual_review`).
5. **Bump the corpus-wide budget threshold** from 100% to whatever
   the decoder achieves on the labelled corpus; the plan calls for
   ≤X% (TBD by spike results), measured per
   `project_legal_corpus_zero_skip`.

## What this spike does NOT cover

Same exclusions as the structural-anchoring spike:

- Cross-module citations inside diff text
- `text_diff` schema sufficiency under deep amendment patterns
- Author-tool variation over time

These were captured in `docs/spike-ordinance-structural-anchoring.md`
and remain owned by the follow-up PR.
