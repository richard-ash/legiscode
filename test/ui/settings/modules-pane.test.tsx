// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../../electron/ipc/contract";
import { ModulesPane } from "@/ui/settings/modules-pane";

function setApi(partial: Partial<Api["modules"]>) {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (window as any).api = { modules: partial } as Api;
}

describe("ModulesPane", () => {
  it("renders loading state before the promise resolves", () => {
    setApi({ list: vi.fn().mockReturnValue(new Promise(() => {})) });
    render(<ModulesPane />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders an error state when the IPC call rejects", async () => {
    setApi({ list: vi.fn().mockRejectedValue(new Error("IPC transport error")) });
    render(<ModulesPane />);
    await waitFor(() => {
      expect(screen.getByText("IPC transport error")).toBeInTheDocument();
    });
  });

  it("renders empty state when no modules are installed", async () => {
    setApi({ list: vi.fn().mockResolvedValue({ ok: true, value: [] }) });
    render(<ModulesPane />);
    await waitFor(() => {
      expect(screen.getByText(/No law packages are installed/)).toBeInTheDocument();
    });
  });

  it("renders installed modules with name, section count, and version", async () => {
    setApi({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            id: "sf-port",
            name: "San Francisco Port Code",
            jurisdiction: "City and County of San Francisco",
            module_version: "2026.04.01",
            schema_version: 3,
            section_count: 42,
          },
        ],
      }),
    });
    render(<ModulesPane />);
    await waitFor(() => {
      expect(screen.getByText("San Francisco Port Code")).toBeInTheDocument();
      expect(screen.getByText(/42 sections/)).toBeInTheDocument();
      expect(screen.getByText(/v2026\.04\.01/)).toBeInTheDocument();
      expect(screen.getByText("City and County of San Francisco")).toBeInTheDocument();
    });
  });

  it("renders an error state when modules:list fails", async () => {
    setApi({
      list: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: "not_loaded", detail: "Corpus not loaded." },
      }),
    });
    render(<ModulesPane />);
    await waitFor(() => {
      expect(screen.getByText("Corpus not loaded.")).toBeInTheDocument();
    });
  });
});
