// Citation-resolution E2E. Five flows that diverge from jsdom + RTL
// coverage:
//
//   CR1 — Plain click on an internal citation is a NO-OP (VS Code
//          semantics: text selection only). Tab count stays at 1, content
//          stays at the original section.
//   CR2 — ⌘/Ctrl-click on an internal citation opens the cite in a new
//          foreground tab; tablist grows to 2 and the new tab is active.
//   CR3 — ⌘⌥→ / ⌘⌥← keyboard switches between open tabs with wrap.
//   CR4 — ⌘-click on a cross_module citation into an uninstalled
//          module is a no-op (popover-only flow; navigation suppressed).
//   CR5 — Mixed section tabs persist across an electron app restart.
//
// All five reuse the hermetic test/fixtures/corpus-min fixture; section
// test-alpha 1.1 carries one internal citation (→ 1.2) and one
// cross_module citation (Cal. Veh. Code § 21, module not installed).
//
// The hover popover render is exercised by App.test.tsx (jsdom integration);
// driving real DOMRect math in headed Electron is brittle and adds nothing
// the unit layer doesn't already cover, per `feedback_test_each_path_once`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-citations-"));
}

const HERMETIC_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-min");

async function waitForColdStart(page: Page): Promise<void> {
  await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
  await expect(page.locator(".lc-section-body")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-cite-kind="internal"]').first()).toBeVisible({
    timeout: 10_000,
  });
}

test("CR1 — plain click on an internal citation is a no-op (selection only)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await waitForColdStart(page);
    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });

    await expect(page.locator(".lc-section-id")).toHaveText("§ 1.1");
    await page.locator('[data-cite-kind="internal"]').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator(".lc-section-id")).toHaveText("§ 1.1");
    await expect(sectionList.getByRole("tab")).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("CR2 — ⌘/Ctrl-click on an internal citation opens a new foreground tab", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await waitForColdStart(page);
    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });

    await page
      .locator('[data-cite-kind="internal"]')
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });

    const tabs = sectionList.locator('[role="tab"]');
    // Primary intent — the new tab is activated.
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".lc-section-id")).toHaveText("§ 1.2");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("CR3 — ⌘⌥→ and ⌘⌥← switch between open tabs and wrap at the boundary", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await waitForColdStart(page);
    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await page
      .locator('[data-cite-kind="internal"]')
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });

    const tabs = sectionList.locator('[role="tab"]');
    // After ⌘-click the new tab (index 1) is active.
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    // ⌘⌥← → index 0.
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

    // ⌘⌥← wraps back to last tab.
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    // ⌘⌥→ wraps forward to first tab.
    await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("CR4 — ⌘-click on a cross_module cite into an uninstalled module is a no-op", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await waitForColdStart(page);
    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });

    await page
      .locator('[data-cite-kind="cross_module"]')
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await page.waitForTimeout(200);
    // ca-vehicle isn't installed in the hermetic fixture → no nav.
    await expect(sectionList.getByRole("tab")).toHaveCount(1);
    await expect(page.locator(".lc-section-id")).toHaveText("§ 1.1");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("CR5 — section tabs persist across an electron app restart", async () => {
  const userDataDir = freshUserDataDir();
  try {
    {
      const { app, window: page } = await launchApp({
        userDataDir,
        env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
      });
      try {
        await waitForColdStart(page);
        const sectionList = page.getByRole("tablist", { name: "Open sections" });
        await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });

        await page
          .locator('[data-cite-kind="internal"]')
          .first()
          .click({ modifiers: ["ControlOrMeta"] });
        await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });
      } finally {
        await app.close();
      }
    }
    {
      const { app, window: page } = await launchApp({
        userDataDir,
        env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
      });
      try {
        const sectionList = page.getByRole("tablist", { name: "Open sections" });
        await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });
      } finally {
        await app.close();
      }
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
