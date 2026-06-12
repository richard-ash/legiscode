// ModelProvider — the only vendor-neutral seam between the conversation
// loop and a concrete SDK. The AnthropicAdapter implements this and is
// the ONE file in the codebase that imports @anthropic-ai/sdk. Adding
// OpenAI later means writing one new adapter file; no other call site
// changes.
//
// Per the locked vendor-isolation rule (C9 / [[feedback_vendor_sdk_isolation]]),
// the shape stays minimum-viable. Don't extend it speculatively — if a
// future provider needs a richer field, add it on demand.

/**
 * Vendor-neutral content block in a request or response message. Mirrors
 * the Anthropic block shapes but stays narrow enough that an OpenAI
 * adapter can map function-calling messages onto it.
 */
export type ProviderContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      toolUseId: string;
      /** Stringified result body wrapped in <corpus_evidence> by the conversation loop. */
      content: string;
      isError?: boolean;
    }
  // Anthropic extended-thinking blocks. Round-tripped verbatim through the
  // conversation history so the provider's tool-use contract is satisfied;
  // never surfaced to the renderer.
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "redacted_thinking"; data: string };

export interface ProviderMessage {
  role: "user" | "assistant";
  content: ProviderContentBlock[];
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  /** JSON Schema input contract. The adapter forwards verbatim; zod
   *  validation runs inside the tool router, not here. */
  inputSchema: Record<string, unknown>;
  /** Adapter hint: provider-specific cache_control flag for Anthropic
   *  prompt caching. Adapters that don't support it ignore it. */
  cacheable?: boolean;
}

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  /** Marked cache-control:ephemeral on Anthropic. */
  systemCacheable: boolean;
  tools: ProviderToolDefinition[];
  messages: ProviderMessage[];
  /** Adapter hint: mark the tail of the conversation window for
   *  provider-side prompt caching (Anthropic cache_control on the last
   *  two user messages — read point + write point). Adapters without
   *  prompt caching ignore it. */
  cacheConversation?: boolean;
  maxTokens: number;
  /** "none" disables tool use for this round — the conversation loop
   *  sets it on the forced-final round so the model must answer in
   *  prose from what it has already fetched. Omitted/"auto" otherwise.
   *  (Compatible with extended thinking; forced tool_choice is not.) */
  toolChoice?: "auto" | "none";
  /** Stop the in-flight HTTP request when this signal aborts. */
  signal: AbortSignal;
  /** Invoked per text delta as the response streams in. Adapters
   *  without streaming support omit this. When the loop sees no
   *  deltas it falls back to emitting whole text blocks from the
   *  returned ProviderResponse. */
  onTextDelta?(delta: string): void;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type ProviderStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "other";

export interface ProviderResponse {
  content: ProviderContentBlock[];
  stopReason: ProviderStopReason;
  usage: ProviderUsage;
}

/**
 * The vendor seam. Implementations are constructed once per provider per
 * settings load and held by `ConversationManager`. Throwing surfaces as
 * a provider error to the conversation loop; the loop maps it to a
 * `turn_error` event the renderer renders as honest prose.
 */
export interface ModelProvider {
  readonly providerId: "anthropic" | "openai" | "mock";
  readonly availableModels: readonly string[];
  /**
   * Run one round of inference. The conversation loop calls this in a
   * 10-round-max loop (P4); the provider doesn't track round count.
   */
  call(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Errors a provider may throw. The loop maps each to a turn_error event. */
export class ProviderError extends Error {
  constructor(
    public readonly kind:
      | "network"
      | "rate_limited"
      | "auth"
      | "timeout"
      | "cancelled"
      | "bad_request"
      | "internal",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}
