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
