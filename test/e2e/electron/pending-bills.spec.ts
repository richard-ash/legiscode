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

test("PB4 — section pending rail surfaces the Original · Changes · Proposed segmented control", async () => {
  // The hermetic bill 990001 amends test-alpha §1.1. When we navigate
  // to §1.1, the section-pending-rail surfaces with the three-mode
  // segmented control. Clicking Changes / Proposed re-renders the
  // body; clicking Original clears the overlay. This covers the
  // user-facing surface that the unit tests can't: real Electron
  // renders, real CSS, real state machine.
  const userDataDir = freshUserDataDir();
  try {
    const { app, window: page } = await launchApp({
      userDataDir,
      env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
    });
    try {
      await page.waitForSelector('[role="tree"]', { timeout: 10_000 });

      // Open §1.1 via the bill's Amends chip.
      await page.locator('[data-bill-id="990001"]').first().click();
      await page.getByRole("heading", { name: /Hermetic Test Ordinance/ }).waitFor();
      await page.locator(".lc-amends-chip", { hasText: "§ 1.1" }).click();

      // Rail is visible with all three mode buttons. The pending rail
      // is the aside containing the "1 pending ordinance" label.
      const rail = page.locator(".lc-section-pending-rail");
      await expect(rail).toBeVisible({ timeout: 5_000 });
      await expect(rail.getByRole("button", { name: "Original" })).toBeVisible();
      await expect(rail.getByRole("button", { name: "Changes" })).toBeVisible();
      await expect(rail.getByRole("button", { name: "Proposed" })).toBeVisible();

      // Original is the resting state — section body renders without
      // the overlay class.
      expect(await page.locator(".lc-section-body--overlay").count()).toBe(0);

      // Click Changes — body re-renders as the structured diff
      // overlay. The data-overlay-mode attribute carries the mode for
      // downstream debugging.
      await rail.getByRole("button", { name: "Changes" }).click();
      const overlay = page.locator(".lc-section-body--overlay");
      await expect(overlay).toBeVisible();
      await expect(overlay).toHaveAttribute("data-overlay-mode", "changes");
      // Bill 990001 carries one equal + one insert chunk, so a
      // diff_insert span is present.
      await expect(overlay.locator(".lc-overlay-insert")).toHaveCount(1);

      // Click Proposed — body re-renders without diff marks.
      await rail.getByRole("button", { name: "Proposed" }).click();
      await expect(overlay).toHaveAttribute("data-overlay-mode", "proposed");
      await expect(overlay.locator(".lc-overlay-insert")).toHaveCount(0);
      await expect(overlay.locator(".lc-overlay-delete")).toHaveCount(0);

      // Click Original — overlay clears.
      await rail.getByRole("button", { name: "Original" }).click();
      expect(await page.locator(".lc-section-body--overlay").count()).toBe(0);
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
