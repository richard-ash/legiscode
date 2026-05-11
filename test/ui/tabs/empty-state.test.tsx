// @vitest-environment jsdom
/// <reference lib="dom" />

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabEmptyState } from "@/ui/tabs/empty-state";

describe("TabEmptyState", () => {
  it("renders quiet copy + the ⌘P keycap hint", () => {
    render(<TabEmptyState />);
    expect(screen.getByText("No section open")).toBeInTheDocument();
    // Match the hint text + keycap together.
    expect(screen.getByText(/Open a section from the file tree, or press/)).toBeInTheDocument();
    expect(screen.getByText("⌘P")).toBeInTheDocument();
  });
});
