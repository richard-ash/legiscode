// Conversation loop. Drives the agentic round-trip:
//   user prompt → provider call → tool_use blocks?
//   if yes: dispatch each via tool-router → provider call again
//   if no:  verify citations → if disjoint, inject synthetic tool_error
//                              and continue; else end turn.
//
// Bounded by P4 (10 exploration rounds per turn). Exploration rounds
// (the model called tools) and verifier fix-up rounds draw on separate
// budgets so a citation-heavy answer can't starve research, and vice
// versa. When exploration runs dry the loop forces ONE final round with
// toolChoice "none" plus a synthetic "answer from what you have" notice
// — the turn always ends in prose, never in a discarded transcript.
// Cancellation threads through the AbortController per A3. The A4 API
// window is enforced by ConversationManager.history() — turn-aligned,
// with hysteresis so the message prefix stays byte-stable across turns
// (prompt caching is a prefix match; a window that slides every round
// would invalidate the cache on every provider call). Within a turn the
// messages array is append-only for the same reason.
//
// Per N17/N18 the loop has ONE user-visible state: prose. Verification
// failures stay in the agentic loop as synthetic tool_error blocks; the
// model self-corrects or rewrites the answer. The renderer sees only
// the final prose + tool trail.

import {
  type FetchedBill,
  formatSourcesBlockFailure,
  formatVerificationFailure,
  verifyCitations,
  verifySourcesBlock,
} from "@/parser/citation-verify";
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

// Per A4: the wire window targets ~10 plain turns (2 messages each).
// LOW is the post-cut size; the window is allowed to grow to HIGH
// before the next cut so the prefix stays byte-identical across several
// turns between cuts (each cut is one prompt-cache miss; everything in
// between is a cache read). Cuts happen at turn boundaries only — a
// fixed message slice could orphan a tool_result from its tool_use or
// start the array with an assistant message, both API errors.
const WINDOW_LOW_MESSAGES = 20;
const WINDOW_HIGH_MESSAGES = 30;
// Per P4 — exploration budget: rounds in which the model called tools.
const MAX_ROUNDS_PER_TURN = 10;
// Verifier self-correct allowance, separate from exploration. Each
// citation / Sources-block failure costs one provider round; without a
// separate budget a cite-heavy answer would eat the research budget.
const MAX_FIXUP_ROUNDS = 3;
// Hard cap on provider calls per turn: full exploration + every fix-up
// + the forced-final answer round. The loop provably returns within
// this bound; the trailing max_rounds exit is a defensive backstop.
const MAX_TOTAL_ROUNDS = MAX_ROUNDS_PER_TURN + MAX_FIXUP_ROUNDS + 1;
const MAX_TOKENS = 4096;
// Concurrency cap on tool_use dispatch per round. The Anthropic
// parallel-tool-use contract permits multiple tool_use blocks in one
// assistant response; without a cap a high-fanout round could
// hammer the corpus indexes and fight the event loop. Four is the
// Anthropic-recommended budget for typical parallel-tool-use turns
// (D6 lock). Real read latency is in milliseconds; the cap mostly
// bounds memory and event-loop fairness, not throughput.
const TOOL_DISPATCH_CONCURRENCY = 4;

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
  /** Prior assistant + user messages. Already windowed by
   *  ConversationManager.history(); the loop sends them verbatim and
   *  never re-prunes mid-turn (prefix stability = prompt-cache hits). */
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
  /** Number of provider rounds the turn used (1-MAX_TOTAL_ROUNDS). */
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
  // Bills the model fetched this turn (read /bills/{file_no}/* paths).
  // Tracked separately from section refs because bills resolve against
  // the session bills index, not the sections index. R19 enforces that
  // every bill cited in prose appears in the Sources block AND that
  // every block entry was fetched this turn.
  const turnFetchedBills: FetchedBill[] = [];
  const turnMessages: ProviderMessage[] = [
    { role: "user", content: [{ kind: "text", text: input.userPrompt }] },
  ];

  // Rounds in which the model called tools (capped at MAX_ROUNDS_PER_TURN).
  let explorationRounds = 0;
  // Verifier-failure retries (capped at MAX_FIXUP_ROUNDS).
  let fixupRounds = 0;

  for (let round = 1; round <= MAX_TOTAL_ROUNDS; round++) {
    if (input.signal.aborted) {
      acc.stopReason = "cancelled";
      acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
      return acc;
    }
    // Exploration budget spent → every remaining call is an answer
    // round: tools disabled at the API layer, and the tool-results
    // message already carries the "answer from what you have" notice.
    const forceFinal = explorationRounds >= MAX_ROUNDS_PER_TURN;
    let response: ProviderResponse;
    // Track whether the provider streamed text deltas this round. When
    // it did, the loop must NOT re-emit text from the returned content
    // blocks — that would double up the chat panel's accumulator.
    let streamedAnyText = false;
    const providerCallStart = Date.now();
    try {
      response = await config.provider.call({
        model: config.model,
        systemPrompt: SYSTEM_PROMPT_V1,
        systemCacheable: true,
        tools: TOOL_DEFINITIONS_V1 as unknown as Parameters<ModelProvider["call"]>[0]["tools"],
        // Append-only across rounds: each round extends the previous
        // round's byte-exact prefix, so with cacheConversation the
        // provider reads the whole transcript-so-far from cache and
        // pays full price only for the new suffix.
        messages: [...messages],
        cacheConversation: true,
        maxTokens: MAX_TOKENS,
        toolChoice: forceFinal ? "none" : "auto",
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
      } else if (block.kind === "tool_use" && !forceFinal) {
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
      promptMessageCount: messages.length,
      toolCallCount: toolUses.length,
    });

    // Record the assistant message for the history (full content, not
    // just text — tool_use blocks must be paired with their results in
    // the next user message). On a forced-final round any tool_use a
    // misbehaving provider emitted anyway is stripped: it was never
    // dispatched, and a dangling tool_use id would poison the next
    // turn's API call.
    const assistantMsg: ProviderMessage = {
      role: "assistant",
      content: forceFinal
        ? response.content.filter((b) => b.kind !== "tool_use")
        : response.content,
    };
    messages.push(assistantMsg);
    turnMessages.push(assistantMsg);

    if (forceFinal || response.stopReason !== "tool_use" || toolUses.length === 0) {
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
      if (!verify.ok && fixupRounds < MAX_FIXUP_ROUNDS && round < MAX_TOTAL_ROUNDS) {
        acc.verifierFailures += 1;
        fixupRounds += 1;
        const failure = formatVerificationFailure(verify);
        const fixUp: ProviderMessage = {
          role: "user",
          content: [{ kind: "text", text: failure }],
        };
        messages.push(fixUp);
        turnMessages.push(fixUp);
        continue;
      }
      // R19 / D8 — Sources block enforcement. Runs after the
      // inline-cite verifier so the model first reconciles unfetched
      // cites (the most common failure), then surfaces missing /
      // incomplete blocks as a separate self-correct loop.
      //
      // Pass turnAttempted separately so the verifier can exempt
      // honest-acknowledgment cites ("§ X doesn't exist") from the
      // Sources-block-required rule. A probed-and-not-found ref is not
      // authority; mentioning it in prose doesn't carry citation weight.
      const sourcesOutcome = verifySourcesBlock({
        text: assistantText,
        fetchedSections: turnFetched,
        fetchedBills: turnFetchedBills,
        attemptedSections: turnAttempted,
      });
      if (!sourcesOutcome.ok && fixupRounds < MAX_FIXUP_ROUNDS && round < MAX_TOTAL_ROUNDS) {
        acc.verifierFailures += 1;
        fixupRounds += 1;
        const failure = formatSourcesBlockFailure(sourcesOutcome);
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

    // Bounded-concurrency parallel tool dispatch.
    //
    // Anthropic permits multiple tool_use blocks per assistant turn and
    // expects the next user message to carry one tool_result per id, in
    // the SAME order. We dispatch up to TOOL_DISPATCH_CONCURRENCY tools
    // at once with a worker-pool pattern, but stash each result by its
    // ORIGINAL index so the toolResults array stays positionally aligned
    // with tool_use order.
    //
    // Latency accounting: acc.toolLatencyMs records wall-clock spent in
    // the parallel block, not the sum of per-tool times. The per-tool
    // timing still rides on the tool_result event so telemetry can see
    // each call's individual cost, but the turn total is honest about
    // overlap.
    const toolResults: ProviderContentBlock[] = new Array(toolUses.length);
    const toolDispatchStart = Date.now();
    let nextToolIndex = 0;
    let abortedDuringDispatch = false;
    const workerCount = Math.min(TOOL_DISPATCH_CONCURRENCY, toolUses.length);
    const workers = Array.from({ length: workerCount }, async (): Promise<void> => {
      while (true) {
        const idx = nextToolIndex++;
        if (idx >= toolUses.length) return;
        if (input.signal.aborted) {
          // Drain without dispatching new tools. In-flight tools (already
          // awaiting in another worker) run to completion; the conversation
          // loop bails after Promise.all resolves.
          abortedDuringDispatch = true;
          return;
        }
        const use = toolUses[idx] as (typeof toolUses)[number];
        const toolStart = Date.now();
        const { toolUseId, payload } = await config.router(use.name, use.input, use.toolUseId);
        const toolLatencyMs = Date.now() - toolStart;
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
          // Bill paths (/bills/{file_no}[/...]) don't surface via
          // payload.fetched — that field is typed as section refs only.
          // Harvest bill file_nos from the requested path AND from the
          // result payload (listings + metadata both expose them) so the
          // Sources-block verifier (R19) can validate bill citations
          // symmetrically. Listings count: the model legitimately cites a
          // bill it discovered via `/bills` without per-bill drilling.
          for (const fb of harvestFetchedBills(use.name, use.input, payload)) {
            const idx = turnFetchedBills.findIndex((b) => b.file_no === fb.file_no);
            if (idx === -1) {
              turnFetchedBills.push(fb);
            } else {
              turnFetchedBills[idx] = mergeFetchedBill(turnFetchedBills[idx] as FetchedBill, fb);
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
        toolResults[idx] = {
          kind: "tool_result",
          toolUseId,
          content: serializeToolResult(payload),
          isError: !payload.ok,
        };
      }
    });
    await Promise.all(workers);
    acc.toolLatencyMs += Date.now() - toolDispatchStart;
    if (abortedDuringDispatch || input.signal.aborted) {
      acc.stopReason = "cancelled";
      acc.newMessages = turnMessages;
      acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
      return acc;
    }
    // Filter out any positions that never resolved — shouldn't happen
    // unless the abort drained early, but defends against a sparse
    // toolResults array leaking past the abort check.
    const orderedResults = toolResults.filter((r): r is ProviderContentBlock => r !== undefined);
    explorationRounds += 1;
    // Round-status stamp: prompt rule 15 names a 10-round budget but the
    // model can't count rounds from the transcript alone. The stamp rides
    // AFTER the tool_result blocks (Anthropic requires results first).
    // On the last exploration round it becomes the forced-final notice.
    const budgetNote =
      explorationRounds >= MAX_ROUNDS_PER_TURN
        ? `[tool budget: round ${explorationRounds} of ${MAX_ROUNDS_PER_TURN} — exhausted. ` +
          "Write your final answer now from the sections you have already fetched; " +
          "tool calls are disabled. Cite only fetched sections.]"
        : `[tool budget: round ${explorationRounds} of ${MAX_ROUNDS_PER_TURN}]`;
    const userMsg: ProviderMessage = {
      role: "user",
      content: [...orderedResults, { kind: "text", text: budgetNote }],
    };
    messages.push(userMsg);
    turnMessages.push(userMsg);
  }

  // Defensive backstop — the budget arithmetic above means the loop
  // always returns before exhausting MAX_TOTAL_ROUNDS. If it ever falls
  // through, surface stop_reason "max_rounds" with whatever text the
  // turn streamed; the renderer shows the condition as a status, not as
  // assistant prose.
  acc.stopReason = "max_rounds";
  acc.newMessages = turnMessages;
  acc.fetchedRefs = turnFetched;
  acc.totalLatencyMs = acc.providerLatencyMs + acc.toolLatencyMs;
  return acc;
}

/**
 * Harvest the set of bill file_nos a successful tool dispatch made
 * available to the model. Sources are unioned across two surfaces:
 *
 *   1. The requested path: `/bills/{file_no}[/...]` reveals one bill.
 *   2. The result payload: a `bills-list` listing yields every file_no
 *      in `payload.bills[]`; a single-bill response yields its file_no.
 *
 * Without (2), a perfectly normal pattern — "the session has one
 * pending bill: [Bill #N]" after reading `/bills` — would fail R19's
 * Sources-block enforcement because the file_no never appears in
 * fetchedBills. The listing IS the model's evidence the bill exists.
 *
 * Used by R19's Sources-block verifier so cited bills can be validated
 * against the fetched-this-turn set symmetrically with sections.
 */
function harvestFetchedBills(
  toolName: string,
  rawInput: unknown,
  payload: ToolResultBase,
): readonly FetchedBill[] {
  if (toolName !== "read") return [];
  // Per-file_no accumulator so a single dispatch can union path-side and
  // payload-side data into one record.
  const out = new Map<string, { module_id?: string; affected_section_ids: Set<string> }>();
  const upsert = (fileNo: string, moduleId?: string, affected?: readonly string[]): void => {
    const existing = out.get(fileNo) ?? { affected_section_ids: new Set<string>() };
    if (!existing.module_id && moduleId) existing.module_id = moduleId;
    if (affected) for (const s of affected) existing.affected_section_ids.add(s);
    out.set(fileNo, existing);
  };
  // Path-side harvest.
  if (rawInput && typeof rawInput === "object" && "path" in rawInput) {
    const path = (rawInput as { path: unknown }).path;
    if (typeof path === "string") {
      const parts = path
        .trim()
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .split("/")
        .filter((p) => p.length > 0);
      if (parts.length >= 2 && parts[0] === "bills") {
        const fileNo = parts[1];
        if (typeof fileNo === "string" && /^\d{3,12}$/.test(fileNo)) upsert(fileNo);
      }
    }
  }
  // Payload-side harvest. Inspect kind-tagged shapes from electron/ai/tools/types.ts.
  if (payload.ok) {
    const p = payload as unknown as {
      kind?: string;
      file_no?: string;
      module_id?: string;
      bill?: { file_no?: string; module_id?: string; affected_section_ids?: readonly string[] };
      bills?: readonly {
        file_no?: string;
        module_id?: string;
        affected_section_ids?: readonly string[];
      }[];
      body?: { file_no?: string };
      diff?: { file_no?: string };
      changes?: readonly { section_id?: string }[];
    };
    switch (p.kind) {
      case "bill":
        if (p.bill?.file_no) {
          upsert(p.bill.file_no, p.bill.module_id, p.bill.affected_section_ids);
        }
        break;
      case "bills-list":
        for (const b of p.bills ?? []) {
          if (b.file_no) upsert(b.file_no, b.module_id, b.affected_section_ids);
        }
        break;
      case "bill-proposed-text":
        if (p.body?.file_no) upsert(p.body.file_no);
        break;
      case "bill-changes":
        if (p.file_no) {
          const ids = (p.changes ?? [])
            .map((c) => c.section_id)
            .filter((s): s is string => typeof s === "string");
          upsert(p.file_no, p.module_id, ids);
        }
        break;
      case "bill-section-diff":
        if (p.diff?.file_no) upsert(p.diff.file_no);
        break;
    }
  }
  return Array.from(out.entries()).map(([file_no, info]) => ({
    file_no,
    module_id: info.module_id,
    affected_section_ids:
      info.affected_section_ids.size > 0 ? Array.from(info.affected_section_ids) : undefined,
  }));
}

/**
 * Fold a freshly-harvested bill into the turn's accumulated set. Earlier
 * dispatches may have captured only path-side data; later ones may bring
 * payload-side `module_id` / `affected_section_ids`. Always keep the
 * richer record so R23's completeness check has the full picture.
 */
function mergeFetchedBill(existing: FetchedBill, incoming: FetchedBill): FetchedBill {
  const moduleId = existing.module_id ?? incoming.module_id;
  const ids = new Set<string>([
    ...(existing.affected_section_ids ?? []),
    ...(incoming.affected_section_ids ?? []),
  ]);
  return {
    file_no: existing.file_no,
    module_id: moduleId,
    affected_section_ids: ids.size > 0 ? Array.from(ids) : undefined,
  };
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
 * Compute the API window over whole turns. Replays the append history
 * deterministically: a cut happens only when the running window exceeds
 * WINDOW_HIGH_MESSAGES, and drops whole turns from the front until the
 * window is back under WINDOW_LOW_MESSAGES. Replay makes the function
 * pure — the same turn list always yields the same cut points — so the
 * window's leading messages stay byte-identical call after call until
 * the next cut. That stability is what lets Anthropic prompt caching
 * hit on the conversation prefix across turns.
 *
 * The newest turn is always included whole, even when it alone exceeds
 * the high-water mark (a 10-round research turn can) — turns are the
 * atomic unit because splitting one would orphan tool_use/tool_result
 * pairs.
 */
function windowTurns(turns: readonly (readonly ProviderMessage[])[]): ProviderMessage[] {
  let start = 0;
  let count = 0;
  for (let i = 0; i < turns.length; i++) {
    count += (turns[i] as readonly ProviderMessage[]).length;
    if (count > WINDOW_HIGH_MESSAGES) {
      while (start < i && count > WINDOW_LOW_MESSAGES) {
        count -= (turns[start] as readonly ProviderMessage[]).length;
        start += 1;
      }
    }
  }
  return turns.slice(start).flat() as ProviderMessage[];
}

/**
 * Conversation manager: per-chat history with API window pruning. Keyed
 * by `${module_id}/${section_id}` per the architecture lock; pinned
 * chats use a fresh chatId.
 *
 * History is stored as whole turns (one entry per appendTurn) so the
 * window can cut at turn boundaries — see windowTurns above.
 */
export class ConversationManager {
  private readonly histories = new Map<string, ProviderMessage[][]>();
  private readonly turnCounters = new Map<string, number>();

  history(chatId: string): readonly ProviderMessage[] {
    return windowTurns(this.histories.get(chatId) ?? []);
  }

  nextTurnId(chatId: string): number {
    const next = (this.turnCounters.get(chatId) ?? 0) + 1;
    this.turnCounters.set(chatId, next);
    return next;
  }

  appendTurn(chatId: string, messages: readonly ProviderMessage[]): void {
    // Cancelled-before-first-round turns produce no messages; storing an
    // empty turn would only add a no-op boundary to the window replay.
    if (messages.length === 0) return;
    const existing = this.histories.get(chatId) ?? [];
    this.histories.set(chatId, [...existing, [...messages]]);
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
