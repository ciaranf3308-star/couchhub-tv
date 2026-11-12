/**
 * @vitest-environment jsdom
 *
 * Live TV 2.0 (0.11.7) W5 — PERFORMANCE INSTRUMENTATION.
 *
 * Measured benchmark (performance.now()-based, reported numbers).
 * Run it with:
 *
 *   pnpm vitest run tests/livetv0117/livetv0117-benchmark.test.ts
 *
 * It prints a timing table to stdout. It asserts NO millisecond
 * thresholds — CI hardware varies, and a threshold would be a lie
 * about the user's PC. The deterministic guarantees (work counts,
 * DOM bounds) live in the other livetv0117 test files; this file
 * only measures and reports, plus asserts the measured operations
 * actually ran (counters moved exactly as expected, focus landed).
 *
 * NEVER claim physical-PC performance is verified: these numbers
 * are sandbox/CI measurements on fixture data against stub
 * harnesses (and the real index/grouping path where noted). The
 * user's PC is the only performance verdict that counts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nowNextRows } from "@/scripts/lib/livetv-guide";
import {
  buildCategoryIndex,
  getCategoryIndex,
  getCategoryIndexBuildCount,
  getDerivedChannels,
  sliceDerivedWindow,
  __resetCategoryIndexCacheForTests,
} from "./stubs/category-index.stub";
import { mountGuideList } from "./stubs/guide.stub";
import { mountVirtualList } from "./stubs/virtual-list.stub";
import {
  FIXTURE_NOW_MS,
  buildFixtureChannels,
  buildGuideFixture,
} from "./fixtures";

interface BenchRow {
  operation: string;
  size: number;
  iterations: number;
  totalMs: number;
  meanMs: number;
}

const rows: BenchRow[] = [];

function bench(
  operation: string,
  size: number,
  iterations: number,
  fn: () => void,
): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - start;
  rows.push({ operation, size, iterations, totalMs, meanMs: totalMs / iterations });
  return totalMs;
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  __resetCategoryIndexCacheForTests();
});
afterEach(() => {
  root.remove();
});

describe("livetv0117 benchmark (reported numbers, no thresholds)", () => {
  it("measures index build, cache hit, category switch, scroll and focus", { timeout: 60_000 }, () => {
    // 1. Index build (fresh build per iteration) at each size.
    for (const size of [200, 2000, 5000, 10000]) {
      const channels = buildFixtureChannels(size);
      bench(`buildCategoryIndex (fresh)`, size, 5, () => {
        buildCategoryIndex(channels, 1);
      });
    }

    // 2. Cache hit: same array + revision must not rebuild.
    const channels10k = buildFixtureChannels(10000);
    const cached = getCategoryIndex(channels10k, 1);
    const buildsBefore = getCategoryIndexBuildCount();
    bench("getCategoryIndex (cache hit)", 10000, 1000, () => {
      expect(getCategoryIndex(channels10k, 1)).toBe(cached);
    });
    expect(getCategoryIndexBuildCount()).toBe(buildsBefore);

    // 3. Category switch: first derivation per category (recompute),
    //    then repeated access (cache hit).
    const index = getCategoryIndex(channels10k, 1);
    const groupIds = index.groups.map((g) => g.id);
    // One fresh index, one derivation per group.
    {
      const fresh = buildCategoryIndex(channels10k, 9);
      const start = performance.now();
      for (const groupId of groupIds) getDerivedChannels(fresh, { groupId });
      const totalMs = performance.now() - start;
      rows.push({
        operation: "category switch (first derivation per group)",
        size: 10000,
        iterations: groupIds.length,
        totalMs,
        meanMs: totalMs / groupIds.length,
      });
      expect(fresh.recomputeCount).toBe(groupIds.length);
    }
    bench("category re-access (derived cache hit)", 10000, 1000, () => {
      getDerivedChannels(index, { groupId: "sports" });
    });
    expect(index.recomputeCount).toBe(1);

    // 4. Scroll rendering: window slices over a 10k derived list.
    const sports = getDerivedChannels(index, { groupId: "sports" });
    let sliceOffset = 0;
    bench("scroll window slice (14 rows)", 6000, 2000, () => {
      sliceDerivedWindow(sports, sliceOffset, 14);
      sliceOffset = (sliceOffset + 7) % 5900;
    });
    // Deterministic scroll walk (no Math.random in assertions):
    let walked = 0;
    bench("scroll walk (200 sequential windows)", 6000, 200, () => {
      const win = sliceDerivedWindow(sports, walked * 7, 14);
      walked = (walked + 1) % 800;
      expect(win.length).toBeGreaterThan(0);
    });

    // 5. Virtual list: mount + scroll + controller-to-focus moves.
    const list = mountVirtualList(root, {
      items: buildFixtureChannels(2000),
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
      programmeOf: (c) => `Now: ${c.displayName}`,
      rowHeight: 76,
      viewportHeight: 600,
      overscanRows: 3,
    });
    bench("virtual list scroll step (re-render window)", 2000, 200, () => {
      list.scrollByRows(7);
    });
    const focusStart = performance.now();
    for (let i = 0; i < 500; i++) list.moveFocus(1);
    const focusTotal = performance.now() - focusStart;
    rows.push({
      operation: "controller move → focus (500 moves, incl. DOM focus)",
      size: 2000,
      iterations: 500,
      totalMs: focusTotal,
      meanMs: focusTotal / 500,
    });
    expect(list.getFocusedKey()).not.toBeNull();
    list.destroy();

    // 6. Guide: On Now row build + virtualised mount at 2,500 rows.
    const { programmes } = buildGuideFixture(2500);
    let guideRows = nowNextRows(programmes, FIXTURE_NOW_MS);
    bench("nowNextRows (2,500 channels)", 2500, 20, () => {
      guideRows = nowNextRows(programmes, FIXTURE_NOW_MS);
    });
    expect(guideRows).toHaveLength(2500);
    const guide = mountGuideList(root, {
      mode: "now",
      rows: guideRows,
      rowHeight: 76,
      viewportHeight: 600,
      overscanRows: 3,
    });
    bench("guide scroll step", 2500, 200, () => {
      guide.scrollByRows(11);
    });
    expect(guide.getMountedRowCount()).toBeLessThanOrEqual(20);
    guide.destroy();

    // Report. Vitest prints console output with the run; the
    // numbers are recorded in the W5 report, not asserted.
    const table = rows
      .map(
        (r) =>
          `${r.operation.padEnd(52)} n=${String(r.size).padStart(6)} ` +
          `x${String(r.iterations).padStart(5)} total=${r.totalMs.toFixed(2)}ms ` +
          `mean=${r.meanMs.toFixed(4)}ms`,
      )
      .join("\n");
    console.log(`\n[LIVETV-0117 BENCHMARK]\n${table}\n[/LIVETV-0117 BENCHMARK]`);
  });
});
