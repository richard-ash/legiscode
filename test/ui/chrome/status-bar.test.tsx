// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { registerStatusBarItem, StatusBar } from "../../../src/ui/chrome/status-bar";

afterEach(() => {
  // Reset internal state by deregistering anything still registered.
  // The module's register API returns deregister callbacks; cumulative state
  // across tests would otherwise leak.
  document.body.innerHTML = "";
});

describe("StatusBar Phase-1 hardcoded slots", () => {
  it("renders the corpus version + indexed-count slots", () => {
    render(
      <StatusBar rootLabel="SF Municipal Code" jurisdictionVersion="2026.05.01" codeCount={18} />,
    );
    expect(screen.getByText(/SF Municipal Code v2026.05.01/)).toBeInTheDocument();
    expect(screen.getByText(/18 codes indexed/)).toBeInTheDocument();
    expect(screen.getByText(/⌘P for sections/)).toBeInTheDocument();
  });
});

describe("registerStatusBarItem", () => {
  it("renders registered items in the requested slot", () => {
    const dereg = registerStatusBarItem({
      id: "test-left",
      slot: "left",
      priority: 1,
      render: () => "left-slot-content",
    });
    render(<StatusBar rootLabel="Root" jurisdictionVersion="2026.05.01" codeCount={1} />);
    expect(screen.getByText("left-slot-content")).toBeInTheDocument();
    dereg();
  });

  it("orders items in the same slot by priority ascending (lower first)", () => {
    const deregA = registerStatusBarItem({
      id: "a",
      slot: "right",
      priority: 50,
      render: () => "B-50",
    });
    const deregB = registerStatusBarItem({
      id: "b",
      slot: "right",
      priority: 10,
      render: () => "A-10",
    });
    render(<StatusBar rootLabel="Root" jurisdictionVersion="2026.05.01" codeCount={1} />);
    const a = screen.getByText("A-10");
    const b = screen.getByText("B-50");
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    deregA();
    deregB();
  });

  it("returns a deregister function that removes the item", () => {
    const dereg = registerStatusBarItem({
      id: "going-away",
      slot: "left",
      priority: 1,
      render: () => "TBD",
    });
    const { rerender } = render(
      <StatusBar rootLabel="Root" jurisdictionVersion="2026.05.01" codeCount={1} />,
    );
    expect(screen.getByText("TBD")).toBeInTheDocument();
    dereg();
    rerender(<StatusBar rootLabel="Root" jurisdictionVersion="2026.05.01" codeCount={1} />);
    expect(screen.queryByText("TBD")).not.toBeInTheDocument();
  });

  it("preserves registration order on equal priority (stable on tie)", () => {
    const deregA = registerStatusBarItem({
      id: "first",
      slot: "center",
      priority: 5,
      render: () => "first",
    });
    const deregB = registerStatusBarItem({
      id: "second",
      slot: "center",
      priority: 5,
      render: () => "second",
    });
    render(<StatusBar rootLabel="Root" jurisdictionVersion="2026.05.01" codeCount={1} />);
    const first = screen.getByText("first");
    const second = screen.getByText("second");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    deregA();
    deregB();
  });
});
