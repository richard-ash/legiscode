// Multi-line chat input. Cmd+Enter sends; Esc cancels (when busy).

import { useCallback, useEffect, useRef } from "react";

interface ChatInputProps {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onCancel?(): void;
  busy: boolean;
  disabled: boolean;
  /** Counter that increments when the parent wants the input focused. */
  focusTick?: number;
}

export function ChatInput({
  value,
  onChange,
  onSend,
  onCancel,
  busy,
  disabled,
  focusTick,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (focusTick === undefined) return;
    textareaRef.current?.focus();
  }, [focusTick]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!busy && value.trim().length > 0 && !disabled) onSend();
        return;
      }
      if (e.key === "Escape" && busy && onCancel) {
        e.preventDefault();
        onCancel();
      }
    },
    [busy, value, disabled, onSend, onCancel],
  );

  return (
    <div className="lc-chat-input">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder={disabled ? "Configure an API key in AI settings to start." : "Ask anything…"}
        disabled={disabled}
        aria-label="Chat message"
      />
      <div className="lc-chat-input-row">
        <span>{busy ? "Esc to cancel" : "⌘↵ to send"}</span>
        {busy ? (
          <button
            type="button"
            className="lc-chat-cancel"
            onClick={onCancel}
            aria-label="Cancel turn"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="lc-chat-send"
            onClick={onSend}
            disabled={disabled || value.trim().length === 0}
            aria-label="Send message"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
