// Contract between @/parser (producer) and @/storage (consumer). Lives in
// @/types so both can depend only on the contract layer rather than each
// other. If the parser changes its internal pipeline without changing this
// shape, storage doesn't rebuild; if the storage layout changes, the parser
// doesn't rebuild. Decoupling.

import type { Appendix } from "./appendix";
import type { CorpusEntryKind } from "./corpus-meta";
import type { DefinitionsFile } from "./definitions";
import type { SectionId } from "./identifiers";
import type { ModuleConfig } from "./manifest";
import type { OrdinanceHistory } from "./ordinance-history";
import type { ReferencesFile } from "./references";
import type { ResolutionHistory } from "./resolution-history";
import type { SectionFile } from "./section";
import type { SkippedEntry } from "./corpus-meta";

/**
 * The fully-validated, enriched output of parsing one module out of a
 * jurisdiction source export. Everything a downstream writer needs is
 * here: validated entries by kind, the computed definitions and references
 * graphs, the skipped-entry log (parser-time and validator-time), and
 * which entry kinds appeared.
 *
 * Intended downstream: hand the whole object to `writeModule()` from
 * `@/storage`. Do not destructure for orchestration — that is a sign the
 * boundary is leaking.
 */
export interface ParsedModule {
  /** The manifest module config this result corresponds to. */
  module: ModuleConfig;
  /** Validated section entries; safe to write to disk verbatim. */
  sections: SectionFile[];
  /** Validated appendix entries. */
  appendices: Appendix[];
  /** Validated ordinance-history digest entries. */
  ordinanceHistories: OrdinanceHistory[];
  /** Validated resolution-history digest entries. */
  resolutionHistories: ResolutionHistory[];
  /** definitions.json content for this module. */
  definitions: DefinitionsFile;
  /** references.json content for this module. */
  references: ReferencesFile;
  /**
   * Entries the parser or validator could not promote. Contributes to the
   * 0%-skip-rate gate. The gate itself lives in storage; this list is the
   * input it consumes.
   */
  skipped: SkippedEntry[];
  /** Non-fatal observations surfaced to the caller (logging, dashboards). */
  warnings: ParseWarning[];
  /**
   * Distinct CorpusEntry kinds emitted in this module, sorted and unique.
   * Always includes "section". Drives `corpus_entry_kinds` in corpus-meta.
   */
  corpusEntryKinds: CorpusEntryKind[];
  /**
   * Per-section storage-path components, indexed by section id. The parser
   * computes these (today via `slugify(hierarchy[i])`); the storage writer
   * uses them to lay out `<output>/sections/<...path>/<id>.json`. Carrying
   * the addresses on the contract keeps the slug algorithm parser-private
   * and prevents the parser/storage path encoding from drifting.
   */
  sectionPaths: Record<SectionId, readonly string[]>;
  /**
   * Every JD_ anchor's id (with the "JD_" prefix stripped) inside this
   * module's bound — including anchors NOT promoted to sections (deletion
   * stubs, Note sub-elements, paragraph subscripts). The corpus-level
   * citation gate uses this to resolve cites to anchors that exist in source but
   * aren't queryable sections. Validates that the cited content is at
   * least documented in the source material.
   */
  tocAnchors: readonly string[];
}

/**
 * Non-fatal observations the parser surfaces to callers. Open union — add
 * new variants here (and ideally a `kind` discriminator) when more land.
 */
export type ParseWarning = UnresolvedInterCodeLinkWarning;

export interface UnresolvedInterCodeLinkWarning {
  sourceModuleId: string;
  sourceSectionId: string;
  rawInfobasePath: string;
  rawDestinationId: string;
  reason: string;
}
