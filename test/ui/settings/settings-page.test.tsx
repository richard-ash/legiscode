// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/ui/settings/settings-page";
import { SHORTCUTS } from "@/ui/shortcuts/registry";

describe("SettingsPage — keyboard shortcuts", () => {
  it("renders the Commands and In-view navigation groups", () => {
    render(<SettingsPage section="shortcuts" />);
    expect(screen.getByRole("heading", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In-view navigation" })).toBeInTheDocument();
  });

  it("collapses ⌘1–⌘9 into a single row", () => {
    render(<SettingsPage section="shortcuts" />);
    const jumpRows = screen.getAllByText("Jump to tab 1–9");
    expect(jumpRows).toHaveLength(1);
    // The nine granular entries must NOT each render their own row.
    expect(screen.queryByText("Jump to tab 5")).not.toBeInTheDocument();
  });

  it("renders bindings as <kbd> elements", () => {
    const { container } = render(<SettingsPage section="shortcuts" />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds.length).toBeGreaterThan(0);
    // The catalog defines the close-active binding; its label row carries it.
    const closeRow = screen.getByText("Close active tab").closest("li");
    expect(closeRow).not.toBeNull();
    expect(within(closeRow as HTMLElement).getByText(/W$/)).toBeInTheDocument();
  });

  it("exposes each scope group as an aria-labelled region", () => {
    render(<SettingsPage section="shortcuts" />);
    expect(screen.getByRole("region", { name: "Global" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Command palette" })).toBeInTheDocument();
  });

  it("filters rows by label, keyword, or binding substring", () => {
    render(<SettingsPage section="shortcuts" />);
    const search = screen.getByLabelText("Filter keyboard shortcuts");
    fireEvent.change(search, { target: { value: "palette" } });
    expect(screen.getByText("Open command palette")).toBeInTheDocument();
    expect(screen.queryByText("Toggle left panel")).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", () => {
    render(<SettingsPage section="shortcuts" />);
    const search = screen.getByLabelText("Filter keyboard shortcuts");
    fireEvent.change(search, { target: { value: "zzzznomatch" } });
    expect(screen.getByText(/No shortcuts match/)).toBeInTheDocument();
  });

  it("wires ARIA tabpanel linkage when given a tabPanel", () => {
    render(
      <SettingsPage
        section="shortcuts"
        tabPanel={{ id: "tabpanel-settings::shortcuts", labelledBy: "tab-settings::shortcuts" }}
      />,
    );
    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("tabpanel-settings::shortcuts");
    expect(panel.getAttribute("aria-labelledby")).toBe("tab-settings::shortcuts");
  });

  it("renders a row for every non-jump catalog entry plus one collapsed jump row", () => {
    const { container } = render(<SettingsPage section="shortcuts" />);
    const nonJump = SHORTCUTS.filter((s) => !/^tabs\.jump-to-\d$/.test(s.id)).length;
    const rows = container.querySelectorAll(".lc-settings-entry");
    expect(rows).toHaveLength(nonJump + 1);
  });
});

describe("SettingsPage — pane nav", () => {
  // The AI pane is otherwise only reachable from the chat panel's
  // no-api-key state; the nav must exist on every pane so a user with a
  // key configured can still reach the telemetry/model settings.

  it("hides the pane nav when no onNavigatePane is wired", () => {
    render(<SettingsPage section="shortcuts" />);
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
  });

  it("renders all three pane entries with the active one marked aria-current", () => {
    render(<SettingsPage section="shortcuts" onNavigatePane={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const active = within(nav).getByRole("button", { name: "Keyboard Shortcuts" });
    const aiBtn = within(nav).getByRole("button", { name: "AI" });
    const modulesBtn = within(nav).getByRole("button", { name: "Law Packages" });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(aiBtn.getAttribute("aria-current")).toBeNull();
    expect(modulesBtn.getAttribute("aria-current")).toBeNull();
  });

  it("navigates to the AI pane on click and no-ops on the active pane", () => {
    const onNavigatePane = vi.fn();
    render(<SettingsPage section="shortcuts" onNavigatePane={onNavigatePane} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Keyboard Shortcuts" }));
    expect(onNavigatePane).not.toHaveBeenCalled();
    fireEvent.click(within(nav).getByRole("button", { name: "AI" }));
    expect(onNavigatePane).toHaveBeenCalledWith("ai");
    expect(onNavigatePane).toHaveBeenCalledTimes(1);
  });

  it("navigates to the modules pane on click", () => {
    const onNavigatePane = vi.fn();
    render(<SettingsPage section="shortcuts" onNavigatePane={onNavigatePane} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Law Packages" }));
    expect(onNavigatePane).toHaveBeenCalledWith("modules");
    expect(onNavigatePane).toHaveBeenCalledTimes(1);
  });
});
