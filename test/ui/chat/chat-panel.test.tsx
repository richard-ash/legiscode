// @vitest-environment jsdom
/// <reference lib="dom" />

// Single-state chat panel render tests. Exercises the visible states:
//   empty (with + without anchor) / no-api-key / busy / tool-trail /
//   answer (markdown + citations) / error.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatTurn, UseChatReturn } from "@/app/ai/use-chat";
import { ChatPanel } from "@/ui/chat/chat-panel";

function makeChat(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  return {
    turns: [],
    busy: false,
    send: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

function makeTurn(partial: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "turn-1",
    turnId: 1,
    userPrompt: "What does § 1.1 say?",
    assistantText: "",
    toolCalls: [],
    usage: null,
    startedAt: 0,
    durationMs: null,
    busy: false,
    error: null,
    ...partial,
  };
}

const defaults = {
  anchor: { module_id: "test-alpha", section_id: "1.1" },
  anchorLabel: "§ 1.1",
  anchorModule: "test-alpha",
  onOpenSettings: () => {},
  onCitationClick: () => {},
  onBillClick: () => {},
};

const noAnchorDefaults = {
  anchorLabel: null,
  anchorModule: "",
  onOpenSettings: () => {},
  onCitationClick: () => {},
  onBillClick: () => {},
};

describe("ChatPanel render states", () => {
  it("renders the empty state with the anchored section name", () => {
    render(<ChatPanel {...defaults} chat={makeChat()} hasApiKey={true} />);
    expect(screen.getByText(/Ask anything about/)).toBeInTheDocument();
    expect(screen.getByText("§ 1.1")).toBeInTheDocument();
  });

  it("renders a generic empty state when no section is anchored", () => {
    render(<ChatPanel {...noAnchorDefaults} chat={makeChat()} hasApiKey={true} />);
    expect(screen.getByText(/Ask anything about this code/)).toBeInTheDocument();
  });

  it("renders the no-api-key state with an open-settings affordance", () => {
    render(<ChatPanel {...defaults} chat={makeChat()} hasApiKey={false} />);
    expect(screen.getByText(/No API key configured/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open AI settings/ })).toBeInTheDocument();
  });

  it("renders the rotating thinking status while a turn is busy with no text yet", () => {
    const chat = makeChat({
      busy: true,
      turns: [makeTurn({ busy: true, assistantText: "" })],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    const status = container.querySelector(".lc-chat-thinking");
    expect(status).not.toBeNull();
    expect(status?.textContent?.length ?? 0).toBeGreaterThan(0);
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the thinking status visible while text is already streaming", () => {
    const chat = makeChat({
      busy: true,
      turns: [makeTurn({ busy: true, assistantText: "Looking that up…" })],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(container.querySelector(".lc-chat-thinking")).not.toBeNull();
    expect(screen.getByText(/Looking that up/)).toBeInTheDocument();
  });

  it("hides the thinking status once the turn finishes", () => {
    const chat = makeChat({
      turns: [makeTurn({ busy: false, assistantText: "Final answer." })],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(container.querySelector(".lc-chat-thinking")).toBeNull();
  });

  it("renders markdown formatting in the assistant prose (bold, list, code)", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText:
            "Two things to know about **§ 1.1**:\n\n- It uses `vehicle` as the controlling term.\n- The exception lives in [test-alpha § 1.5].",
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    // **bold** rendered as <strong>
    expect(container.querySelector(".lc-chat-prose strong")).not.toBeNull();
    // `code` rendered as inline <code>
    const code = container.querySelector(".lc-chat-prose code");
    expect(code?.textContent).toBe("vehicle");
    // - list item rendered as <li>
    expect(container.querySelectorAll(".lc-chat-prose li").length).toBe(2);
    // Citation in list item still becomes a clickable button.
    const cite = screen.getByRole("button", { name: /test-alpha § 1.5/ });
    expect(cite).toHaveTextContent("[test-alpha § 1.5]");
  });

  it("does not render per-tool rows; the footer summarizes tool count + citations", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText: "Per [test-alpha § 1.1], the rule applies.",
          toolCalls: [
            {
              toolUseId: "u1",
              name: "read",
              input: { path: "/modules/test-alpha/sections/1.1" },
              result: {
                ok: true,
                fetched: [{ module_id: "test-alpha", section_id: "1.1" }],
                corpus_hash: "abc123",
                turn_id: 1,
                payload: { kind: "section" },
              },
            },
          ],
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    // No tool row container — chain-of-thought is hidden in the UI.
    expect(container.querySelector(".lc-chat-tools")).toBeNull();
    expect(container.querySelector(".lc-tool-line")).toBeNull();
    // Footer carries the summary instead.
    const footer = document.querySelector(".lc-chat-footer");
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toMatch(/1 tool/);
    expect(footer?.textContent).toMatch(/1 citation/);
  });

  it("renders the assistant prose with clickable citation spans", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText: "Per [test-alpha § 1.1], the rule applies.",
        }),
      ],
    });
    render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    const cite = screen.getByRole("button", { name: /test-alpha § 1.1/ });
    expect(cite).toBeInTheDocument();
    expect(cite).toHaveTextContent("[test-alpha § 1.1]");
  });

  it("renders [Bill #N] as a clickable button and routes the file_no through onBillClick", async () => {
    const onBillClick = vi.fn();
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText: "Active bills include [Bill #260542] and [Bill #260543].",
        }),
      ],
    });
    render(<ChatPanel {...defaults} onBillClick={onBillClick} chat={chat} hasApiKey={true} />);
    const first = screen.getByRole("button", { name: /Bill #260542/ });
    expect(first).toHaveTextContent("[Bill #260542]");
    expect(first.className).toMatch(/lc-cite-bill/);
    first.click();
    expect(onBillClick).toHaveBeenCalledWith("260542");

    const second = screen.getByRole("button", { name: /Bill #260543/ });
    second.click();
    expect(onBillClick).toHaveBeenCalledWith("260543");
    expect(onBillClick).toHaveBeenCalledTimes(2);
  });

  it("renders GFM pipe tables and tokenizes citations inside cells", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText:
            "Here's the comparison:\n\n" +
            "| Element | Current | Proposed |\n" +
            "| --- | --- | --- |\n" +
            "| Penalties | None specified | First offense: infraction, $125-$250 fine |\n" +
            "| Definition | None | Cross-references [test-alpha § 1.5] |\n",
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    const table = container.querySelector(".lc-chat-prose table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("thead th")).toHaveLength(3);
    const bodyRows = table?.querySelectorAll("tbody tr") ?? [];
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[0]?.textContent).toContain("Penalties");
    expect(bodyRows[0]?.textContent).toContain("$125-$250");
    // Citation inside a cell still becomes a clickable button.
    const cite = screen.getByRole("button", { name: /test-alpha § 1.5/ });
    expect(cite).toHaveTextContent("[test-alpha § 1.5]");
    expect(cite.closest("td")).not.toBeNull();
  });

  it("renders an error message when a turn ended with an error", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText: "",
          error: "Anthropic API connection failed.",
        }),
      ],
    });
    render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(screen.getByText("Anthropic API connection failed.")).toBeInTheDocument();
  });

  it("does not surface in-flight tool calls in the UI", () => {
    const chat = makeChat({
      busy: true,
      turns: [
        makeTurn({
          busy: true,
          toolCalls: [
            {
              toolUseId: "u1",
              name: "read",
              input: { path: "/modules/test-alpha/sections/1.1" },
              result: null,
            },
          ],
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    // No per-tool rendering, running or otherwise.
    expect(container.querySelector(".lc-chat-tools")).toBeNull();
    expect(container.querySelector(".lc-tool-line")).toBeNull();
    // The rotating thinking status is the only "we're working" affordance.
    expect(container.querySelector(".lc-chat-thinking")).not.toBeNull();
  });

  // F2 / D3 Sources block UI states — per feedback_ui_state_coverage,
  // every render branch (empty / single / many / mixed / broken) gets an
  // explicit assertion.

  it("does not render a Sources block when the answer has none", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText: "The corpus doesn't include sf-fire.",
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(container.querySelector(".lc-sources-block")).toBeNull();
  });

  it("renders a Sources block with a single section entry", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText:
            "Per [sf-planning § 106], zoning is incorporated.\n\n" +
            "**Sources**\n- [sf-planning § 106] — Zoning Map\n",
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    const block = container.querySelector(".lc-sources-block");
    expect(block).not.toBeNull();
    expect(block?.querySelectorAll(".lc-sources-item")).toHaveLength(1);
    expect(block?.textContent).toContain("[sf-planning § 106]");
    expect(block?.textContent).toContain("Zoning Map");
  });

  it("renders a mixed Sources block with section + bill chips", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText:
            "[sf-planning § 106] and [Bill #260543] both apply.\n\n" +
            "**Sources**\n" +
            "- [sf-planning § 106] — Zoning Map\n" +
            "- [Bill #260543] — Police Code Penalty\n",
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    const block = container.querySelector(".lc-sources-block");
    expect(block).not.toBeNull();
    expect(block?.querySelectorAll(".lc-sources-item")).toHaveLength(2);
    expect(block?.querySelectorAll(".lc-cite-bill")).toHaveLength(1);
  });

  // Copy affordance — per feedback_ui_state_coverage: present on a
  // finished answer, absent while busy, absent when the turn errored
  // with no prose, and the click path (payload + label feedback) is
  // asserted explicitly.

  function stubClipboard() {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it("renders a copy button on a finished answer", () => {
    const chat = makeChat({
      turns: [makeTurn({ assistantText: "Final answer.", durationMs: 4200 })],
    });
    render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
  });

  it("does not render a copy button while the turn is busy", () => {
    const chat = makeChat({
      busy: true,
      turns: [makeTurn({ busy: true, assistantText: "Streaming…" })],
    });
    render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(screen.queryByRole("button", { name: "Copy answer" })).toBeNull();
  });

  it("does not render a copy button when the turn errored with no prose", () => {
    const chat = makeChat({
      turns: [makeTurn({ assistantText: "", error: "Connection failed." })],
    });
    render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    expect(screen.queryByRole("button", { name: "Copy answer" })).toBeNull();
  });

  it("copies the prose plus tool count, citation count and duration", () => {
    const writeText = stubClipboard();
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText: "Per [test-alpha § 1.1], the rule applies.",
          toolCalls: [
            {
              toolUseId: "u1",
              name: "read",
              input: { path: "/modules/test-alpha/sections/1.1" },
              result: null,
            },
          ],
          durationMs: 4200,
        }),
      ],
    });
    render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(writeText).toHaveBeenCalledWith(
      "Per [test-alpha § 1.1], the rule applies.\n\n---\n1 tool · 1 citation · 4.2s",
    );
  });

  it("flips the copy label to Copied and reverts after the timeout", () => {
    vi.useFakeTimers();
    try {
      stubClipboard();
      const chat = makeChat({
        turns: [makeTurn({ assistantText: "Final answer.", durationMs: 1000 })],
      });
      render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
      const button = screen.getByRole("button", { name: "Copy answer" });
      fireEvent.click(button);
      expect(button).toHaveTextContent("Copied");
      act(() => {
        vi.advanceTimersByTime(1700);
      });
      expect(button).toHaveTextContent("Copy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gracefully renders a broken Sources entry with fallback styling", () => {
    const chat = makeChat({
      turns: [
        makeTurn({
          assistantText:
            "Per [sf-planning § 106] the rule applies.\n\n" +
            "**Sources**\n" +
            "- [sf-planning § 106] — Zoning Map\n" +
            "- [garbage] — should fall back\n",
        }),
      ],
    });
    const { container } = render(<ChatPanel {...defaults} chat={chat} hasApiKey={true} />);
    const broken = container.querySelectorAll(".lc-sources-item-broken");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.textContent).toContain("[garbage]");
  });
});
