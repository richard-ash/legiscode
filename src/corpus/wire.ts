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
