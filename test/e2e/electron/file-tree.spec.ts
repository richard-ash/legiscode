// File-tree E2E tests. Five tests covering the flows where real
// Chromium / real localStorage / real keyboard events diverge from
// jsdom + RTL coverage:
//
//   UF3 — Cmd+click "open without switch" modifier semantics
//   UF4 — real localStorage round-trip across a renderer reload
//   UF5 — legacy `legiscode.activeSection` migration (REGRESSION,
//         IRON RULE)
//   UF6 — `?recovered=1` crash-recovery path → user-clicks-reload →
//         openItems reappear
//   UF7 — real keyboard typeahead jump
//
// UF1 + UF2 (basic click + multi-click) are trusted to the Layer 4
// pure-function tests + Layer 5 component tests; jsdom faithfully
// simulates those.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launchApp } from "./launch-helper";

function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "legiscode-e2e-"));
}

/**
 * Walk the loaded corpus tree and return a parent that has at least `n`
 * direct section children, plus the ancestor-id chain leading to it.
 * The CI fixture and production corpora differ in shape (alphabetical
 * order of modules, depth at which sections live), so tests that need to
 * click section rows derive the chain dynamically rather than assuming
 * `.nth(N)` is a section leaf.
 */
async function findSectionGroup(
  page: Page,
  n: number,
): Promise<{
  ancestorIds: readonly string[];
  sections: ReadonlyArray<{
    nodeId: string;
    ref: { moduleId: string; sectionId: string };
  }>;
} | null> {
  return await page.evaluate(async (count) => {
    const list = await window.api.corpus.list();
    if (!list.ok) return null;
    interface Node {
      id: string;
      kind: string;
      ref?: { moduleId: string; sectionId: string };
      kids?: Node[];
    }
    const findGroup = (
      node: Node,
      ancestors: readonly string[],
    ): { ancestors: readonly string[]; sections: Node[] } | null => {
      const sectionKids = (node.kids ?? []).filter((k) => k.kind === "section");
      if (sectionKids.length >= count) {
        return { ancestors: [...ancestors, node.id], sections: sectionKids.slice(0, count) };
      }
      for (const k of node.kids ?? []) {
        if (k.kind === "section") continue;
        const found = findGroup(k, [...ancestors, node.id]);
        if (found) return found;
      }
      return null;
    };
    for (const root of list.value.tree as Node[]) {
      const found = findGroup(root, []);
      if (found) {
        return {
          ancestorIds: found.ancestors,
          sections: found.sections.map((s) => ({
            nodeId: s.id,
            ref: s.ref as { moduleId: string; sectionId: string },
          })),
        };
      }
    }
    return null;
  }, n);
}

/**
 * Click each ancestor whose `aria-expanded="false"` so the section rows
 * underneath become visible. Default expansion auto-opens depth ≤ 1; deeper
 * ancestors need explicit user-click toggles.
 */
async function expandAncestors(page: Page, ancestorIds: readonly string[]): Promise<void> {
  for (const id of ancestorIds) {
    const row = page.locator(`[data-row-id="${cssEscape(id)}"]`);
    await row.scrollIntoViewIfNeeded();
    const expanded = await row.getAttribute("aria-expanded");
    if (expanded === "false") await row.click();
  }
}

/**
 * CSS attribute selectors disallow several characters bare; tree node ids
 * include `::`, spaces, dots, and colons. Escape them via `\\`-prefix.
 */
function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

test("UF3 — Cmd+click on a section appends to openItems without switching active", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({ userDataDir });
  try {
    await page.waitForSelector('[role="tree"]');

    const group = await findSectionGroup(page, 2);
    expect(group).not.toBeNull();
    if (!group) return;
    await expandAncestors(page, group.ancestorIds);

    const firstRow = page.locator(`[data-row-id="${cssEscape(group.sections[0]!.nodeId)}"]`);
    const secondRow = page.locator(`[data-row-id="${cssEscape(group.sections[1]!.nodeId)}"]`);

    // Click the first section to activate it; Cmd+click the second to
    // open-without-switching. Asserts the modifier semantics from real
    // Chromium (jsdom's MouseEvent doesn't carry the same modifier shape).
    await firstRow.click();
    await secondRow.click({ modifiers: ["Meta"] });

    await expect(firstRow).toHaveAttribute("aria-selected", "true");
    await expect(secondRow).toHaveAttribute("data-open", "true");

    const persisted = await page.evaluate(() => window.localStorage.getItem("legiscode.openItems"));
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted ?? "{}");
    expect(parsed.items.length).toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF4 — openItems persist across a renderer reload (real localStorage round-trip)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({ userDataDir });
  try {
    await page.waitForSelector('[role="tree"]');

    const group = await findSectionGroup(page, 1);
    expect(group).not.toBeNull();
    if (!group) return;
    await expandAncestors(page, group.ancestorIds);

    const target = group.sections[0];
    expect(target).toBeDefined();
    if (!target) return;
    const targetId = target.nodeId;
    const targetRow = page.locator(`[data-row-id="${cssEscape(targetId)}"]`);
    await targetRow.click();

    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem("legiscode.openItems")))
      .not.toBeNull();

    // Reload the renderer; cold-start hydrates from localStorage and
    // re-expands per default-expansion rules. The restored section may sit
    // behind collapsed parents — re-expand the chain before asserting.
    await page.reload();
    await page.waitForSelector('[role="tree"]');
    await expandAncestors(page, group.ancestorIds);

    const restoredRow = page.locator(`[data-row-id="${cssEscape(targetId)}"]`);
    await expect(restoredRow).toHaveClass(/is-active/);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF5 — legacy legiscode.activeSection migrates on cold start (REGRESSION — IRON RULE)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({ userDataDir });
  try {
    await page.waitForSelector('[role="tree"]');
    // Pick a real section ref from the loaded corpus.
    const ref = await page.evaluate(async () => {
      const list = await window.api.corpus.list();
      if (!list.ok) return null;
      const findSection = (node: {
        kind: string;
        ref?: { moduleId: string; sectionId: string };
        kids?: unknown[];
      }): { moduleId: string; sectionId: string } | null => {
        if (node.kind === "section" && node.ref) return node.ref;
        for (const k of (node.kids ?? []) as Parameters<typeof findSection>[0][]) {
          const found = findSection(k);
          if (found) return found;
        }
        return null;
      };
      for (const root of list.value.tree) {
        const found = findSection(root);
        if (found) return found;
      }
      return null;
    });
    expect(ref).not.toBeNull();
    if (!ref) return;

    // Seed the legacy key + clear the new key, then reload to trigger
    // the cold-start migration path.
    await page.evaluate((legacy) => {
      window.localStorage.removeItem("legiscode.openItems");
      window.localStorage.setItem("legiscode.activeSection", JSON.stringify(legacy));
    }, ref);

    await page.reload();
    await page.waitForSelector('[role="tree"]');

    // Migration ran: legacy key gone, new key present, ref active.
    const legacy = await page.evaluate(() =>
      window.localStorage.getItem("legiscode.activeSection"),
    );
    expect(legacy).toBeNull();
    const fresh = await page.evaluate(() => window.localStorage.getItem("legiscode.openItems"));
    expect(fresh).not.toBeNull();
    const parsed = JSON.parse(fresh ?? "{}");
    expect(parsed.items[0]?.ref).toEqual({ module: ref.moduleId, section: ref.sectionId });
    expect(parsed.activeIndex).toBe(0);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF6 — ?recovered=1 BootOverlay path → reload → openItems reappear", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({ userDataDir });
  try {
    await page.waitForSelector('[role="tree"]');

    const group = await findSectionGroup(page, 1);
    expect(group).not.toBeNull();
    if (!group) return;
    await expandAncestors(page, group.ancestorIds);

    const target = group.sections[0];
    expect(target).toBeDefined();
    if (!target) return;
    const targetId = target.nodeId;
    const targetRow = page.locator(`[data-row-id="${cssEscape(targetId)}"]`);
    await targetRow.click();
    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem("legiscode.openItems")))
      .not.toBeNull();

    // Force the recovery path by navigating to the same URL with the
    // recovery query — App.tsx reads the search string and shows the
    // crash-variant BootOverlay.
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.search = "?recovered=1";
      window.location.replace(url.toString());
    });
    await expect(page.getByRole("heading", { name: /App crashed/i })).toBeVisible({
      timeout: 10_000,
    });

    // User clicks Reload — App.tsx replaces the URL with pathname only,
    // which restarts the cold-start path (migration + hydration). The
    // openItems we wrote earlier should still be in localStorage.
    await page.getByRole("button", { name: /Reload/i }).click();
    await page.waitForSelector('[role="tree"]', { timeout: 10_000 });
    await expandAncestors(page, group.ancestorIds);

    const restoredRow = page.locator(`[data-row-id="${cssEscape(targetId)}"]`);
    await expect(restoredRow).toHaveClass(/is-active/);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("UF7 — typeahead jumps focus to the next prefix-match row (real keyboard event)", async () => {
  const userDataDir = freshUserDataDir();
  const { app, window: page } = await launchApp({ userDataDir });
  try {
    await page.waitForSelector('[role="tree"]');

    // Build a nodeId → canonical-label map using the same `${code} ${name}`
    // join the renderer's `prefixMatch` uses (corpus-nav/filter-predicate.ts).
    // tree-node.tsx renders `<code>{node.code}</code>{node.name}` with no
    // whitespace between the two, so a row's textContent tokenization
    // diverges from the renderer's. Probing letters and asserting matches
    // both have to read from this map to stay in lockstep with the prod
    // tokenizer.
    const labelById = await page.evaluate(async () => {
      const list = await window.api.corpus.list();
      if (!list.ok) return {};
      interface Node {
        id: string;
        code: string;
        name: string;
        kids?: Node[];
      }
      const out: Record<string, string> = {};
      const walk = (node: Node) => {
        out[node.id] = `${node.code} ${node.name}`;
        for (const k of node.kids ?? []) walk(k);
      };
      for (const root of list.value.tree as Node[]) walk(root);
      return out;
    });

    // Use Playwright locators (which auto-wait) instead of
    // document.querySelectorAll: under virtualization the tree initially
    // mounts zero treeitems until the virtualizer measures layout, so a
    // synchronous DOM scan races the renderer.
    const allRows = page.locator('[role="treeitem"]');
    await allRows.first().waitFor({ state: "attached" });
    const rowCount = await allRows.count();
    expect(rowCount).toBeGreaterThan(1);

    // Derive the target letter from a NON-first visible row so the
    // typeahead is guaranteed to find a match in whatever corpus is loaded.
    // The previous hardcoded "p" depended on the production SF corpus that
    // ships Port / Police / Planning Codes — the CI fixture only carries
    // sf-charter + sf-transportation, with no "p"-prefix tokens.
    let letter: string | null = null;
    for (let i = 1; i < rowCount; i++) {
      const id = await allRows.nth(i).getAttribute("data-row-id");
      const label = id ? (labelById[id] ?? "") : "";
      const token = label
        .toLowerCase()
        .split(/\s+/)
        .find((t) => /^[a-z]/.test(t));
      if (token) {
        letter = token.charAt(0);
        break;
      }
    }
    expect(letter).not.toBeNull();
    if (!letter) return;

    const firstRow = allRows.first();
    await firstRow.focus();
    await page.keyboard.press(letter);

    // After typeahead, focus moved to a row whose canonical label has a
    // token starting with the probe letter. Look up the focused row by
    // data-row-id and tokenize via the same `${code} ${name}` join.
    const focusedId = await page.evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      return focused?.getAttribute("data-row-id") ?? null;
    });
    expect(focusedId).not.toBeNull();
    const focusedLabel = focusedId ? (labelById[focusedId] ?? "") : "";
    const focusedTokens = focusedLabel.toLowerCase().split(/\s+/);
    expect(focusedTokens.some((t) => t.startsWith(letter))).toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
