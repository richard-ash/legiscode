// Anthropic SDK adapter. THE single file allowed to import
// @anthropic-ai/sdk anywhere in the codebase. The eslint rule (and the
// vendor-isolation invariant in [[feedback_vendor_sdk_isolation]])
// expects every other module to talk to `ModelProvider` and call
// AnthropicAdapter through providers/index.ts.
//
// One file means swapping providers is one new file, never a sweep.

import Anthropic from "@anthropic-ai/sdk";
import {
  type ModelProvider,
  type ProviderContentBlock,
  ProviderError,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStopReason,
  type ProviderToolDefinition,
  type ProviderUsage,
} from "./types";

/** Default model per P6. Surfaced through settings as the writable choice. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Extended-thinking budget per request. Small enough to keep latency
 * tight; large enough that the model can plan multi-read sequences
 * (e.g. bill metadata → changes → per-section diff) without leaking
 * the plan into prose. Bumped by trial-and-error; revisit if turn
 * latency or accuracy moves.
 */
const THINKING_BUDGET_TOKENS = 4000;

/**
 * Models we expose in the settings dropdown. Sonnet default; Haiku for
 * quick lookups; Opus for complex multi-round research. Listed here so
 * adding a new model is one literal edit, not a cross-file sweep.
 */
export const ANTHROPIC_AVAILABLE_MODELS = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-7",
] as const;

export interface AnthropicAdapterDeps {
  apiKey: string;
  /** Override for tests. Defaults to the real SDK. */
  client?: Anthropic;
}

export class AnthropicAdapter implements ModelProvider {
  readonly providerId = "anthropic" as const;
  readonly availableModels = ANTHROPIC_AVAILABLE_MODELS;
  private readonly client: Anthropic;

  constructor(deps: AnthropicAdapterDeps) {
    this.client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    try {
      // Extended thinking. Budget is small but meaningful — gives the
      // model a scratchpad for planning bill-diff reads, dedup logic,
      // and mid-response self-correction without leaking it into the
      // user-visible prose. Thinking blocks come back in `content` and
      // get silently dropped in fromAnthropicContent (renderer doesn't
      // know how to display them and the user shouldn't see them).
      //
      // max_tokens MUST exceed budget_tokens per the API contract; the
      // caller's maxTokens already covers both because we add the
      // budget on top.
      const thinkingBudget = THINKING_BUDGET_TOKENS;
      const stream = this.client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens + thinkingBudget,
          thinking: { type: "enabled", budget_tokens: thinkingBudget },
          system: req.systemCacheable
            ? [
                {
                  type: "text",
                  text: req.systemPrompt,
                  cache_control: { type: "ephemeral" },
                },
              ]
            : req.systemPrompt,
          tools: toAnthropicTools(req.tools),
          messages: toAnthropicMessages(req.messages),
        },
        { signal: req.signal },
      );
      if (req.onTextDelta) {
        stream.on("text", (delta) => req.onTextDelta?.(delta));
      }
      const raw = await stream.finalMessage();
      return {
        content: fromAnthropicContent(raw.content),
        stopReason: mapStopReason(raw.stop_reason),
        usage: mapUsage(raw.usage),
      };
    } catch (cause) {
      throw mapError(cause);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toAnthropicTools(tools: readonly ProviderToolDefinition[]): Anthropic.Tool[] {
  // The last tool gets cache_control: ephemeral when any tool is
  // cacheable — Anthropic caches the prefix including the tools block,
  // and marking the tail of the tools list is the canonical pattern.
  const anyCacheable = tools.some((t) => t.cacheable);
  return tools.map((t, i) => {
    const isTail = i === tools.length - 1;
    const tool: Anthropic.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    };
    if (anyCacheable && isTail) {
      (tool as Anthropic.Tool & { cache_control?: { type: "ephemeral" } }).cache_control = {
        type: "ephemeral",
      };
    }
    return tool;
  });
}

function toAnthropicMessages(messages: readonly ProviderMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: ProviderContentBlock): Anthropic.ContentBlockParam {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.toolUseId,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError ?? false,
      };
    case "thinking":
      return { type: "thinking", thinking: block.text, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
  }
}

function fromAnthropicContent(blocks: readonly Anthropic.ContentBlock[]): ProviderContentBlock[] {
  const out: ProviderContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      out.push({ kind: "text", text: b.text });
    } else if (b.type === "tool_use") {
      out.push({
        kind: "tool_use",
        toolUseId: b.id,
        name: b.name,
        input: b.input,
      });
    } else if (b.type === "thinking") {
      // Round-trip thinking blocks back to the API on subsequent rounds
      // — Anthropic's extended-thinking + tool-use contract requires the
      // signature to match. Never surfaced to the renderer.
      out.push({ kind: "thinking", text: b.thinking, signature: b.signature });
    } else if (b.type === "redacted_thinking") {
      out.push({ kind: "redacted_thinking", data: b.data });
    }
    // server_tool_use, mcp_tool_use, etc. — we don't ask for them and
    // would have no way to render them; silently dropped.
  }
  return out;
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): ProviderStopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(usage: Anthropic.Usage): ProviderUsage {
  const u: ProviderUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
  if (typeof usage.cache_creation_input_tokens === "number") {
    u.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    u.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  return u;
}

function mapError(cause: unknown): ProviderError {
  if (cause instanceof ProviderError) return cause;
  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("timeout", cause.message, { cause });
  }
  if (cause instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", cause.message, { cause });
  }
  if (cause instanceof Anthropic.RateLimitError) {
    return new ProviderError("rate_limited", cause.message, { cause });
  }
  if (cause instanceof Anthropic.AuthenticationError) {
    return new ProviderError("auth", cause.message, { cause });
  }
  if (cause instanceof Anthropic.BadRequestError) {
    return new ProviderError("bad_request", cause.message, { cause });
  }
  if (cause instanceof Anthropic.APIError) {
    return new ProviderError("internal", cause.message, { cause });
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    return new ProviderError("cancelled", cause.message, { cause });
  }
  return new ProviderError("internal", cause instanceof Error ? cause.message : String(cause), {
    cause,
  });
}
