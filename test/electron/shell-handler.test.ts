// Protocol allowlist + happy-path coverage for handleShellOpenExternal.
// Drives the handler with a mock `openExternal` so the test runs in plain
// Node — no electron import, no IPC plumbing.

import { describe, expect, it, vi } from "vitest";
import { handleShellOpenExternal } from "../../electron/shell-handler";

function recorderOpenExternal() {
  const calls: string[] = [];
  return {
    calls,
    openExternal: vi.fn(async (url: string) => {
      calls.push(url);
    }),
  };
}

describe("handleShellOpenExternal", () => {
  it("opens an https URL and returns ok", async () => {
    const rec = recorderOpenExternal();
    const result = await handleShellOpenExternal(
      { url: "https://leginfo.legislature.ca.gov/x" },
      { openExternal: rec.openExternal },
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(rec.calls).toEqual(["https://leginfo.legislature.ca.gov/x"]);
  });

  it("opens an http URL", async () => {
    const rec = recorderOpenExternal();
    const result = await handleShellOpenExternal(
      { url: "http://example.com/" },
      { openExternal: rec.openExternal },
    );
    expect(result.ok).toBe(true);
    expect(rec.calls).toEqual(["http://example.com/"]);
  });

  it("rejects file:// URLs without invoking shell.openExternal", async () => {
    const rec = recorderOpenExternal();
    const result = await handleShellOpenExternal(
      { url: "file:///etc/passwd" },
      { openExternal: rec.openExternal },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_url" } });
    expect(rec.openExternal).not.toHaveBeenCalled();
  });

  it("rejects javascript: URLs without invoking shell.openExternal", async () => {
    const rec = recorderOpenExternal();
    const result = await handleShellOpenExternal(
      { url: "javascript:alert(1)" },
      { openExternal: rec.openExternal },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_url" } });
    expect(rec.openExternal).not.toHaveBeenCalled();
  });

  it("rejects custom-scheme URLs (slack://, vscode://) without invoking shell.openExternal", async () => {
    const rec = recorderOpenExternal();
    const slack = await handleShellOpenExternal(
      { url: "slack://channel/T123" },
      { openExternal: rec.openExternal },
    );
    expect(slack).toMatchObject({ ok: false, error: { kind: "invalid_url" } });
    const vscode = await handleShellOpenExternal(
      { url: "vscode://file/Users/me/secret" },
      { openExternal: rec.openExternal },
    );
    expect(vscode).toMatchObject({ ok: false, error: { kind: "invalid_url" } });
    expect(rec.openExternal).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs without invoking shell.openExternal", async () => {
    const rec = recorderOpenExternal();
    const result = await handleShellOpenExternal(
      { url: "not a url" },
      { openExternal: rec.openExternal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "invalid_url", detail: /not a URL/ },
    });
    expect(rec.openExternal).not.toHaveBeenCalled();
  });

  it("returns platform_error when shell.openExternal rejects", async () => {
    const openExternal = vi.fn(async () => {
      throw new Error("xdg-open: command not found");
    });
    const result = await handleShellOpenExternal({ url: "https://example.com/" }, { openExternal });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "platform_error", detail: "xdg-open: command not found" },
    });
  });
});
