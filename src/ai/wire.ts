// AI module wire types. Pure TS shapes, no runtime imports — same
// preload-safety rule as @/corpus/wire. The IPC contract re-exports
// these so renderer call sites and electron handler types stay aligned.

/** Qualified section reference — every AI surface uses these, never bare ids. */
export interface AiCorpusContextRef {
  module_id: string;
  section_id: string;
}

export interface AiTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Shape sent back to the renderer for a single tool result. Mirrors the
 *  main-side ToolResultBase but stays plain. */
export interface AiToolResultView {
  ok: boolean;
  fetched: readonly AiCorpusContextRef[];
  corpus_hash: string;
  turn_id: number;
  /** Tool-specific payload; the renderer reads `name` from the matching
   *  tool_call event to decide how to render the expanded body. */
  payload: unknown;
}

// ─── ai:query ───────────────────────────────────────────────────────────────

export interface AiQueryRequest {
  /** Stable per chat session. Today the renderer ships one global
   *  thread (chat_id = "global"); pinning a chat would assign a
   *  fresh id. */
  chat_id: string;
  /** The currently-focused section, if any. Used as default scope
   *  for bare-cite resolution. Omitted on tabs without a section
   *  anchor (Bill, Settings, empty workbench); the model must use
   *  qualified `[module § id]` cites in that case. */
  anchor?: AiCorpusContextRef;
  /** Free-text user prompt; capped at 4000 chars by the main handler. */
  prompt: string;
}

export interface AiQueryResult {
  ok: boolean;
  /** Echoed back so the renderer can ignore stale responses (race guard). */
  chat_id: string;
  /** Monotonic per chat; renderer ignores events with a lower turn_id. */
  turn_id: number;
  /** Final assistant prose for the turn. */
  text: string;
  usage: AiTokenUsage;
  /** Reason the turn ended. */
  stop_reason: "end_turn" | "max_rounds" | "cancelled" | "error" | "no_provider";
  error?: {
    kind:
      | "network"
      | "rate_limited"
      | "auth"
      | "timeout"
      | "cancelled"
      | "bad_request"
      | "internal"
      | "no_provider"
      | "no_corpus"
      | "bad_payload";
    message: string;
  };
}

// ─── ai:cancel ──────────────────────────────────────────────────────────────

export interface AiCancelRequest {
  chat_id: string;
  turn_id: number;
}

export interface AiCancelResult {
  ok: boolean;
  /** True when the cancel signal reached an in-flight turn; false when
   *  there was nothing to cancel (already complete or unknown). */
  cancelled: boolean;
}

// ─── ai:event channel (one-way push) ────────────────────────────────────────

export type AiEvent =
  | {
      kind: "turn_started";
      chat_id: string;
      turn_id: number;
    }
  | {
      kind: "tool_call";
      chat_id: string;
      turn_id: number;
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      chat_id: string;
      turn_id: number;
      tool_use_id: string;
      result: AiToolResultView;
    }
  | {
      kind: "text_delta";
      chat_id: string;
      turn_id: number;
      text: string;
    }
  | {
      kind: "turn_completed";
      chat_id: string;
      turn_id: number;
      text: string;
      usage: AiTokenUsage;
      stop_reason: "end_turn" | "max_rounds" | "cancelled" | "error" | "no_provider";
    }
  | {
      kind: "turn_error";
      chat_id: string;
      turn_id: number;
      message: string;
    }
  | {
      kind: "turn_cancelled";
      chat_id: string;
      turn_id: number;
    };

export type AiEventCallback = (event: AiEvent) => void;
export type AiUnsubscribeFn = () => void;

// ─── ai:getSettings / ai:updateSettings ─────────────────────────────────────

export interface AiSettingsView {
  active_provider: "anthropic";
  model: string;
  telemetry_enabled: boolean;
  /** Models the renderer shows in the dropdown. */
  available_models: readonly string[];
  /** True when an API key for the active provider is configured. */
  has_active_provider_key: boolean;
  /** Cumulative token spend for this electron run; resets on app restart
   *  (in-memory only, per v1 lock). */
  session_usage: AiTokenUsage;
}

export type AiGetSettingsResult = AiSettingsView;

export interface AiUpdateSettingsRequest {
  model?: string;
  telemetry_enabled?: boolean;
}

export type AiUpdateSettingsResult = AiSettingsView;

// ─── ai:hasApiKey / ai:setApiKey / ai:clearApiKey ───────────────────────────

export interface AiHasApiKeyRequest {
  provider_id: "anthropic";
}

export interface AiHasApiKeyResult {
  has_key: boolean;
}

export interface AiSetApiKeyRequest {
  provider_id: "anthropic";
  api_key: string;
}

export interface AiSetApiKeyResult {
  ok: boolean;
  /** When false, the platform did not support safeStorage or the key
   *  failed a minimum-length check. */
  reason?: "no_encryption" | "too_short" | "internal";
}

export interface AiClearApiKeyRequest {
  provider_id: "anthropic";
}

export interface AiClearApiKeyResult {
  ok: boolean;
}
