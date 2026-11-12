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
 * All measurements run against the REAL merged modules (W1 index,
 * W2 browser, W3 virtual list, real nowNextRows). NEVER claim
 * physical-PC performance is verified: these numbers are
 * sandbox/CI measurements on fixture data. The user's PC is the
 * only performance verdict that counts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BROWSER_ROW_HEIGHT, mountChannelBrowser } from "@/scripts/lib/livetv-browser";
import {
  buildCategoryIndex,
  categoryIndexBuildCount,
  derivedListRecomputeCount,
  getCategoryIndex,
  getDerivedChannels,
  resetCategoryIndexCache,
  resetCategoryIndexCounters,
} from "@/scripts/lib/livetv-category-index";
import { nowNextRows, type GuideNowRow } from "@/scripts/lib/livetv-guide";
import {
  createVirtualList,
  virtualListWindow,
} from "@/scripts/lib/livetv-guide-virtual";
import { guideProgrammeKey } from "@/scripts/lib/livetv-state";
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

async function benchAsync(
  operation: string,
  size: number,
  iterations: number,
  fn: () => Promise<void>,
): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - start;
  rows.push({ operation, size, iterations, totalMs, meanMs: totalMs / iterations });
  return totalMs;
}

async function nextFrames(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  resetCategoryIndexCache();
  resetCategoryIndexCounters();
});
afterEach(() => {
  root.remove();
});

describe("livetv0117 benchmark (reported numbers, no thresholds)", () => {
  it("measures index build, cache hit, category switch, scroll and focus", { timeout: 120_000 }, async () => {
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
    const buildsBefore = categoryIndexBuildCount();
    bench("getCategoryIndex (cache hit)", 10000, 1000, () => {
      expect(getCategoryIndex(channels10k, 1)).toBe(cached);
    });
    expect(categoryIndexBuildCount()).toBe(buildsBefore);

    // 3. Category switch: first derivation per category (recompute),
    //    then repeated access (cache hit).
    const index = getCategoryIndex(channels10k, 1);
    const groupIds = index.groups.map((g) => g.id);
    // One fresh index, one derivation per group.
    {
      const fresh = buildCategoryIndex(channels10k, 9);
      const recomputesBefore = derivedListRecomputeCount();
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
      expect(derivedListRecomputeCount() - recomputesBefore).toBe(groupIds.length);
    }
    {
      const recomputesBefore = derivedListRecomputeCount();
      bench("category re-access (derived cache hit)", 10000, 1000, () => {
        getDerivedChannels(index, { groupId: "sports" });
      });
      // Exactly one miss (the first access), then 999 cache hits.
      expect(derivedListRecomputeCount() - recomputesBefore).toBe(1);
    }

    // 4. Scroll rendering: window slices over a 10k derived list.
    const sports = getDerivedChannels(index, { groupId: "sports" });
    let sliceOffset = 0;
    bench("scroll window slice (14 rows)", 6000, 2000, () => {
      sports.slice(sliceOffset, sliceOffset + 14);
      sliceOffset = (sliceOffset + 7) % 5900;
    });
    // Deterministic scroll walk (no Math.random in assertions):
    let walked = 0;
    bench("scroll walk (200 sequential windows)", 6000, 200, () => {
      const win = sports.slice(walked * 7, walked * 7 + 14);
      walked = (walked + 1) % 800;
      expect(win.length).toBeGreaterThan(0);
    });

    // 5. Real browser: scroll paints + controller-to-highlight moves.
    const browserChannels = buildFixtureChannels(2000);
    const browser = mountChannelBrowser(root, { channels: browserChannels });
    const listEl = root.querySelector<HTMLElement>("[data-browser-list]")!;
    let scrollTop = 0;
    await benchAsync("browser scroll step (rAF paint)", 2000, 100, async () => {
      scrollTop += 7 * BROWSER_ROW_HEIGHT;
      listEl.scrollTop = scrollTop;
      listEl.dispatchEvent(new Event("scroll"));
      await nextFrames();
    });
    const focusStart = performance.now();
    for (let i = 0; i < 500; i++) keyOn(listEl, "ArrowDown");
    const focusTotal = performance.now() - focusStart;
    rows.push({
      operation: "controller move → highlight (500 moves, sync paint)",
      size: 2000,
      iterations: 500,
      totalMs: focusTotal,
      meanMs: focusTotal / 500,
    });
    // No initial highlight: the first move lands on index 0, so
    // 500 moves land on index 499.
    expect(browser.getHighlightedId()).toBe(browserChannels[499]!.id);
    browser.destroy();

    // 6. Guide: On Now row build + real virtual-list mount at 2,500 rows.
    const { programmes } = buildGuideFixture(2500);
    let guideRows = nowNextRows(programmes, FIXTURE_NOW_MS);
    bench("nowNextRows (2,500 channels)", 2500, 20, () => {
      guideRows = nowNextRows(programmes, FIXTURE_NOW_MS);
    });
    expect(guideRows).toHaveLength(2500);
    const container = document.createElement("div");
    root.appendChild(container);
    let guideScrollTop = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => guideScrollTop,
      set: (value: number) => {
        guideScrollTop = value;
      },
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", { get: () => 600, configurable: true });
    const guide = createVirtualList<GuideNowRow>({
      container,
      mode: "spacer",
      rowHeightPx: 112,
      overscanRows: 4,
      keyOf: (row) => guideProgrammeKey(row.channelId, row.current.startMs),
      renderRow: (row, _index, existing) => {
        if (existing) {
          existing.textContent = row.current.title;
          return existing;
        }
        const node = document.createElement("button");
        node.setAttribute("data-focus-key", guideProgrammeKey(row.channelId, row.current.startMs));
        node.textContent = row.current.title;
        return node;
      },
    });
    guide.setItems(guideRows);
    guide.renderNow();
    await benchAsync("guide scroll step", 2500, 100, async () => {
      guideScrollTop += 11 * 112;
      container.dispatchEvent(new Event("scroll"));
      await nextFrames();
      guide.renderNow();
    });
    const guideWin = virtualListWindow({
      total: 2500,
      rowHeightPx: 112,
      scrollTopPx: 112 * 100,
      viewportHeightPx: 600,
      overscanRows: 4,
    });
    expect(guide.mountedCount()).toBeLessThanOrEqual(guideWin.endIndex - guideWin.startIndex + 1);
    guide.destroy();
    container.remove();

    // Report. Vitest prints console output with the run; the
    // numbers are recorded in the integration report, not asserted.
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
