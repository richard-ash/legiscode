// AnthropicAdapter request-shape tests. The adapter is the ONE file that
// talks to @anthropic-ai/sdk; these tests pin the wire shape it builds —
// per-model thinking config and cache_control breakpoint placement —
// via the deps.client test seam, without any network or SDK import.

import { describe, expect, it } from "vitest";
import type { AnthropicAdapterDeps } from "../../../electron/ai/providers/anthropic";
import { AnthropicAdapter } from "../../../electron/ai/providers/anthropic";
import type { ProviderRequest } from "../../../electron/ai/providers/types";

type CapturedParams = {
  model: string;
  max_tokens: number;
  thinking: { type: string; budget_tokens?: number };
  system: string | { type: string; text: string; cache_control?: { type: string } }[];
  tools: { name: string; cache_control?: { type: string } }[];
  messages: {
    role: string;
    content: { type: string; cache_control?: { type: string } }[];
  }[];
};

function makeAdapter(captured: CapturedParams[]): AnthropicAdapter {
  const client = {
    messages: {
      stream: (params: CapturedParams) => {
        captured.push(params);
        return {
          on: () => {},
          finalMessage: async () => ({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }),
        };
      },
    },
  } as unknown as NonNullable<AnthropicAdapterDeps["client"]>;
  return new AnthropicAdapter({ apiKey: "test-key", client });
}

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-sonnet-4-5",
    systemPrompt: "system text",
    systemCacheable: true,
    tools: [
      { name: "read", description: "read", inputSchema: { type: "object" }, cacheable: true },
      { name: "search", description: "search", inputSchema: { type: "object" } },
    ],
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    maxTokens: 4096,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("AnthropicAdapter request shape", () => {
  it("sends adaptive thinking on Opus 4.7 (manual extended thinking 400s there)", async () => {
    const captured: CapturedParams[] = [];
    await makeAdapter(captured).call(baseRequest({ model: "claude-opus-4-7" }));
    expect(captured[0]?.thinking).toEqual({ type: "adaptive" });
    // Headroom still added: adaptive thinking draws on the same
    // max_tokens pool the visible output uses.
    expect(captured[0]?.max_tokens).toBe(4096 + 4000);
  });

  it("sends manual extended thinking with a budget on pre-adaptive models", async () => {
    const captured: CapturedParams[] = [];
    await makeAdapter(captured).call(baseRequest({ model: "claude-sonnet-4-5" }));
    expect(captured[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(captured[0]?.max_tokens).toBe(4096 + 4000);
  });

  it("marks the system block and the tail tool for caching", async () => {
    const captured: CapturedParams[] = [];
    await makeAdapter(captured).call(baseRequest());
    const system = captured[0]?.system;
    expect(Array.isArray(system)).toBe(true);
    if (Array.isArray(system)) {
      expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    }
    const tools = captured[0]?.tools ?? [];
    // Breakpoint rides the LAST tool — the cache prefix covers the whole
    // tools block — even though `read` (not `search`) is the cacheable one.
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the last two user messages when cacheConversation is set", async () => {
    const captured: CapturedParams[] = [];
    await makeAdapter(captured).call(
      baseRequest({
        cacheConversation: true,
        messages: [
          { role: "user", content: [{ kind: "text", text: "q1" }] },
          { role: "assistant", content: [{ kind: "text", text: "a1" }] },
          {
            role: "user",
            content: [
              { kind: "tool_result", toolUseId: "u1", content: "result" },
              { kind: "text", text: "[tool budget: round 1 of 10]" },
            ],
          },
          { role: "assistant", content: [{ kind: "text", text: "a2" }] },
          { role: "user", content: [{ kind: "text", text: "q2" }] },
        ],
      }),
    );
    const messages = captured[0]?.messages ?? [];
    // Read point: previous user message's last block (where the prior
    // request's cache entry was written). Write point: final message's
    // last block. Nothing else carries a marker.
    expect(messages[2]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[2]?.content[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[4]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[1]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[3]?.content[0]?.cache_control).toBeUndefined();
  });

  it("adds no message cache_control when cacheConversation is absent", async () => {
    const captured: CapturedParams[] = [];
    await makeAdapter(captured).call(
      baseRequest({
        messages: [
          { role: "user", content: [{ kind: "text", text: "q1" }] },
          { role: "assistant", content: [{ kind: "text", text: "a1" }] },
          { role: "user", content: [{ kind: "text", text: "q2" }] },
        ],
      }),
    );
    for (const m of captured[0]?.messages ?? []) {
      for (const block of m.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }
  });
});
