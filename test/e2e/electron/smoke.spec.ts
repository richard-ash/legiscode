// Smoke test — the broadest E2E gate. If this fails, no other E2E will pass,
// and the user sees a blank window or crash dialog on first launch. Asserts:
//   1. Electron launches and a BrowserWindow opens.
//   2. The renderer mounts (root element has children).
//   3. The structure tree shows the corpus code count (proves IPC round-trip
//      from main → preload → renderer succeeded).
//   4. No console errors fired during boot.
//
// This is the test that would have caught the sandboxed-ESM-preload bug:
// preload silently failed → window.api missing → ipc-client threw → React
// unmounted the tree → root empty. Step 2 alone catches that whole cascade.

import { expect, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

test("electron app boots into a populated chrome shell", async () => {
  const { app, window, consoleErrors } = await launchApp();

  try {
    // 1. Window opens and becomes visible. Polled because main.ts gates
    //    show() on Promise.all([did-finish-load, corpusReady]); the load
    //    event in launch-helper resolves on did-finish-load alone, so
    //    visibility lags by however long corpus loading takes.
    await expect
      .poll(
        async () =>
          await app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            return win?.isVisible() ?? false;
          }),
        { timeout: 10_000, message: "BrowserWindow never became visible" },
      )
      .toBe(true);

    // 2. React mounted — #root has rendered children. Empty #root would
    //    indicate the App component threw during mount.
    const rootHtml = await window.evaluate(() => document.getElementById("root")?.innerHTML ?? "");
    expect(rootHtml.length).toBeGreaterThan(0);

    // 3. Structure tree populated with corpus codes. The fixture corpus at
    //    build/modules/ has 18 SF code modules; assert at least one
    //    rather than pinning the exact count so the test survives corpus
    //    regeneration.
    const codeCountText = await window.locator(".lc-leftpanel-title-count").first().textContent();
    expect(codeCountText).toMatch(/\d+ codes/);
    const count = Number.parseInt(codeCountText?.match(/(\d+) codes/)?.[1] ?? "0", 10);
    expect(count).toBeGreaterThan(0);

    // 4. No console errors during boot. Warnings are tolerated; errors are
    //    not — they indicate either a CSP violation, a failed asset, or an
    //    unhandled exception.
    expect(consoleErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
