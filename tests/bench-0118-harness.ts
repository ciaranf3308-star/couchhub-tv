// Benchmark harness (0.11.8, W5 — brief §20 + §15 instrumentation).
//
// Measures, per fixture size: time to first usable landing shelf,
// time to enter Browse Everything, filter application time, page
// switching time, controller-to-focus response, mounted DOM card
// count, image (poster) element count, memory delta (where measurable
// headless), full catalogue passes, full sorts, grouping runs, and
// rebuilds caused by scrolling.
//
// The harness RETURNS numbers; the test file
// (tests/bench-0118-performance.test.ts) holds the DETERMINISTIC
// assertions (bounded work / bounded DOM). Millisecond figures are
// reported, never threshold-asserted, and are STUB-BASELINE numbers
// until integration re-runs this harness against the real merged
// tree. Re-run command (from the repo root):
//
//   pnpm vitest run tests/bench-0118-performance.test.ts
//
// Hermetic: seeded fixtures, jsdom DOM, no network. Poster <img>
// elements are counted, never fetched (jsdom loads no resources).

import {
  applyFilters,
  createBrowseState,
  deriveBrowsePage,
  getBrowseInstrumentation,
  getCatalogIndex,
  mountBrowseEverything,
  resetBrowseInstrumentation,
  resetCatalogIndexCache,
  selectHomeShelves,
  type BrowseInstrumentation,
  type CatalogEntry,
} from "./movies-series-2.0-stubs.ts"
import {
  generateCatalogueOfSize,
  type GeneratedCatalogue,
} from "./fixtures-0118-catalogue.ts"

export const BENCH_SIZES = [1000, 5000, 10000, 25000, 50000] as const

export interface BenchNumbers {
  size: number
  rows: number
  generateMs: number
  indexBuildMs: number
  firstShelfMs: number
  enterBrowseMs: number
  filterApplyMs: number
  pageSwitchMsTotal: number
  pageSwitchCount: number
  focusMoveMsTotal: number
  focusMoveCount: number
  mountedCards: number
  posterImages: number
  heapDeltaBytes: number | null
  instrumentation: BrowseInstrumentation
  scrollRebuilds: number
  indexBuilds: number
}

function now(): number {
  return performance.now()
}

function heapUsed(): number | null {
  try {
    const mem = (globalThis as unknown as { process?: { memoryUsage?: () => { heapUsed: number } } })
      .process?.memoryUsage?.()
    return mem ? mem.heapUsed : null
  } catch {
    return null
  }
}

/**
 * Run the full benchmark for one fixture size. `container` must be an
 * empty, attached DOM element (jsdom). Returns measured numbers only —
 * assertions live in the test file.
 */
export async function runBenchForSize(
  size: number,
  container: HTMLElement,
  revision: number
): Promise<BenchNumbers> {
  resetCatalogIndexCache()
  resetBrowseInstrumentation()
  container.replaceChildren()

  const genStart = now()
  const catalogue: GeneratedCatalogue = generateCatalogueOfSize(size)
  const generateMs = now() - genStart
  const rows = catalogue.movies.length + catalogue.series.length

  const heapBefore = heapUsed()
  const indexStart = now()
  const index = getCatalogIndex("vod", catalogue.movies, revision)
  const indexBuildMs = now() - indexStart

  // Time to first usable landing shelf: selector composition only.
  const shelfStart = now()
  const shelves = selectHomeShelves(index)
  const firstShelfMs = now() - shelfStart
  void shelves

  // Time to enter Browse Everything: mount + first paint.
  const enterStart = now()
  const mount = mountBrowseEverything(container, { index })
  await mount.awaitSettled()
  const enterBrowseMs = now() - enterStart
  const mountedCards = mount.getMountedCardCount()
  const posterImages = container.querySelectorAll("img[data-poster]").length

  // Filter application: one genre + one rating change, settled.
  const filterStart = now()
  mount.applyFilters({ genre: "action" })
  await mount.awaitSettled()
  mount.applyFilters({ genre: "action", minRating: 7 })
  await mount.awaitSettled()
  const filterApplyMs = now() - filterStart

  // Page switching: walk 10 pages (or all, if fewer).
  const pageCount = mount.getDerivation().pageCount
  const pageSwitchCount = Math.min(10, Math.max(0, pageCount - 1))
  const pageStart = now()
  for (let page = 1; page <= pageSwitchCount; page++) {
    mount.setPage(page)
    await mount.awaitSettled()
  }
  const pageSwitchMsTotal = now() - pageStart

  // Controller-to-focus response: 50 focus moves via the mount's
  // focus model (keydown-driven moves in the bench test's terms).
  const focusStart = now()
  const focusMoveCount = 50
  const cards = container.querySelectorAll("[data-browse-card]")
  for (let i = 0; i < focusMoveCount; i++) {
    mount.focusCard(i % Math.max(1, cards.length))
  }
  const focusMoveMsTotal = now() - focusStart

  // Rebuilds caused by scrolling: scroll 25 rows, count paints and
  // instrumentation deltas. Scrolling must rebuild NOTHING.
  const paintsBeforeScroll = mount.getPaintCount()
  const instrBeforeScroll = getBrowseInstrumentation()
  for (let i = 0; i < 25; i++) mount.scrollWithinPage(1)
  const scrollRebuilds = mount.getPaintCount() - paintsBeforeScroll
  const instrAfterScroll = getBrowseInstrumentation()
  void instrBeforeScroll
  void instrAfterScroll

  const heapAfter = heapUsed()
  const instrumentation = getBrowseInstrumentation()
  const heapDeltaBytes =
    heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null
  const indexBuilds = 1 // one getCatalogIndex build per size (cache reset)

  mount.unmount()
  return {
    size,
    rows,
    generateMs,
    indexBuildMs,
    firstShelfMs,
    enterBrowseMs,
    filterApplyMs,
    pageSwitchMsTotal,
    pageSwitchCount,
    focusMoveMsTotal,
    focusMoveCount,
    mountedCards,
    posterImages,
    heapDeltaBytes,
    instrumentation,
    scrollRebuilds,
    indexBuilds,
  }
}

/** One-line summary row for the benchmark report table. */
export function formatBenchRow(numbers: BenchNumbers): string {
  const heap =
    numbers.heapDeltaBytes == null
      ? "n/a"
      : `${(numbers.heapDeltaBytes / 1048576).toFixed(1)}MB`
  return (
    `size=${numbers.size} rows=${numbers.rows} ` +
    `generate=${numbers.generateMs.toFixed(0)}ms ` +
    `index=${numbers.indexBuildMs.toFixed(0)}ms ` +
    `shelf=${numbers.firstShelfMs.toFixed(1)}ms ` +
    `enterBrowse=${numbers.enterBrowseMs.toFixed(0)}ms ` +
    `filter=${numbers.filterApplyMs.toFixed(0)}ms ` +
    `pages(${numbers.pageSwitchCount})=${numbers.pageSwitchMsTotal.toFixed(0)}ms ` +
    `focus(${numbers.focusMoveCount})=${numbers.focusMoveMsTotal.toFixed(0)}ms ` +
    `cards=${numbers.mountedCards} posters=${numbers.posterImages} ` +
    `heapDelta=${heap} passes=${numbers.instrumentation.fullPasses} ` +
    `sorts=${numbers.instrumentation.sorts} groups=${numbers.instrumentation.groupRuns} ` +
    `scrollRebuilds=${numbers.scrollRebuilds}`
  )
}

/**
 * Pure-derivation work check (no DOM): how many full passes / sorts /
 * grouping runs does a realistic browse session cost? Used by the
 * test file to pin bounded-work invariants independent of the mount.
 */
export function measureDerivationWork(
  entries: CatalogEntry[],
  revision: number
): { passes: number; sorts: number; groups: number; cacheHits: number } {
  resetCatalogIndexCache()
  resetBrowseInstrumentation()
  const index = getCatalogIndex("vod", entries, revision)
  const base = createBrowseState("vod")
  // Session: open, 5 page turns, 2 filter changes, 2 sorts, 1 search.
  deriveBrowsePage(index, base)
  const total = deriveBrowsePage(index, base).totalGroups
  for (let page = 1; page <= 5; page++) {
    deriveBrowsePage(index, { ...base, page: Math.min(page, Math.max(0, Math.ceil(total / 60) - 1)) })
  }
  deriveBrowsePage(index, applyFilters(base, { genre: "action" }))
  deriveBrowsePage(index, applyFilters(base, { genre: "action", minRating: 7 }))
  deriveBrowsePage(index, { ...base, sort: "rating" })
  deriveBrowsePage(index, { ...base, sort: "az" })
  deriveBrowsePage(index, { ...base, query: "harbour", searchScope: "all" })
  const instrumentation = getBrowseInstrumentation()
  return {
    passes: instrumentation.fullPasses,
    sorts: instrumentation.sorts,
    groups: instrumentation.groupRuns,
    cacheHits: instrumentation.cacheHits,
  }
}
