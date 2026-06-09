// AI settings pane. Per-provider API key field via safeStorage IPC,
// model dropdown, telemetry toggle, per-session token spend (P7).

import { useCallback, useEffect, useState } from "react";
import type { AiSettingsView } from "@/ai/wire";
import { api } from "@/app/api";

export function AiSettingsPane() {
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyStored, setKeyStored] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api().ai.getSettings();
    setSettings(next);
    setKeyStored(next.has_active_provider_key);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSaveKey = useCallback(async () => {
    setKeyError(null);
    setSavingKey(true);
    try {
      const result = await api().ai.setApiKey({
        provider_id: "anthropic",
        api_key: keyInput.trim(),
      });
      if (!result.ok) {
        const reason = result.reason ?? "internal";
        setKeyError(
          reason === "too_short"
            ? "Key looks too short. Paste your full Anthropic API key."
            : reason === "no_encryption"
              ? "This platform doesn't support Electron safeStorage; key not saved."
              : "Could not store key.",
        );
        return;
      }
      setKeyInput("");
      await refresh();
    } finally {
      setSavingKey(false);
    }
  }, [keyInput, refresh]);

  const onClearKey = useCallback(async () => {
    await api().ai.clearApiKey({ provider_id: "anthropic" });
    await refresh();
  }, [refresh]);

  const onModelChange = useCallback(
    async (model: string) => {
      await api().ai.updateSettings({ model });
      await refresh();
    },
    [refresh],
  );

  const onTelemetryChange = useCallback(
    async (telemetry_enabled: boolean) => {
      await api().ai.updateSettings({ telemetry_enabled });
      await refresh();
    },
    [refresh],
  );

  if (!settings) {
    return <div className="lc-settings-empty">Loading AI settings…</div>;
  }

  const usage = settings.session_usage;
  const totalTokens = usage.input_tokens + usage.output_tokens;
  const cacheRate =
    usage.input_tokens === 0
      ? 0
      : Math.round((usage.cache_read_input_tokens / usage.input_tokens) * 100);

  return (
    <div>
      <div className="lc-settings-head">
        <h1 className="lc-settings-title">AI</h1>
      </div>
      <section className="lc-settings-group">
        <h2 className="lc-settings-group-title">Provider</h2>
        <ul className="lc-settings-entries">
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Active</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--ui-sm)" }}>
              Anthropic Claude
            </span>
          </li>
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">API key</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--ui-sm)" }}>
              {keyStored ? (
                <>
                  configured&nbsp;
                  <button
                    type="button"
                    onClick={onClearKey}
                    style={{
                      background: "transparent",
                      color: "var(--red)",
                      border: "1px solid var(--border-soft)",
                      borderRadius: 3,
                      padding: "2px 8px",
                      cursor: "pointer",
                    }}
                  >
                    Clear
                  </button>
                </>
              ) : (
                "not configured"
              )}
            </span>
          </li>
        </ul>
        {!keyStored ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8, padding: "0 12px" }}>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-ant-…"
              style={{
                flex: 1,
                background: "var(--bg-base)",
                color: "var(--text)",
                border: "1px solid var(--border-soft)",
                borderRadius: 4,
                padding: "6px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--ui-sm)",
              }}
              aria-label="API key"
            />
            <button
              type="button"
              onClick={onSaveKey}
              disabled={savingKey || keyInput.trim().length < 8}
              style={{
                background: "var(--mauve, var(--accent))",
                color: "var(--bg-crust)",
                border: "none",
                borderRadius: 4,
                padding: "6px 14px",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--ui-sm)",
                cursor: savingKey ? "not-allowed" : "pointer",
              }}
            >
              {savingKey ? "Saving…" : "Save key"}
            </button>
          </div>
        ) : null}
        {keyError ? (
          <div
            style={{
              color: "var(--red)",
              fontSize: "var(--ui-sm)",
              marginTop: 8,
              padding: "0 12px",
            }}
          >
            {keyError}
          </div>
        ) : null}
      </section>

      <section className="lc-settings-group">
        <h2 className="lc-settings-group-title">Model</h2>
        <ul className="lc-settings-entries">
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Default model</span>
            <select
              value={settings.model}
              onChange={(e) => onModelChange(e.target.value)}
              style={{
                background: "var(--bg-base)",
                color: "var(--text)",
                border: "1px solid var(--border-soft)",
                borderRadius: 4,
                padding: "4px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--ui-sm)",
              }}
              aria-label="Default model"
            >
              {settings.available_models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </li>
        </ul>
      </section>

      <section className="lc-settings-group">
        <h2 className="lc-settings-group-title">Telemetry</h2>
        <ul className="lc-settings-entries">
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Local-only event log (no remote upload)</span>
            <label style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={settings.telemetry_enabled}
                onChange={(e) => onTelemetryChange(e.target.checked)}
                aria-label="Enable local telemetry"
                style={{ marginRight: 8 }}
              />
              {settings.telemetry_enabled ? "enabled" : "disabled"}
            </label>
          </li>
        </ul>
      </section>

      <section className="lc-settings-group">
        <h2 className="lc-settings-group-title">Session usage (in-memory)</h2>
        <ul className="lc-settings-entries">
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Input tokens</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--ui-sm)" }}>
              {usage.input_tokens.toLocaleString()}
            </span>
          </li>
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Output tokens</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--ui-sm)" }}>
              {usage.output_tokens.toLocaleString()}
            </span>
          </li>
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Cache read</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--ui-sm)" }}>
              {usage.cache_read_input_tokens.toLocaleString()} ({cacheRate}%)
            </span>
          </li>
          <li className="lc-settings-entry">
            <span className="lc-settings-entry-label">Total this session</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--ui-sm)" }}>
              {totalTokens.toLocaleString()}
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
