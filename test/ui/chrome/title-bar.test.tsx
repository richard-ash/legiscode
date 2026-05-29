// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TitleBar } from "../../../src/ui/chrome/title-bar";

describe("TitleBar — Phase-1 chrome trim", () => {
  it("renders brand mark + workspace chip + settings", () => {
    render(
      <TitleBar
        workspaceLabel="SF Municipal Code"
        fileLabel="§ 1.4 — Definitions"
        onOpenPalette={() => {}}
        onOpenShortcuts={() => {}}
      />,
    );
    expect(screen.getByText("LegisCode")).toBeInTheDocument();
    expect(screen.getByText("SF Municipal Code")).toBeInTheDocument();
    expect(screen.getByLabelText("Settings")).toBeInTheDocument();
  });

  it("does NOT render the sync indicator (A15)", () => {
    render(
      <TitleBar
        workspaceLabel="X"
        fileLabel=""
        onOpenPalette={() => {}}
        onOpenShortcuts={() => {}}
      />,
    );
    expect(screen.queryByText(/Last sync/)).not.toBeInTheDocument();
  });

  it("does NOT render Bell or Share buttons (A16)", () => {
    render(
      <TitleBar
        workspaceLabel="X"
        fileLabel=""
        onOpenPalette={() => {}}
        onOpenShortcuts={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Notifications")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Share")).not.toBeInTheDocument();
  });

  it("workspace chip click invokes onOpenPalette (⌘P entry)", async () => {
    const onOpenPalette = vi.fn();
    render(
      <TitleBar
        workspaceLabel="X"
        fileLabel=""
        onOpenPalette={onOpenPalette}
        onOpenShortcuts={() => {}}
      />,
    );
    await userEvent.click(screen.getByLabelText(/Open section finder/));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("Settings button toggles the dropdown open state", async () => {
    render(
      <TitleBar
        workspaceLabel="X"
        fileLabel=""
        onOpenPalette={() => {}}
        onOpenShortcuts={() => {}}
      />,
    );
    const button = screen.getByLabelText("Settings");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Settings" })).toBeInTheDocument();
  });
});
