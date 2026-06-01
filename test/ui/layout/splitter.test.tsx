// @vitest-environment jsdom
/// <reference lib="dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Splitter } from "@/ui/layout/splitter";

function Harness({
  initial = 0.45,
  onCommit,
}: {
  initial?: number;
  onCommit?: (v: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ height: 400 }}>
      <Splitter
        value={value}
        onChange={setValue}
        onCommit={onCommit}
        ariaLabel="Resize activity pane"
        ariaControls="activity-pane"
      />
      <div data-testid="value">{value.toFixed(2)}</div>
    </div>
  );
}

describe("Splitter — ARIA contract", () => {
  it("renders with role=separator + horizontal orientation", () => {
    render(<Harness />);
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("aria-orientation", "horizontal");
    expect(sep).toHaveAttribute("aria-label", "Resize activity pane");
    expect(sep).toHaveAttribute("aria-controls", "activity-pane");
  });

  it("aria-valuenow reflects the current value as a 0..100 percent", () => {
    render(<Harness initial={0.3} />);
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("aria-valuenow", "30");
    expect(sep).toHaveAttribute("aria-valuemin", "20");
    expect(sep).toHaveAttribute("aria-valuemax", "80");
  });

  it("is keyboard-focusable (tabIndex=0)", () => {
    render(<Harness />);
    expect(screen.getByRole("separator")).toHaveAttribute("tabindex", "0");
  });
});

describe("Splitter — keyboard nudge", () => {
  it("ArrowDown grows the bottom pane by 5%", () => {
    render(<Harness initial={0.5} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowDown" });
    expect(screen.getByTestId("value").textContent).toBe("0.55");
  });

  it("ArrowUp shrinks the bottom pane by 5%", () => {
    render(<Harness initial={0.5} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    expect(screen.getByTestId("value").textContent).toBe("0.45");
  });

  it("clamps to the min (20%) on repeated ArrowUp", () => {
    render(<Harness initial={0.25} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    expect(screen.getByTestId("value").textContent).toBe("0.20");
  });

  it("clamps to the max (80%) on repeated ArrowDown", () => {
    render(<Harness initial={0.75} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowDown" });
    fireEvent.keyDown(sep, { key: "ArrowDown" });
    fireEvent.keyDown(sep, { key: "ArrowDown" });
    expect(screen.getByTestId("value").textContent).toBe("0.80");
  });

  it("Home jumps to min and End to max", () => {
    render(<Harness initial={0.5} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "Home" });
    expect(screen.getByTestId("value").textContent).toBe("0.20");
    fireEvent.keyDown(sep, { key: "End" });
    expect(screen.getByTestId("value").textContent).toBe("0.80");
  });

  it("ignores unrelated keys", () => {
    render(<Harness initial={0.5} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "a" });
    expect(screen.getByTestId("value").textContent).toBe("0.50");
  });

  it("emits onCommit on each keyboard nudge", () => {
    const onCommit = vi.fn();
    render(<Harness initial={0.5} onCommit={onCommit} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowDown" });
    expect(onCommit).toHaveBeenCalledWith(0.55);
  });
});
