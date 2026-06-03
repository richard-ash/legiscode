# Data Sources

This document records every external source the legiscode pipelines pull
from, the parser path each source feeds, and the operator workflow that
keeps the on-disk corpus fresh.

## Sources

### AmLegal HTML (codified corpus)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| URL                  | `https://library.amlegal.com/nxt/gateway.dll?f=templates&fn=default.htm&vid=amlegal:sanfrancisco_ca` |
| On-disk path         | `build/downloads/sf.html`                                              |
| Parser               | `src/parser/parse-html.ts` (strategy `sf-amlegal`)                     |
| Manifest declaration | `manifests/sf/jurisdiction.json` → `source.format = "amlegal-html"`    |
| Refresh cadence      | Manual (no scheduled fetcher yet — operator runs `mise run validate:full` after dropping the new HTML into `build/downloads/sf.html`) |
| Programmatic access  | **Hostile.** Cloudflare blocks headless requests; the "Save Text" UI is auth-gated. Per `project_amlegal_hostile_to_programmatic_access`, expect to download the HTML manually via a real browser session. |

The corpus build (`mise run corpus:build`) reads this single HTML
snapshot, slices it into per-module regions via the `JD_<jd_anchor>`
markers the manifest declares, and emits one validated bundle per
module under `build/modules/<module-id>/`.

### Legistar HTML (pending bills)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| Search URL           | `https://sfgov.legistar.com/Legislation.aspx`                          |
| Detail URL pattern   | `https://sfgov.legistar.com/LegislationDetail.aspx?ID=<matter_id>&GUID=<guid>` |
| Attachment URL pattern | `https://sfgov.legistar.com/View.ashx?M=F&ID=<attachment_id>&GUID=<attachment_guid>` |
| On-disk path         | `build/downloads/bills/bills-index.json` + `build/downloads/bills/pdfs/` |
| Parsers              | `src/parser/bills/legistar-html.ts` (search + detail HTML), `src/parser/bills/index.ts` (PDF structural pass) |
| Manifest declaration | `manifests/sf/jurisdiction.json` → `pending_bill_source.format = "legistar-search-html"` |
| Programmatic access  | **Open.** No Cloudflare gate; standard `fetch` works. Rate-limited at 500ms minimum between requests; 3× exponential backoff on 5xx + 429 (per `scripts/fetch-bills.ts`). |
| Refresh cadence      | Operator-driven; run `make bills-fetch && make bills-sync` to refresh. |

The Legistar scrape is a **UI scrape, not a Web API call**. SF's Legistar
deployment exposes a SOAP / REST API surface to authorized accounts, but
the unauthenticated `Legislation.aspx` listing + `LegislationDetail.aspx`
detail pages carry every field the renderer needs (file_no, title,
status, sponsor, introduced date, attachments). Avoiding the API also
avoids the per-jurisdiction account provisioning each new SF-style
deployment would otherwise require.

## Lanes

The pipeline splits external HTTP from hermetic parsing so CI never
makes a live network call:

| Lane | Hermetic? | Triggered by | Reads | Writes |
| ---- | --------- | ------------ | ----- | ------ |
| **Lane 1 — AmLegal fetch** | ❌ (manual) | Operator (no script yet) | `library.amlegal.com` | `build/downloads/sf.html` |
| **Lane 2 — Corpus build** | ✅ | `mise run corpus:build` / `mise run validate:full` | `build/downloads/sf.html`, manifest | `build/modules/<m>/` |
| **Lane 1 — Bills fetch** | ❌ (operator-driven) | `make bills-fetch` | `sfgov.legistar.com` | `build/downloads/bills/{bills-index.json, pdfs/}` |
| **Lane 2 — Bills sync** | ✅ | `make bills-sync` | `build/downloads/bills/`, manifest, `build/modules/<m>/sections/` | `build/modules/<m>/pending-bills/` |

CI runs Lane-2 commands only. Tests against the bill pipeline use
committed fixtures at `test/fixtures/sf/{bills,legistar-html}/`.

## Caching

### AmLegal

Single-file snapshot at `build/downloads/sf.html`. The corpus build
records the source sha256 in `corpus-meta.json` so the build's identity
is stable across runs even when the HTML doesn't change.

### Legistar

Per-attachment content-hashed cache at
`build/downloads/bills/pdfs/<attachment_id>-<guid8>-<sha16>.pdf`.

The three-part key (attachment_id + matter_guid + content sha256
prefix) per Codex amendment #1 catches Leg Ver{N} swap-in-place
(city replaces the PDF bytes at the same `attachment_id`) by
invalidating the cache entry — the new bytes get a different sha
and land under a new filename, leaving the old entry inert until
the next sync purges it. Conversely, a re-serve of identical bytes
hits the cache hash check and skips the download.

## Refresh workflow

Operator-driven refresh sequence for a full corpus + pending-bills
update:

```bash
# 1. (Manual) Download fresh AmLegal HTML into build/downloads/sf.html.

# 2. Scrape pending bills from Legistar.
make bills-fetch

# 3. Rebuild the codified corpus AND write per-module pending-bill files.
make corpus-rebuild
```

After step 4 the renderer reflects every pending bill in the tree,
section banners, Impact tab, and bill-detail tab without restart on
the next corpus reload (Electron app restart in v1; the watcher that
hot-reloads pending-bills is the deferred follow-up T30).
