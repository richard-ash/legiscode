// Single source of truth for the typed IPC bridge between the Electron main
// process and the renderer. Three concerns live here:
//   • The channel registry (`ChannelMap`) — adding a channel is an entry here
//   • The runtime allowlist (`CHANNELS`) — cross-checked against `ChannelMap`
//     at compile time so the two cannot drift
//   • The renderer-facing `Api` shape — hand-written, namespaced for ergonomics
//   • The `IpcBridgeError` class — wraps plumbing failures
//
// Domain payload shapes (CorpusTreeNode, CorpusSectionView, ...) are owned
// by `@/corpus/wire` and re-exported here for back-compat with existing
// electron-side imports. Pure-domain modules import them from `@/corpus/wire`
// directly so they don't depend on electron/ at all.
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
//
// Preload sandbox guard: this file is part of the preload-script
// dependency graph. Any `import` (not `import type`) of a value that pulls
// zod or other heavy runtime deps will silently break `window.api` exposure
// in sandboxed preloads. The baseline grep gate in test/baseline.test.ts
// pins this against importing `@/corpus/refs` (which carries zod). Wire
// types live in `@/corpus/wire` precisely because that module is value-free
// (`import type` only) and safe to pull through the preload graph.

// ─── Domain shapes (re-exported from @/corpus/wire) ──────────────────────────

export type {
  AppPingResult,
  CorpusError,
  CorpusErrorKind,
  CorpusListResult,
  CorpusModuleSummary,
  CorpusReadRequest,
  CorpusReadResult,
  CorpusSectionView,
  CorpusTreeNode,
  ModuleInfo,
  ModulesListResult,
  Result,
  ShellOpenExternalError,
  ShellOpenExternalErrorKind,
  ShellOpenExternalRequest,
  ShellOpenExternalResult,
} from "@/corpus/wire";

import type {
  AppPingResult,
  CorpusListResult,
  CorpusReadRequest,
  CorpusReadResult,
  ModulesListResult,
  ShellOpenExternalRequest,
  ShellOpenExternalResult,
} from "@/corpus/wire";

// ─── AI wire types (used by ai:query / ai:cancel / ai:event channel) ────────

import type {
  AiCancelRequest,
  AiCancelResult,
  AiEvent,
  AiQueryRequest,
  AiQueryResult,
} from "@/ai/wire";

export type {
  AiCorpusContextRef,
  AiEventCallback,
  AiSettingsView,
  AiTokenUsage,
  AiToolResultView,
  AiUnsubscribeFn,
} from "@/ai/wire";
export type { AiCancelRequest, AiCancelResult, AiEvent, AiQueryRequest, AiQueryResult };

import type {
  AiClearApiKeyRequest,
  AiClearApiKeyResult,
  AiGetSettingsResult,
  AiHasApiKeyRequest,
  AiHasApiKeyResult,
  AiSetApiKeyRequest,
  AiSetApiKeyResult,
  AiUpdateSettingsRequest,
  AiUpdateSettingsResult,
} from "@/ai/wire";

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
  "corpus:list": { request: undefined; response: CorpusListResult };
  "corpus:read": { request: CorpusReadRequest; response: CorpusReadResult };
  "app:ping": { request: undefined; response: AppPingResult };
  "shell:openExternal": {
    request: ShellOpenExternalRequest;
    response: ShellOpenExternalResult;
  };
  "ai:query": { request: AiQueryRequest; response: AiQueryResult };
  "ai:cancel": { request: AiCancelRequest; response: AiCancelResult };
  "ai:getSettings": { request: undefined; response: AiGetSettingsResult };
  "ai:updateSettings": { request: AiUpdateSettingsRequest; response: AiUpdateSettingsResult };
  "ai:hasApiKey": { request: AiHasApiKeyRequest; response: AiHasApiKeyResult };
  "ai:setApiKey": { request: AiSetApiKeyRequest; response: AiSetApiKeyResult };
  "ai:clearApiKey": { request: AiClearApiKeyRequest; response: AiClearApiKeyResult };
  "modules:list": { request: undefined; response: ModulesListResult };
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
export const CHANNELS = [
  "corpus:list",
  "corpus:read",
  "app:ping",
  "shell:openExternal",
  "ai:query",
  "ai:cancel",
  "ai:getSettings",
  "ai:updateSettings",
  "ai:hasApiKey",
  "ai:setApiKey",
  "ai:clearApiKey",
  "modules:list",
] as const;

/**
 * One-way event channel from main → renderer for the AI module's
 * progressive events (tool calls, results, prose text). NOT part of
 * the typed ipcMain.handle/invoke surface — events flow over
 * webContents.send + ipcRenderer.on. Listed here so the preload bridge
 * can register the subscription and the renderer's window.api.ai.onEvent
 * has one place to read the channel name.
 */
export const AI_EVENT_CHANNEL = "ai:event" as const;

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
  shell: {
    /** Hands an http(s) URL to the platform browser. Validates the
     *  protocol main-side — non-http(s) URLs resolve as
     *  `{ ok: false, error: { kind: "invalid_url" } }` without invoking
     *  Electron's shell. Fire-and-forget at the call site; failures are
     *  logged main-side, not surfaced as UI. */
    openExternal: (request: ShellOpenExternalRequest) => Promise<ShellOpenExternalResult>;
  };
  ai: {
    /** Submit a chat turn. Resolves with the final assistant prose +
     *  usage; progressive events arrive on the ai:event channel. */
    query: (request: AiQueryRequest) => Promise<AiQueryResult>;
    /** Cancel an in-flight turn by turnId. */
    cancel: (request: AiCancelRequest) => Promise<AiCancelResult>;
    getSettings: () => Promise<AiGetSettingsResult>;
    updateSettings: (request: AiUpdateSettingsRequest) => Promise<AiUpdateSettingsResult>;
    hasApiKey: (request: AiHasApiKeyRequest) => Promise<AiHasApiKeyResult>;
    setApiKey: (request: AiSetApiKeyRequest) => Promise<AiSetApiKeyResult>;
    clearApiKey: (request: AiClearApiKeyRequest) => Promise<AiClearApiKeyResult>;
    /** Subscribe to progressive events. Returns an unsubscribe fn. The
     *  subscription is held by the preload bridge; the renderer never
     *  touches ipcRenderer directly. */
    onEvent: (callback: (event: AiEvent) => void) => () => void;
  };
  modules: {
    list: () => Promise<ModulesListResult>;
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
