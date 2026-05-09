// @vitest-environment jsdom
//
// C11 lock — toggle in Settings dropdown writes the
// --section-line-height-mult CSS variable on <html> and persists to
// localStorage under the legiscode.section.lineHeightMult key. The CSS
// rule in section-view.css does the actual layout swap; this test just
// pins the var-write behaviour.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLineHeightMult } from "@/app/section-line-height";
import { SettingsDropdown } from "@/ui/chrome/settings-dropdown";

describe("Settings dropdown — line-height multiplier (C11)", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--section-line-height-mult");
    window.localStorage.clear();
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--section-line-height-mult");
    window.localStorage.clear();
  });

  it("clicking 1.7× sets the CSS variable on <html>", () => {
    render(<SettingsDropdown open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("1.7×"));
    expect(document.documentElement.style.getPropertyValue("--section-line-height-mult")).toBe(
      "1.7",
    );
  });

  it("clicking 1× resets the CSS variable to 1", () => {
    render(<SettingsDropdown open onClose={() => {}} />);
    // Flip to 1.7 first, then back.
    fireEvent.click(screen.getByLabelText("1.7×"));
    fireEvent.click(screen.getByLabelText("1×"));
    expect(document.documentElement.style.getPropertyValue("--section-line-height-mult")).toBe("1");
  });

  it("persists the multiplier to localStorage so it survives reloads", () => {
    render(<SettingsDropdown open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("1.7×"));
    expect(window.localStorage.getItem("legiscode.section.lineHeightMult")).toBe("1.7");
  });

  it("imperative setLineHeightMult also updates the CSS variable", () => {
    setLineHeightMult("1.7");
    expect(document.documentElement.style.getPropertyValue("--section-line-height-mult")).toBe(
      "1.7",
    );
  });
});
