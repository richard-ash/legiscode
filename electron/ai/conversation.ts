// Conversation loop. Drives the agentic round-trip:
//   user prompt → provider call → tool_use blocks?
//   if yes: dispatch each via tool-router → provider call again
//   if no:  verify citations → if disjoint, inject synthetic tool_error
//                              and continue; else end turn.
//
// Bounded by P4 (10 rounds per turn). Cancellation threads through the
// AbortController per A3. Last-10-turn API window per A4 — the
// caller-side history is pruned before each provider call.
//
// Per N17/N18 the loop has ONE user-visible state: prose. Verification
// failures stay in the agentic loop as synthetic tool_error blocks; the
// model self-corrects or rewrites the answer. The renderer sees only
// the final prose + tool trail.

import { formatVerificationFailure, verifyCitations } from "@/parser/citation-verify";
import { SYSTEM_PROMPT_V1, TOOL_DEFINITIONS_V1 } from "./prompt";
import type {
  ModelProvider,
  ProviderContentBlock,
  ProviderMessage,
  ProviderResponse,
} from "./providers/types";
import { ProviderError } from "./providers/types";
import { dispatchTool, type RouterContext, serializeToolResult } from "./tool-router";
import type { ToolName, ToolResultBase } from "./tools/types";

// Per A4. Cap is on the LAST messages array sent to the provider; the
// caller may hold a longer history but only the tail goes on the wire.
const API_WINDOW_TURNS = 10;
// Per P4.
const MAX_ROUNDS_PER_TURN = 10;
const MAX_TOKENS = 4096;

// Event emitted up to the caller — the IPC handler forwards each as
// `ai:event` over webContents.send. Turn-id propagation lives here.
//
// Latency fields are stamped from Date.now() deltas around the awaited
// boundary they describe: tool_result.latencyMs covers the router
// dispatch + tool body; round_completed.latencyMs covers the provider
// call + stream finalization. The IPC handler forwards measurement-only
// fields to the local telemetry sink (per N17/N18 the renderer never
// sees them) so the operator can audit which round-trip dominates
// turn wall-clock without a code change.
export type ConversationEvent =
  | {
      kind: "tool_call";
      turnId: number;
      toolUseId: string;
      name: ToolName;
      input: unknown;
    }
  | {
      kind: "tool_result";
      turnId: number;
      toolUseId: string;
      result: ToolResultBase;
      latencyMs: number;
    }
  | {
      kind: "text";
      turnId: number;
      text: string;
    }
  | {
      kind: "round_completed";
      turnId: number;
      round: number;
      usage: ProviderResponse["usage"];
      latencyMs: number;
      /** Count of `thinking` / `redacted_thinking` blocks the model emitted
       *  this round. Proxy for "did extended thinking fire" — Anthropic
       *  doesn't expose a separate thinking-token count today. */
      thinkingBlockCount: number;
      /** Count of messages on the wire for this round (system+tool defs are
       *  cached separately; this measures the chat window). */
      promptMessageCount: number;
      /** Count of tool_use blocks the assistant produced this round. */
      toolCallCount: number;
    }
  | {
      kind: "verification_outcome";
      turnId: number;
      round: number;
      ok: boolean;
      matchedCount: number;
      missing: readonly { module_id: string | null; section_id: string }[];
    };

export interface ConversationConfig {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly anchorModule: string;
  readonly router: (
    name: string,
    input: unknown,
    toolUseId: string,
  ) => Promise<{ toolUseId: string; payload: ToolResultBase }>;
}

export interface RunTurnInput {
  /** Stable across rounds in a turn; counter from the manager. */
  turnId: number;
  /** Prior assistant + user messages (already pruned by the caller). */
  history: readonly ProviderMessage[];
  /** The new user prompt for this turn. */
  userPrompt: string;
  /** Aborts the whole turn including in-flight tool calls. */
  signal: AbortSignal;
  /** Receive progressive events (tool calls, results, text). */
  onEvent(event: ConversationEvent): void;
}

export interface TurnResult {
  /** Final assistant message — only the prose text blocks. */
  finalText: string;
  /** Full provider exchange for the turn (for history retention). */
  newMessages: readonly ProviderMessage[];
  /** Aggregated usage across every round in the turn. */
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  /** Refs the verifier counted as fetched. */
  fetchedRefs: readonly { module_id: string; section_id: string }[];
  /** Whether the verifier injected a synthetic failure during the turn. */
  verifierFailures: number;
  /** Reason the turn ended. */
  stopReason: "end_turn" | "max_rounds" | "cancelled" | "error";
  error?: { kind: ProviderError["kind"]; message: string };
  /** Number of provider rounds the turn used (1-MAX_ROUNDS_PER_TURN). */
  roundCount: number;
  /** Provider-call wall-clock summed across rounds, in milliseconds. */
  providerLatencyMs: number;
  /** Tool-dispatch wall-clock summed across rounds, in milliseconds. */
  toolLatencyMs: number;
  /** Total provider-call + tool-dispatch wall-clock, in milliseconds. */
  totalLatencyMs: number;
  /** Aggregate tool_use count across rounds. */
  toolCallCount: number;
  /** Aggregate thinking-block count across rounds. */
  thinkingBlockCount: number;
}

/**
 * Run one turn of conversation. The caller passes pruned history; this
 * function never mutates global state and is safe to call concurrently
 * for different (chat, turn) pairs.
 */
export async function runConversationTurn(
  config: ConversationConfig,
  input: RunTurnInput,
): Promise<TurnResult> {
  const acc: TurnResult = {
    finalText: "",
    newMessages: [],
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    fetchedRefs: [],
    verifierFailures: 0,
    stopReason: "end_turn",
    roundCount: 0,
    providerLatencyMs: 0,
    toolLatencyMs: 0,
    totalLatencyMs: 0,
    toolCallCount: 0,
    thinkingBlockCount: 0,
  };

  const messages: ProviderMessage[] = [
    ...input.history,
    { role: "user", content: [{ kind: "text", text: input.userPrompt }] },
  ];
  const turnFetched: { module_id: string; section_id: string }[] = [];
  // Refs the model attempted to fetch this turn, including refs that
  // returned ok:false (not_found). The verifier accepts these as proof
  // the model deliberately checked — the prose can honestly say
  // "§ X doesn't exist" because the tool call is in the log.
  const turnAttempted: { module_id: string; section_id: string }[] = [];
  const turnMessages: ProviderMessage[] = [
    { role: "user", content: [{ kind: "text", text: input.userPrompt }] },
  ];

  for (let round = 1; round <= MAX_ROUNDS_PER_TURN; round++) {
    if (input.signal.aborted) {
      acc.stopReason = "cancelled";
      acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
      return acc;
    }
    let response: ProviderResponse;
    // Track whether the provider streamed text deltas this round. When
    // it did, the loop must NOT re-emit text from the returned content
    // blocks — that would double up the chat panel's accumulator.
    let streamedAnyText = false;
    const prunedMessages = pruneToWindow(messages);
    const providerCallStart = Date.now();
    try {
      response = await config.provider.call({
        model: config.model,
        systemPrompt: SYSTEM_PROMPT_V1,
        systemCacheable: true,
        tools: TOOL_DEFINITIONS_V1 as unknown as Parameters<ModelProvider["call"]>[0]["tools"],
        messages: prunedMessages,
        maxTokens: MAX_TOKENS,
        signal: input.signal,
        onTextDelta: (delta) => {
          streamedAnyText = true;
          input.onEvent({ kind: "text", turnId: input.turnId, text: delta });
        },
      });
    } catch (cause) {
      if (cause instanceof ProviderError) {
        acc.stopReason = cause.kind === "cancelled" ? "cancelled" : "error";
        acc.error = { kind: cause.kind, message: cause.message };
      } else {
        acc.stopReason = "error";
        acc.error = {
          kind: "internal",
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      acc.newMessages = turnMessages;
      acc.providerLatencyMs += Date.now() - providerCallStart;
      acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
      return acc;
    }

    const providerLatencyMs = Date.now() - providerCallStart;
    // Emit text + collect tool_use blocks.
    const toolUses: { toolUseId: string; name: string; input: unknown }[] = [];
    let assistantText = "";
    let thinkingBlockCount = 0;
    for (const block of response.content) {
      if (block.kind === "text") {
        assistantText += block.text;
        // Skip the buffered emit when the provider already streamed
        // deltas this round — the renderer accumulated them as they
        // arrived. Non-streaming providers fall through here.
        if (!streamedAnyText) {
          input.onEvent({ kind: "text", turnId: input.turnId, text: block.text });
        }
      } else if (block.kind === "tool_use") {
        toolUses.push({
          toolUseId: block.toolUseId,
          name: block.name,
          input: block.input,
        });
        input.onEvent({
          kind: "tool_call",
          turnId: input.turnId,
          toolUseId: block.toolUseId,
          name: block.name as ToolName,
          input: block.input,
        });
      } else if (block.kind === "thinking" || block.kind === "redacted_thinking") {
        thinkingBlockCount += 1;
      }
    }
    addUsage(acc.totalUsage, response.usage);
    acc.roundCount = round;
    acc.providerLatencyMs += providerLatencyMs;
    acc.toolCallCount += toolUses.length;
    acc.thinkingBlockCount += thinkingBlockCount;
    input.onEvent({
      kind: "round_completed",
      turnId: input.turnId,
      round,
      usage: response.usage,
      latencyMs: providerLatencyMs,
      thinkingBlockCount,
      promptMessageCount: prunedMessages.length,
      toolCallCount: toolUses.length,
    });

    // Record the assistant message for the history (full content, not
    // just text — tool_use blocks must be paired with their results in
    // the next user message).
    const assistantMsg: ProviderMessage = { role: "assistant", content: response.content };
    messages.push(assistantMsg);
    turnMessages.push(assistantMsg);

    if (response.stopReason !== "tool_use" || toolUses.length === 0) {
      // Verifier runs on the final assistant text. If the model wrote
      // citations that aren't in the fetched set, inject a synthetic
      // user message with a <verification_failure> wrap and loop.
      const verify = verifyCitations({
        text: assistantText,
        // Accept both successful fetches and attempted-but-absent refs.
        // The model citing a section that returned not_found is honest
        // meta-commentary; the tool call is in the log.
        fetched: [...turnFetched, ...turnAttempted],
        anchorModule: config.anchorModule,
      });
      input.onEvent({
        kind: "verification_outcome",
        turnId: input.turnId,
        round,
        ok: verify.ok,
        matchedCount: verify.matched.length,
        missing: verify.missing.map((m) => ({
          module_id: m.module_id,
          section_id: m.section_id,
        })),
      });
      if (!verify.ok && round < MAX_ROUNDS_PER_TURN) {
        acc.verifierFailures += 1;
        const failure = formatVerificationFailure(verify);
        const fixUp: ProviderMessage = {
          role: "user",
          content: [{ kind: "text", text: failure }],
        };
        messages.push(fixUp);
        turnMessages.push(fixUp);
        continue;
      }
      acc.finalText = assistantText;
      acc.newMessages = turnMessages;
      acc.fetchedRefs = turnFetched;
      acc.stopReason = "end_turn";
      acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
      return acc;
    }

    // Dispatch tools, build the tool_result message in the same order.
    const toolResults: ProviderContentBlock[] = [];
    for (const use of toolUses) {
      if (input.signal.aborted) {
        acc.stopReason = "cancelled";
        acc.newMessages = turnMessages;
        acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
        return acc;
      }
      const toolStart = Date.now();
      const { toolUseId, payload } = await config.router(use.name, use.input, use.toolUseId);
      const toolLatencyMs = Date.now() - toolStart;
      acc.toolLatencyMs += toolLatencyMs;
      input.onEvent({
        kind: "tool_result",
        turnId: input.turnId,
        toolUseId,
        result: payload,
        latencyMs: toolLatencyMs,
      });
      if (payload.ok) {
        for (const f of payload.fetched) {
          if (
            !turnFetched.some((r) => r.module_id === f.module_id && r.section_id === f.section_id)
          ) {
            turnFetched.push({ module_id: f.module_id, section_id: f.section_id });
          }
        }
      } else {
        // not_found on read("/modules/X/sections/Y") identifies a ref
        // the model deliberately probed. Record it as "attempted" so
        // the verifier accepts honest acknowledgment prose like
        // "§ X doesn't exist."
        const probed = extractProbedRef(use.name, use.input);
        if (
          probed &&
          !turnAttempted.some(
            (r) => r.module_id === probed.module_id && r.section_id === probed.section_id,
          )
        ) {
          turnAttempted.push(probed);
        }
      }
      toolResults.push({
        kind: "tool_result",
        toolUseId,
        content: serializeToolResult(payload),
        isError: !payload.ok,
      });
    }
    const userMsg: ProviderMessage = { role: "user", content: toolResults };
    messages.push(userMsg);
    turnMessages.push(userMsg);
  }

  acc.stopReason = "max_rounds";
  acc.newMessages = turnMessages;
  acc.fetchedRefs = turnFetched;
  acc.finalText = acc.finalText || "(round budget exhausted)";
  acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
  return acc;
}

function pruneToWindow(messages: readonly ProviderMessage[]): ProviderMessage[] {
  if (messages.length <= API_WINDOW_TURNS * 2) return [...messages];
  return messages.slice(-(API_WINDOW_TURNS * 2));
}

/**
 * Extract the (module_id, section_id) the model probed in a not_found
 * tool call so the verifier accepts honest acknowledgment prose ("§ X
 * doesn't exist"). Only `read` with a section-shaped path counts; other
 * paths (bills, definitions, root listings) don't reference a section.
 */
function extractProbedRef(
  toolName: string,
  rawInput: unknown,
): { module_id: string; section_id: string } | null {
  if (toolName !== "read") return null;
  if (!rawInput || typeof rawInput !== "object" || !("path" in rawInput)) return null;
  const path = (rawInput as { path: unknown }).path;
  if (typeof path !== "string") return null;
  const parts = path
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((p) => p.length > 0);
  // /modules/{module_id}/sections/{section_id}[/...]
  if (parts.length >= 4 && parts[0] === "modules" && parts[2] === "sections") {
    return { module_id: parts[1] as string, section_id: parts[3] as string };
  }
  // /bills/{file_no}/changes/{module_id}/{section_id}
  if (parts.length === 5 && parts[0] === "bills" && parts[2] === "changes") {
    return { module_id: parts[3] as string, section_id: parts[4] as string };
  }
  return null;
}

function addUsage(acc: TurnResult["totalUsage"], delta: ProviderResponse["usage"]): void {
  acc.inputTokens += delta.inputTokens;
  acc.outputTokens += delta.outputTokens;
  acc.cacheCreationInputTokens += delta.cacheCreationInputTokens ?? 0;
  acc.cacheReadInputTokens += delta.cacheReadInputTokens ?? 0;
}

/**
 * Conversation manager: per-chat history with API window pruning. Keyed
 * by `${module_id}/${section_id}` per the architecture lock; pinned
 * chats use a fresh chatId.
 */
export class ConversationManager {
  private readonly histories = new Map<string, ProviderMessage[]>();
  private readonly turnCounters = new Map<string, number>();

  history(chatId: string): readonly ProviderMessage[] {
    return this.histories.get(chatId) ?? [];
  }

  nextTurnId(chatId: string): number {
    const next = (this.turnCounters.get(chatId) ?? 0) + 1;
    this.turnCounters.set(chatId, next);
    return next;
  }

  appendTurn(chatId: string, messages: readonly ProviderMessage[]): void {
    const existing = this.histories.get(chatId) ?? [];
    this.histories.set(chatId, [...existing, ...messages]);
  }

  resetChat(chatId: string): void {
    this.histories.delete(chatId);
    this.turnCounters.delete(chatId);
  }
}

/**
 * Helper to wire the tool router. The conversation loop accepts a
 * router function so tests can inject a deterministic stub without
 * touching the corpus.
 */
export function makeRouterFn(ctx: RouterContext) {
  return async (
    name: string,
    input: unknown,
    toolUseId: string,
  ): Promise<{ toolUseId: string; payload: ToolResultBase }> => {
    const result = await dispatchTool({ name, input, toolUseId }, ctx);
    return result;
  };
}
