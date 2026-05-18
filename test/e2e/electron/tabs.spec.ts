// Tab-strip E2E. Two flows that diverge from jsdom + RTL coverage:
//
//   TAB1 — Tab persistence across electron app restart:
//          open §B from the tree on top of the cold-start default
//          section, quit, relaunch with the SAME user-data dir, assert
//          both tabs hydrate and the active tab is restored.
//   TAB2 — Smoke: open §A, open §B via tree, both tabs visible, switch
//          back via tab click.
//
// Both reuse the hermetic test/fixtures/corpus-min fixture used by
// section-view.spec.ts so the tree leaves are predictable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-tabs-"));
}

const HERMETIC_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-min");

test("TAB1 — tab list + active tab persist across app restart", async () => {
  const userDataDir = freshUserDataDir();
  try {
    // Round 1: launch, open a second tab from the tree, quit.
    {
      const { app, window: page } = await launchApp({
        userDataDir,
        env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
      });
      try {
        await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
        const sectionList = page.getByRole("tablist", { name: "Open sections" });
        await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });
        // Click a non-active leaf to open a second tab.
        const secondLeaf = page
          .locator('[role="treeitem"]:not([aria-expanded]):not([aria-selected="true"])')
          .first();
        await expect(secondLeaf).toBeVisible({ timeout: 10_000 });
        await secondLeaf.click();
        await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });
        // The just-opened tab is active.
        const activeTabRound1 = sectionList.locator('[role="tab"][aria-selected="true"]');
        await expect(activeTabRound1).toHaveCount(1);
      } finally {
        await app.close();
      }
    }

    // Round 2: relaunch with the same userDataDir; expect 2 tabs + same active.
    {
      const { app, window: page } = await launchApp({
        userDataDir,
        env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
      });
      try {
        const sectionList = page.getByRole("tablist", { name: "Open sections" });
        await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });
        // Same tab is still active — the second one we opened, which sits
        // at index 1 in the strip.
        const tabs = sectionList.locator('[role="tab"]');
        await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      } finally {
        await app.close();
      }
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("TAB2 — smoke: open §A, open §B, both visible, switch back via click", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await expect(sectionList.getByRole("tab")).toHaveCount(1, { timeout: 10_000 });

    // Open a second section.
    const secondLeaf = page
      .locator('[role="treeitem"]:not([aria-expanded]):not([aria-selected="true"])')
      .first();
    await secondLeaf.click();
    await expect(sectionList.getByRole("tab")).toHaveCount(2, { timeout: 10_000 });

    // Capture the two tab labels for back-switching.
    const tabs = sectionList.locator('[role="tab"]');
    const firstTab = tabs.nth(0);
    const secondTab = tabs.nth(1);
    await expect(secondTab).toHaveAttribute("aria-selected", "true");

    // Click the first tab → active flips back.
    await firstTab.click();
    await expect(firstTab).toHaveAttribute("aria-selected", "true");
    await expect(secondTab).toHaveAttribute("aria-selected", "false");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
