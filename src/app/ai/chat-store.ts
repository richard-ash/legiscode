// Module-level chat store. Holds the single global thread plus a
// pub/sub for React via useSyncExternalStore.
//
// Per [[feedback_global_chat_not_per_section]]: the chat is one
// conversation, accessible from any tab. The currently-focused
// section is just *context* the renderer attaches to each send —
// not a key that swaps which thread is visible.

import type { AiEvent } from "@/ai/wire";
import type { ChatTurn } from "./use-chat";

/** Fixed chat_id we send over IPC. The conversation manager keys its
 *  history by this string; renaming requires a wipe on next launch. */
export const GLOBAL_CHAT_ID = "global";

let turns: readonly ChatTurn[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getChatTurns(): readonly ChatTurn[] {
  return turns;
}

export function subscribeChatStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateChatTurns(updater: (prev: readonly ChatTurn[]) => readonly ChatTurn[]): void {
  const next = updater(turns);
  if (next === turns) return;
  turns = next;
  emit();
}

/** Clear the thread — exposed for the renderer's reset() and for tests. */
export function resetChatStore(): void {
  if (turns.length === 0) return;
  turns = [];
  emit();
}

/** Lift the ai:event handler out of useChat so the subscription survives
 *  every renderer remount. Idempotent — guarded against double-bind. */
let eventUnsubscribe: (() => void) | null = null;

export function bindChatEventStream(
  subscribe: (cb: (e: AiEvent) => void) => () => void,
  handle: (e: AiEvent) => void,
): void {
  if (eventUnsubscribe) return;
  eventUnsubscribe = subscribe((e) => handle(e));
}

export function unbindChatEventStream(): void {
  if (!eventUnsubscribe) return;
  eventUnsubscribe();
  eventUnsubscribe = null;
}
