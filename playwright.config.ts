// Playwright config for Electron E2E. Runs against the BUILT artifact
// (out/main/main.js), not the dev server — these tests assert that the
// production launch path works, which is the layer where preload-format
// regressions and missing-CSP regressions hide. The unit suite mocks
// window.api and never launches Electron, so this config is the only line
// of defense for posture invariants.
//
// `mise run test:e2e` is the entry point and chains `electron-vite build`
// first so out/ is fresh.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.ts$/,
  // Electron sessions are not parallel-safe — they share localStorage and
  // window-bounds state via the OS. Single worker keeps state isolated.
  fullyParallel: false,
  workers: 1,
  // Tests are short (window-open + a handful of evaluates); a 30s ceiling
  // catches a hung launch without padding the happy path.
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
  },
});
