// Right-panel chat surface. Single user-visible state: prose. Tool
// activity is summarized in the footer (count + duration); the model's
// individual reads aren't rendered as rows — the citations in the prose
// ARE the evidence affordance.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AiCorpusContextRef } from "@/ai/wire";
import type { ChatTurn, UseChatReturn } from "@/app/ai/use-chat";
import { ChatInput } from "./chat-input";
import { ChatCitationProse } from "./citation-render";
import "./chat-panel.css";

interface ChatPanelProps {
  chat: UseChatReturn;
  /** Current section anchor to attach to each send. Null when the
   *  active tab isn't a section (Bill, Settings, empty workbench). */
  anchor?: AiCorpusContextRef;
  /** Display label for the empty-state hint (e.g. "§ 1.1"). Null
   *  when no section is active. */
  anchorLabel: string | null;
  /** Module id used to resolve bare `§ X` cites in rendered prose.
   *  Empty string when no section is active. */
  anchorModule: string;
  hasApiKey: boolean;
  /** Open the AI settings tab — wired from App.tsx. */
  onOpenSettings(): void;
  /** Navigate to a section ref when the user clicks a citation in prose. */
  onCitationClick(ref: AiCorpusContextRef): void;
  /** Open a bill tab when the user clicks a [Bill #file_no] citation. */
  onBillClick(fileNo: string): void;
}

export function ChatPanel({
  chat,
  anchor,
  anchorLabel,
  anchorModule,
  hasApiKey,
  onOpenSettings,
  onCitationClick,
  onBillClick,
}: ChatPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chat.turns is the deliberate change-trigger so autoscroll fires on every new turn / streaming delta; the body reads scrollRef.current, not the dep.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.turns]);

  const onSend = (): void => {
    if (prompt.trim().length === 0) return;
    chat.send(prompt.trim(), anchor);
    setPrompt("");
  };

  const empty = chat.turns.length === 0 && !chat.busy;

  return (
    <section className="lc-chat" aria-label="AI chat panel">
      {!hasApiKey ? (
        <div className="lc-chat-scroll">
          <div className="lc-chat-no-key">
            <p>No API key configured.</p>
            <button
              type="button"
              className="lc-chat-send"
              onClick={onOpenSettings}
              style={{ marginTop: 8 }}
            >
              Open AI settings
            </button>
          </div>
        </div>
      ) : (
        <div className="lc-chat-scroll" ref={scrollRef}>
          {empty ? (
            <div className="lc-chat-empty">
              {anchorLabel ? (
                <>
                  Ask anything about <span className="lc-chat-empty-cite">{anchorLabel}</span>
                </>
              ) : (
                "Ask anything about this code"
              )}
            </div>
          ) : (
            chat.turns.map((turn) => (
              <ChatTurnView
                key={turn.id}
                turn={turn}
                anchorModule={anchorModule}
                onCitationClick={onCitationClick}
                onBillClick={onBillClick}
              />
            ))
          )}
        </div>
      )}
      {hasApiKey ? (
        <ChatInput
          value={prompt}
          onChange={setPrompt}
          onSend={onSend}
          onCancel={chat.cancel}
          busy={chat.busy}
          disabled={!hasApiKey}
          focusTick={focusTick}
        />
      ) : null}
      {/* Hidden span so a parent can request focus on the input via the
       * focusTick prop pattern (used by /chat-input shortcuts later). */}
      <button
        type="button"
        style={{ display: "none" }}
        onClick={() => setFocusTick((t) => t + 1)}
      />
    </section>
  );
}

interface ChatTurnViewProps {
  turn: ChatTurn;
  anchorModule: string;
  onCitationClick(ref: AiCorpusContextRef): void;
  onBillClick(fileNo: string): void;
}

function ChatTurnView({ turn, anchorModule, onCitationClick, onBillClick }: ChatTurnViewProps) {
  const footer = useMemo(() => buildFooterLine(turn), [turn]);
  return (
    <div className="lc-chat-turn">
      <div className="lc-chat-user">{turn.userPrompt}</div>
      {turn.assistantText ? (
        <ChatCitationProse
          text={turn.assistantText}
          anchorModule={anchorModule}
          onCitationClick={onCitationClick}
          onBillClick={onBillClick}
        />
      ) : null}
      {turn.busy ? <ThinkingStatus /> : null}
      {turn.error ? <div className="lc-chat-error">{turn.error}</div> : null}
      {footer ? <div className="lc-chat-footer">{footer}</div> : null}
    </div>
  );
}

function buildFooterLine(turn: ChatTurn): string | null {
  if (turn.busy) return null;
  const tools = turn.toolCalls.length;
  const citations = countCitations(turn.assistantText);
  const seconds = turn.durationMs ? (turn.durationMs / 1000).toFixed(1) : null;
  const parts: string[] = [];
  parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  parts.push(`${citations} citation${citations === 1 ? "" : "s"}`);
  if (seconds) parts.push(`${seconds}s`);
  return parts.join(" · ");
}

const THINKING_MESSAGES = [
  "Reading the fine print…",
  "Cross-referencing the code…",
  "Skimming ordinances…",
  "Tracing citations…",
  "Looking up definitions…",
  "Searching the corpus…",
  "Checking pending bills…",
  "Consulting the muni code…",
] as const;

function ThinkingStatus() {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * THINKING_MESSAGES.length));
  useEffect(() => {
    const id = window.setInterval(() => setIdx((i) => (i + 1) % THINKING_MESSAGES.length), 2400);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="lc-chat-thinking" aria-live="polite">
      <span key={idx} className="lc-chat-thinking-text">
        {THINKING_MESSAGES[idx]}
      </span>
    </div>
  );
}

function countCitations(text: string): number {
  // Strip the qualified bracket form before counting bare cites, so
  // `[test-alpha § 1.1]` counts as one citation, not two.
  const qualifiedRe = /\[[a-z][a-z0-9-]*\s*§\s*[a-z0-9][a-z0-9._-]*\]/gi;
  const qualified = text.match(qualifiedRe) ?? [];
  const stripped = text.replace(qualifiedRe, "");
  const bare = stripped.match(/§\s+[a-z0-9][a-z0-9._-]*/gi) ?? [];
  return qualified.length + bare.length;
}
