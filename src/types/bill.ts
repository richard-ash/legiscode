import { z } from "zod";
import { ModuleIdSchema } from "./identifiers";

// BillMeta is the per-matter row emitted by the Lane-1 Legistar scraper
// (scripts/fetch-bills.ts) into build/downloads/bills/bills-index.json.
// Lane-2 (scripts/sync-bills.ts) reads this index, opens each cached PDF,
// and produces the per-module Bill files consumed by the renderer.
//
// Three field groups, deliberately kept on a single shape so the index is
// self-describing (no second join required to render the bill-detail tab
// or the Impact card without re-scraping):
//
//   audit         — fields the operator needs to debug a sync run
//   scope         — the install-set filter result (advisory, not gating;
//                   every Ordinance-type matter downloads + parses per
//                   Codex amendment A3 reversal — parse_status carries
//                   the real bucket)
//   ui            — fields the renderer needs to populate header / Impact
//                   card / status pill without round-tripping to Legistar
//
// Schema is `.strict()` so a Legistar field rename (e.g. lblTitle2 → lblTitle3)
// surfaces as a schema error at validation time, not a silent null.
export const BillMetaSchema = z
  .object({
    // ── Identity ────────────────────────────────────────────────────────
    /** Legistar matter file_no — e.g. "260217". Stable across versions. */
    file_no: z.string().min(1),
    /** Legistar internal matter ID; one half of the cache key. */
    matter_id: z.string().min(1),
    /** GUID half of the cache key; rotates per attachment. */
    matter_guid: z.string().min(1),

    // ── Display ─────────────────────────────────────────────────────────
    /** Short title from LegislationDetail h1, used in tree + tab title. */
    short_title: z.string().min(1),
    /** Long title from `lblTitle2` — drives scope classifier + journal copy. */
    long_title: z.string().min(1),
    /** Legistar pending-status free text — e.g. "Pending — Land Use Cmte". */
    legistar_status: z.string().min(1),
    /** Sponsor display string — e.g. "Sup. Walton (District 10)". */
    sponsor: z.string().min(1).nullable(),
    /** ISO date of introduction; null when LegislationDetail omits it. */
    introduced_at: z.iso.date().nullable(),
    /** Canonical LegislationDetail URL — drives "View on legistar" link. */
    legistar_url: z.url(),

    // ── Scope (advisory) ────────────────────────────────────────────────
    /** Title-classifier verdict: Class A amends code; Class B does not. */
    title_class: z.enum(["A", "B"]),
    /** Code-name stubs the title mentions verbatim (raw input to filter). */
    touched_code_stubs: z.array(z.string()),
    /** Module ids the stubs resolved to (subset of installed_modules). */
    touched_modules: z.array(ModuleIdSchema),
    /** Module ids the manifest currently lists; lets sync purge orphans. */
    installed_modules: z.array(ModuleIdSchema),
    /** Stubs that named a code with no installed module — kept for audit. */
    not_installed_modules: z.array(z.string()),

    // ── Audit / cache ───────────────────────────────────────────────────
    /** ISO timestamp the row was written. Drives recency reporting. */
    scraped_at: z.iso.datetime({ offset: true }),
    /** Latest-version attachment ID — half of the cache key. */
    attachment_id: z.string().min(1),
    /** Cache filename under build/downloads/bills/pdfs/. */
    pdf_cache_path: z.string().min(1),
    /** sha256 prefix (16 hex chars) of the downloaded PDF bytes. */
    attachment_content_hash: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();

export type BillMeta = z.infer<typeof BillMetaSchema>;

// BillsIndex is the top-level shape of bills-index.json — a versioned
// wrapper so the schema can evolve without re-scraping. Lane-2 (sync) refuses
// to read an index whose schema version it doesn't recognize.
export const BILLS_INDEX_SCHEMA_VERSION = 1 as const;

export const BillsIndexSchema = z
  .object({
    schema_version: z.literal(BILLS_INDEX_SCHEMA_VERSION),
    /** Source URL the listing was scraped from (Legistar legislation search). */
    source_url: z.url(),
    /** Wall-clock for the scrape run — separate from per-matter scraped_at. */
    fetched_at: z.iso.datetime({ offset: true }),
    bills: z.array(BillMetaSchema),
  })
  .strict();

export type BillsIndex = z.infer<typeof BillsIndexSchema>;
