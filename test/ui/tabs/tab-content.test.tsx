// @vitest-environment jsdom
//
// Covers TabContent's routing seam. Each kind gets one focused
// assertion — the per-viewer behaviors live in their own test files
// (section-view/, external-viewer/) so this layer only verifies "the
// switch lands on the right component."

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../../electron/ipc/contract";
import { parse as parseRef } from "../../../src/corpus/refs";
import { TabContent } from "../../../src/ui/tabs/tab-content";
import type { OpenItem } from "../../../src/workbench/open-items";

declare global {
  interface Window {
    api: Api;
  }
}

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: writable global setter for test fixture
  (window as any).api = {
    corpus: { list: vi.fn(), read: vi.fn() },
    app: { ping: vi.fn() },
    shell: { openExternal: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TabContent — routing", () => {
  it("section kind → SectionView with role=tabpanel wrapper", () => {
    const item: OpenItem = {
      kind: "section",
      ref: parseRef({ module: "sf-port", section: "1.1" }),
    };
    render(
      <TabContent
        item={item}
        section={null}
        sectionError={null}
        parentsLabel=""
        navigate={vi.fn()}
      />,
    );
    // Route asserted via the tabpanel id prefix; SectionView's internal
    // branches (placeholder / loaded / error) are covered separately in
    // test/ui/center-panel/section-view/.
    expect(screen.getByRole("tabpanel").id).toMatch(/^tabpanel-section:/);
  });

  it("settings kind → SettingsPage with role=tabpanel wrapper", () => {
    const item: OpenItem = { kind: "settings", section: "shortcuts" };
    render(
      <TabContent
        item={item}
        section={null}
        sectionError={null}
        parentsLabel=""
        navigate={vi.fn()}
      />,
    );
    expect(screen.getByRole("tabpanel").id).toBe("tabpanel-settings::shortcuts");
    expect(screen.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
  });

  it("chat kind → null (placeholder until feat/ai-agent)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const item: OpenItem = { kind: "chat", chatId: "thread-1" };
    const { container } = render(
      <TabContent
        item={item}
        section={null}
        sectionError={null}
        parentsLabel=""
        navigate={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    warn.mockRestore();
  });
});
