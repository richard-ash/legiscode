// Preload script. Runs in an isolated, partially-privileged context between
// the main process and the renderer. Exposes a namespaced `window.api`
// surface backed by the typed channel registry in electron/ipc/contract.ts;
// never leaks `ipcRenderer` or any other Electron primitives. With
// contextIsolation + sandbox both on (electron/main.ts), this script is the
// only path between the renderer and the main process.
//
// All wiring is delegated to preload-bridge.ts so this file stays
// content-free; adding a channel never requires editing it.

import { exposeApi } from "./ipc/preload-bridge";

exposeApi();
