// Main-process handler for `shell:openExternal`. Lives outside main.ts so
// the protocol-allowlist gate is testable without driving the full
// Electron app lifecycle — `openExternal` is injected so tests substitute
// a recording mock instead of stubbing the entire electron module.
//
// Security: `shell.openExternal` hands the URL to the OS, which honors
// `file://`, custom-scheme registrations (`slack://`, `vscode://`), and
// on some platforms `javascript:`. Without this gate, a future renderer
// XSS could pop arbitrary local files or auto-launch other installed
// apps. We allowlist http(s) explicitly; everything else returns
// `invalid_url` without invoking the shell.

import type { ShellOpenExternalRequest, ShellOpenExternalResult } from "@/corpus/wire";

export interface ShellHandlerDeps {
  /** Injected `shell.openExternal`. Resolves on success; rejects when the
   *  platform can't open the URL (e.g. xdg-open missing). */
  openExternal: (url: string) => Promise<void>;
}

export async function handleShellOpenExternal(
  req: ShellOpenExternalRequest,
  deps: ShellHandlerDeps,
): Promise<ShellOpenExternalResult> {
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    return { ok: false, error: { kind: "invalid_url", detail: `not a URL: ${req.url}` } };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: { kind: "invalid_url", detail: `unsupported protocol: ${parsed.protocol}` },
    };
  }
  try {
    await deps.openExternal(req.url);
    return { ok: true, value: undefined };
  } catch (e) {
    return {
      ok: false,
      error: { kind: "platform_error", detail: e instanceof Error ? e.message : String(e) },
    };
  }
}
