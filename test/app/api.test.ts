// @vitest-environment jsdom
/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../electron/ipc/contract";
import { api } from "../../src/app/api";

declare global {
  interface Window {
    api: Api;
  }
}

const stubApi: Api = {
  corpus: {
    list: vi.fn().mockResolvedValue({
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
    read: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        moduleId: "m",
        section: {
          kind: "section",
          id: "1",
          title: "T",
          text: "",
          citations: [],
          defined_terms: [],
          hierarchy: [],
          editorial_status: "active",
        },
        parents: [],
        prev: null,
        next: null,
      },
    }),
  },
  app: {
    ping: vi.fn().mockResolvedValue({ pong: 1 }),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  },
};

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: writable global setter for test fixture
  (window as any).api = stubApi;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("api()", () => {
  it("returns the bridge object exposed on window.api", () => {
    expect(api()).toBe(stubApi);
  });

  it("delegates calls to window.api directly", async () => {
    await api().corpus.list();
    expect(stubApi.corpus.list).toHaveBeenCalledTimes(1);

    await api().corpus.read({ moduleId: "sf-port", sectionId: "1.4" });
    expect(stubApi.corpus.read).toHaveBeenCalledWith({
      moduleId: "sf-port",
      sectionId: "1.4",
    });

    await api().app.ping();
    expect(stubApi.app.ping).toHaveBeenCalledTimes(1);
  });

  it("throws if window.api is missing", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately deleting bridge for negative test
    delete (window as any).api;
    expect(() => api()).toThrow(/window.api is not wired/);
  });
});
