import { z } from "zod";
import { ModuleIdSchema, SectionIdSchema } from "./identifiers";
import { TextDiffSchema } from "./text-diff";

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
//   scope         — the install-set filter result (advisory, not
//                   gating; every Ordinance-type matter downloads +
//                   parses, and parse_status carries the real bucket)
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

// BillStatus — the 5-key taxonomy from the Claude Design handoff
// (bills-doc.jsx:3). The Legistar free-text status maps to this enum via
// src/parser/bills/status.ts:mapLegistarStatusToBillStatus(). The
// renderer's VersionStatusBadge keys its color off this enum.
export const BillStatusSchema = z.enum(["filed", "committee", "engrossed", "floor", "enrolled"]);

export type BillStatus = z.infer<typeof BillStatusSchema>;

// OrdinanceBlock — the discriminated union of structured content nodes
// inside an AMEND section's body. The body parser tokenises the slice
// between two SEC. headers into a list of these.
//
//   code_section_header — `SEC. 407. CONVEYANCE OF BREAD...` style entry
//                         that introduces a code section. Always present
//                         for every SEC. header the structural pass
//                         identified — the parse-quality gate throws if
//                         the parser emits fewer. Named
//                         `code_section_header` (not `section_header`) so
//                         `section` only ever means a corpus section.
//   subsection     — paren-marker entry (`(a)`, `(b)`, `(1)`, ...). The
//                    body is recursive so nested markers like `(a)(1)`
//                    represent cleanly. NO lead_in field in Layer 2 —
//                    extracting the bold-italic phrase that precedes
//                    body prose requires Layer 3 typography info, so
//                    the heuristic is deferred (see TODOS.md).
//   paragraph      — every other prose paragraph inside a section. Layer
//                    2 emits all body prose as paragraph blocks; Layer 3
//                    typography decoration sits on top.
//
// Zod schemas use z.lazy() so subsection.body can recurse into the same
// shape.
export type OrdinanceBlock =
  | { kind: "code_section_header"; number: string; title: string }
  | { kind: "subsection"; marker: string; body: OrdinanceBlock[] }
  | { kind: "paragraph"; text: string };

export const OrdinanceBlockSchema: z.ZodType<OrdinanceBlock> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("code_section_header"),
        number: z.string().min(1),
        title: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("subsection"),
        marker: z.string().min(1),
        body: z.array(OrdinanceBlockSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("paragraph"),
        text: z.string().min(1),
      })
      .strict(),
  ]),
);

// OrdinanceBody — the document model for a single Bill, replacing the
// flat `proposed_text` string. The body parser produces one of these
// from the cleaned PDF text + structural-pass output.
//
//   preamble    — text before the first AMEND group: bracket-title,
//                 long-title boilerplate, the "Be it ordained…"
//                 enacting clause. Plain string in Layer 2; Layer 3
//                 can decorate later.
//   amendments  — one entry per AMEND code-group (`Section N. <Code>
//                 Code is hereby amended…`), in document order. Each
//                 entry's `body` holds the structured content for that
//                 group. Named `amendments` (not `sections`) so
//                 `section` only ever means a corpus section.
//   closing     — text after the last AMEND group: boilerplate
//                 (`Section N. Scope of Ordinance.`, `Section M.
//                 Effective Date.`) + the signature block.
//
// Fallback shape (when the structural pass found zero groups, or the
// PDF text-extractor returned nothing): `{ preamble: <all text>,
// amendments: [], closing: "" }`. The renderer always has something to
// show.
export const OrdinanceBodySchema = z
  .object({
    preamble: z.string(),
    amendments: z.array(
      z
        .object({
          action: z.string().min(1),
          target: z
            .object({
              module_id: ModuleIdSchema,
              raw_section_id: z.string().min(1),
            })
            .strict()
            .nullable(),
          body: z.array(OrdinanceBlockSchema),
        })
        .strict(),
    ),
    closing: z.string(),
  })
  .strict();

export type OrdinanceBody = z.infer<typeof OrdinanceBodySchema>;

// Bill — one per (matter, module). A multi-code bill emits N Bills, one
// per module it touches. text_diff[] is the inline-diff content (empty
// in v1; the inline-diff PR — see commit-plan footnote 11 of the locked
// design — populates it). affected_sections lists the section_ids the
// bill touches inside this module, derived from the structural pass;
// it's separate from text_diff so the renderer can show "this bill
// touches §A and §B" without depending on inline diff content. The
// renderer in this PR consumes affected_sections + parse_status; the
// inline-diff renderer consumes text_diff[].
//
// parse_status semantics (3 buckets):
//   ok                — full inline diff was parsed cleanly
//                       (text_diff[] non-empty, no manual review needed)
//   manual_review     — structural pass succeeded but the typography
//                       decoder couldn't produce a clean diff
//                       (text_diff[] may be empty; renderer shows
//                       "see original PDF" affordance)
//   structural_change — full-chapter repeal / chapter creation; no
//                       per-section diff is meaningful
//                       (text_diff[] empty; structural_change_scope
//                       describes what changes)
export const BillSchema = z
  .object({
    file_no: z.string().min(1),
    module_id: ModuleIdSchema,
    short_title: z.string().min(1),
    long_title: z.string().min(1),
    sponsor: z.string().min(1).nullable(),
    introduced_at: z.iso.date().nullable(),
    legistar_url: z.url(),
    legistar_status: z.string().min(1),
    bill_status: BillStatusSchema,
    affected_sections: z.array(SectionIdSchema),
    text_diff: TextDiffSchema,
    parse_status: z.enum(["ok", "manual_review", "structural_change"]),
    /** Free-text scope description; only set when parse_status === "structural_change". */
    structural_change_scope: z.string().min(1).nullable(),
    /** Structured document body produced by the body parser. Replaces
     *  the pre-Layer-2 `proposed_text` string with preamble + per-AMEND
     *  amendments + closing. Always present and always renderable — the
     *  fallback shape `{ preamble: <all cleaned text>, amendments: [],
     *  closing: "" }` is emitted when the structural pass found no
     *  groups (rare; non-AMEND ordinance), so the renderer never has
     *  to branch on null. Layer 3 typography colorization will sit
     *  on top by replacing paragraph/subsection prose with text_diff
     *  spans. */
    body: OrdinanceBodySchema,
  })
  .strict()
  .refine((b) => b.parse_status !== "ok" || b.text_diff.length > 0, {
    message: "text_diff must be non-empty when parse_status is 'ok'",
    path: ["text_diff"],
  })
  .refine(
    (b) =>
      b.parse_status === "structural_change"
        ? b.structural_change_scope !== null && b.structural_change_scope.length > 0
        : b.structural_change_scope === null,
    {
      message: "structural_change_scope must be set iff parse_status === 'structural_change'",
      path: ["structural_change_scope"],
    },
  );

export type Bill = z.infer<typeof BillSchema>;
