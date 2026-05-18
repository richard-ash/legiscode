// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
            body: [],
          },
          parents: [],
          prev: null,
          next: null,
          definitions: {},
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
            body: [],
          },
          parents: [{ code: "Port Code", name: "" }],
          prev: null,
          next: null,
          definitions: {},
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

  it("corpus.read ok:false renders the in-section banner and clears stale chrome (F3, D8 + C7)", async () => {
    // Round 1: open § 1.1 normally so the banner has stale state to clear.
    const apiMod: { current: Api } = { current: buildPopulatedApi() };
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = apiMod.current;
    render(<App />);
    // Scope assertions to the section-view subtree so file-tree text
    // ("§ 1.1", "Definitions") doesn't collide with the section header.
    const sectionView = await screen.findByTestId("section-view");
    await waitFor(() => {
      expect(within(sectionView).getByText("§ 1.1")).toBeInTheDocument();
    });
    expect(within(sectionView).getByText("Definitions")).toBeInTheDocument();

    // Switch the read mock to ok:false BEFORE clicking § 1.2 so the next
    // read fails.
    const readMock = apiMod.current.corpus.read as ReturnType<typeof vi.fn>;
    readMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", detail: "Section 1.2 not found in module sf-port" },
    });

    const row12 = await screen.findByTestId("tree-row-sf-port::1.2");
    fireEvent.click(row12);

    // Banner appears with the error detail.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Couldn't load this section")).toBeInTheDocument();
    expect(screen.getByText(/Section 1.2 not found in module sf-port/)).toBeInTheDocument();

    // C7: stale chrome inside the section view is gone — the previous
    // § 1.1 / Definitions header text should not remain inside the
    // section-view subtree (it stays in the file-tree, which is correct).
    const sectionViewAfter = screen.getByTestId("section-view");
    expect(within(sectionViewAfter).queryByText("§ 1.1")).toBeNull();
    expect(within(sectionViewAfter).queryByText("Definitions")).toBeNull();
    // Breadcrumb's active label slot is empty — no section label.
    const breadcrumb = screen.getByTestId("breadcrumb");
    expect(within(breadcrumb).queryByText(/§ 1\./)).toBeNull();
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

describe("App — tab strip integration (feat/tabs)", () => {
  beforeEach(() => {
    __resetVisibleRowsCache();
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApi();
  });

  it("cold-start hydrates persisted tabs into the strip + activates the persisted index", async () => {
    window.localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [
          { kind: "section", ref: { module: "sf-port", section: "1.1" } },
          { kind: "section", ref: { module: "sf-port", section: "1.2" } },
        ],
        activeIndex: 1,
      }),
    );
    render(<App />);
    await waitFor(() => {
      const tabs = screen.getAllByRole("tab");
      // 1 activity-bar tab + 2 section tabs.
      expect(tabs.length).toBeGreaterThanOrEqual(3);
    });
    // The section tab list lives under aria-label="Open sections".
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    expect(within(sectionList).getAllByRole("tab")).toHaveLength(2);
    const activeTab = within(sectionList)
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true");
    expect(activeTab).toBeDefined();
    expect(activeTab?.textContent).toContain("1.2");
  });

  it("FileTree.onActivate opens a section as a new tab in the strip", async () => {
    render(<App />);
    await screen.findByTestId("section-view");
    // Click § 1.2 in the tree.
    const row12 = await screen.findByTestId("tree-row-sf-port::1.2");
    fireEvent.click(row12);
    await waitFor(() => {
      const sectionList = screen.getByRole("tablist", { name: "Open sections" });
      const tabs = within(sectionList).getAllByRole("tab");
      expect(tabs).toHaveLength(2);
    });
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    const tabs = within(sectionList).getAllByRole("tab");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("cmd+click on a tree row opens a tab in background (active does NOT switch)", async () => {
    render(<App />);
    await screen.findByTestId("section-view");
    const row12 = await screen.findByTestId("tree-row-sf-port::1.2");
    // Cmd+click → openItemWithoutSwitching.
    fireEvent.click(row12, { metaKey: true });
    await waitFor(() => {
      const sectionList = screen.getByRole("tablist", { name: "Open sections" });
      expect(within(sectionList).getAllByRole("tab")).toHaveLength(2);
    });
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    const tabs = within(sectionList).getAllByRole("tab");
    // Active is still the first tab (§ 1.1) — background open didn't switch.
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("persisted-empty {items:[], activeIndex:null} renders empty state (A7 / codex F2)", async () => {
    // Pre-populate localStorage with an explicit empty list. App must
    // respect that — NOT re-seed defaultRef.
    window.localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({ items: [], activeIndex: null }),
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("No section open")).toBeInTheDocument();
    });
    // No tab strip rendered.
    expect(screen.queryByRole("tablist", { name: "Open sections" })).toBeNull();
    // corpus.read MUST NOT have been called — no active section to load.
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    // Wait a tick for any pending effects.
    await new Promise((r) => setTimeout(r, 50));
    expect(readMock).not.toHaveBeenCalled();
  });

  it("persisted-with-items-all-invalidated re-seeds defaultRef (codex review #1)", async () => {
    // Simulate a corpus upgrade: persisted refs that no longer resolve
    // against the new tree. The original A7 split treated this case the
    // same as "explicitly empty," landing on a blank workbench. Fix:
    // distinguish — only preserve emptiness when persisted itself was
    // explicitly empty; an invalidation seeds the default instead.
    window.localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [{ kind: "section", ref: { module: "sf-port", section: "old-renumbered-id" } }],
        activeIndex: 0,
      }),
    );
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    // Defaultref is sf-port::1.1 — the seed must fire.
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    // The tab strip renders the seeded ref, not the stale one.
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    expect(within(sectionList).getAllByRole("tab")).toHaveLength(1);
  });

  it("⌘P inside the open palette closes it (codex review #2 — fallthrough fix)", async () => {
    render(<App />);
    // Open the palette first.
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Go to section/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/Go to section/) as HTMLInputElement;
    input.focus();
    // Active element is the palette input — the shared global-shortcut
    // guard would suppress; the fix bypasses the guard for ⌘P only.
    expect(document.activeElement).toBe(input);
    // Second ⌘P must toggle the palette closed AND preventDefault so
    // Electron's print dialog doesn't fall through. Capture the event
    // to assert preventDefault was called.
    let captured: Event | null = null;
    const probe = (e: Event) => {
      captured = e;
    };
    window.addEventListener("keydown", probe, true);
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    window.removeEventListener("keydown", probe, true);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Go to section/)).toBeNull();
    });
    expect(captured).not.toBeNull();
    expect((captured as unknown as Event).defaultPrevented).toBe(true);
  });
});
