// Global chat hook. Subscribes to ai:event for the live tool trail and
// drives the renderer state via a module-level store.
//
// Per [[feedback_global_chat_not_per_section]] the chat is one global
// thread. The currently-focused section is supplied to `send` as
// optional anchor context per-message; it never re-keys the thread.
// Cancellation is one Esc keypress in the input.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AiCorpusContextRef, AiEvent, AiTokenUsage, AiToolResultView } from "@/ai/wire";
import { api } from "@/app/api";
import {
  GLOBAL_CHAT_ID,
  bindChatEventStream,
  getChatTurns,
  resetChatStore,
  subscribeChatStore,
  updateChatTurns,
} from "./chat-store";

export interface ChatToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  result: AiToolResultView | null;
}

export interface ChatTurn {
  id: string;
  turnId: number;
  userPrompt: string;
  assistantText: string;
  toolCalls: ChatToolCall[];
  usage: AiTokenUsage | null;
  startedAt: number;
  durationMs: number | null;
  busy: boolean;
  error: string | null;
}

export interface UseChatReturn {
  turns: readonly ChatTurn[];
  busy: boolean;
  send(prompt: string, anchor?: AiCorpusContextRef): void;
  cancel(): void;
  reset(): void;
}

const ZERO_USAGE: AiTokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export function useChat(): UseChatReturn {
  const turns = useSyncExternalStore(subscribeChatStore, getChatTurns, getChatTurns);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const busy = turns.some((t) => t.busy);

  // Bind the event stream once across the whole renderer lifetime.
  // Multiple useChat consumers (e.g. concurrent surfaces, tests) share
  // the same subscription; bindChatEventStream is idempotent.
  useEffect(() => {
    try {
      bindChatEventStream(
        (cb) => api().ai.onEvent(cb),
        (event) => handleEvent(event),
      );
    } catch {
      // window.api may not be wired (jsdom tests during remount). No-op;
      // the chat surface is read-only until the user provides a prompt.
    }
  }, []);

  const send = useCallback((prompt: string, anchor?: AiCorpusContextRef): void => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    // Optimistically append a busy turn. The turnId will overwrite once
    // ai:query resolves; until then we use a synthetic placeholder id so
    // events can promote it on first event.
    const placeholderId = `pending-${Date.now()}`;
    const turn: ChatTurn = {
      id: placeholderId,
      turnId: 0,
      userPrompt: trimmed,
      assistantText: "",
      toolCalls: [],
      usage: null,
      startedAt: Date.now(),
      durationMs: null,
      busy: true,
      error: null,
    };
    updateChatTurns((prev) => [...prev, turn]);
    void api()
      .ai.query({
        chat_id: GLOBAL_CHAT_ID,
        anchor,
        prompt: trimmed,
      })
      .then((result) => {
        // Match by placeholder id (unique per send) and promote it to
        // the real turnId. Any turn_started event that arrived first
        // already overwrote id+turnId, in which case the placeholder
        // won't be found and the resolve is a no-op for state.
        updateChatTurns((prev) =>
          prev.map((t) =>
            t.id === placeholderId || t.turnId === result.turn_id
              ? {
                  ...t,
                  turnId: result.turn_id,
                  busy: false,
                  assistantText: result.text || t.assistantText,
                  usage: result.usage,
                  durationMs: Date.now() - t.startedAt,
                  error:
                    result.ok || result.stop_reason === "cancelled"
                      ? t.error
                      : (result.error?.message ?? "Unknown error."),
                }
              : t,
          ),
        );
      })
      .catch((err) => {
        updateChatTurns((prev) =>
          prev.map((t) =>
            t.id === placeholderId
              ? {
                  ...t,
                  busy: false,
                  error: err instanceof Error ? err.message : String(err),
                }
              : t,
          ),
        );
      });
  }, []);

  const cancel = useCallback((): void => {
    const active = turnsRef.current.find((t) => t.busy);
    if (!active || active.turnId === 0) return;
    void api().ai.cancel({ chat_id: GLOBAL_CHAT_ID, turn_id: active.turnId });
  }, []);

  const reset = useCallback((): void => {
    resetChatStore();
  }, []);

  return useMemo(() => ({ turns, busy, send, cancel, reset }), [turns, busy, send, cancel, reset]);
}

function handleEvent(event: AiEvent): void {
  switch (event.kind) {
    case "turn_started":
      updateChatTurns((prev) => {
        // Promote the most recent placeholder turn to this turn_id.
        const idx = lastIndex(prev, (t) => t.busy && t.turnId === 0);
        if (idx < 0) return prev;
        const next = [...prev];
        const target = next[idx];
        if (!target) return prev;
        next[idx] = { ...target, id: `turn-${event.turn_id}`, turnId: event.turn_id };
        return next;
      });
      return;
    case "tool_call":
      updateChatTurns((prev) =>
        prev.map((t) =>
          t.turnId === event.turn_id
            ? {
                ...t,
                toolCalls: [
                  ...t.toolCalls,
                  {
                    toolUseId: event.tool_use_id,
                    name: event.name,
                    input: event.input,
                    result: null,
                  },
                ],
              }
            : t,
        ),
      );
      return;
    case "tool_result":
      updateChatTurns((prev) =>
        prev.map((t) =>
          t.turnId === event.turn_id
            ? {
                ...t,
                toolCalls: t.toolCalls.map((c) =>
                  c.toolUseId === event.tool_use_id ? { ...c, result: event.result } : c,
                ),
              }
            : t,
        ),
      );
      return;
    case "text_delta":
      // Streaming: deltas arrive incrementally during the round. Append.
      updateChatTurns((prev) =>
        prev.map((t) =>
          t.turnId === event.turn_id
            ? { ...t, assistantText: `${t.assistantText}${event.text}` }
            : t,
        ),
      );
      return;
    case "turn_completed":
      updateChatTurns((prev) =>
        prev.map((t) =>
          t.turnId === event.turn_id
            ? {
                ...t,
                busy: false,
                assistantText: event.text || t.assistantText,
                usage: event.usage,
                durationMs: Date.now() - t.startedAt,
              }
            : t,
        ),
      );
      return;
    case "turn_error":
      updateChatTurns((prev) =>
        prev.map((t) =>
          t.turnId === event.turn_id
            ? { ...t, busy: false, error: event.message, durationMs: Date.now() - t.startedAt }
            : t,
        ),
      );
      return;
    case "turn_cancelled":
      updateChatTurns((prev) =>
        prev.map((t) =>
          t.turnId === event.turn_id
            ? {
                ...t,
                busy: false,
                error: t.assistantText ? null : "Cancelled.",
                durationMs: Date.now() - t.startedAt,
              }
            : t,
        ),
      );
      return;
  }
}

function lastIndex<T>(arr: readonly T[], predicate: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== undefined && predicate(v)) return i;
  }
  return -1;
}

export { ZERO_USAGE as DEFAULT_USAGE };
