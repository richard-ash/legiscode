// main-handlers unit tests. Mocks the `electron` module so registration can
// run in plain Node — `ipcMain.handle` becomes a recording shim that lets us
// drive the registered handlers directly. The renderer-side counterpart lives
// in preload-bridge.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handlers } from "../../../electron/ipc/main-handlers";

type Handler = (event: unknown, request: unknown) => unknown;

const handlers = new Map<string, Handler>();
const removeHandler = vi.fn((channel: string) => {
  handlers.delete(channel);
});
const handle = vi.fn((channel: string, fn: Handler) => {
  handlers.set(channel, fn);
});

vi.mock("electron", () => ({
  ipcMain: { handle, removeHandler },
}));

const contractModule = await import("../../../electron/ipc/contract");
const mainHandlersModule = await import("../../../electron/ipc/main-handlers");

beforeEach(() => {
  mainHandlersModule.__resetForTests();
  handlers.clear();
  handle.mockClear();
  removeHandler.mockClear();
});

afterEach(() => {
  mainHandlersModule.__resetForTests();
});

function buildHandlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    "corpus:list": () => ({
      ok: true,
      value: {
        jurisdiction: "T",
        rootLabel: "T",
        jurisdictionVersion: "2026.05.01",
        codeCount: 0,
        sectionCount: 0,
        defaultRef: { moduleId: "", sectionId: "" },
        tree: [],
      },
    }),
    "corpus:read": () => ({
      ok: false,
      error: { kind: "not_found", detail: "" },
    }),
    "app:ping": () => ({ pong: 42 }),
    ...overrides,
  } as Handlers;
}

describe("registerHandlers", () => {
  it("wires every CHANNELS entry to ipcMain.handle", () => {
    mainHandlersModule.registerHandlers(buildHandlers());
    for (const channel of contractModule.CHANNELS) {
      expect(handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }
    expect(handle).toHaveBeenCalledTimes(contractModule.CHANNELS.length);
  });

  it("routes invocations through the registered handler", async () => {
    mainHandlersModule.registerHandlers(buildHandlers());
    const fn = handlers.get("app:ping");
    expect(fn).toBeDefined();
    const result = await fn?.(undefined, undefined);
    expect(result).toEqual({ pong: 42 });
  });

  it("wraps synchronous handler throws as IpcBridgeError(handler_threw)", async () => {
    mainHandlersModule.registerHandlers(
      buildHandlers({
        "app:ping": () => {
          throw new Error("boom");
        },
      }),
    );
    const fn = handlers.get("app:ping");
    await expect(fn?.(undefined, undefined)).rejects.toBeInstanceOf(contractModule.IpcBridgeError);
    await expect(fn?.(undefined, undefined)).rejects.toMatchObject({ reason: "handler_threw" });
  });

  it("wraps rejected promise handlers as IpcBridgeError(handler_threw)", async () => {
    mainHandlersModule.registerHandlers(
      buildHandlers({
        "app:ping": async () => {
          throw new Error("async boom");
        },
      }),
    );
    const fn = handlers.get("app:ping");
    await expect(fn?.(undefined, undefined)).rejects.toMatchObject({
      reason: "handler_threw",
    });
  });

  it("rejects when called twice without reset", () => {
    mainHandlersModule.registerHandlers(buildHandlers());
    expect(() => mainHandlersModule.registerHandlers(buildHandlers())).toThrow(
      /already has a handler/,
    );
  });
});

describe("assertAllChannelsRegistered", () => {
  it("throws when called before registerHandlers", () => {
    expect(() => mainHandlersModule.assertAllChannelsRegistered()).toThrow(/missing handlers/);
  });

  it("passes after registerHandlers wires every channel", () => {
    mainHandlersModule.registerHandlers(buildHandlers());
    expect(() => mainHandlersModule.assertAllChannelsRegistered()).not.toThrow();
  });
});
