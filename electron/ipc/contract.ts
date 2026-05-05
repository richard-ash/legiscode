// Single source of truth for the typed IPC bridge between the Electron main
// process and the renderer. Every IPC concern lives here:
//   • Domain payload shapes (CorpusTreeNode, CorpusSectionView, ...)
//   • The channel registry (`ChannelMap`) — adding a channel is an entry here
//   • The runtime allowlist (`CHANNELS`) — cross-checked against `ChannelMap`
//     at compile time so the two cannot drift
//   • The renderer-facing `Api` shape — hand-written, namespaced for ergonomics
//   • The `IpcBridgeError` class — wraps plumbing failures
//
// Adding a channel is a two-place edit in this file (one entry in `ChannelMap`,
// one in `CHANNELS`) plus one entry in main.ts's handler literal. The renderer's
// `Api` type is hand-maintained; renderer call sites surface a TS error if a
// channel exists at the wire level without an `Api` method.
//
// Process discipline: this module is process-agnostic — no `ipcMain`,
// `ipcRenderer`, or `contextBridge` imports. main-handlers.ts and
// preload-bridge.ts own those, respectively.
//
// Channel-name convention: "<namespace>:<verb>", lowercase, hyphenated for
// multi-word namespaces. Channels are flat strings on the wire; the
// `window.api.<ns>.<method>()` namespacing is renderer-side ergonomics.
//
// Error model:
//   • Plumbing errors (renderer disconnect, handler throw) reject the
//     renderer-side promise as `IpcBridgeError`. These are bugs.
//   • Domain failures (section not found, corpus not loaded) resolve with a
//     discriminated `{ ok: false, error: ... }` Result — never thrown.

import type { SectionFile } from "@/types";

// ─── Domain shapes ──────────────────────────────────────────────────────────

/**
 * Tree node returned by `corpus:list`. Mirrors the shape `chrome.jsx`'s
 * `Tree` component consumes — Phase 1 structure-tree.tsx renders this
 * verbatim. `feat/file-tree` (Phase 2) extends with pending-amendment dots
 * and search wiring; the wire shape stays compatible.
 *
 * Tree levels in Phase 1:
 *   level 0 — module ("code" kind: e.g. "Port Code")
 *   level 1 — intra-module hierarchy ("chapter" kind: Article/Chapter/Division
 *             markers parsed out of `section.hierarchy[]`)
 *   leaf    — section ("section" kind)
 */
export interface CorpusTreeNode {
  /** Stable id, unique across the entire jurisdiction. */
  id: string;
  /** Display code or section number, e.g. "1.01" or "§ 1.01.010". */
  code: string;
  /** Display name, e.g. "Article 1 — General Provisions". */
  name: string;
  /** Discriminator drives the icon (folder vs section) in structure-tree. */
  kind: "code" | "chapter" | "section";
  /**
   * Section pointer — only set on `kind: "section"` leaves. Carries enough
   * for the renderer to issue a `corpus:read` without re-deriving the
   * (moduleId, sectionId) split from the tree id.
   */
  ref?: { moduleId: string; sectionId: string };
  /** Children — only present for non-section nodes. */
  kids?: CorpusTreeNode[];
}

/**
 * Jurisdiction-wide summary returned by `corpus:list`. The bundled corpus
 * is structured as one or more modules under a jurisdiction root (e.g.
 * `sf-port`, `sf-fire`, ... under `San Francisco`). Phase 1 surfaces all of
 * them under a single tree; the rendered status-bar version is the latest
 * `module_version` across modules.
 */
export interface CorpusModuleSummary {
  jurisdiction: string;
  /** Display label for the corpus root, e.g. "SF Municipal Code". */
  rootLabel: string;
  /** YYYY.MM.DD — latest `module_version` across loaded modules. */
  jurisdictionVersion: string;
  /** Number of code modules loaded (e.g., 18). Drives the indexed-count slot. */
  codeCount: number;
  /** Total section count across all modules, for downstream telemetry. */
  sectionCount: number;
  /** Default section to open on first launch — first module, first section. */
  defaultRef: { moduleId: string; sectionId: string };
  /** Top-level structure tree, eagerly loaded in Phase 1. */
  tree: CorpusTreeNode[];
}

export interface CorpusReadRequest {
  moduleId: string;
  sectionId: string;
}

/**
 * Section payload returned by `corpus:read`. Carries enough context for the
 * Phase 1 stub center panel (header + body) and the breadcrumb stub
 * (title → chapter → section path) without a second round-trip.
 */
export interface CorpusSectionView {
  moduleId: string;
  section: SectionFile;
  /** Display path from corpus root to this section's parent (for breadcrumb). */
  parents: ReadonlyArray<{ code: string; name: string }>;
  /** Adjacent section refs for prev/next navigation, scoped to the module. */
  prev: { moduleId: string; sectionId: string } | null;
  next: { moduleId: string; sectionId: string } | null;
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
  /** Monotonic ms timestamp from the main process. Drives the C13 canary. */
  pong: number;
}

// ─── Channel registry ───────────────────────────────────────────────────────

/**
 * The wire contract. Every channel maps `request → response`. `request: void`
 * means the channel takes no payload (`window.api.<ns>.<verb>()`).
 *
 * To add a channel:
 *   1. Add an entry here.
 *   2. Add the channel name to `CHANNELS` below (compile-time check enforces it).
 *   3. Add a method to `Api` below (renderer call-site enforces it).
 *   4. Add a handler entry to the `Handlers` literal in electron/main.ts.
 */
export interface ChannelMap {
  "corpus:list": { request: void; response: CorpusListResult };
  "corpus:read": { request: CorpusReadRequest; response: CorpusReadResult };
  "app:ping": { request: void; response: AppPingResult };
}

export type Channel = keyof ChannelMap;
export type ChannelRequest<C extends Channel> = ChannelMap[C]["request"];
export type ChannelResponse<C extends Channel> = ChannelMap[C]["response"];

/**
 * Runtime channel allowlist. preload-bridge.ts iterates this to wire the
 * `window.api` shape; main-handlers.ts iterates it to register `ipcMain.handle`
 * once per channel. Cross-checked against `ChannelMap` keys at compile time
 * — adding a channel to one without the other is a TypeScript error.
 */
export const CHANNELS = ["corpus:list", "corpus:read", "app:ping"] as const;

// Compile-time cross-check: CHANNELS and ChannelMap must enumerate the same
// set of channel names. Either side adding/removing without the other fires
// a type error here, not at runtime.
type _ChannelsMatchMap = [
  Exclude<Channel, (typeof CHANNELS)[number]>,
  Exclude<(typeof CHANNELS)[number], Channel>,
];
const _channelsMatchMap: _ChannelsMatchMap = [null as never, null as never];
void _channelsMatchMap;

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

// ─── Renderer-facing Api shape ──────────────────────────────────────────────

/**
 * The `window.api` surface exposed by preload-bridge.ts via contextBridge.
 * Hand-written and namespaced for call-site ergonomics: renderer code calls
 * `window.api.corpus.list()` rather than `window.api["corpus:list"]()`.
 *
 * Adding a channel: extend `ChannelMap` first, then add the corresponding
 * method here. Renderer call sites enforce coverage — a missing method
 * surfaces as a TS error at the call site, not silently.
 */
export interface Api {
  corpus: {
    list: () => Promise<CorpusListResult>;
    read: (request: CorpusReadRequest) => Promise<CorpusReadResult>;
  };
  app: {
    ping: () => Promise<AppPingResult>;
  };
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Plumbing-level IPC failure. Domain failures (corpus not loaded, section
 * not found) flow through a `Result` discriminator and never throw — only
 * unknown channels, renderer disconnects, and handler exceptions surface as
 * `IpcBridgeError`.
 */
export class IpcBridgeError extends Error {
  constructor(
    public readonly channel: string,
    public readonly reason: "unknown_channel" | "handler_threw" | "renderer_disconnected",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IpcBridgeError";
  }
}
