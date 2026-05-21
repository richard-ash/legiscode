// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { CommandPalette } from "../../../src/ui/command-palette/command-palette";
import {
  type UseCommandPaletteResult,
  useCommandPalette,
} from "../../../src/ui/command-palette/use-command-palette";

const corpus: CorpusModuleSummary = {
  jurisdiction: "City and County of San Francisco",
  rootLabel: "San Francisco Municipal Code",
  jurisdictionVersion: "2026.05.01",
  codeCount: 2,
  sectionCount: 4,
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
        {
          id: "sf-fire::133",
          code: "§ 133",
          name: "Side Yards",
          kind: "section",
          ref: { moduleId: "sf-fire", sectionId: "133" },
        },
      ],
    },
  ],
  // Pre-sorted by (term, moduleId) to mirror `aggregateDefinitions()`'s
  // wire contract. sf-administrative sorts before sf-port alphabetically.
  definitions: [
    { term: "Director", moduleId: "sf-administrative", definers: ["1.1"] },
    { term: "Director", moduleId: "sf-port", definers: ["1.1"] },
  ],
};

interface MountOpts {
  initialOpen?: boolean;
}

/** Mount the palette wired to a real `useCommandPalette` instance.
 *  Tests can read the hook's current state via `getPalette()` and
 *  drive open/close via the rendered trigger button. */
function mountPalette(opts: MountOpts = {}) {
  const navigate = vi.fn();
  let paletteRef: UseCommandPaletteResult | null = null;
  function Wrapper() {
    const palette = useCommandPalette(corpus);
    paletteRef = palette;
    // biome-ignore lint/correctness/useExhaustiveDependencies: init-once
    useEffect(() => {
      if (opts.initialOpen) palette.toggle();
    }, []);
    return (
      <>
        <button type="button" data-testid="palette-trigger" onClick={palette.toggle}>
          Open
        </button>
        <CommandPalette palette={palette} navigate={navigate} />
      </>
    );
  }
  const view = render(<Wrapper />);
  return { view, navigate, getPalette: () => paletteRef };
}

describe("CommandPalette — render gate (placeholder parity)", () => {
  it("renders nothing when open is false", () => {
    const { view } = mountPalette({ initialOpen: false });
    expect(view.container.querySelector(".lc-palette-scrim")).toBeNull();
  });
  it("renders the dialog with role=dialog and aria-modal when open", () => {
    mountPalette({ initialOpen: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
  it("renders all sections when search is empty (placeholder parity)", () => {
    mountPalette({ initialOpen: true });
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("Side Yards")).toBeInTheDocument();
  });
});

describe("CommandPalette — search + filter (placeholder parity)", () => {
  it("filters by section number", async () => {
    mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "1.2");
    expect(screen.getByText("Commission")).toBeInTheDocument();
    expect(screen.queryByText("Definitions")).not.toBeInTheDocument();
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
  });
  it("filters by section name keyword", async () => {
    mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "scope");
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.queryByText("Commission")).not.toBeInTheDocument();
  });
  it('shows "no sections match" empty state', async () => {
    mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "zzzzzz");
    expect(screen.getByText(/No sections match/)).toBeInTheDocument();
  });
});

describe("CommandPalette — U1 §133 ranking (the headline bug)", () => {
  it("§ 133 ranks above § 1.1 / § 1.2 when typing '133'", async () => {
    mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "133");
    const rows = screen.getAllByRole("option");
    expect(rows.length).toBeGreaterThan(0);
    // First row is § 133 (Side Yards), not any of the § 1.x sections.
    expect(rows[0]).toHaveTextContent("133");
    expect(rows[0]).toHaveTextContent("Side Yards");
  });
});

describe("CommandPalette — Enter / Escape / Cmd+Enter (Codex F8)", () => {
  it("Enter navigates primary and closes (intent='primary')", async () => {
    const { navigate, getPalette } = mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "Commission");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item, intent] = navigate.mock.calls[0] ?? [];
    expect(item.kind).toBe("section");
    expect(item.ref.module).toBe("sf-port");
    expect(item.ref.section).toBe("1.2");
    expect(intent).toBe("primary");
    expect(getPalette()?.open).toBe(false);
  });
  it("⌘+Enter navigates background, advances selection, palette stays open (Codex F8)", () => {
    const { navigate, getPalette } = mountPalette({ initialOpen: true });
    // Empty q → all sections in tree order. First two ⌘+Enter calls
    // dispatch items[0] then items[1].
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[1]).toBe("background");
    expect(getPalette()?.open).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", metaKey: true });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate.mock.calls[1]?.[0].ref.section).toBe("1.2");
  });
  it("Escape closes without navigating", () => {
    const { navigate, getPalette } = mountPalette({ initialOpen: true });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(navigate).not.toHaveBeenCalled();
    expect(getPalette()?.open).toBe(false);
  });
  it("Enter on empty results is a no-op (palette stays open)", async () => {
    const { navigate, getPalette } = mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "zzzz");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(navigate).not.toHaveBeenCalled();
    expect(getPalette()?.open).toBe(true);
  });
});

describe("CommandPalette — keyboard nav (Codex F10)", () => {
  it("ArrowDown advances selection; Enter dispatches the selected row", () => {
    const { navigate } = mountPalette({ initialOpen: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    // 2 ArrowDowns → selection 2 → sf-fire::101 (Scope).
    expect(navigate.mock.calls[0]?.[0].ref.section).toBe("101");
  });
  it("End jumps to last row", () => {
    const { navigate } = mountPalette({ initialOpen: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "End" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(navigate.mock.calls[0]?.[0].ref.section).toBe("133");
  });
  it("Home jumps to first row", () => {
    const { navigate } = mountPalette({ initialOpen: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "End" });
    fireEvent.keyDown(dialog, { key: "Home" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(navigate.mock.calls[0]?.[0].ref.section).toBe("1.1");
  });
  it("selection clamps when results shrink mid-query", async () => {
    const { navigate } = mountPalette({ initialOpen: true });
    const dialog = screen.getByRole("dialog");
    // End → 3 (last), then type "Commission" → 1 result → clamps to 0.
    fireEvent.keyDown(dialog, { key: "End" });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "Commission");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(navigate.mock.calls[0]?.[0].ref.section).toBe("1.2");
  });
});

describe("CommandPalette — a11y surface (Codex F10)", () => {
  it("listbox has aria-activedescendant pointing at the selected row id", () => {
    mountPalette({ initialOpen: true });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active ?? "")).not.toBeNull();
  });
  it("row id is stable across renders (same key)", async () => {
    mountPalette({ initialOpen: true });
    const idsBefore = screen.getAllByRole("option").map((r) => r.id);
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), "Definitions");
    const idAfter = screen.getAllByRole("option")[0]?.id;
    expect(idsBefore).toContain(idAfter);
  });
  it("input has maxLength=200 to defend against very long queries", () => {
    mountPalette({ initialOpen: true });
    const input = screen.getByPlaceholderText(/Go to section/) as HTMLInputElement;
    expect(input.maxLength).toBe(200);
  });
});

describe("CommandPalette — :def subtype filter (D5, C5)", () => {
  it("`:def Director` switches mode and renders defined-term rows", async () => {
    mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), ":def Director");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Find defined term");
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.textContent?.includes("Director"))).toBe(true);
    expect(screen.getByText(/sf-port/)).toBeInTheDocument();
    expect(screen.getByText(/sf-administrative/)).toBeInTheDocument();
  });
  it('shows "No defined terms match" copy in :def mode', async () => {
    mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), ":def zzzzz");
    expect(screen.getByText(/No defined terms match/)).toBeInTheDocument();
  });
  it(":def-mode Enter navigates to the first definer in the FIRST module (D5 — module identity is load-bearing)", async () => {
    // Cross-module collisions stay as distinct rows; the first row
    // (after stable sort by (term, moduleId) — sf-administrative
    // sorts before sf-port) is what Enter dispatches. Assert the
    // MODULE, not just the section — both modules define "1.1", and
    // routing to the wrong module is the silently-wrong-navigation
    // failure mode D5 was written to prevent.
    const { navigate } = mountPalette({ initialOpen: true });
    await userEvent.type(screen.getByPlaceholderText(/Go to section/), ":def Director");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item] = navigate.mock.calls[0] ?? [];
    expect(item.kind).toBe("section");
    expect(item.ref.module).toBe("sf-administrative");
    expect(item.ref.section).toBe("1.1");
  });
});

describe("CommandPalette — scrim + hover", () => {
  it("scrim mousedown closes the palette", () => {
    const { view, getPalette } = mountPalette({ initialOpen: true });
    const scrim = view.container.querySelector(".lc-palette-scrim");
    expect(scrim).not.toBeNull();
    if (!scrim) return;
    fireEvent.mouseDown(scrim);
    expect(getPalette()?.open).toBe(false);
  });
  it("row mouseEnter sets selection; mouseDown navigates", () => {
    const { navigate } = mountPalette({ initialOpen: true });
    const rows = screen.getAllByRole("option");
    const second = rows[1];
    expect(second).toBeTruthy();
    if (!second) return;
    fireEvent.mouseEnter(second);
    fireEvent.mouseDown(second);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[0].ref.section).toBe("1.2");
  });
});

describe("CommandPalette — focus restore on close (Codex F10)", () => {
  it("Escape restores focus to the previously-focused element", () => {
    mountPalette({ initialOpen: false });
    const trigger = screen.getByTestId("palette-trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("CommandPalette — q persistence across close + re-open (U3)", () => {
  it("re-opening after Escape shows the previous query and matches", () => {
    mountPalette({ initialOpen: true });
    const input = screen.getByPlaceholderText(/Go to section/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Commission" } });
    expect(input.value).toBe("Commission");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("palette-trigger"));
    const reopenedInput = screen.getByPlaceholderText(/Go to section/) as HTMLInputElement;
    expect(reopenedInput.value).toBe("Commission");
  });
});
