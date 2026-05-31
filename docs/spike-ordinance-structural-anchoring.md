# Ordinance Ingestion — Structural Anchoring Spike

Recon report for the design-v2 question: can SF Legistar ordinance redline
PDFs be deterministically bucketed into `(module_id, section_id)` pairs,
and can the install-set scope filter run from the Legistar HTML alone
(no PDF download)?

**Status: validated.** All four pass criteria clear on a 3-PDF + 4-HTML
corpus. Recommended next move is to lock the structural parser shape and
move on to implementation; no further structural recon needed.

## Corpus probed

| File   | Class | Codes                                            | Source              |
| ------ | ----- | ------------------------------------------------ | ------------------- |
| 260217 | A     | 11 codes amended (Admin-heavy multi-code)        | `/tmp/sf-ord-260217-legver1.pdf` |
| 260296 | A     | Admin only (new chapter 94C)                     | Legistar `View.ashx` |
| 260541 | B     | Public Works (waiver — no text change)           | Legistar `View.ashx` |
| 260542 | A     | Planning only (impact-fee exemption)             | HTML only           |

"Class" is the spike's introduced distinction:
- **Class A — code-amending**: `Section N. <Code> Code is hereby amended by…`
  produces `text_diff[]` content.
- **Class B — non-amending**: waivers, findings, appropriations, MOUs. No
  code text changes. `text_diff[]` is empty; `parse_status` carries the
  reason.

The Class distinction is recoverable from the Legistar HTML title alone
(see Criterion 4), so Class B ordinances never need a PDF download.

## Criterion 1 — Code-group header pattern

**Pass.** Two phrasings observed; both are line-anchored and unambiguous:

| Form                                          | Example                                                              | Count in 260217 |
| --------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| `Section N. Chapter X of the <Code> Code …`   | `Section 4. Chapter 2A of the Administrative Code is hereby amended` | 30              |
| `Section N. The <Code> Code[, …,] is …`       | `Section 36. The Health Code is hereby amended by revising …`        | 9               |
| `Section N. The Administrative Code is hereby amended by adding Chapter Y` | 260296's only AMEND section                                          | 1               |

Detection rule:

```
^\s*(?:\d+\s+)?Section\s+\d+[A-Z]?\.\s+.{0,200}
  \b(?:of\s+the|The)\s+([A-Z][A-Za-z\s']+?)\s+(Code|Charter)\b
  [^.]{0,80}?\bis\s+(?:hereby\s+)?amended\b
```

Across 260217 + 260296 every code-amending section was attributed correctly
to its named code (39 of 39 on 260217 substantive sections; 1 of 1 on 260296).
Ordinance-level setup sections (`Legal Effect`, `Effective Date`, etc.) do
not match — that is correct behavior; they are not code amendments and
produce no diff spans.

One real-world quirk to handle: **section-number reuse**. 260217 has two
"Section 32." entries (a numbering bug in the source). The parser must key
on file-offset, not the integer, when grouping spans.

## Criterion 2 — Section header pattern

**Pass.** A single regex handles three observed variants:

```
^\s*(?:\d+\s+)?(?:SEC\.|SECTION|Section)\s+
  (?P<sid>[0-9][0-9A-Za-z.\-]*)\.\s+
  (?P<title>[A-Z][A-Z0-9\s\-,&'()\.]+)$
```

- `SEC. 5.1-1. DEFINITIONS.` — abbreviated, dominant in 260217 (271 hits)
- `SECTION 94C.1. FINDINGS.` — full word, dominant in 260296 (2 hits)
- `Section 240.` — rare; needs uppercase title for disambiguation from
  cross-references like `in this Section 5.1-2`

Sampled section IDs from 260217 resolve cleanly against existing module
JSON files in `build/modules/`:

| Section in redline | Resolves to                                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| `240`              | `sf-planning/sections/planning-code/article-2-use-districts/240.json`                 |
| `13.02`            | `sf-park/sections/park-code/article-13-implementation-of-charter-section-16-107/13.02.json` |
| `41.2`             | `sf-health/sections/health-code/article-1-animals/41.2.json`                          |
| `5.1-1`            | `sf-administrative/sections/administrative-code/article-i-reentry-council/5.1-1.json` |

Section IDs that don't resolve (e.g., 260217's `16.108-1`, 260296's `94C.1`)
are by definition newly inserted sections — that absence IS the signal,
not a parse error. The article path is derivable from the existing module
tree once a section is found, so the diff span only needs to carry
`section_id` plus `module_id`.

## Criterion 3 — Module mapping

**Pass with a one-entry alias dictionary.** Of 10 distinct code-name strings
seen in 260217's substantive section headers, 9 match a manifest `code_title`
canonically. The exception:

```ts
const SF_ORDINANCE_CODE_ALIASES = {
  "Building Inspection Code": "sf-building",
};
```

Plus one code name (`Labor and Employment Code`) that appears in the corpus
but has no installed module. The parser must handle "code group named but
not installed" gracefully — the spans in that section are tagged
`module_id: null` and dropped at render time, not at parse time, so the
`OrdinanceFile` still reflects the full set of amendments for any future
module install.

The `parse_status` discrimination falls out cleanly:

- `ok` — every AMEND ordinance-section resolved to an installed module
- `partial` — at least one resolved + at least one not-installed
- `manual_review` — code-name string didn't match canonical or alias
- `no_code_amendment` — Class B (no AMEND sections)
- `structural_change` — header pattern matched but section IDs all missing
  from module tree (ordinance creates a wholly new chapter)

These five buckets cover every observed PDF and satisfy the
zero-skip / 100%-completeness rule. Accuracy of the diff content is
discovery signal inside `ok`; coverage of the ingestion pipeline is
100% regardless.

## Criterion 4 — HTML-only scope filter

**Pass.** `LegislationDetail.aspx` exposes a `lblTitle2` span containing the
canonical phrasing. The first 1-2 verbs of the title classify the ordinance
without needing the PDF:

| Title prefix              | Class | Action                                |
| ------------------------- | ----- | ------------------------------------- |
| `Ordinance amending the`  | A     | Parse code list, run install-filter   |
| `Ordinance waiving …`     | B     | Record metadata, no PDF download      |
| `Ordinance authorizing …` | B     | Record metadata, no PDF download      |
| `Appropriation - …`       | B     | Record metadata, no PDF download      |
| `Memorandum of …`         | B     | Record metadata, no PDF download      |

For Class A titles, the code list parses with a longest-match
left-consumer over the stub set (e.g., `Business and Tax Regulations`
matches before `Business`). On 260217's 12-stub list, all 12 resolve:
11 to installed modules, 1 (`Labor and Employment`) flagged as
not-installed. Scope verdict: KEEP (touches ≥1 installed module). 260296
and 260542 resolve their single stubs correctly.

The title is **high-recall, moderately imprecise** vs. the PDF body —
260217's title names Business / Campaign / Police, which the body does not
textually amend, and omits Building Inspection, which the body does
amend. For the scope filter ("should we download?") high recall is the
goal; false positives are cheap (parse produces an empty `text_diff[]`
for the bogus stub and the truth is recorded in `parse_status`).

## Typography signal (incidental finding)

Every SF ordinance PDF includes a standardized NOTE block on page 1:

> Unchanged Code text and uncodified text are in plain Arial font.
> Additions to Codes are in single-underline italics Times New Roman font.
> Deletions to Codes are in strikethrough italics Times New Roman font.
> Board amendment additions are in double-underlined Arial font.
> Board amendment deletions are in strikethrough Arial font.
> Asterisks (* * * *) indicate the omission of unchanged Code subsections
> or parts of tables.

That fixes the typography decoder beyond the design-v2 description:
- **Font family** matters in addition to underline/strikethrough.
  Times New Roman = primary additions/deletions; Arial = Board amendment
  (post-introduction) additions/deletions. The diff span schema may want a
  `source: "introduced" | "board_amendment"` discriminator if downstream
  consumers need to distinguish.
- The NOTE block itself is a parse-time invariant: if it's missing, the
  PDF is not a standard SF ordinance redline and should fall through to
  `manual_review` regardless of other signals.

## Implementation hooks

The structural validation locks the following parser shape:

1. `src/parser/ordinances/scope-filter.ts` — given an `lblTitle2` string +
   the installed module set, returns `{ class: 'A'|'B', keep: boolean,
   resolved_modules: ModuleId[], not_installed: string[], unresolved: string[] }`.
   Pure function of inputs; no I/O.

2. `src/parser/ordinances/structural-pass.ts` — given a PDF byte buffer,
   returns an array of `{ ordinance_section_number, code_name,
   module_id | null, file_offset_start, file_offset_end, code_sections:
   [{ section_id, title, file_offset_start, file_offset_end }] }`.
   No typography work here; just the bucketing skeleton the diff pass
   fills in.

3. `src/parser/ordinances/aliases.ts` — the 1-entry alias table above,
   shipped as a const. New aliases get added as discovered.

4. `OrdinanceFileSchema.parse_status` — extend to the 5 buckets above
   (if it doesn't already cover all five).

## What this spike does NOT validate

- **Typography decode** — covered by the Day-0 spike in the design v2 doc.
  The structural pass attaches `(module_id, section_id)` to byte ranges;
  the typography pass turns those byte ranges into `text_diff[]` entries.
  These are independent failure surfaces.
- **Cross-module citations inside diff text** — e.g., does "Police Code
  Section 1602" inside an Admin Code amendment resolve correctly? Out of
  scope here; same problem the existing AmLegal parser already solves
  via `resolve_cross_module_citations`.
- **`text_diff` schema sufficiency** under deep amendment patterns —
  e.g., what does a span that adds a new subsection (h)(3)(B)(ii)
  inside an existing section look like? Verify during implementation;
  the schema is shipped + stable so worst case is a schema additive.
- **Author-tool variation over time** — the corpus is currently 100%
  Word 2016 → PDFlib PLOP. If SF migrates off Word in 2027, the structural
  + typography signals may shift. Re-run this spike when that happens.
