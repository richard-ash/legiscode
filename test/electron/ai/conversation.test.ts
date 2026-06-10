// Conversation loop tests. Covers the agentic round-trip via MockProvider,
// cancellation, the verifier-failure → synthetic-fix-up loop, and the
// 10-round budget cap.

import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../electron/ai/conversation";
import { makeRouterFn, runConversationTurn } from "../../../electron/ai/conversation";
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
            text: 'Per [test-alpha § 1.1], the rule applies. The section says "Hermetic".',
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
      // section in fetched.
      {
        content: [{ kind: "text", text: "Per [test-alpha § 1.1], the rule applies." }],
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
        content: [{ kind: "text", text: "Per [test-alpha § 1.1], rule applies." }],
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
});
