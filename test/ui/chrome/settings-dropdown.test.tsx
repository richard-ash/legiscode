// @vitest-environment jsdom
/// <reference lib="dom" />
//
// Codex review #5 (P3) — Escape with focus on a dropdown radio still
// closes. The shared global-shortcut guard short-circuits when focus is
// on an HTMLInputElement (which radios are), so changing theme or
// line-height and then pressing Escape used to leave the dropdown stuck
// open. Fix applies only the dialog-check (palette-stacked-on-top still
// owns Escape), not the typing-surface checks.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDropdown } from "@/ui/chrome/settings-dropdown";

describe("SettingsDropdown — Escape handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Escape closes the dropdown even when focus is on a radio input", () => {
    const onClose = vi.fn();
    render(<SettingsDropdown open onClose={onClose} />);
    // The keydown listener is attached via setTimeout(_, 0); flush it.
    vi.advanceTimersByTime(1);

    const darkRadio = screen.getByLabelText("Dark") as HTMLInputElement;
    darkRadio.focus();
    expect(document.activeElement).toBe(darkRadio);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("defers to a stacked palette (role=dialog) — palette owns Escape", () => {
    const onClose = vi.fn();
    // Sibling palette dialog with a focused input inside.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogInput = document.createElement("input");
    dialog.appendChild(dialogInput);
    document.body.appendChild(dialog);

    render(<SettingsDropdown open onClose={onClose} />);
    vi.advanceTimersByTime(1);

    dialogInput.focus();
    expect(document.activeElement).toBe(dialogInput);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    document.body.removeChild(dialog);
  });

  it("non-Escape keys are ignored (no spurious close on radio keypress)", () => {
    const onClose = vi.fn();
    render(<SettingsDropdown open onClose={onClose} />);
    vi.advanceTimersByTime(1);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: " " });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
