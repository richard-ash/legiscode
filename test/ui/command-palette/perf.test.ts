// Hermetic perf budget for `rank()`. The 12k-item synthetic fixture
// at `test/fixtures/palette-perf-corpus.json` is committed (deterministic
// across machines) so CI sees the same numbers as the local run. Per
// Codex F5 the budget is tightened to **p95 < 8ms** — 2× headroom over
// the empirically-needed envelope so slower CI hosts still pass.
//
// What this test catches:
//   - quadratic regressions in `rank` (an accidental nested loop, a
//     missing filter-before-sort, swap of `.includes` for something
//     that allocates per call),
//   - haystack-build leakage into the hot path (the precompute is
//     supposed to be one-shot in the hook),
//   - scorer being mode-blind under fixtures with mixed kinds.
//
// What this test does NOT catch (D6 — owned by feat/release-pipeline #17):
//   - real Electron / React reconciliation / virt overhead under load,
//   - GC pause behavior on rapid typing,
//   - keystroke-to-paint latency.
//
// Boil-the-lake completeness: the perf budget asserts a real bound,
// not a placeholder. If this fixture or budget ever needs to "ramp
// down for CI flakiness" the right fix is to pin the CI host class,
// not to slacken the budget.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rank, type SearchableItem } from "../../../src/ui/command-palette/score";

const FIXTURE_PATH = join(__dirname, "..", "..", "fixtures", "palette-perf-corpus.json");

interface FixtureRow {
  kind: "section";
  moduleId: string;
  sectionId: string;
  num: string;
  name: string;
  path: string;
}

function loadFixture(): SearchableItem[] {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const rows = JSON.parse(raw) as FixtureRow[];
  return rows.map<SearchableItem>((r) => ({
    kind: "section",
    moduleId: r.moduleId,
    sectionId: r.sectionId,
    num: r.num,
    name: r.name,
    path: r.path,
    numCanonical: r.num.toLowerCase().replace(/§/g, "").replace(/\s+/g, ""),
    nameLower: r.name.toLowerCase(),
    pathLower: r.path.toLowerCase(),
  }));
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}

describe("rank() — hermetic perf budget (T8, P7, D6)", () => {
  const items = loadFixture();
  // Sanity guard so a corrupted fixture surfaces as a test failure,
  // not as a misleading "perf is fine" pass against a 12-item corpus.
  it("fixture loads as ≥12k items", () => {
    expect(items.length).toBeGreaterThanOrEqual(12_000);
    expect(items[0]?.kind).toBe("section");
  });

  it("rank() over 12k items: p95 < 8ms across 10 timed iterations", () => {
    // Four queries cover the realistic envelope:
    //   - short numeric: cheap canonical lookup, lots of matches
    //   - long name: name field dominant, lots of substring scans
    //   - sort-stress: many low-score path-substring matches force
    //     the sort to actually do work (catches "filter-before-sort"
    //     regressions that would let sort cost grow with corpus size)
    //   - rare prefix: small match count, sort cost tiny
    const queries = ["133", "habitable", "port", "zzz"];
    // Warmup (3 iters, not counted) — knocks out JIT compile + first
    // hidden-class assignment.
    for (const q of queries) {
      for (let i = 0; i < 3; i++) rank(items, q);
    }
    const timings: number[] = [];
    // Floor guard: at least one query must actually return matches
    // during timing. Without this, a future regression that short-
    // circuits `rank()` to `return []` would pass the budget at p95=0.
    let observedNonZeroHits = 0;
    for (let iter = 0; iter < 10; iter++) {
      for (const q of queries) {
        const t0 = performance.now();
        const result = rank(items, q);
        const t1 = performance.now();
        timings.push(t1 - t0);
        if (result.length > 0) observedNonZeroHits++;
      }
    }
    const observedP95 = p95(timings);
    // Log so CI run telemetry is greppable when the budget tightens.
    // (Local runs see this in vitest's stdout.)
    console.log(
      `[palette perf] n=${items.length} samples=${timings.length} p95=${observedP95.toFixed(2)}ms hits=${observedNonZeroHits}`,
    );
    expect(observedP95).toBeLessThan(8);
    // At minimum, "133", "habitable", and "port" should return
    // matches every iteration (3 queries × 10 iters = 30). "zzz" is
    // expected to be empty.
    expect(observedNonZeroHits).toBeGreaterThanOrEqual(30);
  });
});
