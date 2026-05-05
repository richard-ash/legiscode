// Main-process side of the IPC bridge. Owns `ipcMain.handle` registration
// and the boot-time exhaustiveness assertion. Imports `ipcMain` only — the
// renderer-side counterparts (`ipcRenderer`, `contextBridge`) live in
// preload-bridge.ts so the two process contexts never share a runtime module.
//
// Adding a channel: extend `ChannelMap` in contract.ts, then add the
// corresponding entry to the `handlers` literal main.ts passes here. The
// `Handlers` type is exhaustive over `Channel`, so a missing entry is a TS
// error at the call site.

import { ipcMain } from "electron";
import {
  CHANNELS,
  type Channel,
  type ChannelRequest,
  type ChannelResponse,
  IpcBridgeError,
  isChannel,
} from "./contract";

export type { Channel };

/**
 * Exhaustive map from each channel to its handler. The mapped type forces
 * every channel to be present at compile time — adding a channel to
 * `ChannelMap` without a handler entry here fails to type-check.
 */
export type Handlers = {
  [C in Channel]: (request: ChannelRequest<C>) => ChannelResponse<C> | Promise<ChannelResponse<C>>;
};

const registered = new Set<Channel>();

/**
 * Register every channel handler with `ipcMain`. The handler wrapper turns
 * synchronous throws and rejected promises into `IpcBridgeError("handler_threw")`
 * surfaced to the renderer, so domain failures (which should resolve to a
 * Result) are distinguishable from plumbing bugs.
 */
export function registerHandlers(handlers: Handlers): void {
  for (const channel of CHANNELS) {
    if (!isChannel(channel)) {
      // Unreachable — CHANNELS is typed `readonly Channel[]`. Defensive
      // because preload/main share the allowlist and a casting bug would
      // otherwise register an unknown name.
      throw new IpcBridgeError(
        channel,
        "unknown_channel",
        `registerHandlers: "${channel}" is not in the channel allowlist`,
      );
    }
    if (registered.has(channel)) {
      throw new IpcBridgeError(
        channel,
        "unknown_channel",
        `registerHandlers: "${channel}" already has a handler`,
      );
    }
    registered.add(channel);
    // Erase the per-channel request/response generic — the for-loop produces
    // a union and TS can't narrow `handlers[channel]` against the loop var.
    // The Handlers type at the call site has already enforced exhaustiveness
    // and per-channel correctness.
    const handler = handlers[channel] as (request: unknown) => unknown;
    ipcMain.handle(channel, async (_event, request) => {
      try {
        return await handler(request);
      } catch (cause) {
        throw new IpcBridgeError(
          channel,
          "handler_threw",
          `handler for "${channel}" threw: ${describeError(cause)}`,
          { cause },
        );
      }
    });
  }
}

/**
 * Defensive boot-time check that every allowlisted channel has been
 * registered. Redundant with `registerHandlers` (which iterates `CHANNELS`
 * itself) but kept as a defense-in-depth tripwire — if a future refactor
 * splits handler registration across multiple call sites, this catches a
 * missed channel at boot rather than as a renderer-side timeout.
 */
export function assertAllChannelsRegistered(): void {
  const missing = CHANNELS.filter((c) => !registered.has(c));
  if (missing.length > 0) {
    throw new IpcBridgeError(
      missing[0] ?? "(none)",
      "unknown_channel",
      `assertAllChannelsRegistered: missing handlers for ${missing.join(", ")}`,
    );
  }
}

/** Test seam — drops registration state so vitest can re-run main.ts logic. */
export function __resetForTests(): void {
  for (const c of registered) ipcMain.removeHandler(c);
  registered.clear();
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}
