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
    /**
     * ISO date the Mayor signed the bill. Set only when the bill
     * reached `enacted` status; null for in-flight or non-passage
     * terminal bills (vetoed, withdrawn, failed). Parsed from the
     * Legistar action-history table when present.
     */
    enacted_at: z.iso.date().nullable(),
    /**
     * ISO date the bill reached a terminal state (enacted, vetoed,
     * withdrawn, failed). Always set when bill_status is terminal;
     * null while the bill is in-flight (PENDING_STATES). Sort key for
     * the Activity panel's enacted/terminal group:
     * `coalesce(terminal_at, enacted_at, introduced_at)` desc.
     */
    terminal_at: z.iso.date().nullable(),
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
//
// v2: BillMeta will gain `enacted_at` + `terminal_at` action-history
// timestamps (T3 of feat/session-bills) so the Activity panel can sort
// the enacted/terminal group by Mayor-signing date desc. The version
// bumps here in T1 alongside KNOWN_SCHEMA_VERSION so the corpus and
// bills-index schemas advance together — a v1 BillsIndex would lack
// the timestamps the v4 renderer needs.
export const BILLS_INDEX_SCHEMA_VERSION = 2 as const;

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

// BillStatus — the session taxonomy that combines in-flight workflow
// states (5 keys) with post-passage terminal states (4 keys) so a bill
// has a non-`filed` home for every point in its lifecycle.
//
// In-flight (pre-passage, sorted by workflow order):
//   filed      — introduced, no committee assignment yet
//   committee  — pending in committee, hearing scheduled or being heard
//   engrossed  — committee approved, finalized for floor consideration
//   floor      — pending Board floor vote
//   enrolled   — passed both votes, awaiting Mayor / publication
//
// Terminal (post-passage, no further movement):
//   enacted    — signed by the Mayor (or published without veto)
//   vetoed     — Mayor vetoed; Board may attempt override but the bill
//                lives at this state until / unless an override flips it
//   withdrawn  — sponsor pulled the bill
//   failed     — Board vote failed
//
// The Legistar free-text status maps via
// src/parser/bills/status.ts:mapLegistarStatusToBillStatus(). The
// renderer's VersionStatusBadge keys its color off this enum.
export const BillStatusSchema = z.enum([
  "filed",
  "committee",
  "engrossed",
  "floor",
  "enrolled",
  "enacted",
  "vetoed",
  "withdrawn",
  "failed",
]);

export type BillStatus = z.infer<typeof BillStatusSchema>;

// PENDING_STATES — the in-flight subset of BillStatus. Used by the
// scraper's session-turnover carryover clause (a pending bill from a
// prior session survives turnover until it terminates), the activity
// panel's pending-group filter, and the section-pending rail. Single
// source of truth so the three consumers can't drift.
export const PENDING_STATES: ReadonlySet<BillStatus> = new Set<BillStatus>([
  "filed",
  "committee",
  "engrossed",
  "floor",
  "enrolled",
]);

// TERMINAL_STATES — the post-passage subset. A bill in any terminal
// state is in its final form; the Activity panel sorts these by
// terminal_at (then enacted_at, then introduced_at) descending.
export const TERMINAL_STATES: ReadonlySet<BillStatus> = new Set<BillStatus>([
  "enacted",
  "vetoed",
  "withdrawn",
  "failed",
]);

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

// SectionOutcome — per-section diff status. One entry for every
// (corpus, target_section) pair the structural pass identified inside
// this Bill's module. Replaces the legacy flat `affected_sections`
// array: where the old shape said "this bill touches §A and §B," the
// new shape says "this bill touches §A (anchored), §B (added_section)."
// The renderer reads .map(o => o.section_id) when it just needs the
// touched-set (chip list, activity panel touches strip) and reads
// .status when it needs to know whether a per-section diff renders.
//
// Status enum (designed general; new outcomes append here as new
// causes surface):
//   anchored                      — text_diff for this section is
//                                   populated and renderable.
//   classification_low_confidence — typography classifier emitted ≥1
//                                   ambiguous decoration span for this
//                                   section, OR the bill body asserts
//                                   a structural action (wholesale add
//                                   on a section that already exists)
//                                   that needs operator audit. Either
//                                   way the diff was suppressed to
//                                   avoid lying.
//   no_baseline                   — corpus baseline lookup miss; the
//                                   section_id didn't exist in the
//                                   loaded module's section index.
//   structural                    — full-chapter / -article action;
//                                   per-section diff is not meaningful.
//   added_section                 — bill body adds this section
//                                   wholesale. text_diff for this
//                                   section is the whole inserted text.
//   unresolved                    — raw_section_id from the bill body
//                                   didn't resolve against any
//                                   installed module's section index
//                                   AND the bill body didn't classify
//                                   it as added_section.
//   absorbed_external             — AmLegal codifies the change and
//                                   surfaces it under the corpus tree;
//                                   the renderer points the reader at
//                                   the codified text instead of an
//                                   inline diff.
export const SectionOutcomeStatusSchema = z.enum([
  "anchored",
  "classification_low_confidence",
  "no_baseline",
  "structural",
  "added_section",
  "unresolved",
  "absorbed_external",
]);

export type SectionOutcomeStatus = z.infer<typeof SectionOutcomeStatusSchema>;

export const SectionOutcomeSchema = z
  .object({
    section_id: SectionIdSchema,
    status: SectionOutcomeStatusSchema,
    /** Human-readable cause for operator logs. Optional — present when
     *  the cause is non-obvious (e.g. "3 ambiguous-decoration span(s)"
     *  for `classification_low_confidence`). */
    detail: z.string().min(1).nullable().default(null),
  })
  .strict();

export type SectionOutcome = z.infer<typeof SectionOutcomeSchema>;

// parse_status — derived 6-value summary computed from section_outcomes
// + structural-pass discriminator. Designed general; new values append
// when new SectionOutcomeStatus values surface:
//
//   ok                 — every outcome is `anchored` or `added_section`.
//                        text_diff covers every touched section.
//   partial            — at least one outcome is anchored/added_section
//                        AND at least one outcome is not. Renderer
//                        shows the inline diff on the anchored sections,
//                        a per-section banner on the non-anchored ones.
//   manual_review      — every outcome is a non-rendering failure
//                        (classification_low_confidence, no_baseline,
//                        unresolved). Renderer shows the existing
//                        manual-review affordance.
//   structural_change  — bill performs a whole-chapter / -article
//                        action; per-section diff isn't meaningful.
//                        structural_change_scope is set.
//   absorbed_external  — every outcome is absorbed_external. AmLegal
//                        owns the codification; renderer points the
//                        reader at the corpus tree instead of a diff.
//   body_only          — section_outcomes is empty (no section targets
//                        identified). Common shape: a bill that adds a
//                        new section in a module whose structural
//                        pattern doesn't bind to any section header
//                        (260300, 260570 patterns). Renderer shows the
//                        ordinance body; no diff and no manual-review
//                        banner.
export const ParseStatusSchema = z.enum([
  "ok",
  "partial",
  "manual_review",
  "structural_change",
  "absorbed_external",
  "body_only",
]);

export type ParseStatus = z.infer<typeof ParseStatusSchema>;

/**
 * Derive parse_status from section_outcomes + the structural-action
 * discriminator. Pure, deterministic; canonical computation used by
 * both the build-time anchorer and consumers that re-derive after
 * mutating outcomes (no consumer mutates outcomes today, but the rule
 * is one-way: outcomes → status, never the other direction).
 */
export function deriveParseStatus(
  outcomes: readonly SectionOutcome[],
  hasStructuralAction: boolean,
): ParseStatus {
  if (hasStructuralAction) return "structural_change";
  if (outcomes.length === 0) return "body_only";
  let renderable = 0;
  let absorbed = 0;
  for (const o of outcomes) {
    if (o.status === "anchored" || o.status === "added_section") renderable++;
    else if (o.status === "absorbed_external") absorbed++;
  }
  if (absorbed === outcomes.length) return "absorbed_external";
  if (renderable === outcomes.length) return "ok";
  if (renderable > 0) return "partial";
  return "manual_review";
}

// Bill — one per (matter, module). A multi-code bill emits N Bills, one
// per module it touches. text_diff[] is the inline-diff content
// (populated per-anchored-section by the build-time anchorer);
// section_outcomes lists every section the structural pass identified
// inside this module with its per-section diff status. The renderer
// reads section_outcomes for both the touched-set (chip list, activity
// panel touches strip) and the per-section diff visibility decision.
//
// parse_status is DERIVED from section_outcomes (see deriveParseStatus
// above). It still ships on disk so consumers don't have to recompute,
// but a refine() invariant guarantees it matches the per-section
// breakdown.
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
    /** One entry per (target_section) inside this module. Replaces the
     *  legacy flat `affected_sections` array; consumers that want the
     *  flat touched-set read `.map(o => o.section_id)`. */
    section_outcomes: z.array(SectionOutcomeSchema),
    text_diff: TextDiffSchema,
    parse_status: ParseStatusSchema,
    /** Free-text scope description; only set when parse_status === "structural_change". */
    structural_change_scope: z.string().min(1).nullable(),
    /** Structured document body produced by the body parser. Always
     *  present and always renderable — fallback shape is `{ preamble:
     *  <all cleaned text>, amendments: [], closing: "" }`. */
    body: OrdinanceBodySchema,
  })
  .strict()
  .refine(
    (b) =>
      b.parse_status ===
      deriveParseStatus(b.section_outcomes, b.parse_status === "structural_change"),
    {
      message: "parse_status must match deriveParseStatus(section_outcomes, hasStructuralAction)",
      path: ["parse_status"],
    },
  )
  .refine(
    (b) => {
      // text_diff is non-empty for every renderable outcome
      // (anchored / added_section). The TEXT_DIFF presence test
      // covers the parse_status=ok and parse_status=partial cases
      // uniformly.
      const renderable = b.section_outcomes.filter(
        (o) => o.status === "anchored" || o.status === "added_section",
      ).length;
      if (renderable === 0) return true; // no claim of renderable content
      return b.text_diff.length > 0;
    },
    {
      message: "text_diff must be non-empty when any outcome is anchored or added_section",
      path: ["text_diff"],
    },
  )
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
