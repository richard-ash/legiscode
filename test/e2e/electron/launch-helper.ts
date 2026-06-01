// Shared launcher for the built Electron artifact. Used by every E2E spec.
// Centralizing the launch keeps the args/env contract consistent — if the
// posture test passes window.api but the smoke test fails to find the tree,
// the divergence is in the spec, not the launch shape.

import { resolve } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..", "..", "..");
const mainEntry = resolve(projectRoot, "out", "main", "main.js");

export interface LaunchOptions {
  /**
   * Override Electron's user-data directory (where localStorage etc. is
   * persisted). Tests that mutate persistent state pass a per-test
   * temp dir so they don't leak into the developer's real app data.
   */
  userDataDir?: string;
  /**
   * Extra environment variables forwarded into the spawned Electron
   * process. Used by the section-view spec to inject
   * `LEGISCODE_E2E_MOCK_CORPUS_READ` so the main-process corpus:read
   * handler returns synthetic data without touching the real loader.
   */
  env?: Record<string, string>;
}

export async function launchApp(opts: LaunchOptions = {}): Promise<{
  app: ElectronApplication;
  window: Page;
  consoleErrors: string[];
}> {
  const consoleErrors: string[] = [];

  const args = [mainEntry];
  if (opts.userDataDir !== undefined) {
    args.push(`--user-data-dir=${opts.userDataDir}`);
  }

  const app = await electron.launch({
    args,
    // ELECTRON_RENDERER_URL is intentionally NOT set — that drives main.ts to
    // load out/renderer/index.html via file://, exercising the same path that
    // a packaged build will use.
    env: {
      ...process.env,
      // Suppress Electron's "Insecure Content-Security-Policy" warning in
      // E2E logs; the prod CSP is what we assert in posture.spec.ts.
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...(opts.env ?? {}),
    },
    cwd: projectRoot,
  });

  const window = await app.firstWindow();
  window.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
  });

  // Wait for the full load event (did-finish-load) — the renderer's DOM and
  // assets are ready. main.ts's `mainWindow.show()` is gated on load AND
  // corpusReady, so window visibility may still be a tick behind here.
  // Specs that care about visibility poll explicitly via expect.poll.
  await window.waitForLoadState("load");

  return { app, window, consoleErrors };
}
