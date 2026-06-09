// Per-provider API key storage via Electron safeStorage. The renderer
// writes a key (via the IPC ai:setApiKey channel); main encrypts via
// safeStorage and writes a 0600 file at ${userData}/secrets/${provider}.bin.
// Reads decrypt the file synchronously on demand — these are short
// operations called once per turn, not on every IPC roundtrip.
//
// Per N6: lifecycle is filewrite/fileread/filedelete. Migration of legacy
// stores is TBD; v1 starts with safeStorage as the only path.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import type { ProviderId } from "./providers/index";

export interface AiSettings {
  activeProvider: ProviderId;
  model: string;
  /** Local telemetry on/off. Off by default. */
  telemetryEnabled: boolean;
}

const DEFAULT_SETTINGS: AiSettings = {
  activeProvider: "anthropic",
  model: "claude-sonnet-4-5",
  telemetryEnabled: false,
};

/** Read the stored API key for a provider, or null if not configured. */
export function readApiKey(providerId: ProviderId): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const path = secretsPath(providerId);
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return null;
  }
  try {
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

/** Persist a provider API key. Returns true on success. */
export function writeApiKey(providerId: ProviderId, key: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (!key || key.length < 8) return false;
  const path = secretsPath(providerId);
  const enc = safeStorage.encryptString(key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, enc, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return true;
}

/** Remove the stored key for a provider. */
export function clearApiKey(providerId: ProviderId): void {
  const path = secretsPath(providerId);
  try {
    rmSync(path);
  } catch {
    // ignore: file may not exist
  }
}

/** True when a key is on disk for the provider. The IPC handler reports
 *  this so the UI can show "configured" without exposing the key itself. */
export function hasApiKey(providerId: ProviderId): boolean {
  try {
    return statSync(secretsPath(providerId)).isFile();
  } catch {
    return false;
  }
}

function secretsPath(providerId: ProviderId): string {
  return join(app.getPath("userData"), "secrets", `${providerId}.bin`);
}

// ─── Non-secret settings (JSON file) ────────────────────────────────────────
//
// Telemetry on/off, active provider, model choice. These are not secrets
// so they live in plain JSON next to user-prefs storage.

const SETTINGS_FILE = "ai-settings.json";

export function readAiSettings(): AiSettings {
  const path = join(app.getPath("userData"), SETTINGS_FILE);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      activeProvider:
        parsed.activeProvider === "anthropic" ? "anthropic" : DEFAULT_SETTINGS.activeProvider,
      model:
        typeof parsed.model === "string" && parsed.model.length > 0
          ? parsed.model
          : DEFAULT_SETTINGS.model,
      telemetryEnabled: parsed.telemetryEnabled === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeAiSettings(patch: Partial<AiSettings>): AiSettings {
  const current = readAiSettings();
  const next: AiSettings = {
    activeProvider: patch.activeProvider === "anthropic" ? "anthropic" : current.activeProvider,
    model: patch.model ?? current.model,
    telemetryEnabled: patch.telemetryEnabled ?? current.telemetryEnabled,
  };
  const path = join(app.getPath("userData"), SETTINGS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}
