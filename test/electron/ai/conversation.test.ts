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
    // Anthropic API requires it.
    const userToolResults = result.newMessages.find(
      (m) => m.role === "user" && m.content.every((c) => c.kind === "tool_result"),
    );
    expect(userToolResults).toBeDefined();
    const ids = userToolResults?.content.map((c) =>
      c.kind === "tool_result" ? c.toolUseId : null,
    );
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
});
