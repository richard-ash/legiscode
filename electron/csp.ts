// Content-Security-Policy builders. Extracted from main.ts so the rules can
// be unit-tested without standing up the Electron module graph. main.ts
// installs the headers via `session.defaultSession.webRequest.onHeadersReceived`;
// docs/SECURITY.md mirrors what each profile allows.

/**
 * Dev CSP — permissive enough for Vite's HMR socket and inline-script
 * fast-refresh runtime, strict on everything else. The ws:// source is
 * required for HMR; without it Vite's reload loop dies silently.
 */
export function buildDevCsp(): string[] {
  return [
    [
      "default-src 'self' http://localhost:5173 ws://localhost:5173",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173",
      "style-src 'self' 'unsafe-inline' http://localhost:5173 https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self' http://localhost:5173 ws://localhost:5173",
    ].join("; "),
  ];
}

/**
 * Prod CSP — strict. The Anthropic API connect-src extension is owned by
 * `feat/ai-agent` (TODOS.md "CSP connect-src extension for Anthropic API").
 */
export function buildProdCsp(): string[] {
  return [
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  ];
}
