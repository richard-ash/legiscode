// Wire-shape domain primitives. Pure TS interfaces, zero runtime imports
// (only `import type`), so any consumer — renderer, sandboxed preload,
// CLI, future SSR — can pull these without dragging zod or other heavy
// runtime deps through their dependency graph.
//
// Layered responsibility: the IPC contract (electron/ipc/contract.ts)
// re-exports these so existing electron call sites stay unchanged. The
// pure-domain modules (@/corpus-nav, @/ui/...) import from here directly
// instead of reaching across the process boundary into electron/.
//
// Adding a wire type here ONLY costs a structural shape; if a new field
// needs validation, validation lives in the boundary helper (e.g.
// corpusRefFromWire in @/corpus/refs), not in this file.

import type { SectionFile, SectionId } from "@/types";

/**
 * Tree node returned by `corpus:list`. Tree levels:
 *   level 0 — module ("code" kind)
 *   level 1 — intra-module hierarchy ("chapter" kind)
 *   leaf    — section ("section" kind)
 */
export interface CorpusTreeNode {
  /** Stable id, unique across the entire jurisdiction. */
  id: string;
  /** Display code or section number, e.g. "1.01" or "§ 1.01.010". */
  code: string;
  /** Display name, e.g. "Article 1 — General Provisions". */
  name: string;
  /** Discriminator drives the icon (folder vs section) in the file tree. */
  kind: "code" | "chapter" | "section";
  /**
   * Section pointer — only set on `kind: "section"` leaves. Carries the
   * (moduleId, sectionId) split so the renderer can issue a `corpus:read`
   * without re-deriving from the tree id.
   */
  ref?: { moduleId: string; sectionId: string };
  /**
   * Short body excerpt for the citation hover popover — only set on
   * `kind: "section"` leaves. Pre-baked at corpus-load time so the
   * popover renders synchronously, matching the DefinedTerm tooltip
   * pattern (no IPC, no flicker). Bounded length keeps the tree blob
   * small enough to ship over IPC at startup.
   */
  preview?: string;
  /**
   * Subsection-keyed excerpts for cites whose target carries a
   * `subsection` field (e.g. "Subsection (a)"). Keyed by the
   * subsection_label string emitted by the parser ("(a)", "(1)"); the
   * citation target's `subsection` field uses the same string format.
   * Pre-baked alongside `preview` so the popover stays synchronous.
   * Omitted when the section has no subsection_label segments.
   */
  subsectionPreviews?: Record<string, string>;
  /** Children — only present for non-section nodes. */
  kids?: CorpusTreeNode[];
}

/**
 * Jurisdiction-wide summary returned by `corpus:list`. The bundled corpus
 * is structured as one or more modules under a jurisdiction root.
 */
export interface CorpusModuleSummary {
  jurisdiction: string;
  /** Display label for the corpus root, e.g. "SF Municipal Code". */
  rootLabel: string;
  /** YYYY.MM.DD — latest `module_version` across loaded modules. */
  jurisdictionVersion: string;
  /** Number of code modules loaded. */
  codeCount: number;
  /** Total section count across all modules, for downstream telemetry. */
  sectionCount: number;
  /** Default section to open on first launch. */
  defaultRef: { moduleId: string; sectionId: string };
  /** Top-level structure tree, eagerly loaded. */
  tree: CorpusTreeNode[];
  /**
   * Per-(term, module) defined-term entries aggregated across every
   * loaded module. The command palette's `:def` subtype filter renders
   * one row per row here — cross-module collisions intentionally stay
   * as separate rows (a "Director" defined in `sf-port` is a different
   * legal authority than one defined in `sf-administrative`; silently
   * collapsing them would be materially wrong for legal reading).
   * Intra-module duplicates are summarized as "+N more" at the row
   * level; the full `definers` array is preserved here for that count.
   * Sorted by `(term, moduleId)` for stable display.
   */
  definitions: ReadonlyArray<{
    term: string;
    moduleId: string;
    definers: ReadonlyArray<SectionId>;
  }>;
}

export interface CorpusReadRequest {
  moduleId: string;
  sectionId: string;
}

/**
 * Section payload returned by `corpus:read`. Carries enough context for
 * the centre panel + breadcrumb without a second round-trip.
 */
export interface CorpusSectionView {
  moduleId: string;
  section: SectionFile;
  /** Display path from corpus root to this section's parent. */
  parents: ReadonlyArray<{ code: string; name: string }>;
  /** Adjacent section refs for prev/next navigation, scoped to the module. */
  prev: { moduleId: string; sectionId: string } | null;
  next: { moduleId: string; sectionId: string } | null;
  /**
   * Pre-resolved definition lookup for every term that appears as a
   * `defined_term` segment in this section's `body[]`. Pre-joining at
   * load time means the renderer's hover tooltip is synchronous (read
   * from props, no IPC, no flicker). The value is an array because a
   * term can be defined in multiple sections — the lookup preserves
   * every defining section. Keys are restricted to terms used in this
   * section so the payload size stays bounded by the section, not by
   * the module's full definitions dictionary.
   */
  definitions: Readonly<Record<string, ReadonlyArray<{ defined_in_section: SectionId }>>>;
}

export type CorpusErrorKind = "not_loaded" | "not_found" | "corrupt";

export interface CorpusError {
  kind: CorpusErrorKind;
  /** Human-readable detail, safe to surface in BootOverlay or toast. */
  detail: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type CorpusListResult = Result<CorpusModuleSummary, CorpusError>;
export type CorpusReadResult = Result<CorpusSectionView, CorpusError>;

export interface AppPingResult {
  /** Monotonic ms timestamp from the main process. */
  pong: number;
}

// ─── shell:openExternal ─────────────────────────────────────────────────────

export interface ShellOpenExternalRequest {
  /** URL to hand to the platform browser. Main-side validates the
   *  protocol is http(s) — anything else (file://, javascript:, custom
   *  schemes) is rejected to prevent shell.openExternal from being a
   *  privilege-escalation primitive for a future XSS in the renderer. */
  url: string;
}

export type ShellOpenExternalErrorKind = "invalid_url" | "platform_error";

export interface ShellOpenExternalError {
  kind: ShellOpenExternalErrorKind;
  /** Human-readable detail; safe to log but not surfaced as UI today. */
  detail: string;
}

export type ShellOpenExternalResult = Result<undefined, ShellOpenExternalError>;
