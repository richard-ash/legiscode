// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CorpusModuleSummary } from "../../../electron/ipc/contract";
import { CommandPalette } from "../../../src/ui/chrome/command-palette";

const corpus: CorpusModuleSummary = {
  jurisdiction: "City and County of San Francisco",
  rootLabel: "San Francisco Municipal Code",
  jurisdictionVersion: "2026.05.01",
  codeCount: 2,
  sectionCount: 3,
  defaultRef: { moduleId: "sf-port", sectionId: "1.1" },
  tree: [
    {
      id: "sf-port",
      code: "Port Code",
      name: "San Francisco Port Code",
      kind: "code",
      kids: [
        {
          id: "sf-port::ARTICLE 1",
          code: "ARTICLE 1",
          name: "",
          kind: "chapter",
          kids: [
            {
              id: "sf-port::1.1",
              code: "§ 1.1",
              name: "Definitions",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "1.1" },
            },
            {
              id: "sf-port::1.2",
              code: "§ 1.2",
              name: "Commission",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "1.2" },
            },
          ],
        },
      ],
    },
    {
      id: "sf-fire",
      code: "Fire Code",
      name: "San Francisco Fire Code",
      kind: "code",
      kids: [
        {
          id: "sf-fire::101",
          code: "§ 101",
          name: "Scope",
          kind: "section",
          ref: { moduleId: "sf-fire", sectionId: "101" },
        },
      ],
    },
  ],
};

describe("CommandPalette", () => {
  it("renders all sections when search is empty", () => {
    render(<CommandPalette open onClose={() => {}} corpus={corpus} onSelect={() => {}} />);
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
  });

  it("filters sections by section number", async () => {
    render(<CommandPalette open onClose={() => {}} corpus={corpus} onSelect={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "1.2");
    expect(screen.getByText("Commission")).toBeInTheDocument();
    expect(screen.queryByText("Definitions")).not.toBeInTheDocument();
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
  });

  it("filters sections by name keyword", async () => {
    render(<CommandPalette open onClose={() => {}} corpus={corpus} onSelect={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "scope");
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.queryByText("Commission")).not.toBeInTheDocument();
  });

  it('shows "no sections match" empty state', async () => {
    render(<CommandPalette open onClose={() => {}} corpus={corpus} onSelect={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "zzzzzz");
    expect(screen.getByText(/No sections match/)).toBeInTheDocument();
  });

  it("Enter selects the highlighted section and closes", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} corpus={corpus} onSelect={onSelect} />);
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "Commission");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ moduleId: "sf-port", sectionId: "1.2" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape closes without selecting", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} corpus={corpus} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <CommandPalette open={false} onClose={() => {}} corpus={corpus} onSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
