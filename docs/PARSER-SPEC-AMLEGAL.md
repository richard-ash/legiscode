# AmLegal HTML Parser — Specification

What the parser-strategy `sf-amlegal` (in `src/parser/parse-html.ts`) extracts
from an AmLegal "Save Text" HTML export, and what it does not. This is the
contract between the source format and the corpus data model. When AmLegal
ships an HTML evolution that breaks the parser, the gap is between this spec
and the new HTML — not between the parser and an unwritten expectation.

For the orchestration-side companion see `docs/CORPUS-VALIDATION.md`. For
the architectural map see `docs/ARCHITECTURE.md`.

## What is a section

A rbox is promoted to a `SectionFile` (a queryable section in the corpus)
when **all** of the following hold:

1. Its CSS class set contains one of the section-promoting tokens:
   - `Section`, `level-Section`
   - `Section-NewOrd`, `level-Section-NewOrd`
   - `Section-Deleted`, `level-Section-Deleted`
   - `Subsection`, `level-Subsection`, `Subsection-NewOrd`, `level-Subsection-NewOrd`,
     `Subsection-Deleted`, `level-Subsection-Deleted`
   - `SubSection`, `level-SubSection`, `SubSection-NewOrd`, `level-SubSection-NewOrd`,
     `SubSection-Deleted`, `level-SubSection-Deleted`

2. The rbox carries at least one **id signal**:
   - a `<a name="JD_<id>">` descendant with a `title` attribute, OR
   - a heading text matching `HEADING_SEC_RE` (`SEC. <id>` form).

3. For Subsection-class rboxes specifically: the extracted `<id>` must
   match `SECTION_ID_RE`. This filters out structural sub-elements with
   non-section-shaped titles (e.g. `"Article 10, Appendix O, Sec. 1"`)
   that AmLegal renders as Subsection-class rboxes — they're absorbed
   into the parent's body as `consumed_by_parent`.

## What is non-content (the editorial-chrome rule)

A Section-classed rbox with **neither** id signal — no `<a name="JD_*">`
descendant **and** no `SEC. <id>` heading — is editorial chrome. The
parser classifies it as `consumed_by_parent` with reason
`"section-classed editorial chrome (no id signal)"`. Real legal sections
always have at least one id signal.

Audit-confirmed chrome conventions on the production SF corpus
(see `scripts/audit-classifier.ts`):

| Pattern                                              | Real-data count |
|-----------------------------------------------------:|----------------:|
| `New Ordinance Notice` / `New Legislation Notice` / `New Resolution Notice` | 58 |
| Bracketed caption (e.g. `[DIGNITY FUND]`)            | 11              |
| Year label (e.g. `2025`, `2014 Ordinances`)          | 9               |
| Map-sheet header (sf-planning, e.g. `Zoning Use District ("ZN") Maps`) | 7  |
| `APPENDIX X. - HEADING` without JD anchor            | 1               |
| Pseudo-bracketed (`[––]`)                            | 1               |

When AmLegal ships a new chrome convention, `scripts/audit-classifier.ts`
surfaces it; the test suite
(`test/parser/chrome-and-id-patterns.test.ts`) gets a focused
regression test.

## What id formats are valid

`SECTION_ID_RE` (the single source of truth, exported from
`@/types/identifiers`):

```
^[a-z0-9]+(?:[._-][a-z0-9]+)*$
```

Examples that pass:
- `1.100`, `A8.566`, `28.11`, `261.1.5`
- `9.111-1`, `1075.1-art-16`
- `2a.430`

Examples that fail (the parser self-validates with this regex before
returning a section):
- `23.7.` (trailing period — `HEADING_SEC_RE` excludes a trailing
  capture dot so this doesn't happen)
- `Article 10, Appendix O, Sec. 1` (commas)
- `4.100.1-note-1` (Subsection that should be `4.100.1` after stripping
  ` Note 1` suffix from JD anchor title)

Id normalization (`normalizeSectionId` in `parse-html.ts`):

1. Strip leading/trailing whitespace.
2. Strip trailing `*` (editorial footnote indicator).
3. Strip trailing `.` (defensive).
4. Lowercase.
5. Collapse `\s+` → `-`.
6. Trim again.

JD anchor title stripping (`stripJdAnchorSuffixes`, runs **before**
`normalizeSectionId`):

- Strip ` Note <n>` suffix (e.g. `"4.100.1 Note 1*"` → `"4.100.1*"`).
- Strip `-<n>` suffix (e.g. `"9.111-1"` → `"9.111"`).

## TOC enumeration algorithm (coverage gate)

Per module:
1. Walk every `<a name="JD_<id>">` anchor inside the module's bound
   (rbox-level OR nested in body content like deletion-stub markers
   and Note sub-elements). Collect the `<id>` strings into
   `parsed.tocAnchors`.
2. Coverage = `(parsed sections count) / (parsed sections + skipped count)`.
3. Citation resolution walks `tocAnchors` IN ADDITION to parsed section
   ids — a citation to an anchor that exists in source but isn't
   promoted (deletion stub, Note sub-element) still resolves.

The `tocAnchors` set is intentionally broad: it answers the question
"is this id mentioned anywhere in the source?" rather than "is this id
a queryable section?" The latter is what `parsed.sections` answers.

## What the parser does NOT handle

- **Cross-jurisdiction citations.** A citation to `§ 95075` of the
  California Public Resources Code looks identical to an internal
  citation when written bare. The `feat/citation-resolution`
  refoundation (2026-05-20) added a paragraph-scope code-prefix
  tracker driven by `src/citations/module-registry.ts` (31 external
  code modules: 29 named California codes, US Code, CFR): when a
  phrase like "Cal. Veh. Code" appears earlier in the paragraph,
  every subsequent `§` in that paragraph classifies as `cross_module`
  with a stable `module_id`. Bare citations without a recognized
  prefix still demote to `cross-unresolved` (informational, not
  gated). The `external` Citation kind was removed.

- **Inner ordinance / resolution items.** Each `OrdinanceHistory` /
  `ResolutionHistory` entry currently emits with `items: []`. Per-item
  parsing is out of scope for now — the digest is the queryable unit today.

- **`InterCodeLink` graph wiring.** The parser detects InterCodeLink
  elements but doesn't currently surface cross-module forward edges
  via `cited_by`. Carried as a TODO in `TODOS.md`.

- **Appendix sub-numbering.** Subsections of appendices (e.g.
  `Article 10, Appendix O, Sec. 1` through `... Sec. 216` in
  sf-planning) are absorbed into the parent appendix's body. They
  aren't queryable sections.

- **Deletion-marker queryability.** When a section is repealed, AmLegal
  preserves the JD anchor inside body text but doesn't render it as
  its own rbox. The parser sees the anchor (it's in `tocAnchors`) but
  doesn't emit a "repealed stub" SectionFile. Citations to the
  repealed section still resolve via the source-anchor TOC lookup.

- **Cross-module version compatibility.** When module A cites module B
  but they're built from different snapshots, broken-target detection
  isn't yet a build-time gate (cross-module citations are reported in
  `unresolvedCross` but not gated). Tracked in TODOS.md as
  "cross-module version compatibility policy."

## Update procedure when AmLegal HTML evolves

When `mise run validate:full` starts failing on a new snapshot:

1. Read the failure mode from `corpus-meta.json`'s `errors[]`. Each
   `BuildError` has a typed `kind` plus context (`moduleId`, `count`,
   etc.).

2. For `skip_gate_exceeded` failures: inspect the per-module
   `corpus-meta.json`'s `skipped[]` to see what the parser tried to
   emit but couldn't. Re-run `scripts/audit-classifier.ts` to see if
   a new chrome convention slipped in (chrome-rule territory) or if
   id extraction has a new edge case (id-extraction territory).

3. For `toc_coverage_failed` failures: the `missing[]` list names the
   section ids that were attempted but didn't promote. Each is a
   parser-bug candidate.

4. For `citation_resolution_failed` failures: the `unresolved[]` list
   names citing+target pairs. Apply the decision tree (see
   `docs/CORPUS-VALIDATION.md` § "When validation fails"):
   - source typo → manual snapshot repair, document in
     `CORPUS-VALIDATION.md`
   - parser miss → fix the chrome-rule or id-extraction gap
   - renumbering → `redirect_to` schema field
   - non-content the parser shouldn't have skipped → chrome-rule fix

5. Update this spec (`PARSER-SPEC-AMLEGAL.md`) with the new pattern
   so the next contributor doesn't have to rediscover it. Add a
   focused regression test in
   `test/parser/chrome-and-id-patterns.test.ts`.

The completeness gates are non-negotiable: every change above MUST
keep `mise run validate:full` at exit 0, skip rate 0%, TOC coverage
100%, and intra-module citation resolution 100%. No allowlists, no
configurable thresholds, no documented baseline floors. If a gate
would fail today, fix the root cause.
