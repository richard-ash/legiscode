// Cross-platform titlebar smoke. The custom titlebar (`titleBarStyle:
// 'hiddenInset'` on macOS, `titleBarOverlay` on Windows 11+) is design-load-
// bearing per the Claude Design handoff but easy to break per-platform — a
// CSS rule that works on macOS may misalign on Windows because the OS-drawn
// window controls live on opposite sides. This spec runs on each native
// runner in build-matrix.yml and asserts:
//   1. The titlebar mounts (`[data-testid="titlebar"]`).
//   2. The brand mark + LegisCode wordmark render.
//   3. The workspace chip renders with the corpus's rootLabel (proves IPC +
//      App.tsx wired the corpus through to TitleBar).
//   4. None of the Phase-1-hidden elements are rendered (sync indicator,
//      Bell, Share). Per A15/A16/A20/A21 (`feat/electron-shell` plan-design-
//      review): each lands with its owning branch; if one drifts back into
//      the chrome from a verbatim mockup re-fetch, this test fails.
// Closes the "Cross-platform titlebar CI matrix" TODO.
//
// Note on traffic-light / window-control assertions: the OS draws those
// outside the renderer, so Playwright can't see them. Confidence on that
// path comes from manual inspection on the matrix runner artifacts.

import { expect, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

test("titlebar renders Phase-1 chrome on every platform", async () => {
  const { app, window } = await launchApp();

  try {
    // 1. Titlebar mounts and is visible.
    const titlebar = window.locator('[data-testid="titlebar"]');
    await expect(titlebar).toBeVisible();

    // 2. Brand mark (SVG) and wordmark.
    await expect(titlebar.locator(".lc-brand-mark")).toBeVisible();
    await expect(titlebar.locator(".lc-brand-name")).toContainText("LegisCode");

    // 3. Workspace chip is the palette entry point. Asserts the chip renders
    //    with a non-empty workspace label (rootLabel from corpus IPC) and the
    //    visible palette kbd hint. The hint is platform-aware (drawn from the
    //    shortcut catalog via formatBinding) — "⌘P" on macOS, "Ctrl+P" on
    //    Windows — so the matrix runners each assert their own glyph. We don't
    //    pin the exact label text — corpus rootLabel format may shift;
    //    "non-empty" + chip wiring is what this spec defends. The chip always
    //    contains a literal "/" separator between workspaceLabel and
    //    fileLabel, so the workspace label has its own data-testid hook in
    //    title-bar.tsx — checking the chip's full textContent would pass even
    //    with empty rootLabel because of the separator alone.
    const chip = titlebar.locator(".lc-workspace-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/⌘P|Ctrl\+P/);
    // The workspace-label span is initially empty — App.tsx renders the chip
    // before the corpus IPC resolves, so workspaceLabel transitions from ""
    // to corpus.rootLabel. Use Playwright's auto-retrying assertion so the
    // test waits for the wiring to complete; a snapshot read of textContent
    // races the IPC and would assert on the empty initial value. This is
    // the regression Codex flagged when the assertion was on the chip's
    // total textContent (which always contains the literal "/" separator).
    const workspaceLabel = chip.locator('[data-testid="workspace-label"]');
    await expect(workspaceLabel).toContainText(/\S/);

    // 4. Phase-1-hidden elements stay hidden. Per TODOS.md ("Re-enable
    //    Phase-1-hidden chrome elements when their backing systems ship"):
    //    sync indicator → feat/module-manager; Bell + Share → owning
    //    branches TBD. Each must NOT be in the DOM until its branch ships.
    await expect(titlebar.locator(".lc-sync")).toHaveCount(0);
    await expect(titlebar.locator('[aria-label="Notifications"]')).toHaveCount(0);
    await expect(titlebar.locator('[aria-label="Share"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
