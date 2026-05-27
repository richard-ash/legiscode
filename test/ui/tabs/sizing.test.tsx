// CSS contract for tab sizing — inactive tabs share width equally and
// shrink toward a 60px floor; the active tab gets 2× share, never
// shrinks, and stays readable at 220px even when 15+ tabs are open.
//
// Per T1 lock in /plan-eng-review: this unit test asserts the rule
// content only (`flex: 1 1 0`, `flex: 2 0 auto`, min/max widths).
// jsdom doesn't compute layout, so offsetWidth/getBoundingClientRect()
// assertions would be unreliable — real-layout assertions
// (`active boundingBox().width >= 220` at N=15) live in the Playwright
// e2e suite where a layout engine actually runs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "src", "styles", "globals.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "m");
  const m = globalsCss.match(re);
  if (!m?.[1]) throw new Error(`Selector ${selector} not found in globals.css`);
  return m[1];
}

describe("tab sizing CSS contract", () => {
  it(".lc-tab declares equal-share sizing with a 60px floor and 240px cap", () => {
    const body = ruleBody(".lc-tab");
    expect(body).toMatch(/flex:\s*1\s+1\s+0\b/);
    expect(body).toMatch(/min-width:\s*60px\b/);
    expect(body).toMatch(/max-width:\s*240px\b/);
  });

  it(".lc-tab.is-active gets 2× share, never shrinks, holds at least 220px", () => {
    const body = ruleBody(".lc-tab.is-active");
    // `flex: 2 0 auto` is load-bearing: the 0 shrink factor is what keeps
    // the active tab readable when 15 tabs are jammed in. Drop it and
    // every tab equalizes again under pressure.
    expect(body).toMatch(/flex:\s*2\s+0\s+auto\b/);
    expect(body).toMatch(/min-width:\s*220px\b/);
    // 360px cap stops a lone active tab from stretching across an
    // otherwise empty strip — see risk register (commit 2 row 2) in plan.
    expect(body).toMatch(/max-width:\s*360px\b/);
  });
});
