// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShortcut } from "@/ui/shortcuts/use-shortcut";

afterEach(() => {
  document.body.innerHTML = "";
});

function press(init: KeyboardEventInit) {
  fireEvent.keyDown(window, init);
}

describe("useShortcut", () => {
  it("fires on the catalog binding and not on others", () => {
    const cb = vi.fn();
    renderHook(() => useShortcut("global.toggle-left-panel", cb));
    press({ key: "b", metaKey: true });
    expect(cb).toHaveBeenCalledTimes(1);
    press({ key: "b" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire when focus is inside an input (global guard)", () => {
    const cb = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    renderHook(() => useShortcut("global.toggle-left-panel", cb));
    press({ key: "b", metaKey: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("respects exact-modifier matching from the catalog (⌘⌥B ≠ ⌘B)", () => {
    const left = vi.fn();
    const right = vi.fn();
    renderHook(() => useShortcut("global.toggle-left-panel", left));
    renderHook(() => useShortcut("global.toggle-right-panel", right));
    press({ key: "b", metaKey: true, altKey: true });
    expect(right).toHaveBeenCalledTimes(1);
    expect(left).not.toHaveBeenCalled();
  });

  it("cleans up its listener on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useShortcut("global.toggle-left-panel", cb));
    unmount();
    press({ key: "b", metaKey: true });
    expect(cb).not.toHaveBeenCalled();
  });
});
