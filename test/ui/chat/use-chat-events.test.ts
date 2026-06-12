// Chat event-handling tests for the store-mutation logic in use-chat.
// Covers the turn_completed stop_reason branches the panel renders from:
// a normal end_turn (prose, no error) and the max_rounds budget condition
// (error slot populated, streamed partial text preserved — never
// clobbered by an empty final text).

import { beforeEach, describe, expect, it } from "vitest";
import type { AiTokenUsage } from "@/ai/wire";
import { getChatTurns, resetChatStore, updateChatTurns } from "@/app/ai/chat-store";
import { type ChatTurn, handleChatEvent } from "@/app/ai/use-chat";

const USAGE: AiTokenUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function seedBusyTurn(turnId: number, assistantText: string): void {
  const turn: ChatTurn = {
    id: `turn-${turnId}`,
    turnId,
    userPrompt: "permit path for junk dealers?",
    assistantText,
    toolCalls: [],
    usage: null,
    startedAt: 0,
    durationMs: null,
    busy: true,
    error: null,
  };
  updateChatTurns((prev) => [...prev, turn]);
}

describe("handleChatEvent — turn_completed", () => {
  beforeEach(() => {
    resetChatStore();
  });

  it("finishes a normal end_turn with prose and no error", () => {
    seedBusyTurn(1, "");
    handleChatEvent({
      kind: "turn_completed",
      chat_id: "global",
      turn_id: 1,
      text: "Per [test-alpha § 1.1], the rule applies.",
      usage: USAGE,
      stop_reason: "end_turn",
    });
    const turn = getChatTurns()[0];
    expect(turn?.busy).toBe(false);
    expect(turn?.assistantText).toContain("§ 1.1");
    expect(turn?.error).toBeNull();
  });

  it("surfaces max_rounds as an error and keeps streamed partial text", () => {
    seedBusyTurn(2, "Partial reasoning the model streamed mid-turn.");
    handleChatEvent({
      kind: "turn_completed",
      chat_id: "global",
      turn_id: 2,
      text: "",
      usage: USAGE,
      stop_reason: "max_rounds",
    });
    const turn = getChatTurns()[0];
    expect(turn?.busy).toBe(false);
    expect(turn?.error).toMatch(/Ran out of tool rounds/);
    expect(turn?.assistantText).toBe("Partial reasoning the model streamed mid-turn.");
  });
});
