// Provider resolution. Looks up the active provider's stored key via
// safeStorage and constructs the adapter. Centralized here so the
// conversation loop never reaches into safeStorage or the SDK directly.

import { AnthropicAdapter } from "./anthropic";
import type { ModelProvider } from "./types";

export type ProviderId = "anthropic";

export interface ProviderFactoryDeps {
  /** Reads the per-provider API key from safeStorage. Returns null
   *  when the key is missing or the buffer cannot be decrypted. */
  readApiKey(providerId: ProviderId): string | null;
}

/**
 * Build the active provider. Returns null when no key is configured —
 * the IPC handler maps null to a "no provider configured" tool_error so
 * the model writes honest prose telling the user to add a key in
 * Settings.
 */
export function buildProvider(
  providerId: ProviderId,
  deps: ProviderFactoryDeps,
): ModelProvider | null {
  const apiKey = deps.readApiKey(providerId);
  if (!apiKey) return null;
  switch (providerId) {
    case "anthropic":
      return new AnthropicAdapter({ apiKey });
  }
}

export {
  ANTHROPIC_AVAILABLE_MODELS,
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicAdapter,
} from "./anthropic";
export {
  type ModelProvider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
} from "./types";
