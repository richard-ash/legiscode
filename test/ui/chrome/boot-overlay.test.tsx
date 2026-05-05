// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BootOverlay } from "../../../src/ui/chrome/boot-overlay";

describe("BootOverlay — crash variant (A17)", () => {
  it("shows the crash title + Reload + Copy diagnostic actions", () => {
    render(<BootOverlay variant="crash" onReload={() => {}} onCopyDiagnostic={() => {}} />);
    expect(screen.getByRole("heading", { name: /App crashed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reload/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy diagnostic info/ })).toBeInTheDocument();
  });

  it("Reload button invokes onReload", async () => {
    const onReload = vi.fn();
    render(<BootOverlay variant="crash" onReload={onReload} onCopyDiagnostic={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Reload/ }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe("BootOverlay — corpus variant (A17)", () => {
  it("shows the corpus title + provided detail + Copy Diagnostic + Quit", () => {
    render(
      <BootOverlay
        variant="corpus"
        error={{ kind: "not_loaded", detail: "Corpus directory not found at /tmp/missing" }}
        onCopyDiagnostic={() => {}}
        onQuit={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: /Corpus failed to load/ })).toBeInTheDocument();
    expect(screen.getByText(/Corpus directory not found at \/tmp\/missing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy Diagnostic/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quit/ })).toBeInTheDocument();
  });

  it("Quit button invokes onQuit", async () => {
    const onQuit = vi.fn();
    render(
      <BootOverlay
        variant="corpus"
        error={{ kind: "corrupt", detail: "x" }}
        onCopyDiagnostic={() => {}}
        onQuit={onQuit}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Quit/ }));
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});
