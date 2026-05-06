// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetVisibleRowsCache } from "@/corpus-nav";
import type { Api, CorpusModuleSummary, CorpusTreeNode } from "../../electron/ipc/contract";
import { App } from "../../src/ui/App";

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

const populatedCorpus: CorpusModuleSummary = {
  jurisdiction: "City and County of San Francisco",
  rootLabel: "San Francisco Municipal Code",
  jurisdictionVersion: "2026.05.01",
  codeCount: 1,
  sectionCount: 2,
  defaultRef: { moduleId: "sf-port", sectionId: "1.1" },
  tree: [
    {
      id: "sf-port",
      code: "Port Code",
      name: "",
      kind: "code",
      kids: [
        {
          id: "sf-port::ART1",
          code: "ARTICLE 1",
          name: "",
          kind: "chapter",
          kids: [
            {
              id: "sf-port::1.1",
              code: "§ 1.1",
              name: "Definitions",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "1.1" },
            },
            {
              id: "sf-port::1.2",
              code: "§ 1.2",
              name: "Commission",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "1.2" },
            },
          ] satisfies CorpusTreeNode[],
        },
      ],
    },
  ],
};

function buildPopulatedApi(): Api {
  return {
    corpus: {
      list: vi.fn().mockResolvedValue({ ok: true, value: populatedCorpus }),
      read: vi.fn(async (req: { moduleId: string; sectionId: string }) => ({
        ok: true as const,
        value: {
          moduleId: req.moduleId,
          section: {
            kind: "section" as const,
            id: req.sectionId,
            title: req.sectionId === "1.1" ? "Definitions" : "Commission",
            text: "",
            citations: [],
            defined_terms: [],
            hierarchy: ["Port Code", "ARTICLE 1"],
            editorial_status: "active" as const,
          },
          parents: [{ code: "Port Code", name: "" }],
          prev: null,
          next: null,
        },
      })),
    },
    app: { ping: vi.fn().mockResolvedValue({ pong: 1 }) },
  };
}

describe("App — workbench openItems flow (Layer 4 ↔ Layer 5)", () => {
  beforeEach(() => {
    __resetVisibleRowsCache();
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApi();
  });

  it("activeIndex change drives corpus:read", async () => {
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });

    // Wait for the populated tree to render, then click Commission (1.2).
    const row12 = await screen.findByTestId("tree-row-sf-port::1.2");
    fireEvent.click(row12);
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.2" });
    });
  });

  it("Cmd+P palette → palette opens → selecting a section drives openItem", async () => {
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Go to section/)).toBeInTheDocument();
    });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "Commission");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.2" });
    });
  });

  it("openItems persist across cold-start (regression guard for the legacy-key migration path)", async () => {
    // Round 1: open § 1.2 → unmount → assert localStorage written
    const r1 = render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    const row12a = await screen.findByTestId("tree-row-sf-port::1.2");
    fireEvent.click(row12a);
    await waitFor(() => {
      const persisted = window.localStorage.getItem("legiscode.openItems");
      expect(persisted).not.toBeNull();
      expect(JSON.parse(persisted ?? "{}")).toMatchObject({
        items: [
          { kind: "section", ref: { module: "sf-port", section: "1.1" } },
          { kind: "section", ref: { module: "sf-port", section: "1.2" } },
        ],
        activeIndex: 1,
      });
    });
    r1.unmount();

    // Round 2: re-render, expect openItems hydrated and active=1.2
    __resetVisibleRowsCache();
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApi();
    render(<App />);
    const activeRow = await screen.findByTestId("tree-row-sf-port::1.2");
    await waitFor(() => {
      expect(activeRow).toHaveClass("is-active");
    });
  });

  it("legacy `legiscode.activeSection` migrates on cold start (REGRESSION — IRON RULE UF5)", async () => {
    window.localStorage.setItem(
      "legiscode.activeSection",
      JSON.stringify({ moduleId: "sf-port", sectionId: "1.2" }),
    );
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.2" });
    });
    // Legacy key is gone, new key is present.
    expect(window.localStorage.getItem("legiscode.activeSection")).toBeNull();
    expect(window.localStorage.getItem("legiscode.openItems")).not.toBeNull();
    // The active row reflects the migrated ref.
    const activeRow12 = await screen.findByTestId("tree-row-sf-port::1.2");
    expect(activeRow12).toHaveClass("is-active");
  });
});
