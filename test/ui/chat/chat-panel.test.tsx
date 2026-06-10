// @vitest-environment jsdom
/// <reference lib="dom" />

// Single-state chat panel render tests. Exercises the visible states:
//   empty (with + without anchor) / no-api-key / busy / tool-trail /
//   answer (markdown + citations) / error.

import { render, screen } from "@testing-library/react";
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
});
