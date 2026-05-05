// @vitest-environment jsdom
/// <reference lib="dom" />

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/ui/App";
import type { Api } from "../../electron/ipc/contract";

declare global {
  interface Window {
    api: Api;
  }
}

function buildApi(overrides: Partial<Api["corpus"]> = {}): Api {
  return {
    corpus: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          jurisdiction: "T",
          rootLabel: "T",
          jurisdictionVersion: "2026.05.01",
          codeCount: 0,
          sectionCount: 0,
          defaultRef: { moduleId: "m", sectionId: "1" },
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
      ...overrides,
    },
    app: { ping: vi.fn().mockResolvedValue({ pong: 1 }) },
  };
}

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: writable global setter for test fixture
  (window as any).api = buildApi();
});

afterEach(() => {
  vi.clearAllMocks();
  // biome-ignore lint/suspicious/noExplicitAny: deliberate teardown
  delete (window as any).api;
  window.localStorage.clear();
});

describe("App — IPC bridge failure surfaces in BootOverlay (P1)", () => {
  it("renders the corpus BootOverlay when corpus.list rejects (handler threw)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test override
    (window as any).api = buildApi({
      list: vi.fn().mockRejectedValue(new Error('invoke of "corpus:list" failed: handler boom')),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Corpus failed to load/ })).toBeInTheDocument();
    });
    expect(
      screen.getByText(/IPC bridge unavailable: invoke of "corpus:list" failed: handler boom/),
    ).toBeInTheDocument();
  });

  it("renders the corpus BootOverlay when window.api is missing (preload broken)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate teardown to simulate broken preload
    delete (window as any).api;
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Corpus failed to load/ })).toBeInTheDocument();
    });
    expect(screen.getByText(/IPC bridge unavailable: window.api is not wired/)).toBeInTheDocument();
  });

  it("renders the corpus BootOverlay when corpus.read rejects mid-session", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test override
    (window as any).api = buildApi({
      read: vi.fn().mockRejectedValue(new Error("renderer disconnected")),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Corpus failed to load/ })).toBeInTheDocument();
    });
    expect(screen.getByText(/IPC bridge unavailable: renderer disconnected/)).toBeInTheDocument();
  });

  it("renders the corpus BootOverlay when corpus.list resolves with a domain error (regression guard)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test override
    (window as any).api = buildApi({
      list: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: "corrupt", detail: "manifest.json is malformed" },
      }),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Corpus failed to load/ })).toBeInTheDocument();
    });
    expect(screen.getByText(/manifest.json is malformed/)).toBeInTheDocument();
  });
});
