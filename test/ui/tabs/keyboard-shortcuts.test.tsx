// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useTabKeyboardShortcuts } from "@/ui/tabs/keyboard-shortcuts";
import { emptyOpenItems, type OpenItemsState, openItem } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC } from "./helpers";

interface HostProps {
  initial: OpenItemsState;
  onState?: (s: OpenItemsState) => void;
  closeActive: () => void;
  reopenLast: () => void;
}

function Host({ initial, onState, closeActive, reopenLast }: HostProps) {
  const [state, setState] = useState<OpenItemsState>(initial);
  useTabKeyboardShortcuts({
    openItems: state,
    setOpenItems: (update) => {
      setState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        if (onState) onState(next);
        return next;
      });
    },
    closeActive,
    reopenLast,
  });
  return <div data-testid="host" />;
}

describe("useTabKeyboardShortcuts — number jumps", () => {
  it("⌘1..⌘9 sets activeIndex by digit (1-based, 9 → last)", () => {
    const states: OpenItemsState[] = [];
    render(
      <Host
        initial={makeStateWithRefs([refA, refB, refC])}
        onState={(s) => states.push(s)}
        closeActive={() => {}}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(states.at(-1)?.activeIndex).toBe(0);
    fireEvent.keyDown(window, { key: "9", metaKey: true });
    expect(states.at(-1)?.activeIndex).toBe(2);
  });
});

describe("useTabKeyboardShortcuts — ⌘W / ⌘shift+T", () => {
  it("⌘W invokes closeActive", () => {
    const closeActive = vi.fn();
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        closeActive={closeActive}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeActive).toHaveBeenCalledTimes(1);
  });

  it("⌘shift+T invokes reopenLast", () => {
    const reopenLast = vi.fn();
    render(
      <Host initial={makeStateWithRefs([refA])} closeActive={() => {}} reopenLast={reopenLast} />,
    );
    fireEvent.keyDown(window, { key: "T", metaKey: true, shiftKey: true });
    expect(reopenLast).toHaveBeenCalledTimes(1);
  });
});

describe("useTabKeyboardShortcuts — ⌘PageDown / ⌘PageUp wrap", () => {
  it("⌘PageDown wraps from last to first", () => {
    const states: OpenItemsState[] = [];
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        onState={(s) => states.push(s)}
        closeActive={() => {}}
        reopenLast={() => {}}
      />,
    );
    // refB is active (idx 1, last). PageDown wraps to idx 0.
    fireEvent.keyDown(window, { key: "PageDown", metaKey: true });
    expect(states.at(-1)?.activeIndex).toBe(0);
  });

  it("⌘PageUp wraps from first to last", () => {
    const initial = openItem(openItem(emptyOpenItems(), refA), refB);
    // Switch to idx 0.
    const states: OpenItemsState[] = [];
    render(
      <Host
        initial={{ ...initial, activeIndex: 0 }}
        onState={(s) => states.push(s)}
        closeActive={() => {}}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "PageUp", metaKey: true });
    expect(states.at(-1)?.activeIndex).toBe(1);
  });
});

describe("useTabKeyboardShortcuts — F-palette regression", () => {
  it("⌘1 does NOT switch tabs when focus is inside a role=dialog", () => {
    const states: OpenItemsState[] = [];
    // Build a fake palette dialog with a focused input.
    function App() {
      return (
        <>
          <Host
            initial={makeStateWithRefs([refA, refB, refC])}
            onState={(s) => states.push(s)}
            closeActive={() => {}}
            reopenLast={() => {}}
          />
          <div role="dialog" aria-label="Palette">
            <input data-testid="palette-input" />
          </div>
        </>
      );
    }
    render(<App />);
    const input = screen.getByTestId("palette-input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "1", metaKey: true });
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    // No state change — the shouldHandleGlobalShortcut guard short-circuits
    // both inside-dialog AND inside-input branches.
    expect(states).toHaveLength(0);
  });

  it("⌘W does NOT close when focus is inside a text input", () => {
    const closeActive = vi.fn();
    function App() {
      return (
        <>
          <Host
            initial={makeStateWithRefs([refA])}
            closeActive={closeActive}
            reopenLast={() => {}}
          />
          <input data-testid="text-input" />
        </>
      );
    }
    render(<App />);
    const input = screen.getByTestId("text-input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "w", metaKey: true });
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeActive).not.toHaveBeenCalled();
  });
});
