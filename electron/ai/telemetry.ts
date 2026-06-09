// Local-only telemetry sink. Append-only JSONL at ${userData}/ai-telemetry/
// events.jsonl. Off by default; gated by AiSettings.telemetryEnabled. No
// remote upload in v1.
//
// Per A6 + N5: every event carries corpus_hash + prompt_hash. Golden Q&A
// fixtures pin to a (corpus_hash, prompt_hash) pair so a regression
// surfaces as a row mismatch, not silent drift.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

export interface TelemetryEvent {
  kind:
    | "ai.turn.started"
    | "ai.turn.completed"
    | "ai.turn.error"
    | "ai.turn.cancelled"
    | "ai.tool.call"
    | "ai.verification.outcome";
  ts: string;
  corpus_hash: string;
  prompt_hash: string;
  turn_id: number;
  chat_id: string;
  /** Per-kind extras; never includes query/response text. */
  [key: string]: unknown;
}

let enabledOverride: boolean | null = null;

/**
 * Override the on-disk setting at runtime — used by the IPC handler when
 * the user toggles telemetry in the settings pane (avoid a file re-read
 * per emit).
 */
export function setTelemetryEnabled(value: boolean): void {
  enabledOverride = value;
}

/** Drop an event to disk if telemetry is enabled. No-op otherwise. */
export function emitTelemetry(event: TelemetryEvent): void {
  if (enabledOverride !== true) return;
  const path = telemetryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Telemetry must never break the conversation loop; swallow.
  }
}

function telemetryPath(): string {
  return join(app.getPath("userData"), "ai-telemetry", "events.jsonl");
}
