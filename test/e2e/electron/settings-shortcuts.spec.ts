// Settings → Keyboard Shortcuts E2E. Covers the flows that diverge from
// jsdom coverage: the tab actually opens as a real tab (not a modal),
// ⌘, focuses the already-open tab instead of duplicating it, and closing
// it returns to the section that was active. Reuses the hermetic
// corpus-min fixture so the cold-start section tab is predictable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-settings-"));
}

const HERMETIC_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-min");

test("SET1 — open Settings from the titlebar, ⌘, focuses it, close returns to section", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });

    // Open the titlebar settings dropdown, then the Keyboard Shortcuts item.
    // Scope to the titlebar — the chat panel's "Open AI settings" button
    // also has the accessible name "Settings", so a page-scoped lookup
    // hits strict-mode.
    const titlebar = page.getByTestId("titlebar");
    await titlebar.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("menuitem", { name: /Keyboard Shortcuts/ }).click();

    // A real Settings tab opened, rendering the read-only shortcut page.
    const settingsTab = sectionList.locator('[role="tab"]', { hasText: "Settings" });
    await expect(settingsTab).toHaveCount(1, { timeout: 5_000 });
    await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
    await expect(settingsTab).toHaveAttribute("aria-selected", "true");

    // ⌘, focuses the already-open tab — it must not duplicate.
    await page.keyboard.press("Meta+,");
    await expect(settingsTab).toHaveCount(1);
    await expect(settingsTab).toHaveAttribute("aria-selected", "true");

    // Close the Settings tab → it's gone and a section tab is active again.
    await settingsTab.getByRole("button", { name: /Close Settings/ }).click();
    await expect(sectionList.locator('[role="tab"]', { hasText: "Settings" })).toHaveCount(0, {
      timeout: 5_000,
    });
    const active = sectionList.locator('[role="tab"][aria-selected="true"]');
    await expect(active).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
