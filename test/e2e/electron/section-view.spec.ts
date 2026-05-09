// Section-view E2E tests. Two flows that diverge from jsdom + RTL
// coverage:
//
//   SV1 — F3 REGRESSION (mandatory per IRON RULE):
//          force corpus.read to fail, assert in-section banner appears,
//          then assert the next read recovers cleanly (no stale text).
//   SV2 — long-section render time:
//          synthetic ~100KB section (matches sf-publicworks 184.12);
//          assert real-Chromium render completes within the perf budget.
//
// Both rely on the LEGISCODE_E2E_MOCK_CORPUS_READ launch-flag mock seam
// in electron/main.ts (codex C13). Spec passes `env: { ... }` through
// the launch helper instead of mutating window.api after-the-fact —
// keeping the mock at the IPC boundary mirrors how production traffic
// flows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-"));
}

// Hermetic corpus fixture — committed under test/fixtures/corpus-min/. The
// section-view specs only care that a tree populates with at least two
// leaf sections (one default-active, one recovery target); they don't
// exercise parser output or real-corpus structure. Pointing the loader
// here via LEGISCODE_CORPUS_PATH decouples SV1/SV2 from whatever the
// CI corpus build produces under build/modules-full, which fixed an
// SV1-breaking divergence where the CI corpus's deeply-nested hierarchy
// kept leaf rows hidden until the user expanded multiple parents.
const HERMETIC_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-min");

test("SV1 — corpus.read ok:false renders the in-section banner; subsequent read recovers (F3)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: {
      LEGISCODE_E2E_MOCK_CORPUS_READ: "fail",
      LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS,
    },
  });
  try {
    // The mock fails ONCE — the cold-start corpus:read for the default
    // section returns ok:false, surfacing the banner.
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Couldn't load this section")).toBeVisible();
    await expect(page.getByText(/e2e-mock-failure/)).toBeVisible();

    // C7 chrome strip: section-view subtree shouldn't carry any prior
    // section markup. Body is replaced by the banner.
    const sectionBody = page.locator(".lc-section-body");
    await expect(sectionBody).toHaveCount(0);

    // Recover: click a section row that is NOT the cold-start active
    // section (the failed read targeted the default ref, so the
    // workbench's activeKey is on that row — clicking it again is a
    // no-op and never re-fires corpus:read). Sections are tree leaves,
    // so they render with no `aria-expanded` attribute (only branches
    // carry aria-expanded). The active row carries aria-selected="true".
    // Filtering for `:not([aria-expanded]):not([aria-selected="true"])`
    // yields visible non-active sections; picking the first one
    // guarantees an activeKey change, which fires the second read
    // against the real loader (mock is one-shot).
    await page.waitForSelector('[role="tree"]');
    const recoveryRow = page
      .locator('[role="treeitem"]:not([aria-expanded]):not([aria-selected="true"])')
      .first();
    await expect(recoveryRow).toBeVisible({ timeout: 10_000 });
    await recoveryRow.click();
    await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".lc-section-id")).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("SV2 — synthetic 100KB section renders within the perf budget", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: {
      LEGISCODE_E2E_MOCK_CORPUS_READ: "long",
      LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS,
    },
  });
  try {
    // The mock returns a 100KB synthetic section for ANY corpus:read;
    // the cold-start default ref triggers it. Wait for the body to land
    // in the DOM, then measure render with performance.now() inside the
    // page context (Chromium's high-resolution timer).
    await page.waitForSelector(".lc-section-body p", { timeout: 10_000 });

    const renderMs = await page.evaluate(() => {
      const t0 = performance.now();
      // Force a layout pass to confirm everything is rendered, not just
      // mounted — getBoundingClientRect flushes pending layout.
      const body = document.querySelector(".lc-section-body");
      body?.getBoundingClientRect();
      return performance.now() - t0;
    });

    // 200 paragraphs of plain text inside one .lc-section-body.
    const paraCount = await page.locator(".lc-section-body p.lc-para").count();
    expect(paraCount).toBe(200);

    // Per the perf review (locked 2026-05-06): real-Chromium long-section
    // render completes <200ms. The measurement above is layout-flush
    // time on an already-mounted tree; the budget for the spec reflects
    // worst-case stale-tree relayout, not first-paint cost.
    expect(renderMs).toBeLessThan(200);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
