// preload-bridge unit tests. Mocks the `electron` module so `ipcRenderer`
// and `contextBridge` are recording shims, then drives the api object built
// by `buildApi`. The main-process counterpart lives in main-handlers.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke },
}));

const contractModule = await import("../../../electron/ipc/contract");
const preloadModule = await import("../../../electron/ipc/preload-bridge");

beforeEach(() => {
  exposeInMainWorld.mockClear();
  invoke.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildApi", () => {
  it("produces a namespaced object covering every channel", () => {
    const api = preloadModule.buildApi();
    expect(api.corpus.list).toBeTypeOf("function");
    expect(api.corpus.read).toBeTypeOf("function");
    expect(api.app.ping).toBeTypeOf("function");
  });

  it("each method invokes the matching channel name on ipcRenderer", async () => {
    invoke.mockResolvedValue({ pong: 1 });
    const api = preloadModule.buildApi();
    await api.app.ping();
    expect(invoke).toHaveBeenCalledWith("app:ping", undefined);

    invoke.mockResolvedValue({ ok: true, value: {} });
    await api.corpus.read({ moduleId: "sf-port", sectionId: "1.4" });
    expect(invoke).toHaveBeenCalledWith("corpus:read", {
      moduleId: "sf-port",
      sectionId: "1.4",
    });
  });

  it("forwards the resolved response unchanged", async () => {
    const payload = { ok: true, value: "x" };
    invoke.mockResolvedValue(payload);
    const api = preloadModule.buildApi();
    const result = await api.corpus.list();
    expect(result).toBe(payload);
  });

  it("wraps invoke rejections as IpcBridgeError(handler_threw)", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    const api = preloadModule.buildApi();
    await expect(api.app.ping()).rejects.toBeInstanceOf(contractModule.IpcBridgeError);
    await expect(api.app.ping()).rejects.toMatchObject({
      channel: "app:ping",
      reason: "handler_threw",
    });
  });
});

describe("exposeApi", () => {
  it("registers the api object on the main world via contextBridge", () => {
    preloadModule.exposeApi();
    expect(exposeInMainWorld).toHaveBeenCalledWith("api", expect.any(Object));
    const exposed = exposeInMainWorld.mock.calls[0]?.[1];
    expect(exposed).toMatchObject({
      corpus: { list: expect.any(Function), read: expect.any(Function) },
      app: { ping: expect.any(Function) },
    });
  });
});
