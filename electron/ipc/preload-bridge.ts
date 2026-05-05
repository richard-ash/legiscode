// Preload-process side of the IPC bridge. Builds the `window.api` object by
// iterating `CHANNELS` and exposes it via `contextBridge.exposeInMainWorld`.
// Imports `ipcRenderer` and `contextBridge` only — the main-side counterpart
// (`ipcMain.handle`) lives in main-handlers.ts so neither side mixes
// runtime imports across process boundaries.
//
// Channel names are flat strings ("corpus:list") on the wire. The
// `window.api.corpus.list()` namespacing is built here at runtime by
// splitting each channel on `:` once. The shape produced is asserted to
// match the hand-written `Api` interface in contract.ts; a mismatch surfaces
// at every renderer call site.

import { contextBridge, ipcRenderer } from "electron";
import { type Api, CHANNELS, type Channel, IpcBridgeError } from "./contract";

/**
 * Wire `window.api` to `ipcRenderer.invoke`. Called once from preload.ts.
 * Builds the namespaced api object from `CHANNELS` so adding a channel never
 * requires editing this file.
 */
export function exposeApi(): void {
  contextBridge.exposeInMainWorld("api", buildApi());
}

/**
 * Construct the `Api` object from `CHANNELS`. Exported so tests can verify
 * the shape without engaging contextBridge.
 */
export function buildApi(): Api {
  const api: Record<string, Record<string, (request?: unknown) => Promise<unknown>>> = {};
  for (const channel of CHANNELS) {
    const colon = channel.indexOf(":");
    const namespace = channel.slice(0, colon);
    const verb = channel.slice(colon + 1);
    if (!api[namespace]) api[namespace] = {};
    api[namespace][verb] = (request) => safeInvoke(channel, request);
  }
  return api as unknown as Api;
}

/**
 * Wrap `ipcRenderer.invoke` so renderer code sees a typed `IpcBridgeError`
 * on plumbing failure (renderer disconnect, handler throw). Domain errors
 * arrive as a resolved `{ ok: false, error }` Result and are not thrown.
 */
async function safeInvoke(channel: Channel, request: unknown): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(channel, request);
  } catch (cause) {
    throw new IpcBridgeError(
      channel,
      "handler_threw",
      `invoke of "${channel}" failed: ${describeError(cause)}`,
      { cause },
    );
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}
