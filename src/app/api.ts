// Renderer-side accessor for the IPC bridge exposed by electron/preload.ts.
// Throws synchronously if `window.api` is missing — that means the preload
// script failed to evaluate (sandbox+CJS misconfiguration, electron-vite
// build artifact missing, etc.) and every IPC call would fail with a
// confusing "cannot read property of undefined" otherwise.
//
// Replaces the previous corpusClient/appClient wrappers — the namespaced
// shape on `window.api` is already ergonomic enough that a per-namespace
// re-export was redundant.

import type { Api } from "../../electron/ipc/contract";

export function api(): Api {
  if (typeof window === "undefined" || !window.api) {
    throw new Error("window.api is not wired — preload script failed to expose the IPC bridge.");
  }
  return window.api;
}
