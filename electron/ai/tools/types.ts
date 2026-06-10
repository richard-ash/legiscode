// Tool input/output contracts. Two tools — `read` and `search` — over a
// filesystem-style path tree. Path schema:
//
//   /                                                  → root directory
//   /bills                                             → session bills (list)
//   /bills/{file_no}                                   → bill metadata
//   /bills/{file_no}/proposed-text                     → bill body (preamble +
//                                                       amendments + closing)
//   /bills/{file_no}/changes                           → per-section diff index
//   /bills/{file_no}/changes/{module_id}/{section_id}  → before/after diff
//   /modules                                           → installed modules
//   /modules/{module_id}                               → module metadata
//   /modules/{module_id}/sections/{section_id}         → section text
//   /modules/{module_id}/sections/{section_id}/cited-by      → inverse citers
//   /modules/{module_id}/sections/{section_id}/history       → ordinance history
//   /modules/{module_id}/sections/{section_id}/amendments    → pending bills
//   /modules/{module_id}/definitions/{term}            → defs in module
//   /definitions/{term}                                → defs across modules
//   /ordinances                                        → recent ordinances
//   /ordinances/{year}                                 → ordinances by year
//
// Outputs share `ToolResultBase`:
//   - ok           — success/failure discriminator
//   - fetched      — qualified refs the verifier counts as fetched THIS TURN.
//                    `read` on a section path populates this; reads of
//                    bill/ordinance paths do not (they aren't sections).
//   - corpus_hash  — sha256 prefix of loaded module versions (N5).
//   - turn_id      — monotonic counter from the conversation loop (N9).
//
// On success, ReadOutput discriminates by `kind` so the model can pattern-
// match the payload shape without re-parsing the path it sent.

import { z } from "zod";
import { ModuleIdSchema, SectionIdSchema } from "@/types";

// ─── Names ──────────────────────────────────────────────────────────────────

export const TOOL_NAMES = ["read", "search"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

// ─── Shared ─────────────────────────────────────────────────────────────────

export const QualifiedRefSchema = z
  .object({
    module_id: ModuleIdSchema,
    section_id: SectionIdSchema,
  })
  .strict();
export type QualifiedRef = z.infer<typeof QualifiedRefSchema>;

export interface ToolResultBase {
  ok: boolean;
  fetched: readonly QualifiedRef[];
  corpus_hash: string;
  turn_id: number;
}

export interface ToolNotFound extends ToolResultBase {
  ok: false;
  reason: "not_found";
  detail: string;
}

export interface ToolBadInput extends ToolResultBase {
  ok: false;
  reason: "bad_input";
  detail: string;
}

export interface ToolInternalError extends ToolResultBase {
  ok: false;
  reason: "internal";
  detail: string;
}

export type ToolError = ToolNotFound | ToolBadInput | ToolInternalError;

// ─── read ───────────────────────────────────────────────────────────────────

export const ReadInputSchema = z
  .object({
    path: z.string().min(1).max(512),
  })
  .strict();
export type ReadInput = z.infer<typeof ReadInputSchema>;

/** Directory entry: a path the model can read next, with a short summary. */
export interface DirectoryEntry {
  path: string;
  summary: string;
}

export interface DirectoryListing extends ToolResultBase {
  ok: true;
  kind: "directory";
  path: string;
  entries: readonly DirectoryEntry[];
  /** True when the entries were capped by the router. */
  truncated: boolean;
}

// ─── Read payloads — sections ────────────────────────────────────────────────

export interface SectionPayload {
  module_id: string;
  section_id: string;
  display_label: string;
  title: string;
  hierarchy: readonly string[];
  editorial_status: "active" | "reserved" | "repealed" | "redesignated";
  redirect_to?: string;
  text: string;
  citations: readonly QualifiedRef[];
  defined_terms: readonly string[];
}

export interface SectionContent extends ToolResultBase {
  ok: true;
  kind: "section";
  section: SectionPayload;
}

export interface CiterRef {
  module_id: string;
  section_id: string;
  display_label: string;
  title: string;
}

export interface SectionCiters extends ToolResultBase {
  ok: true;
  kind: "section-citers";
  target: QualifiedRef;
  /** Sections that cite the target. Same-module first; cross-module after. */
  citers: readonly CiterRef[];
}

export interface HistoryEntry {
  year: number;
  instrument_kind: "ordinance" | "resolution";
  instrument_number: string;
  file_number: string | null;
  approved_at: string | null;
  effective_at: string | null;
}

export interface SectionHistory extends ToolResultBase {
  ok: true;
  kind: "section-history";
  target: QualifiedRef;
  /** Newest first. */
  history: readonly HistoryEntry[];
}

export interface AmendmentRef {
  file_no: string;
  short_title: string;
  long_title: string;
  legistar_status: string;
  bill_status: string;
  sponsor: string | null;
  introduced_at: string | null;
  legistar_url: string;
}

export interface SectionAmendments extends ToolResultBase {
  ok: true;
  kind: "section-amendments";
  target: QualifiedRef;
  amendments: readonly AmendmentRef[];
}

// ─── Read payloads — bills ──────────────────────────────────────────────────

/** Top-level bill metadata reachable at /bills/{file_no}. */
export interface BillMetadataPayload {
  file_no: string;
  module_id: string;
  short_title: string;
  long_title: string;
  bill_status: string;
  legistar_status: string;
  sponsor: string | null;
  introduced_at: string | null;
  legistar_url: string;
  parse_status: string;
  /** Section IDs this bill touches in its module. */
  affected_section_ids: readonly string[];
  /** Convenience: subpaths the model can read next. */
  subpaths: {
    proposed_text: string;
    changes: string;
  };
}

export interface BillMetadata extends ToolResultBase {
  ok: true;
  kind: "bill";
  bill: BillMetadataPayload;
}

/** Structured ordinance body — the full proposed bill text. */
export interface BillProposedTextPayload {
  file_no: string;
  module_id: string;
  /** Boilerplate before the first amendment block. */
  preamble: string;
  amendments: readonly {
    action: string;
    target: { module_id: string; raw_section_id: string } | null;
    /** Rendered text of the amendment block — paragraph-per-line. */
    text: string;
  }[];
  /** Boilerplate after the last amendment block. */
  closing: string;
}

export interface BillProposedText extends ToolResultBase {
  ok: true;
  kind: "bill-proposed-text";
  body: BillProposedTextPayload;
}

/** Per-section change index for a bill. */
export interface BillChangeEntry {
  module_id: string;
  section_id: string;
  /** SectionOutcomeStatus value: anchored, no_changes, added_section, ... */
  status: string;
  detail: string | null;
  /** Path the model reads to see the actual diff for this section. */
  path: string;
}

export interface BillChangesList extends ToolResultBase {
  ok: true;
  kind: "bill-changes";
  file_no: string;
  module_id: string;
  changes: readonly BillChangeEntry[];
}

/** Single chunk of a diff: equal=unchanged, insert=added, delete=removed. */
export interface DiffChunkPayload {
  kind: "equal" | "insert" | "delete";
  text: string;
}

export interface BillSectionDiffPayload {
  file_no: string;
  module_id: string;
  section_id: string;
  status: string;
  /** Current text. Null when the bill adds the section (no baseline). */
  baseline_text: string | null;
  /** Proposed text after applying the bill. */
  proposed_text: string;
  /** Word-level chunks the renderer iterates. May be empty when status
   *  is no_changes or structural. */
  chunks: readonly DiffChunkPayload[];
}

export interface BillSectionDiff extends ToolResultBase {
  ok: true;
  kind: "bill-section-diff";
  diff: BillSectionDiffPayload;
}

// ─── Read payloads — bills/modules/ordinances listings ──────────────────────

export interface SessionBillSummary {
  file_no: string;
  module_id: string;
  short_title: string;
  long_title: string;
  bill_status: string;
  legistar_status: string;
  sponsor: string | null;
  introduced_at: string | null;
  legistar_url: string;
  affected_section_ids: readonly string[];
}

export interface SessionBillsList extends ToolResultBase {
  ok: true;
  kind: "bills-list";
  total: number;
  bills: readonly SessionBillSummary[];
  truncated: boolean;
}

export interface ModuleMetadataPayload {
  module_id: string;
  name: string;
  code_title: string;
  jurisdiction: string;
  section_count: number;
  definition_count: number;
  session_bill_count: number;
}

export interface ModuleMetadata extends ToolResultBase {
  ok: true;
  kind: "module";
  module: ModuleMetadataPayload;
}

export interface DefinitionHit {
  module_id: string;
  section_id: string;
  term: string;
  excerpt: string;
  scope: unknown;
}

export interface DefinitionMatches extends ToolResultBase {
  ok: true;
  kind: "definitions";
  term: string;
  module_id?: string;
  matches: readonly DefinitionHit[];
}

export interface OrdinanceSummary {
  ordinance_number: string;
  year: number;
  file_number: string | null;
  approved_at: string | null;
  effective_at: string | null;
  cited_in: readonly { module_id: string; section_id: string }[];
}

export interface OrdinancesList extends ToolResultBase {
  ok: true;
  kind: "ordinances";
  total: number;
  ordinances: readonly OrdinanceSummary[];
  truncated: boolean;
}

// ─── ReadOutput union ───────────────────────────────────────────────────────

export type ReadOutput =
  | DirectoryListing
  | SectionContent
  | SectionCiters
  | SectionHistory
  | SectionAmendments
  | BillMetadata
  | BillProposedText
  | BillChangesList
  | BillSectionDiff
  | SessionBillsList
  | ModuleMetadata
  | DefinitionMatches
  | OrdinancesList;

export type ReadResult = ReadOutput | ToolError;

// ─── search ─────────────────────────────────────────────────────────────────

export const SearchInputSchema = z
  .object({
    query: z.string().min(1).max(200),
    /** Optional module scope. */
    module_id: ModuleIdSchema.optional(),
    /** Cap; the router clamps to 25. */
    max_results: z.number().int().positive().max(50).optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof SearchInputSchema>;

export interface SearchHit {
  module_id: string;
  section_id: string;
  display_label: string;
  title: string;
  snippet: string;
  /** Path the model can read to fetch the full section. */
  path: string;
}

export interface SearchOutput extends ToolResultBase {
  ok: true;
  kind: "search-results";
  total_matches: number;
  hits: readonly SearchHit[];
  truncated: boolean;
}

export type SearchResult = SearchOutput | ToolError;
