// Pending-bills E2E. Covers the cross-component flows where real
// Chromium / real IPC / real localStorage diverge from jsdom + RTL:
//
//   PB1 — Activity panel renders the seeded hermetic pending bill,
//         clicking the row opens a bill tab with the kicker + h1.
//   PB2 — Bill tab's Amends chip opens the affected section.
//   PB3 — Splitter persistence: drag/keyboard-nudge, quit + restart,
//         the persisted height survives.
//
// The fixture corpus at test/fixtures/corpus-min carries one pending
// bill (file_no 990001) in test-alpha — hermetic per
// `project_tests_are_hermetic`, no live Legistar fetch. The Open in
// Legistar IPC wiring is exercised at unit-test level (BillView click
// → onOpenLegistar; main-side handler in shell-handler.test.ts);
// asserting the full preload-frozen chain here would require an
// additional e2e seam and provides little marginal coverage.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-bills-"));
}

const HERMETIC_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-min");

test("PB1 — activity panel surfaces seeded pending bills; clicking a row opens a bill tab", async () => {
  const userDataDir = freshUserDataDir();
  try {
    const { app, window: page } = await launchApp({
      userDataDir,
      env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
    });
    try {
      await page.waitForSelector('[role="tree"]', { timeout: 10_000 });

      // Activity panel header carries the pending count.
      const activityHeader = page.getByRole("button", { name: /Activity/ });
      await expect(activityHeader).toBeVisible({ timeout: 10_000 });
      await expect(activityHeader).toContainText(/pending/);

      // Seeded bill row is in the list.
      const billRow = page.locator('[data-bill-id="990001"]').first();
      await expect(billRow).toBeVisible({ timeout: 10_000 });

      // Click → opens a bill tab.
      await billRow.click();
      const sectionList = page.getByRole("tablist", { name: "Open sections" });
      const billTab = sectionList.locator('[role="tab"][data-kind="bill"]');
      await expect(billTab).toHaveCount(1, { timeout: 5_000 });

      // Bill view shows the title.
      await expect(page.getByRole("heading", { name: /Hermetic Test Ordinance/ })).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await app.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("PB2 — clicking an Amends chip opens the affected section", async () => {
  const userDataDir = freshUserDataDir();
  try {
    const { app, window: page } = await launchApp({
      userDataDir,
      env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
    });
    try {
      await page.waitForSelector('[role="tree"]', { timeout: 10_000 });

      // Open the bill tab.
      await page.locator('[data-bill-id="990001"]').first().click();
      await page.getByRole("heading", { name: /Hermetic Test Ordinance/ }).waitFor();

      // Chip for §1.1 opens that section as a new tab. Scope to the
      // amends-chip class so we don't collide with the tab strip's
      // close button (which carries "Close § 1.1 …" as its
      // aria-label).
      const chip = page.locator(".lc-amends-chip", { hasText: "§ 1.1" });
      await chip.click();

      const sectionList = page.getByRole("tablist", { name: "Open sections" });
      const sectionTab = sectionList.locator('[role="tab"][data-kind="section"]');
      // The seeded default section is also kind=section, so there can
      // be more than one — the active one is the freshly opened §1.1.
      const activeTab = sectionList.locator('[role="tab"][aria-selected="true"]');
      await expect(activeTab).toHaveAttribute("data-kind", "section");
      await expect(sectionTab.first()).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("PB3 — splitter state survives an app restart", async () => {
  const userDataDir = freshUserDataDir();
  try {
    // Round 1 — open, nudge the splitter via the keyboard, quit.
    {
      const { app, window: page } = await launchApp({
        userDataDir,
        env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
      });
      try {
        await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
        const splitter = page.locator(".lc-splitter");
        await expect(splitter).toBeVisible({ timeout: 5_000 });
        await splitter.focus();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        // Wait briefly for the commit + write to fire.
        await page.waitForTimeout(80);
      } finally {
        await app.close();
      }
    }

    // Round 2 — relaunch with the same userDataDir; assert the
    // persisted height was read back.
    {
      const { app, window: page } = await launchApp({
        userDataDir,
        env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
      });
      try {
        await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
        const persisted = await page.evaluate(() =>
          window.localStorage.getItem("legiscode.activityPane"),
        );
        expect(persisted).not.toBeNull();
        const parsed = JSON.parse(persisted ?? "{}") as { height?: number };
        // Default is 0.45; two ArrowDown nudges grow the bottom pane by
        // 0.10 to 0.55.
        expect(parsed.height).toBeCloseTo(0.55, 1);
      } finally {
        await app.close();
      }
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
