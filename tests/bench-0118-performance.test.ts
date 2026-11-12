/**
 * @vitest-environment jsdom
 */
// Benchmarks + instrumentation assertions (0.11.8, W5 — brief §20/§15).
//
// DETERMINISTIC assertions only: bounded DOM counts, zero full
// passes/sorts/grouping on focus movement, scrolling and page turns,
// one index build per revision. Millisecond figures are REPORTED via
// console (captured into tests/bench-0118-baseline.md) and NEVER
// threshold-asserted. These are STUB-BASELINE numbers: integration
// re-runs this file against the real merged tree with:
//
//   pnpm vitest run tests/bench-0118-performance.test.ts
//
// No physical-PC performance is claimed anywhere in this file.

import { describe, it, expect, beforeEach } from "vitest"
import {
  BENCH_SIZES,
  formatBenchRow,
  measureDerivationWork,
  runBenchForSize,
  type BenchNumbers,
} from "./bench-0118-harness.ts"
import {
  DEFAULT_PAGE_SIZE,
  catalogIndexBuildCount,
  createBrowseState,
  deriveBrowsePage,
  getBrowseInstrumentation,
  getCatalogIndex,
  mountBrowseEverything,
  resetBrowseInstrumentation,
  resetCatalogIndexCache,
} from "./movies-series-2.0-stubs.ts"
import { generateCatalogueOfSize } from "./fixtures-0118-catalogue.ts"

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("bench-0118 performance + instrumentation", { timeout: 300000 }, () => {
  it(
    "bounded DOM + bounded work at every fixture size (1k–50k)",
    async () => {
      const rows: BenchNumbers[] = []
      let revision = 9000
      for (const size of BENCH_SIZES) {
        revision += 1
        const container = document.createElement("div")
        document.body.appendChild(container)
        const numbers = await runBenchForSize(size, container, revision)
        rows.push(numbers)
        container.remove()

        // DETERMINISTIC: mounted cards never exceed one page, at ANY
        // catalogue size. Posters never exceed mounted cards.
        expect(numbers.mountedCards).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE)
        expect(numbers.mountedCards).toBeGreaterThan(0)
        expect(numbers.posterImages).toBeLessThanOrEqual(numbers.mountedCards)
        // DETERMINISTIC: scrolling rebuilds nothing.
        expect(numbers.scrollRebuilds).toBe(0)
        // The index was built exactly once for the revision.
        expect(numbers.indexBuilds).toBe(1)
        // Generation produced at least the requested size.
        expect(numbers.rows).toBeGreaterThanOrEqual(size)
        console.log(`bench-0118 [stub-baseline] ${formatBenchRow(numbers)}`)
      }
      // DOM boundedness is size-independent: the 50k mount holds no
      // more cards than the 1k mount.
      const cards = rows.map((r) => r.mountedCards)
      expect(Math.max(...cards)).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE)
      expect(rows[rows.length - 1].mountedCards).toBeLessThanOrEqual(
        rows[0].mountedCards
      )
    },
    300000
  )

  it("a realistic browse session costs one pass per constraint set, zero on page turns", () => {
    const catalogue = generateCatalogueOfSize(10000, 0x0118)
    const work = measureDerivationWork(catalogue.movies, 9101)
    // 6 distinct constraint sets (open + 2 filters + 2 sorts + 1
    // search) → 6 full passes, 6 grouping runs, 2 sorts.
    expect(work.passes).toBe(6)
    expect(work.groups).toBe(6)
    expect(work.sorts).toBe(2)
    // 5 page turns + 1 repeated derivation served from cache.
    expect(work.cacheHits).toBe(6)
  }, 120000)

  it("focus movement and scrolling cost zero passes, sorts and grouping runs", async () => {
    const catalogue = generateCatalogueOfSize(5000, 0x0118)
    resetCatalogIndexCache()
    resetBrowseInstrumentation()
    const index = getCatalogIndex("vod", catalogue.movies, 9102)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const mount = mountBrowseEverything(container, { index })
    await mount.awaitSettled()
    resetBrowseInstrumentation()
    // 100 focus moves + 50 scroll rows + 10 repaint-free interactions.
    for (let i = 0; i < 100; i++) mount.focusCard(i % 30)
    for (let i = 0; i < 50; i++) mount.scrollWithinPage(1)
    const after = getBrowseInstrumentation()
    expect(after.fullPasses).toBe(0)
    expect(after.sorts).toBe(0)
    expect(after.groupRuns).toBe(0)
    expect(after.focusMoves).toBe(0) // focusCard is direct, not a key move
    // Key-driven moves likewise cost nothing: drive arrows through
    // the grid's keydown handler via dispatched events.
    const before = getBrowseInstrumentation()
    mount.focusCard(0)
    const grid = container.querySelector("[data-browse-grid]") as HTMLElement
    for (let i = 0; i < 20; i++) {
      const active = document.activeElement as Element
      active.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
      )
    }
    void grid
    const afterKeys = getBrowseInstrumentation()
    expect(afterKeys.fullPasses).toBe(before.fullPasses)
    expect(afterKeys.sorts).toBe(before.sorts)
    expect(afterKeys.groupRuns).toBe(before.groupRuns)
    expect(afterKeys.focusMoves).toBeGreaterThan(before.focusMoves)
    mount.unmount()
  }, 120000)

  it("the index builds once per revision and never per render", () => {
    const catalogue = generateCatalogueOfSize(5000, 0x0118)
    resetCatalogIndexCache()
    const before = catalogIndexBuildCount()
    const index = getCatalogIndex("vod", catalogue.movies, 9103)
    expect(catalogIndexBuildCount()).toBe(before + 1)
    // Repeated reads + derivations never rebuild.
    for (let i = 0; i < 10; i++) {
      expect(getCatalogIndex("vod", catalogue.movies, 9103)).toBe(index)
      deriveBrowsePage(index, createBrowseState("vod"))
    }
    expect(catalogIndexBuildCount()).toBe(before + 1)
    // A new revision rebuilds exactly once.
    getCatalogIndex("vod", catalogue.movies, 9104)
    expect(catalogIndexBuildCount()).toBe(before + 2)
  }, 120000)
})
