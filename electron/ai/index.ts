// Main-process AI module orchestrator. Builds the per-electron-run
// state (active provider, conversation manager, in-flight turn set,
// session usage) and returns IPC handler implementations the
// main.ts handler literal plugs in.
//
// Per A8: every handler gates on corpus readiness. Per N8: every handler
// validates payload shape (zod) + caps prompt length + enforces 1-in-
// flight per window.

import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type {
  AiCancelResult,
  AiClearApiKeyRequest,
  AiClearApiKeyResult,
  AiEvent,
  AiGetSettingsResult,
  AiHasApiKeyRequest,
  AiHasApiKeyResult,
  AiQueryRequest,
  AiQueryResult,
  AiSetApiKeyRequest,
  AiSetApiKeyResult,
  AiTokenUsage,
  AiUpdateSettingsRequest,
  AiUpdateSettingsResult,
} from "@/ai/wire";
import { type AiCorpusHandle, getAiCorpusHandle } from "../corpus-loader";
import { AI_EVENT_CHANNEL } from "../ipc/contract";
import {
  type ConversationEvent,
  ConversationManager,
  makeRouterFn,
  runConversationTurn,
} from "./conversation";
import { installAiNetworkAllowlist } from "./network-allowlist";
import { SYSTEM_PROMPT_HASH } from "./prompt";
import { buildProvider, type ModelProvider } from "./providers/index";
import {
  clearApiKey,
  hasApiKey,
  readAiSettings,
  readApiKey,
  writeAiSettings,
  writeApiKey,
} from "./settings";
import { emitTelemetry, setTelemetryEnabled } from "./telemetry";
import type { ToolResultBase } from "./tools/types";

const PROMPT_CHARACTER_CAP = 4000;

// ─── Payload schemas (per N8) ───────────────────────────────────────────────

const QualifiedRefSchema = z
  .object({
    module_id: z.string().min(1).max(120),
    section_id: z.string().min(1).max(120),
  })
  .strict();

const AiQueryRequestSchema = z
  .object({
    chat_id: z.string().min(1).max(120),
    anchor: QualifiedRefSchema.optional(),
    prompt: z.string().min(1).max(PROMPT_CHARACTER_CAP),
  })
  .strict();

const AiCancelRequestSchema = z
  .object({
    chat_id: z.string().min(1).max(120),
    turn_id: z.number().int().positive(),
  })
  .strict();

const AiUpdateSettingsRequestSchema = z
  .object({
    model: z.string().min(1).max(120).optional(),
    telemetry_enabled: z.boolean().optional(),
  })
  .strict();

const AiSetApiKeyRequestSchema = z
  .object({
    provider_id: z.literal("anthropic"),
    api_key: z.string().min(8).max(1024),
  })
  .strict();

const AiKeyProviderSchema = z.object({ provider_id: z.literal("anthropic") }).strict();

// ─── Runtime state ──────────────────────────────────────────────────────────

interface InFlightTurn {
  controller: AbortController;
  chatId: string;
  turnId: number;
}

interface Runtime {
  manager: ConversationManager;
  /** windowId → set of in-flight turns. N8 limits this to 1 per window. */
  inFlight: Map<number, InFlightTurn>;
  sessionUsage: AiTokenUsage;
  provider: ModelProvider | null;
  providerModel: string;
}

let runtime: Runtime | null = null;

function ensureRuntime(): Runtime {
  if (runtime) return runtime;
  installAiNetworkAllowlist();
  const settings = readAiSettings();
  setTelemetryEnabled(settings.telemetryEnabled);
  runtime = {
    manager: new ConversationManager(),
    inFlight: new Map(),
    sessionUsage: zeroUsage(),
    provider: buildProvider("anthropic", { readApiKey }),
    providerModel: settings.model,
  };
  return runtime;
}

/** Test seam. */
export function __resetAiRuntimeForTests(): void {
  runtime = null;
}

// ─── IPC handlers ───────────────────────────────────────────────────────────

export interface AiHandlerDeps {
  /** Resolves a webContents-bearing window for an invoke event so the
   *  handler can push ai:event packets back. Optional override for tests. */
  resolveWindow?(event: IpcMainInvokeEvent): BrowserWindow | null;
}

export function buildAiHandlers(deps: AiHandlerDeps = {}) {
  return {
    "ai:query": async (raw: unknown, event?: IpcMainInvokeEvent): Promise<AiQueryResult> => {
      const parsed = AiQueryRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return errorResult(
          "(unknown)",
          0,
          "bad_payload",
          parsed.error.issues[0]?.message ?? "bad payload",
        );
      }
      const req: AiQueryRequest = parsed.data;
      const window = deps.resolveWindow?.(event ?? ({} as IpcMainInvokeEvent)) ?? null;
      return runQuery(req, window);
    },
    "ai:cancel": async (raw: unknown): Promise<AiCancelResult> => {
      const parsed = AiCancelRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, cancelled: false };
      const r = ensureRuntime();
      for (const [, entry] of r.inFlight) {
        if (entry.chatId === parsed.data.chat_id && entry.turnId === parsed.data.turn_id) {
          entry.controller.abort();
          return { ok: true, cancelled: true };
        }
      }
      return { ok: true, cancelled: false };
    },
    "ai:getSettings": async (): Promise<AiGetSettingsResult> => {
      return projectSettings();
    },
    "ai:updateSettings": async (raw: unknown): Promise<AiUpdateSettingsResult> => {
      const parsed = AiUpdateSettingsRequestSchema.safeParse(raw);
      if (!parsed.success) return projectSettings();
      const req: AiUpdateSettingsRequest = parsed.data;
      const next = writeAiSettings({
        ...(req.model !== undefined ? { model: req.model } : {}),
        ...(req.telemetry_enabled !== undefined ? { telemetryEnabled: req.telemetry_enabled } : {}),
      });
      const r = ensureRuntime();
      r.providerModel = next.model;
      setTelemetryEnabled(next.telemetryEnabled);
      return projectSettings();
    },
    "ai:hasApiKey": async (raw: unknown): Promise<AiHasApiKeyResult> => {
      const parsed = AiKeyProviderSchema.safeParse(raw);
      if (!parsed.success) return { has_key: false };
      const req: AiHasApiKeyRequest = parsed.data;
      return { has_key: hasApiKey(req.provider_id) };
    },
    "ai:setApiKey": async (raw: unknown): Promise<AiSetApiKeyResult> => {
      const parsed = AiSetApiKeyRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: parsed.error.issues[0]?.path.includes("api_key") ? "too_short" : "internal",
        };
      }
      const req: AiSetApiKeyRequest = parsed.data;
      const stored = writeApiKey(req.provider_id, req.api_key);
      if (!stored) return { ok: false, reason: "no_encryption" };
      const r = ensureRuntime();
      r.provider = buildProvider(req.provider_id, { readApiKey });
      return { ok: true };
    },
    "ai:clearApiKey": async (raw: unknown): Promise<AiClearApiKeyResult> => {
      const parsed = AiKeyProviderSchema.safeParse(raw);
      if (!parsed.success) return { ok: false };
      const req: AiClearApiKeyRequest = parsed.data;
      clearApiKey(req.provider_id);
      const r = ensureRuntime();
      r.provider = null;
      return { ok: true };
    },
  };
}

// ─── Conversation orchestration ─────────────────────────────────────────────

async function runQuery(req: AiQueryRequest, window: BrowserWindow | null): Promise<AiQueryResult> {
  const r = ensureRuntime();
  const corpus = getAiCorpusHandle();
  if (!corpus) {
    return errorResult(req.chat_id, 0, "no_corpus", "Corpus has not finished loading.");
  }
  if (!r.provider) {
    return errorResult(req.chat_id, 0, "no_provider", "No API key configured. Open AI settings.");
  }
  // 1-in-flight per window (N8).
  const windowId = window?.id ?? 0;
  const existing = r.inFlight.get(windowId);
  if (existing) {
    return errorResult(
      req.chat_id,
      0,
      "bad_request",
      "Another query is in flight; cancel it first.",
    );
  }
  const turnId = r.manager.nextTurnId(req.chat_id);
  const controller = new AbortController();
  r.inFlight.set(windowId, { controller, chatId: req.chat_id, turnId });

  const emit = (event: AiEvent): void => {
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(AI_EVENT_CHANNEL, event);
    } catch {
      // Tab probably closed mid-turn; the renderer-side teardown handles it.
    }
  };

  emit({ kind: "turn_started", chat_id: req.chat_id, turn_id: turnId });
  emitTelemetry({
    kind: "ai.turn.started",
    ts: new Date().toISOString(),
    corpus_hash: corpus.corpusHash,
    prompt_hash: SYSTEM_PROMPT_HASH,
    turn_id: turnId,
    chat_id: req.chat_id,
  });

  try {
    const history = r.manager.history(req.chat_id);
    const turn = await runConversationTurn(
      {
        provider: r.provider,
        model: r.providerModel,
        // No active section anchor → empty string. The verifier still
        // resolves bare § cites by scanning every fetched module; only
        // a model that cites a section it never fetched fails the gate.
        anchorModule: req.anchor?.module_id ?? "",
        router: makeRouterFn({ corpus, turnId }),
      },
      {
        turnId,
        history,
        userPrompt: req.prompt,
        signal: controller.signal,
        onEvent: (e) => forwardConversationEvent(e, req.chat_id, corpus, emit),
      },
    );

    r.manager.appendTurn(req.chat_id, turn.newMessages);
    addUsage(r.sessionUsage, turn.totalUsage);

    if (turn.stopReason === "cancelled") {
      emit({ kind: "turn_cancelled", chat_id: req.chat_id, turn_id: turnId });
      emitTelemetry({
        kind: "ai.turn.cancelled",
        ts: new Date().toISOString(),
        corpus_hash: corpus.corpusHash,
        prompt_hash: SYSTEM_PROMPT_HASH,
        turn_id: turnId,
        chat_id: req.chat_id,
      });
      return {
        ok: false,
        chat_id: req.chat_id,
        turn_id: turnId,
        text: turn.finalText,
        usage: toWireUsage(turn.totalUsage),
        stop_reason: "cancelled",
        error: { kind: "cancelled", message: "Turn cancelled by user." },
      };
    }
    if (turn.stopReason === "error") {
      const errKind = turn.error?.kind ?? "internal";
      emit({
        kind: "turn_error",
        chat_id: req.chat_id,
        turn_id: turnId,
        message: turn.error?.message ?? "Unknown error.",
      });
      emitTelemetry({
        kind: "ai.turn.error",
        ts: new Date().toISOString(),
        corpus_hash: corpus.corpusHash,
        prompt_hash: SYSTEM_PROMPT_HASH,
        turn_id: turnId,
        chat_id: req.chat_id,
        error_kind: errKind,
      });
      return {
        ok: false,
        chat_id: req.chat_id,
        turn_id: turnId,
        text: turn.finalText,
        usage: toWireUsage(turn.totalUsage),
        stop_reason: "error",
        error: { kind: errKind, message: turn.error?.message ?? "Unknown error." },
      };
    }

    emit({
      kind: "turn_completed",
      chat_id: req.chat_id,
      turn_id: turnId,
      text: turn.finalText,
      usage: toWireUsage(turn.totalUsage),
      stop_reason: turn.stopReason === "max_rounds" ? "max_rounds" : "end_turn",
    });
    emitTelemetry({
      kind: "ai.turn.completed",
      ts: new Date().toISOString(),
      corpus_hash: corpus.corpusHash,
      prompt_hash: SYSTEM_PROMPT_HASH,
      turn_id: turnId,
      chat_id: req.chat_id,
      total_tokens: turn.totalUsage.inputTokens + turn.totalUsage.outputTokens,
      cache_read: turn.totalUsage.cacheReadInputTokens,
      verifier_failures: turn.verifierFailures,
      // Per-turn latency breakdown (commit 2, feat/agent-polish). Lets
      // the operator see whether a slow turn (T03 at 409s in the MVP run)
      // was dominated by the provider rounds (extended thinking +
      // generation) or by the in-process tool dispatch. provider_latency
      // and tool_latency may overlap with each other only when a future
      // commit ships parallel dispatch; today they're serial and sum to
      // total wall-clock.
      round_count: turn.roundCount,
      tool_call_count: turn.toolCallCount,
      thinking_block_count: turn.thinkingBlockCount,
      total_latency_ms: turn.totalLatencyMs,
      provider_latency_ms: turn.providerLatencyMs,
      tool_latency_ms: turn.toolLatencyMs,
    });
    return {
      ok: true,
      chat_id: req.chat_id,
      turn_id: turnId,
      text: turn.finalText,
      usage: toWireUsage(turn.totalUsage),
      stop_reason: turn.stopReason === "max_rounds" ? "max_rounds" : "end_turn",
    };
  } finally {
    r.inFlight.delete(windowId);
  }
}

function forwardConversationEvent(
  e: ConversationEvent,
  chatId: string,
  corpus: AiCorpusHandle,
  emit: (event: AiEvent) => void,
): void {
  switch (e.kind) {
    case "tool_call":
      emit({
        kind: "tool_call",
        chat_id: chatId,
        turn_id: e.turnId,
        tool_use_id: e.toolUseId,
        name: e.name,
        input: e.input,
      });
      emitTelemetry({
        kind: "ai.tool.call",
        ts: new Date().toISOString(),
        corpus_hash: corpus.corpusHash,
        prompt_hash: SYSTEM_PROMPT_HASH,
        turn_id: e.turnId,
        chat_id: chatId,
        tool_name: e.name,
      });
      return;
    case "tool_result":
      emit({
        kind: "tool_result",
        chat_id: chatId,
        turn_id: e.turnId,
        tool_use_id: e.toolUseId,
        result: projectToolResult(e.result),
      });
      // Tool-call latency posts to telemetry only — the renderer's tool
      // chip already shows pending-vs-done; the millisecond figure is for
      // post-hoc latency analysis, not UI.
      emitTelemetry({
        kind: "ai.tool.result",
        ts: new Date().toISOString(),
        corpus_hash: corpus.corpusHash,
        prompt_hash: SYSTEM_PROMPT_HASH,
        turn_id: e.turnId,
        chat_id: chatId,
        tool_use_id: e.toolUseId,
        ok: e.result.ok,
        latency_ms: e.latencyMs,
      });
      return;
    case "text":
      emit({
        kind: "text_delta",
        chat_id: chatId,
        turn_id: e.turnId,
        text: e.text,
      });
      return;
    case "round_completed":
      // Round-level events stay local; the renderer doesn't render them.
      // Telemetry captures the per-round breakdown so the operator can
      // see whether wall-clock comes from the provider call (extended
      // thinking, generation) or downstream tool dispatch.
      emitTelemetry({
        kind: "ai.round.completed",
        ts: new Date().toISOString(),
        corpus_hash: corpus.corpusHash,
        prompt_hash: SYSTEM_PROMPT_HASH,
        turn_id: e.turnId,
        chat_id: chatId,
        round: e.round,
        latency_ms: e.latencyMs,
        thinking_block_count: e.thinkingBlockCount,
        prompt_message_count: e.promptMessageCount,
        tool_call_count: e.toolCallCount,
        input_tokens: e.usage.inputTokens,
        output_tokens: e.usage.outputTokens,
        cache_creation_input_tokens: e.usage.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: e.usage.cacheReadInputTokens ?? 0,
      });
      return;
    case "verification_outcome":
      // Renderer never sees the verifier per N17/N18; only telemetry
      // captures it, and only when the user has opted in.
      emitTelemetry({
        kind: "ai.verification.outcome",
        ts: new Date().toISOString(),
        corpus_hash: corpus.corpusHash,
        prompt_hash: SYSTEM_PROMPT_HASH,
        turn_id: e.turnId,
        chat_id: chatId,
        round: e.round,
        ok: e.ok,
        matched_count: e.matchedCount,
        missing_count: e.missing.length,
        missing: e.missing,
      });
      return;
  }
}

function projectToolResult(result: ToolResultBase) {
  // Strip the leading {ok, fetched, corpus_hash, turn_id} from the tool's
  // tool-specific fields and project them as `payload`.
  const { ok, fetched, corpus_hash, turn_id, ...payload } = result as ToolResultBase & {
    [key: string]: unknown;
  };
  return { ok, fetched, corpus_hash, turn_id, payload };
}

function projectSettings(): AiGetSettingsResult {
  const r = ensureRuntime();
  const stored = readAiSettings();
  return {
    active_provider: stored.activeProvider,
    model: stored.model,
    telemetry_enabled: stored.telemetryEnabled,
    available_models: r.provider?.availableModels ?? [
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-opus-4-7",
    ],
    has_active_provider_key: hasApiKey(stored.activeProvider),
    session_usage: r.sessionUsage,
  };
}

function errorResult(
  chatId: string,
  turnId: number,
  kind: NonNullable<AiQueryResult["error"]>["kind"],
  message: string,
): AiQueryResult {
  return {
    ok: false,
    chat_id: chatId,
    turn_id: turnId,
    text: "",
    usage: zeroUsage(),
    stop_reason: kind === "no_provider" ? "no_provider" : "error",
    error: { kind, message },
  };
}

function zeroUsage(): AiTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addUsage(
  acc: AiTokenUsage,
  delta: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
): void {
  acc.input_tokens += delta.inputTokens;
  acc.output_tokens += delta.outputTokens;
  acc.cache_creation_input_tokens += delta.cacheCreationInputTokens;
  acc.cache_read_input_tokens += delta.cacheReadInputTokens;
}

function toWireUsage(d: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}): AiTokenUsage {
  return {
    input_tokens: d.inputTokens,
    output_tokens: d.outputTokens,
    cache_creation_input_tokens: d.cacheCreationInputTokens,
    cache_read_input_tokens: d.cacheReadInputTokens,
  };
}
