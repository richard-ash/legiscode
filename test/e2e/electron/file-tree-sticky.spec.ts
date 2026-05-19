// Sticky-header E2E tests under real Chromium + the production
// virtualizer. Covers UF8 (scroll-deep + click), UF8b (cross-depth click
// shrinks the sticky stack), UF9 (transition seam), and UF10 (collapse-
// race regression smoke — the hook-level test in
// `test/ui/left-panel/file-tree/use-roving-focus.test.ts` is the primary
// regression guard).
//
// We don't navigate to a specific corpus row by id (the virtualizer
// doesn't mount out-of-window rows for Playwright's selector engine to
// find). Instead we scroll the container programmatically — that's the
// real code path the sticky mechanism reacts to — and inspect whatever
// the renderer produces. Tests stay corpus-shape-agnostic by reading the
// post-scroll DOM state rather than asserting specific ancestor labels.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

const ROW_HEIGHT_PX = 24;

// Hermetic corpus fixture — 1 module + 1 chapter + 250 sections committed
// under test/fixtures/corpus-deep/. Mirrors the section-view spec's
// LEGISCODE_CORPUS_PATH pattern. Sticky-header tests need a tree that
// (1) crosses JSDOM_GUARD_ROW_COUNT (200) so the virtualizer engages —
// sticky behaviour is conditional on useVirtualization=true — and
// (2) is deep enough that scrollContainerTo(800) lands the topmost row
// past depth 0, so the chapter pins as the sticky ancestor. The CI
// build-pipeline produces a small SF fixture (≈14 sections) that doesn't
// clear either bar; pointing the loader here decouples these specs from
// whatever shape the CI corpus build emits.
const HERMETIC_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-deep");

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-"));
}

/**
 * Scroll the tree container by `deltaPx` and let one render frame settle.
 * Used instead of locator.scrollIntoViewIfNeeded() because under
 * virtualization the target element may not be mounted yet — Playwright's
 * scroll-into-view path waits for the element to exist, which never
 * happens for an off-window row.
 */
async function waitForTreePopulated(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelectorAll('[role="treeitem"]').length > 0,
    null,
    { timeout: 15_000 },
  );
}

async function scrollContainerTo(page: Page, targetScrollTop: number): Promise<void> {
  // Assign scrollTop directly — synchronous, no scroll-behavior
  // ambiguity. The virtualizer's scroll subscription fires immediately
  // afterward and commits a render reflecting the new offset.
  await page.evaluate((target) => {
    const container = document.querySelector('[role="tree"]') as HTMLElement | null;
    if (container) container.scrollTop = target;
  }, targetScrollTop);
  // Give React + the virtualizer a frame to flush. The useEffect that
  // syncs stickyStackHeight runs after the post-scroll commit; a brief
  // settle lets the sticky stack appear in the DOM before assertions.
  await page.waitForTimeout(150);
}

async function getStackRowCount(page: Page): Promise<number> {
  return await page.locator(".lc-tree-sticky-row").count();
}

test("UF8 — scroll-deep shows sticky stack with at least one ancestor row", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]');
    await waitForTreePopulated(page);

    // The corpus-deep fixture renders 1 module + 1 chapter + 250 sections
    // (≈6048px total), comfortably past JSDOM_GUARD_ROW_COUNT=200 so the
    // virtualizer engages. Scrolling 800px down (≈33 rows past the top)
    // reliably moves past the module's depth-0 row so the chapter pins
    // as the sticky ancestor.
    await scrollContainerTo(page, 800);

    const stack = page.locator(".lc-tree-sticky-stack");
    await expect(stack).toBeVisible();
    const stackCount = await getStackRowCount(page);
    expect(stackCount).toBeGreaterThanOrEqual(1);

    // Geometry (D16 uniform-height assumption): stack height should be
    // ≈ stackCount × 24px, with +1 tolerance for sub-pixel rendering.
    const box = await stack.boundingBox();
    expect(box, "sticky stack must have a layout box").not.toBeNull();
    if (!box) return;
    expect(box.height).toBeLessThanOrEqual(stackCount * ROW_HEIGHT_PX + 1);

    // Sticky rows carry role=presentation; the wrapper is aria-hidden so
    // none of them count as treeitems. Real treeitems must still be the
    // only AT navigation targets (D3 belt-and-suspenders).
    const stickyTreeItems = await stack.locator('[role="treeitem"]').count();
    expect(stickyTreeItems).toBe(0);
    await expect(stack).toHaveAttribute("aria-hidden", "true");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF8b — clicking a sticky ancestor LABEL preserves its expansion state (D15 split-click)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]');
    await waitForTreePopulated(page);
    await scrollContainerTo(page, 800);
    await expect(page.locator(".lc-tree-sticky-stack")).toBeVisible();

    // Read the top sticky row's label text and Playwright-click it.
    // Default click hits the row center, which lands on the label span
    // (not the chevron's leading ~16px). Per the split-click design,
    // label-area clicks scroll without mutating expansion. The
    // chevron-area click path (collapses the ancestor) is covered by
    // the unit test in sticky-header-stack.test.tsx.
    const topSticky = page.locator(".lc-tree-sticky-row").first();
    const topStickyLabel = await topSticky.locator(".lc-tree-label").textContent();
    expect(topStickyLabel).toBeTruthy();

    await topSticky.click();
    await page.waitForTimeout(100);

    // After the click, find the real treeitem with the same label and
    // assert it stayed expanded (aria-expanded="true").
    const matched = page
      .locator('[role="treeitem"]')
      .filter({ hasText: topStickyLabel ?? "" })
      .first();
    await expect(matched).toBeVisible();
    await expect(matched).toHaveAttribute("aria-expanded", "true");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF8c — clicking a sticky ancestor CHEVRON collapses it (D15 split-click)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]');
    await waitForTreePopulated(page);
    await scrollContainerTo(page, 800);
    await expect(page.locator(".lc-tree-sticky-stack")).toBeVisible();

    // Pick the bottom-most sticky row (its real treeitem is closest to
    // the viewport edge, so the post-collapse assertion can find it).
    // Read its label text so we can locate the matching real row after
    // the click, then click the chevron span explicitly — Playwright's
    // default center-click would hit the label area and route to the
    // scroll path instead.
    const stickyRows = page.locator(".lc-tree-sticky-row");
    const stickyCount = await stickyRows.count();
    expect(stickyCount).toBeGreaterThan(0);
    const bottomSticky = stickyRows.nth(stickyCount - 1);
    const bottomStickyLabel = await bottomSticky.locator(".lc-tree-label").textContent();
    expect(bottomStickyLabel).toBeTruthy();

    // Click the chevron span specifically — closest('.lc-tree-chevron')
    // in sticky-header-stack.tsx routes this to onCollapse instead of
    // onStickyClick.
    await bottomSticky.locator(".lc-tree-chevron").click();
    await page.waitForTimeout(150);

    // After the chevron click the ancestor should be collapsed. The
    // real treeitem stays in the rows list (collapse only hides
    // descendants), so find it by label and assert aria-expanded flipped
    // to "false".
    const matched = page
      .locator('[role="treeitem"]')
      .filter({ hasText: bottomStickyLabel ?? "" })
      .first();
    await expect(matched).toBeVisible();
    await expect(matched).toHaveAttribute("aria-expanded", "false");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF9 — sticky stack disappears when scrolled back to the top (seam transition)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]');
    await waitForTreePopulated(page);
    await scrollContainerTo(page, 800);
    await expect(page.locator(".lc-tree-sticky-stack")).toBeVisible();

    // Scroll all the way back to the top. The first real row is now in
    // view at its own position; useStickyHeaders' topmost-row pick is
    // the first row (depth 0), which has no ancestors. The stack
    // component returns null and falls out of the DOM entirely.
    await scrollContainerTo(page, 0);
    await expect(page.locator(".lc-tree-sticky-stack")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF10 — collapse-race smoke: ArrowLeft on expanded parent does not throw", async () => {
  // The hook-level test in use-roving-focus.test.ts is the primary
  // regression guard. This is a real-Chromium smoke confirming the
  // collapse path doesn't error and the tree settles into a valid focus
  // state under real keyboard events.
  const userDataDir = freshUserDataDir();
  const {
    app,
    window: page,
    consoleErrors,
  } = await launchApp({
    userDataDir,
    env: { LEGISCODE_CORPUS_PATH: HERMETIC_CORPUS },
  });
  try {
    await page.waitForSelector('[role="tree"]');
    await waitForTreePopulated(page);

    // Focus the first row, ArrowDown into the second row (likely an
    // expanded chapter), then ArrowLeft to collapse it. Under the
    // pending-focus / collapse-race regression, the focus stash would
    // be orphaned and steal focus on a later remount — this is the path
    // that broke before the F-pendingFocus fix landed. Assert nothing
    // throws and a treeitem still carries tabindex=0.
    const firstRow = page.locator('[role="treeitem"]').first();
    await firstRow.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(100);

    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
    const tabZero = await page.locator('[role="treeitem"][tabindex="0"]').count();
    expect(tabZero).toBeGreaterThanOrEqual(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
