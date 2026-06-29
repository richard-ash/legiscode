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

function aiStub(): Api["ai"] {
  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const settings = {
    active_provider: "anthropic" as const,
    model: "claude-sonnet-4-5",
    telemetry_enabled: false,
    available_models: [] as readonly string[],
    has_active_provider_key: false,
    session_usage: zeroUsage,
  };
  return {
    query: vi.fn().mockResolvedValue({
      ok: true,
      chat_id: "c",
      turn_id: 1,
      text: "",
      usage: zeroUsage,
      stop_reason: "end_turn",
    }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    hasApiKey: vi.fn().mockResolvedValue({ has_key: false }),
    setApiKey: vi.fn().mockResolvedValue({ ok: true }),
    clearApiKey: vi.fn().mockResolvedValue({ ok: true }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
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
          definitions: [],
          sessionBills: { count: 0, bills: [], classBMeta: [] },
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
    shell: { openExternal: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
    ai: aiStub(),
    modules: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
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
  definitions: [],
  sessionBills: { count: 0, bills: [], classBMeta: [] },
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
            display_label: req.sectionId,
            title: req.sectionId === "1.1" ? "Definitions" : "Commission",
            text: "",
            citations: [],
            defined_terms: [],
            hierarchy: ["Port Code", "ARTICLE 1"],
            editorial_status: "active" as const,
            body: [],
            article: null,
          },
          parents: [{ code: "Port Code", name: "", sectionId: null }],
          prev: null,
          next: null,
          definitions: {},
        },
      })),
    },
    app: { ping: vi.fn().mockResolvedValue({ pong: 1 }) },
    shell: { openExternal: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
    ai: aiStub(),
    modules: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
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

  it("cold-start guard: never restores a Settings tab as the active tab", async () => {
    // Persisted state where Settings was the active tab last session. The
    // app must boot into law, not settings — Settings stays open but the
    // default section becomes active.
    window.localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [{ kind: "settings", section: "shortcuts" }],
        activeIndex: 0,
      }),
    );
    render(<App />);
    const sectionList = await screen.findByRole("tablist", { name: "Open sections" });
    await waitFor(() => {
      expect(within(sectionList).getAllByRole("tab").length).toBe(2);
    });
    const tabs = within(sectionList).getAllByRole("tab");
    const activeTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(activeTab?.textContent).not.toContain("Settings");
    // The Settings tab is still present, just not active.
    const settingsTab = tabs.find((t) => t.textContent?.includes("Settings"));
    expect(settingsTab).toBeDefined();
    expect(settingsTab?.getAttribute("aria-selected")).toBe("false");
  });

  it("cold-start guard: invalidated active section + surviving Settings tab boots into law", async () => {
    // Regression: persisted active section gets dropped by corpus
    // validation (renumbered ref), but a Settings tab survives. That
    // leaves items=[settings], activeIndex=null — non-empty, so the seed
    // doesn't fire, and activeItem is null, so the old settings-only guard
    // didn't fire either. The app must still boot into the default section.
    window.localStorage.setItem(
      "legiscode.openItems",
      JSON.stringify({
        items: [
          { kind: "section", ref: { module: "sf-port", section: "renumbered-away" } },
          { kind: "settings", section: "shortcuts" },
        ],
        activeIndex: 0,
      }),
    );
    render(<App />);
    const sectionList = await screen.findByRole("tablist", { name: "Open sections" });
    await waitFor(() => {
      expect(within(sectionList).getAllByRole("tab").length).toBe(2);
    });
    const tabs = within(sectionList).getAllByRole("tab");
    const activeTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(activeTab).toBeDefined();
    expect(activeTab?.textContent).not.toContain("Settings");
  });

  it("⌘, opens a Settings tab from a fresh start and makes it active", async () => {
    // The cold-start guards above cover restoring a persisted Settings tab.
    // This covers the other direction: pressing ⌘, with no Settings tab open
    // routes through useShortcut("global.open-settings") and opens one.
    render(<App />);
    const sectionList = await screen.findByRole("tablist", { name: "Open sections" });
    await waitFor(() => {
      expect(within(sectionList).getAllByRole("tab").length).toBeGreaterThanOrEqual(1);
    });
    expect(
      within(sectionList)
        .getAllByRole("tab")
        .some((t) => t.textContent?.includes("Settings")),
    ).toBe(false);

    fireEvent.keyDown(window, { key: ",", metaKey: true });

    await waitFor(() => {
      const settingsTab = within(sectionList)
        .getAllByRole("tab")
        .find((t) => t.textContent?.includes("Settings"));
      expect(settingsTab).toBeDefined();
      expect(settingsTab?.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("clicking a file-tree row opens a section as a new tab in the strip", async () => {
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

  it("IRON RULE: ⌘B with the palette OPEN does NOT collapse the panel (F-palette regression)", async () => {
    // The original bug was three competing window-keydown handlers
    // (App.tsx, three-panel.tsx, file-tree onKeyDown) with no focus-trap
    // coordination — ⌘B with the palette open would fire ThreePanel's
    // toggle under the open dialog. The fix landed in
    // `should-handle-shortcut.ts` (`target.closest("[role=dialog]")`
    // returns false + the input-focus check). This test defends both
    // checks against future removal: if either is dropped, the ⌘B
    // handler runs to completion and calls preventDefault, which the
    // probe catches.
    //
    // Codex F12 argued this was test bloat already covered at the hook
    // layer. Pushed back: the hook test verifies the guard's CONTRACT;
    // this integration test verifies the call sites in
    // three-panel.tsx and file-tree.tsx are actually wired to it.
    // Different failure mode — keep the test (IRON RULE).
    render(<App />);
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Go to section/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/Go to section/) as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    // Capture ⌘B at window level so we can assert the ThreePanel
    // handler did NOT call preventDefault (which it would if the
    // guard were removed and the handler ran to completion).
    let captured: Event | null = null;
    const probe = (e: Event) => {
      captured = e;
    };
    window.addEventListener("keydown", probe, true);
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    window.removeEventListener("keydown", probe, true);
    expect(captured).not.toBeNull();
    // Guard fired → handler returned early → no preventDefault.
    // (If this flips to true, the guard regressed and ⌘B can again
    // collapse the panel under an open palette.)
    expect((captured as unknown as Event).defaultPrevented).toBe(false);
    // Palette is still open (extra belt-and-suspenders — the dialog
    // never received the ⌘B as something to act on).
    expect(screen.getByPlaceholderText(/Go to section/)).toBeInTheDocument();
  });
});

// ─── T7 citation dispatch — App.tsx wires resolve() → navigate() ──────────
//
// Section views fire `onCitationActivate(citation, intent)` on a delegated
// click. App.tsx builds a `CorpusExistence` oracle from `titleMap`, calls
// `resolve(citation, existence)`, and dispatches based on the result kind:
// internal/cross_module → `navigate({kind:"section", ...}, intent)`, external
// (URL-synthesizable) → `navigate({kind:"external-citation", ...}, intent)`.
// Unresolvable + appendix + null-URL external all log+skip without surfacing
// UI today.

function buildPopulatedApiWithCitations(
  sectionBodies: Record<string, { body: unknown[]; citations: unknown[] }>,
): Api {
  return {
    corpus: {
      list: vi.fn().mockResolvedValue({ ok: true, value: populatedCorpus }),
      read: vi.fn(async (req: { moduleId: string; sectionId: string }) => {
        const override = sectionBodies[req.sectionId];
        return {
          ok: true as const,
          value: {
            moduleId: req.moduleId,
            section: {
              kind: "section" as const,
              id: req.sectionId,
              display_label: req.sectionId,
              title: req.sectionId === "1.1" ? "Definitions" : "Commission",
              text: "",
              // biome-ignore lint/suspicious/noExplicitAny: test fixture shape passthrough
              citations: (override?.citations ?? []) as any,
              defined_terms: [],
              hierarchy: ["Port Code", "ARTICLE 1"],
              editorial_status: "active" as const,
              // biome-ignore lint/suspicious/noExplicitAny: test fixture shape passthrough
              body: (override?.body ?? []) as any,
              article: null,
            },
            parents: [{ code: "Port Code", name: "", sectionId: null }],
            prev: null,
            next: null,
            definitions: {},
          },
        };
      }),
    },
    app: { ping: vi.fn().mockResolvedValue({ pong: 1 }) },
    shell: { openExternal: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
    ai: aiStub(),
    modules: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
  };
}

describe("App — citation dispatch (T7)", () => {
  beforeEach(() => {
    __resetVisibleRowsCache();
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApiWithCitations({
      "1.1": {
        citations: [{ display_text: "§ 1.2", target: { kind: "internal", section_id: "1.2" } }],
        body: [
          { kind: "text", text: "see " },
          { kind: "citation", raw: "§ 1.2", citation_index: 0 },
        ],
      },
    });
  });

  it("plain click on an internal citation does NOT navigate (VS Code semantics: selection only)", async () => {
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    const link = await waitFor(() => {
      const a = document.querySelector("span.lc-cite") as HTMLSpanElement | null;
      if (!a) throw new Error("citation span not yet rendered");
      return a;
    });
    fireEvent.click(link);
    await new Promise((r) => setTimeout(r, 50));
    expect(readMock).not.toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.2" });
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    const tabs = within(sectionList).getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toContain("1.1");
  });

  it("Cmd-click on an internal citation opens the target in a new foreground tab", async () => {
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    const link = await waitFor(() => {
      const a = document.querySelector("span.lc-cite") as HTMLSpanElement | null;
      if (!a) throw new Error("citation span not yet rendered");
      return a;
    });
    fireEvent.click(link, { metaKey: true });
    // Primary intent → 2 tabs, foreground switched to 1.2.
    await waitFor(() => {
      const sectionList = screen.getByRole("tablist", { name: "Open sections" });
      expect(within(sectionList).getAllByRole("tab")).toHaveLength(2);
    });
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    const tabs = within(sectionList).getAllByRole("tab");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.textContent).toContain("1.1");
    expect(tabs[1]?.textContent).toContain("1.2");
  });

  it("Cmd-click on a cross_module citation into an uninstalled module is a no-op", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApiWithCitations({
      "1.1": {
        citations: [
          {
            display_text: "Cal. Veh. Code § 21",
            target: { kind: "cross_module", module_id: "ca-vehicle", section_id: "21" },
          },
        ],
        body: [{ kind: "citation", raw: "Cal. Veh. Code § 21", citation_index: 0 }],
      },
    });
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    const link = await waitFor(() => {
      const a = document.querySelector("span.lc-cite") as HTMLSpanElement | null;
      if (!a) throw new Error("citation span not yet rendered");
      return a;
    });
    fireEvent.click(link, { metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    // No new tab; ⌘-click on a not-installed module is a popover-only flow.
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    expect(within(sectionList).getAllByRole("tab")).toHaveLength(1);
  });

  it("Cmd-click on an unresolvable (vague) citation is a safe no-op — no tab change", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApiWithCitations({
      "1.1": {
        citations: [
          {
            display_text: "see related rules",
            target: { kind: "vague", raw: "see related rules" },
          },
        ],
        body: [{ kind: "citation", raw: "see related rules", citation_index: 0 }],
      },
    });
    // Phase 3 — unresolvable was warn-level; promoted to error-level so
    // dev catches the should-never-fire path under the Phase 4 gate.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });
    const link = await waitFor(() => {
      const a = document.querySelector("span.lc-cite") as HTMLSpanElement | null;
      if (!a) throw new Error("citation span not yet rendered");
      return a;
    });
    fireEvent.click(link, { metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    const sectionList = screen.getByRole("tablist", { name: "Open sections" });
    expect(within(sectionList).getAllByRole("tab")).toHaveLength(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("unresolvable"));
    err.mockRestore();
  });

  it("subsection citation triggers a scrollTop write on the target section's container (P1.3)", async () => {
    // Codex review caught: useNavigation's `subsection` history field
    // was recorded but never consumed — clicking § 1.2(b) flipped to
    // § 1.2 but never scrolled into the (b) anchor. This test pins the
    // wiring by spying on every scrollTop assignment on the scroll
    // container. useRestoreScroll fires one scrollTop write on every
    // section flip (restoring saved position); the new pending-scroll
    // consumer fires a second write when the target section's body
    // contains a matching `lc-sub-{label}` anchor. Asserting on the
    // second write (against a baseline of one) catches the
    // "consumer removed" regression without depending on layout math
    // jsdom can't simulate.
    //
    // Strategy: render App, capture the .lc-doc.lc-scroll element after
    // cold-start render, override its scrollTop accessor to count
    // writes, then click the subsection citation. The unit-tested
    // pendingScroll state proves the right TARGET is computed; this
    // test proves the App's effect ACTS on it.
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (window as any).api = buildPopulatedApiWithCitations({
      "1.1": {
        citations: [
          {
            display_text: "§ 1.2(b)",
            target: { kind: "internal", section_id: "1.2", subsection: "(b)" },
          },
        ],
        body: [
          { kind: "text", text: "see " },
          { kind: "citation", raw: "§ 1.2(b)", citation_index: 0 },
        ],
      },
      "1.2": {
        citations: [],
        body: [
          { kind: "text", text: "Lead text. " },
          { kind: "subsection_label", label: "(b)" },
          { kind: "text", text: " Subsection content." },
        ],
      },
    });
    render(<App />);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const readMock = (window as any).api.corpus.read as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.1" });
    });

    // Once the scroll container has mounted, install a scrollTop spy on
    // its instance. This survives subsequent renders because the
    // callback ref hands the same element back to setScrollEl. Reading
    // the property has to return *something* so React's effect that
    // computes `scrollEl.scrollTop + delta` doesn't blow up.
    const scrollEl = await waitFor(() => {
      const el = document.querySelector(".lc-doc.lc-scroll") as HTMLElement | null;
      if (!el) throw new Error("scroll container not yet mounted");
      return el;
    });
    let scrollTopWrites = 0;
    let internalScrollTop = 0;
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => internalScrollTop,
      set: (v: number) => {
        scrollTopWrites += 1;
        internalScrollTop = v;
      },
    });

    // Reset before the click so we count writes triggered by this
    // navigation only (the initial cold-start renders may have written
    // before the spy was installed).
    scrollTopWrites = 0;

    const link = await waitFor(() => {
      const a = document.querySelector("span.lc-cite") as HTMLSpanElement | null;
      if (!a) throw new Error("citation span not yet rendered");
      return a;
    });
    fireEvent.click(link, { metaKey: true });

    // Wait for the corpus read for § 1.2 (the target section).
    await waitFor(() => {
      expect(readMock).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.2" });
    });
    // The (b) anchor must mount so the consumer's querySelector lands
    // on a real element rather than null (null → consumer clears
    // pending but does not write scrollTop).
    await waitFor(() => {
      expect(document.getElementById("lc-sub-(b)")).not.toBeNull();
    });

    // Two scrollTop writes expected: 1 from useRestoreScroll (restoring
    // saved scroll for §1.2 — defaults to 0), 1 from the pending-scroll
    // consumer landing on `#lc-sub-(b)`. If the consumer is ever
    // removed, this drops to 1 and the test fails.
    await waitFor(() => {
      expect(scrollTopWrites).toBeGreaterThanOrEqual(2);
    });
  });
});
