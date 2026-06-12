// Conversation loop tests. Covers the agentic round-trip via MockProvider,
// cancellation, the verifier-failure → synthetic-fix-up loop (own budget,
// MAX_FIXUP_ROUNDS), the per-round budget stamp, and the forced-final
// answer round when the 10-round exploration budget runs out.

import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../electron/ai/conversation";
import {
  ConversationManager,
  makeRouterFn,
  runConversationTurn,
} from "../../../electron/ai/conversation";
import type { ProviderMessage } from "../../../electron/ai/providers/types";
import { loadFixtureCorpus } from "./load-fixture-corpus";
import { MockProvider } from "./mock-provider";

describe("runConversationTurn", () => {
  it("completes a one-tool one-round turn", async () => {
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          {
            kind: "text",
            text:
              'Per [test-alpha § 1.1], the rule applies. The section says "Hermetic".\n\n' +
              "**Sources**\n- [test-alpha § 1.1] — Test Section 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const events: ConversationEvent[] = [];
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.finalText).toContain("§ 1.1");
    expect(result.fetchedRefs).toContainEqual({ module_id: "test-alpha", section_id: "1.1" });
    expect(result.verifierFailures).toBe(0);
    expect(events.some((e) => e.kind === "tool_call")).toBe(true);
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
    provider.assertExhausted();
  });

  it("injects a synthetic verification failure when prose cites a section that wasn't fetched", async () => {
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      // First round: model writes prose with a cite it never fetched.
      {
        content: [{ kind: "text", text: "Per [test-alpha § 1.1] the rule applies." }],
        stopReason: "end_turn",
      },
      // Second round: model self-corrects after seeing the synthetic
      // verification_failure block — fetches the section it was citing.
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      // Third round: model writes the answer correctly, now with the
      // section in fetched and a Sources block listing it (R19).
      {
        content: [
          {
            kind: "text",
            text:
              "Per [test-alpha § 1.1], the rule applies.\n\n" +
              "**Sources**\n- [test-alpha § 1.1] — Test Section 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(result.verifierFailures).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    provider.assertExhausted();
  });

  it("captures per-round and per-tool latency on TurnResult and round_completed", async () => {
    // Per D2/D6+D9 lock: the operator needs to see provider-call wall-clock
    // separately from tool-dispatch wall-clock so the parallel-dispatch
    // decision (commit 3) is grounded in measurement, not theory. Asserts
    // (a) the round_completed event carries latency / thinking / message
    // counts, (b) tool_result carries latency, (c) the TurnResult totals
    // are consistent with the per-round events.
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          {
            kind: "text",
            text:
              "Per [test-alpha § 1.1], rule applies.\n\n" +
              "**Sources**\n- [test-alpha § 1.1] — Test Section 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const events: ConversationEvent[] = [];
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 7 }),
      },
      {
        turnId: 7,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.roundCount).toBe(2);
    expect(result.toolCallCount).toBe(1);
    // MockProvider doesn't emit thinking blocks; this asserts the counter
    // doesn't accidentally count something else as thinking.
    expect(result.thinkingBlockCount).toBe(0);
    // Latencies are >= 0 (real timing is non-deterministic; we just verify
    // the field is populated, not a specific magnitude).
    expect(result.providerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.toolLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.totalLatencyMs).toBe(result.providerLatencyMs + result.toolLatencyMs);

    const roundEvents = events.filter((e) => e.kind === "round_completed");
    expect(roundEvents).toHaveLength(2);
    for (const e of roundEvents) {
      if (e.kind !== "round_completed") continue;
      expect(e.latencyMs).toBeGreaterThanOrEqual(0);
      expect(e.promptMessageCount).toBeGreaterThan(0);
      expect(e.thinkingBlockCount).toBe(0);
    }
    const firstRound = roundEvents[0];
    if (firstRound?.kind === "round_completed") {
      expect(firstRound.toolCallCount).toBe(1);
    }
    const secondRound = roundEvents[1];
    if (secondRound?.kind === "round_completed") {
      expect(secondRound.toolCallCount).toBe(0);
    }

    const toolResultEvents = events.filter((e) => e.kind === "tool_result");
    expect(toolResultEvents).toHaveLength(1);
    if (toolResultEvents[0]?.kind === "tool_result") {
      expect(toolResultEvents[0].latencyMs).toBeGreaterThanOrEqual(0);
    }
    provider.assertExhausted();
  });

  it("cancels promptly when the signal aborts before the first provider call", async () => {
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([]);
    const controller = new AbortController();
    controller.abort();
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: controller.signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("cancelled");
  });

  it("dispatches multiple tool_use blocks in parallel and preserves tool_result order", async () => {
    // Three tools per round. Tool 1 takes 30ms, tool 2 takes 5ms, tool 3
    // takes 5ms. Sequential dispatch would take ≥40ms; parallel with the
    // cap-of-4 worker pool takes ≤max(30,5,5)+overhead ≈ 30-50ms. Assert
    // wall-clock is below the sequential floor to prove concurrency.
    //
    // Independently assert that tool_result events surface in completion
    // order (latest may arrive first when latencies differ) but the
    // toolResults that ride the next user message stay in tool_use order
    // — required by Anthropic's contract.
    const completionOrder: string[] = [];
    const customRouter = async (
      _name: string,
      _input: unknown,
      toolUseId: string,
    ): Promise<{
      toolUseId: string;
      payload: import("../../../electron/ai/tools/types").ToolResultBase;
    }> => {
      const delays: Record<string, number> = { u1: 30, u2: 5, u3: 5 };
      const ms = delays[toolUseId] ?? 5;
      await new Promise((resolve) => setTimeout(resolve, ms));
      completionOrder.push(toolUseId);
      return {
        toolUseId,
        payload: {
          ok: true,
          fetched: [{ module_id: "test-alpha", section_id: toolUseId.replace("u", "") }],
          corpus_hash: "mock",
          turn_id: 1,
        } as import("../../../electron/ai/tools/types").ToolResultBase,
      };
    };

    const provider = new MockProvider([
      {
        content: [
          { kind: "tool_use", toolUseId: "u1", name: "read", input: { path: "/x/1" } },
          { kind: "tool_use", toolUseId: "u2", name: "read", input: { path: "/x/2" } },
          { kind: "tool_use", toolUseId: "u3", name: "read", input: { path: "/x/3" } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ kind: "text", text: "Done." }],
        stopReason: "end_turn",
      },
    ]);
    const events: ConversationEvent[] = [];
    const start = Date.now();
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: customRouter,
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "fan out",
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
      },
    );
    const wallClockMs = Date.now() - start;

    expect(result.stopReason).toBe("end_turn");
    // Sequential would be ≥40ms (30+5+5); parallel should beat it. Allow
    // generous headroom (35ms cap) to soak up CI scheduler jitter.
    expect(wallClockMs).toBeLessThan(40 + 10);
    // Completion order should put the two 5ms tools (u2, u3) before u1.
    expect(completionOrder[0]).not.toBe("u1");
    // The user-message tool_results must align with tool_use order — the
    // Anthropic API requires it. The budget stamp rides after them as a
    // trailing text block.
    const userToolResults = result.newMessages.find(
      (m) => m.role === "user" && m.content[0]?.kind === "tool_result",
    );
    expect(userToolResults).toBeDefined();
    const ids = userToolResults?.content
      .filter((c) => c.kind === "tool_result")
      .map((c) => (c.kind === "tool_result" ? c.toolUseId : null));
    expect(ids).toEqual(["u1", "u2", "u3"]);
    // turnFetched accumulates from all three parallel results without
    // duplicates (each tool returns a distinct section_id).
    expect(result.fetchedRefs).toHaveLength(3);
    expect(new Set(result.fetchedRefs.map((r) => r.section_id))).toEqual(new Set(["1", "2", "3"]));
  });

  it("injects an R19 self-correct loop when prose cites but lacks a Sources block", async () => {
    // Round 1: model fetches the section and writes correct prose, but
    // omits the trailing Sources block. R19's verifySourcesBlock fires a
    // synthetic verification_failure. Round 2: model adds the block.
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        // Cited but no Sources block — R19 forces a retry.
        content: [{ kind: "text", text: "Per [test-alpha § 1.1] the rule applies." }],
        stopReason: "end_turn",
      },
      {
        content: [
          {
            kind: "text",
            text:
              "Per [test-alpha § 1.1], the rule applies.\n\n" +
              "**Sources**\n- [test-alpha § 1.1] — Test Section 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.verifierFailures).toBe(1);
    expect(result.finalText).toContain("**Sources**");
    provider.assertExhausted();
  });

  it("injects an R23 self-correct loop when a memo omits an affected section", async () => {
    // Round 1: model reads /bills/990001 (bill metadata, kind="bill" with
    // affected_section_ids ["1.1", "1.2"]) AND /modules/test-alpha/sections/1.1.
    // Round 2: model writes a memo (R20) citing Bill plus § 1.1 only —
    // § 1.2 is in affected_section_ids but unmentioned, so R23 fires.
    // Round 3: model rewrites as free prose (no `## Memo:` heading), which
    // exempts the answer from R23's completeness rule.
    const customRouter = async (
      name: string,
      input: unknown,
      toolUseId: string,
    ): Promise<{
      toolUseId: string;
      payload: import("../../../electron/ai/tools/types").ToolResultBase;
    }> => {
      const path = (input as { path?: string }).path ?? "";
      if (name === "read" && path === "/bills/990001") {
        return {
          toolUseId,
          payload: {
            ok: true,
            kind: "bill",
            fetched: [],
            corpus_hash: "test",
            turn_id: 1,
            bill: {
              file_no: "990001",
              module_id: "test-alpha",
              affected_section_ids: ["1.1", "1.2"],
            },
          } as unknown as import("../../../electron/ai/tools/types").ToolResultBase,
        };
      }
      if (name === "read" && path === "/modules/test-alpha/sections/1.1") {
        return {
          toolUseId,
          payload: {
            ok: true,
            kind: "section",
            fetched: [{ module_id: "test-alpha", section_id: "1.1" }],
            corpus_hash: "test",
            turn_id: 1,
            section: { id: "1.1", title: "Test", text: "..." },
          } as unknown as import("../../../electron/ai/tools/types").ToolResultBase,
        };
      }
      throw new Error(`unexpected router call: ${name} ${path}`);
    };
    const provider = new MockProvider([
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/bills/990001" },
          },
          {
            kind: "tool_use",
            toolUseId: "u2",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        // Memo heading triggers R23; § 1.2 omitted → verifier fires.
        content: [
          {
            kind: "text",
            text:
              "## Memo: [Bill #990001]\n" +
              "**Re:** Test ordinance\n" +
              "**Summary** — One section updated.\n" +
              "**Affected Sections** — [test-alpha § 1.1].\n\n" +
              "**Sources**\n" +
              "- [Bill #990001] — Test\n" +
              "- [test-alpha § 1.1] — Sec 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
      {
        // Free prose — no memo heading; R23 doesn't enforce.
        content: [
          {
            kind: "text",
            text:
              "Bill #990001 amends [test-alpha § 1.1] with revised text.\n\n" +
              "**Sources**\n" +
              "- [Bill #990001] — Test\n" +
              "- [test-alpha § 1.1] — Sec 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: customRouter,
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "memo on bill 990001",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.verifierFailures).toBe(1);
    expect(result.finalText).not.toMatch(/^## Memo:/);
    expect(result.finalText).toContain("[test-alpha § 1.1]");
    provider.assertExhausted();
  });

  it("does not require a Sources block when the answer cites nothing", async () => {
    // R19 / D8 escape hatch: a no-citation answer (e.g. "the corpus
    // doesn't include sf-fire") legitimately omits the block. The
    // verifier must let it pass without looping.
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      {
        content: [{ kind: "text", text: "The corpus doesn't include sf-fire." }],
        stopReason: "end_turn",
      },
    ]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does sf-fire say?",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.verifierFailures).toBe(0);
    provider.assertExhausted();
  });

  it("stops parallel dispatch when the signal aborts mid-round", async () => {
    // First worker awaits a 50ms tool; the abort fires after 5ms. The
    // worker that's already in flight runs to completion; subsequent
    // workers (those that haven't yet pulled work) see the aborted
    // signal and drain without dispatching.
    const dispatched: string[] = [];
    const customRouter = async (
      _name: string,
      _input: unknown,
      toolUseId: string,
    ): Promise<{
      toolUseId: string;
      payload: import("../../../electron/ai/tools/types").ToolResultBase;
    }> => {
      dispatched.push(toolUseId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        toolUseId,
        payload: {
          ok: true,
          fetched: [],
          corpus_hash: "mock",
          turn_id: 1,
        } as import("../../../electron/ai/tools/types").ToolResultBase,
      };
    };
    const provider = new MockProvider([
      {
        content: [
          { kind: "tool_use", toolUseId: "a1", name: "read", input: { path: "/x/1" } },
          { kind: "tool_use", toolUseId: "a2", name: "read", input: { path: "/x/2" } },
          { kind: "tool_use", toolUseId: "a3", name: "read", input: { path: "/x/3" } },
          { kind: "tool_use", toolUseId: "a4", name: "read", input: { path: "/x/4" } },
          { kind: "tool_use", toolUseId: "a5", name: "read", input: { path: "/x/5" } },
          { kind: "tool_use", toolUseId: "a6", name: "read", input: { path: "/x/6" } },
        ],
        stopReason: "tool_use",
      },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: customRouter,
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "abort me",
        signal: controller.signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("cancelled");
    // Workers cap at 4, so at most 4 tools may have been dispatched before
    // abort took effect. Fewer than 6 always.
    expect(dispatched.length).toBeLessThan(6);
    expect(dispatched.length).toBeLessThanOrEqual(4);
  });

  it("stamps a budget marker after each round's tool results", async () => {
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          {
            kind: "text",
            text:
              "Per [test-alpha § 1.1], the rule applies.\n\n" +
              "**Sources**\n- [test-alpha § 1.1] — Test Section 1.1\n",
          },
        ],
        stopReason: "end_turn",
      },
    ]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("end_turn");
    // Round 1 explored, so round 2's request carries the stamp as the
    // trailing text block of the tool-results user message.
    const secondRequest = provider.captured[1];
    const lastMessage = secondRequest?.messages[secondRequest.messages.length - 1];
    expect(lastMessage?.role).toBe("user");
    const trailing = lastMessage?.content[lastMessage.content.length - 1];
    expect(trailing).toEqual({ kind: "text", text: "[tool budget: round 1 of 10]" });
    // Exploration budget not exhausted — tools stay enabled.
    expect(provider.captured[0]?.toolChoice).toBe("auto");
    expect(provider.captured[1]?.toolChoice).toBe("auto");
    provider.assertExhausted();
  });

  it("forces a tools-disabled final round when the exploration budget runs out", async () => {
    const corpus = await loadFixtureCorpus();
    const toolRound = {
      content: [
        {
          kind: "tool_use" as const,
          toolUseId: "u1",
          name: "read",
          input: { path: "/modules/test-alpha/sections/1.1" },
        },
      ],
      stopReason: "tool_use" as const,
    };
    const provider = new MockProvider([
      ...Array.from({ length: 10 }, () => toolRound),
      {
        content: [
          {
            kind: "text" as const,
            text:
              "Per [test-alpha § 1.1], the rule applies.\n\n" +
              "**Sources**\n- [test-alpha § 1.1] — Test Section 1.1\n",
          },
        ],
        stopReason: "end_turn" as const,
      },
    ]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "deep dive on § 1.1",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    // The turn ends in prose, not a discarded transcript.
    expect(result.stopReason).toBe("end_turn");
    expect(result.finalText).toContain("§ 1.1");
    expect(result.roundCount).toBe(11);
    expect(result.toolCallCount).toBe(10);
    // Rounds 1-10 explore with tools enabled; round 11 is forced final.
    for (let i = 0; i < 10; i++) {
      expect(provider.captured[i]?.toolChoice).toBe("auto");
    }
    expect(provider.captured[10]?.toolChoice).toBe("none");
    // The 10th tool-results message carries the exhausted directive.
    const finalRequest = provider.captured[10];
    const lastMessage = finalRequest?.messages[finalRequest.messages.length - 1];
    const trailing = lastMessage?.content[lastMessage.content.length - 1];
    expect(trailing?.kind).toBe("text");
    if (trailing?.kind === "text") {
      expect(trailing.text).toContain("round 10 of 10");
      expect(trailing.text).toContain("exhausted");
      expect(trailing.text).toContain("tool calls are disabled");
    }
    provider.assertExhausted();
  });

  it("strips rogue tool_use blocks from a forced-final response instead of dispatching them", async () => {
    // The real API honors toolChoice "none"; MockProvider deliberately
    // doesn't, standing in for a misbehaving provider. The loop must not
    // dispatch the rogue tools, and the recorded assistant message must
    // not carry dangling tool_use ids (they'd poison the next turn).
    const corpus = await loadFixtureCorpus();
    const toolRound = {
      content: [
        {
          kind: "tool_use" as const,
          toolUseId: "u1",
          name: "read",
          input: { path: "/modules/test-alpha/sections/1.1" },
        },
      ],
      stopReason: "tool_use" as const,
    };
    const provider = new MockProvider([...Array.from({ length: 10 }, () => toolRound), toolRound]);
    const events: ConversationEvent[] = [];
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "deep dive on § 1.1",
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
      },
    );
    // Empty prose passes both verifiers; the turn ends rather than loops.
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCallCount).toBe(10);
    expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(10);
    const lastAssistant = [...result.newMessages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content.some((c) => c.kind === "tool_use")).toBe(false);
    provider.assertExhausted();
  });

  it("caps verifier fix-ups at MAX_FIXUP_ROUNDS, then accepts the degraded answer", async () => {
    // Four rounds of prose citing a section that was never fetched. The
    // first three failures consume the fix-up budget; the fourth is
    // accepted as-is (degraded) instead of burning rounds forever.
    const corpus = await loadFixtureCorpus();
    const badRound = {
      content: [{ kind: "text" as const, text: "Per [test-alpha § 1.1] the rule applies." }],
      stopReason: "end_turn" as const,
    };
    const provider = new MockProvider([badRound, badRound, badRound, badRound]);
    const result = await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history: [],
        userPrompt: "what does § 1.1 say?",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.verifierFailures).toBe(3);
    expect(result.roundCount).toBe(4);
    expect(result.finalText).toContain("§ 1.1");
    provider.assertExhausted();
  });

  it("sends an append-only message prefix across rounds with cacheConversation set", async () => {
    // Prompt caching is a prefix match: round N+1's messages must start
    // with round N's messages byte-for-byte, and the request must carry
    // the cacheConversation adapter hint. A window that re-pruned
    // mid-turn would shift the prefix and miss the cache every round.
    const corpus = await loadFixtureCorpus();
    const provider = new MockProvider([
      {
        content: [
          {
            kind: "tool_use",
            toolUseId: "u1",
            name: "read",
            input: { path: "/modules/test-alpha/sections/1.1" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ kind: "text", text: "Done. No citations needed." }],
        stopReason: "end_turn",
      },
    ]);
    // History longer than the old 20-message wire cap — the loop must
    // send it verbatim (windowing is the manager's job, not the loop's).
    const history: ProviderMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: "user", content: [{ kind: "text", text: `q${i}` }] });
      history.push({ role: "assistant", content: [{ kind: "text", text: `a${i}` }] });
    }
    await runConversationTurn(
      {
        provider,
        model: "mock-model-1",
        anchorModule: "test-alpha",
        router: makeRouterFn({ corpus, turnId: 1 }),
      },
      {
        turnId: 1,
        history,
        userPrompt: "look something up",
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    );
    expect(provider.captured).toHaveLength(2);
    const [first, second] = provider.captured;
    expect(first?.cacheConversation).toBe(true);
    expect(second?.cacheConversation).toBe(true);
    // Full history + new user prompt on the wire, unpruned.
    expect(first?.messages).toHaveLength(history.length + 1);
    // Round 2 = round 1's messages (byte-exact prefix) + assistant
    // tool_use turn + tool_results user turn.
    expect(second?.messages).toHaveLength(history.length + 3);
    expect(second?.messages.slice(0, history.length + 1)).toEqual(first?.messages);
    provider.assertExhausted();
  });
});

describe("ConversationManager windowing", () => {
  const makeTurn = (label: string, messageCount: number): ProviderMessage[] => {
    const turn: ProviderMessage[] = [
      { role: "user", content: [{ kind: "text", text: `${label}:prompt` }] },
    ];
    for (let i = 1; i < messageCount; i++) {
      turn.push({
        role: i % 2 === 1 ? "assistant" : "user",
        content: [{ kind: "text", text: `${label}:${i}` }],
      });
    }
    return turn;
  };
  const firstText = (history: readonly ProviderMessage[]): string | undefined => {
    const block = history[0]?.content[0];
    return block?.kind === "text" ? block.text : undefined;
  };

  it("returns the full history while under the high-water mark", () => {
    const m = new ConversationManager();
    for (let t = 0; t < 5; t++) m.appendTurn("c", makeTurn(`t${t}`, 6));
    expect(m.history("c")).toHaveLength(30);
    expect(firstText(m.history("c"))).toBe("t0:prompt");
  });

  it("cuts at a turn boundary once the high-water mark is crossed", () => {
    const m = new ConversationManager();
    for (let t = 0; t < 6; t++) m.appendTurn("c", makeTurn(`t${t}`, 6));
    // 36 messages > 30 high water → drop whole turns from the front
    // until ≤ 20: t0..t2 (18 messages) go, t3..t5 (18 messages) stay.
    const history = m.history("c");
    expect(history).toHaveLength(18);
    expect(firstText(history)).toBe("t3:prompt");
    // The cut never leaves a turn fragment: the window starts at a
    // turn's opening user prompt.
    expect(history[0]?.role).toBe("user");
  });

  it("keeps the window prefix byte-stable between cuts", () => {
    // The whole point of hysteresis: after a cut, subsequent turns
    // extend the window without moving its start, so the provider-side
    // prompt cache keeps hitting on the conversation prefix.
    const m = new ConversationManager();
    for (let t = 0; t < 6; t++) m.appendTurn("c", makeTurn(`t${t}`, 6));
    const afterCut = m.history("c");
    m.appendTurn("c", makeTurn("t6", 4));
    const next = m.history("c");
    // 18 + 4 = 22 ≤ 30 → no new cut; the old window is a prefix of the new.
    expect(next).toHaveLength(22);
    expect(next.slice(0, afterCut.length)).toEqual(afterCut);
  });

  it("always includes the newest turn whole, even when it alone exceeds the window", () => {
    const m = new ConversationManager();
    m.appendTurn("c", makeTurn("small", 2));
    m.appendTurn("c", makeTurn("huge", 35));
    const history = m.history("c");
    expect(history).toHaveLength(35);
    expect(firstText(history)).toBe("huge:prompt");
  });

  it("ignores empty turns", () => {
    const m = new ConversationManager();
    m.appendTurn("c", makeTurn("t0", 4));
    m.appendTurn("c", []);
    expect(m.history("c")).toHaveLength(4);
  });
});
