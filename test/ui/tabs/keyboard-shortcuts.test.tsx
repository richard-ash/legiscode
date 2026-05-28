// @vitest-environment jsdom
/// <reference lib="dom" />

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabKeyboardShortcuts } from "@/ui/tabs/keyboard-shortcuts";
import { emptyOpenItems, type OpenItemsState, openItem } from "@/workbench/open-items";
import { makeStateWithRefs, refA, refB, refC } from "./helpers";

interface HostProps {
  initial: OpenItemsState;
  onState?: (s: OpenItemsState) => void;
  closeActive: () => void;
  closeAll?: () => void;
  reopenLast: () => void;
}

function Host({ initial, onState, closeActive, closeAll, reopenLast }: HostProps) {
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
    closeAll: closeAll ?? (() => {}),
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

describe("useTabKeyboardShortcuts — exact-modifier normalization", () => {
  // The old handlers were tolerant of stray modifiers: ⌘PageUp/PageDown
  // ignored Shift/Alt, and ⌘⇧T ignored a stray Alt. The catalog refactor
  // matches exactly (cmd-only / cmd+shift). These assert the deliberate
  // tightening so it can't regress silently.
  it("⌘⇧PageDown does NOT cycle (cmd-only required)", () => {
    const states: OpenItemsState[] = [];
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        onState={(s) => states.push(s)}
        closeActive={() => {}}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "PageDown", metaKey: true, shiftKey: true });
    expect(states).toHaveLength(0);
  });

  it("⌘⌥PageUp does NOT cycle (cmd-only required)", () => {
    const states: OpenItemsState[] = [];
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        onState={(s) => states.push(s)}
        closeActive={() => {}}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "PageUp", metaKey: true, altKey: true });
    expect(states).toHaveLength(0);
  });

  it("⌘⌥⇧T does NOT reopen (cmd+shift only, no Alt)", () => {
    const reopenLast = vi.fn();
    render(
      <Host initial={makeStateWithRefs([refA])} closeActive={() => {}} reopenLast={reopenLast} />,
    );
    fireEvent.keyDown(window, { key: "T", metaKey: true, shiftKey: true, altKey: true });
    expect(reopenLast).not.toHaveBeenCalled();
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

describe("useTabKeyboardShortcuts — ⌘K W chord (closeAll)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⌘K alone is a no-op (does not fire any handler)", () => {
    const closeActive = vi.fn();
    const closeAll = vi.fn();
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        closeActive={closeActive}
        closeAll={closeAll}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(closeActive).not.toHaveBeenCalled();
    expect(closeAll).not.toHaveBeenCalled();
  });

  it("⌘K W within the chord window invokes closeAll once", () => {
    const closeActive = vi.fn();
    const closeAll = vi.fn();
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        closeActive={closeActive}
        closeAll={closeAll}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeAll).toHaveBeenCalledTimes(1);
    // closeActive must NOT fire — chord resolution takes priority.
    expect(closeActive).not.toHaveBeenCalled();
  });

  it("⌘K ⌘W with real modifier keydowns invokes closeAll, not close-active", () => {
    // Regression (Electron E2E TAB5): a real ⌘W press fires keydown
    // "Meta" THEN keydown "w". The leading "Meta" event used to enter the
    // chord-resolution lane, disarm the ⌘K chord, and let the trailing
    // "w" fall through to close-active — closing one tab instead of all.
    // The other chord tests miss it because they skip the standalone
    // modifier keydown that a real keyboard emits.
    const closeActive = vi.fn();
    const closeAll = vi.fn();
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        closeActive={closeActive}
        closeAll={closeAll}
        reopenLast={() => {}}
      />,
    );
    // ⌘K — modifier down, then the letter.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // ⌘W — modifier down (must NOT disarm the chord), then the letter.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(closeActive).not.toHaveBeenCalled();
  });

  it("⌘K → unrelated key cancels the chord without firing closeAll", () => {
    const closeAll = vi.fn();
    const states: OpenItemsState[] = [];
    render(
      <Host
        initial={makeStateWithRefs([refA, refB, refC])}
        onState={(s) => states.push(s)}
        closeActive={() => {}}
        closeAll={closeAll}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // ⌘1 — a normal handler. Chord cancels; ⌘1 still jumps to tab 1.
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(closeAll).not.toHaveBeenCalled();
    expect(states.at(-1)?.activeIndex).toBe(0);
  });

  it("⌘K → wait 2s → ⌘W fires plain closeActive, not closeAll", () => {
    const closeActive = vi.fn();
    const closeAll = vi.fn();
    render(
      <Host
        initial={makeStateWithRefs([refA])}
        closeActive={closeActive}
        closeAll={closeAll}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // Chord window is 1500ms; advance past it.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeActive).toHaveBeenCalledTimes(1);
    expect(closeAll).not.toHaveBeenCalled();
  });

  it("guard short-circuits arm: typing ⌘K in a text input does not arm the chord", () => {
    const closeAll = vi.fn();
    const closeActive = vi.fn();
    function App() {
      return (
        <>
          <Host
            initial={makeStateWithRefs([refA])}
            closeActive={closeActive}
            closeAll={closeAll}
            reopenLast={() => {}}
          />
          <input data-testid="text-input" />
        </>
      );
    }
    render(<App />);
    const input = screen.getByTestId("text-input") as HTMLInputElement;
    input.focus();
    // First leg of the chord while typing — guarded.
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // Now release focus and try ⌘W — should be plain close-active, not
    // the second leg of an armed chord.
    input.blur();
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeAll).not.toHaveBeenCalled();
    expect(closeActive).toHaveBeenCalledTimes(1);
  });

  it("an unmodified keypress cancels an armed chord (no accidental closeAll)", () => {
    // Regression: the `if (!mod) return` guard ran before the chord lane,
    // so a plain key after ⌘K left the chord armed and the next ⌘W
    // resolved as closeAll. An unmodified key must disarm the chord.
    const closeActive = vi.fn();
    const closeAll = vi.fn();
    render(
      <Host
        initial={makeStateWithRefs([refA, refB])}
        closeActive={closeActive}
        closeAll={closeAll}
        reopenLast={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true }); // arm
    fireEvent.keyDown(window, { key: "x" }); // plain key — must cancel the chord
    fireEvent.keyDown(window, { key: "w", metaKey: true }); // expect plain close
    expect(closeAll).not.toHaveBeenCalled();
    expect(closeActive).toHaveBeenCalledTimes(1);
  });

  it("a guarded keypress clears an already-armed chord (no accidental closeAll)", () => {
    const closeActive = vi.fn();
    const closeAll = vi.fn();
    function App() {
      return (
        <>
          <Host
            initial={makeStateWithRefs([refA])}
            closeActive={closeActive}
            closeAll={closeAll}
            reopenLast={() => {}}
          />
          <input data-testid="text-input" />
        </>
      );
    }
    render(<App />);
    const input = screen.getByTestId("text-input") as HTMLInputElement;
    // Arm the chord with focus OUTSIDE any input (on body) — this leg is
    // NOT guarded, so the chord actually arms.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // Focus an input and fire a modifier key. shouldHandleGlobalShortcut
    // is false here, so the guard branch runs clearPending() and disarms
    // the chord — the path the "short-circuits arm" test never reaches
    // because it never armed first.
    input.focus();
    fireEvent.keyDown(input, { key: "a", metaKey: true });
    // Back outside the input: ⌘W must be a plain close-active, proving
    // the chord was cleared rather than left armed to swallow ⌘W.
    input.blur();
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(closeAll).not.toHaveBeenCalled();
    expect(closeActive).toHaveBeenCalledTimes(1);
  });
});
