# Corpus Validation

How to run the production corpus validation locally and what to do when
something fails. The companion `docs/PARSER-SPEC-AMLEGAL.md` documents
what the parser produces; this file documents how to operate the gate.

## TL;DR

```bash
# 1. Obtain the SF AmLegal HTML snapshot (see "Snapshot fetch" below).
#    Place it at build/downloads/sf.html (gitignored).

# 2. Run validation.
mise run validate:full

# 3. Inspect the corpus-level meta.
jq . build/modules-full/corpus-meta.json
```

Pass criteria — every field below MUST be true for the corpus to be
considered valid:

- `exitCode` is `0`
- `valid` is `true` in `build/modules-full/corpus-meta.json`
- `skips.total` is `0` across every module
- `coverage.missing` is `[]` per module
- `citations.unresolvedIntra` is `[]`
- Wall time `< 120s`
- Max RSS `< 12 GB`

If any criterion fails, **fix the cause, never the gate**. The legal
corpus completeness principle is non-negotiable: an aide cannot be unable
to find a law that's on the books because we tolerated a "known-broken"
threshold. See "When validation fails" below for the decision tree.

## Why this is operator-driven, not CI

The 56,824-line production HTML is too large and too volatile to commit:
it changes whenever AmLegal publishes an amendment. Pinning a snapshot
into the repo would either bloat git or get stale. CI hermeticity requires
committed inputs (`project_tests_are_hermetic` memory), so PR CI runs only
the fixture-based tests at `test/fixtures/sf/source.html`. This means
maintainers run `mise run validate:full` locally before milestone
shipping; the BuildResult JSON is captured as an artifact for reviewers.

When a future fetcher lives in `feat/build-pipeline`, the cron job that
refreshes the snapshot will run `validate:full` against the new bytes
and fail loudly if any gate trips. PR CI still won't gate on this.

## Snapshot fetch

The source export is the SF AmLegal "Save Text" output — a single HTML
file containing every code module. Today the fetch is manual because
AmLegal's codelibrary is hostile to programmatic access (Cloudflare-blocks
headless browsers, Save Text is an authenticated async job — see
`project_amlegal_hostile_to_programmatic_access` memory).

Manual procedure:

1. Open <https://codelibrary.amlegal.com/codes/san_francisco/latest/>
   in a real Chromium browser, signed into the AmLegal account.
2. From the left navigation: "Save Text" → choose "All codes / All
   sections / HTML".
3. Wait for the email notification (typically 5–15 minutes).
4. Download the resulting HTML.
5. Place at `build/downloads/sf.html` (the path expected by
   `manifests/sf/jurisdiction.json`).

The snapshot is gitignored — it never lands in the repo. Each operator
fetches their own.

### Recording the snapshot date and SHA

`mise run validate:full` writes `corpus-meta.json` files (corpus-level +
per-module) that record the source SHA-256 in `source_sha256` and the
build wall-clock in `snapshot_at`. To compare snapshots across runs:

```bash
# Compute current snapshot's sha
openssl dgst -sha256 build/downloads/sf.html

# Pull what the most recent build recorded
jq -r .source_sha256 build/modules-full/corpus-meta.json
```

Both values should match. A mismatch means either the source changed
between fetch and build, or the build read a different file (e.g., a
stale path).

A reference value at the time of this writing
(2026-05-04, last good run):

```
a9b0000d042c1bcb74393ab34602c80bf690a3fac344a14fc4daa8712754c342
```

## When validation fails

`BuildResult.errors[]` is the list of typed `BuildError`s. The `kind`
discriminates; see `src/build/types.ts` for the union shape.

| `BuildError.kind`             | Most likely cause                                  |
|-------------------------------|----------------------------------------------------|
| `manifest_invalid`            | `manifests/sf/jurisdiction.json` doesn't validate against `JurisdictionManifestSchema` |
| `source_unreadable`           | `build/downloads/sf.html` is missing or unreadable |
| `parse_aborted`               | The classifier hit a dead end on a corrupt anchor  |
| `skip_gate_exceeded`          | The parser dropped sections beyond `max_skip_count` (today: 0) |
| `toc_coverage_failed`         | Sections present in source TOC but not parsed      |
| `citation_resolution_failed`  | Intra-module citation points to a non-existent section |
| `atomic_write_failed`         | Filesystem write failure under the lock            |
| `corpus_meta_write_failed`    | Filesystem write failure for corpus-level meta     |

For `skip_gate_exceeded` and the corpus-level gate failures, follow this
decision tree:

| Cause                                      | Fix                                                                |
|--------------------------------------------|--------------------------------------------------------------------|
| Source HTML typo (citation → ghost section)| Edit the snapshot text; document in this file                      |
| Parser missed the target                   | Parser bug; fix the chrome rule or id-extraction gap               |
| Renumbering / redesignation                | Use the existing `redirect_to` schema field                        |
| Non-content the parser shouldn't have skipped | Editorial-chrome classifier rule fix                            |

Never widen the gate. No allowlists, no "documented baseline floors,"
no configurable thresholds. The gate is at 100% / 0%; that's the contract.

## Refresh procedure

When AmLegal publishes an amendment that affects a module's
`module_version` (the `YYYY.MM.DD` date in `manifests/sf/jurisdiction.json`):

1. Re-fetch the snapshot per "Snapshot fetch" above.
2. Update each affected module's `module_version` in
   `manifests/sf/jurisdiction.json` to the new amendment date.
3. Run `mise run validate:full`.
4. Commit `manifests/sf/jurisdiction.json` (and any parser fixes if
   the new amendment surfaced a regression). The fetched HTML stays
   gitignored.

## Module hierarchy

`manifests/sf/jurisdiction.json` declares the 18 SF modules, each with
its own `jd_anchor` (the AmLegal navigation slug), `citation_patterns`,
and `module_version`. The list is operator-curated,
not auto-discovered (`project_discovery_is_operator_driven` memory).
When AmLegal adds a new code (say, a 19th module), append it to
`modules[]` with the appropriate fields and re-run validation.
