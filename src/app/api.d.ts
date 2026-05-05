// Augments the global `Window` shape with the typed `api` namespace exposed
// by electron/preload.ts via contextBridge. Renderer code reads window.api
// through this declaration; the runtime is wired in preload-bridge.ts.

import type { Api as IpcApi } from "../../electron/ipc/contract";

declare global {
  interface Window {
    api: IpcApi;
  }
}
