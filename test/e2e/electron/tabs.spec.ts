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
const HERMETIC_CORPUS_DEEP = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-deep");

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

test("TAB-PIN — TabStrip + Breadcrumb stay pinned while .lc-doc scrolls", async () => {
  // Regression guard for the .lc-center flex-chain pin. jsdom can't run
  // layout, so test/ui/tabs/scroll-pins-strip.test.tsx only verifies
  // CSS rules + DOM shape. This e2e runs real Chromium against a long
  // section and asserts the chrome stays at its initial Y after the
  // scroller advances. The bug class is "a wrapper between .lc-center
  // and .lc-doc breaks the chain, OR .lc-center isn't height-anchored
  // to its panel" — the structural unit test misses both unless paired
  // with a real-layout check at this altitude.
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: {
      LEGISCODE_E2E_MOCK_CORPUS_READ: "long",
      LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS,
    },
  });
  try {
    // Wait for the long-section body to land in the DOM. The synthetic
    // 200-paragraph body is ~30x viewport height, so scrollTop has plenty
    // of headroom.
    await page.waitForSelector(".lc-section-body p", { timeout: 10_000 });

    const tabsRow = page.locator(".lc-tabs-row");
    const breadcrumb = page.locator(".lc-breadcrumb");
    const doc = page.locator(".lc-doc");

    const beforeTabsTop = (await tabsRow.boundingBox())?.y;
    const beforeBreadcrumbTop = (await breadcrumb.boundingBox())?.y;
    if (beforeTabsTop === undefined || beforeBreadcrumbTop === undefined) {
      throw new Error("pinned chrome has no bounding box pre-scroll");
    }

    // Advance the scroller. Direct scrollTop assignment is synchronous
    // and skips smooth-scroll ambiguity — mirrors file-tree-sticky.spec.
    await doc.evaluate((el) => {
      el.scrollTop = 800;
    });
    // Confirm the scroller actually moved — guards against the assertion
    // passing because nothing happened.
    const scrollTop = await doc.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    const afterTabsTop = (await tabsRow.boundingBox())?.y;
    const afterBreadcrumbTop = (await breadcrumb.boundingBox())?.y;
    if (afterTabsTop === undefined || afterBreadcrumbTop === undefined) {
      throw new Error("pinned chrome has no bounding box post-scroll");
    }

    // The chrome is pinned by the flex chain — any vertical drift means
    // the chain re-broke. Allow zero tolerance: this is not animated.
    expect(afterTabsTop).toBe(beforeTabsTop);
    expect(afterBreadcrumbTop).toBe(beforeBreadcrumbTop);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("TAB-SIZE — active tab stays at least 220px wide at N=15", async () => {
  // jsdom can't compute layout, so the sizing CSS contract test
  // (test/ui/tabs/sizing.test.tsx) only verifies the declared rules.
  // The load-bearing claim is behavioral: at high tab count, the active
  // tab still gets enough width to read a typical section label
  // (e.g. "§ 10.04.020 · Sales Tax Definitions"). Pre-seed localStorage
  // with 15 OpenItems against corpus-deep, reload, then assert the
  // active tab's bounding box width.
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS_DEEP },
  });
  try {
    // Wait until corpus has loaded so localStorage write isn't clobbered
    // by the cold-start hydration.
    await page.waitForSelector('[role="tree"]', { timeout: 15_000 });

    const items = Array.from({ length: 15 }, (_, i) => ({
      kind: "section" as const,
      ref: { module: "sf-deep", section: `1.${i + 1}` },
    }));
    await page.evaluate((openItems) => {
      window.localStorage.setItem(
        "legiscode.openItems",
        JSON.stringify({ items: openItems, activeIndex: 7 }),
      );
    }, items);
    await page.reload({ waitUntil: "load" });

    const sectionList = page.getByRole("tablist", { name: "Open sections" });
    await expect(sectionList.getByRole("tab")).toHaveCount(15, { timeout: 15_000 });

    const active = sectionList.locator('[role="tab"][aria-selected="true"]');
    await expect(active).toHaveCount(1);
    const box = await active.boundingBox();
    expect(box).not.toBeNull();
    // 220px = the readable-label floor locked in commit 2's CSS. If a
    // future change drops the `flex: 2 0 auto` rule, every tab equalizes
    // and this assertion fires loud at N=15.
    expect(box!.width).toBeGreaterThanOrEqual(220);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
