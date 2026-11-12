// Benchmark harness (0.11.8 — brief §20 + §15 instrumentation).
//
// Measures, per fixture size: time to first usable landing shelf,
// time to enter Browse Everything, filter application time, page
// switching time, controller-to-focus response, mounted DOM card
// count, image (poster) element count, memory delta (where measurable
// headless), index builds, derive calls, decorated sorts, grouping
// runs, and rebuilds caused by scrolling.
//
// INTEGRATION REWRITE: the W5 harness ran against the contract stubs.
// This version drives the REAL modules: W1 `getCatalogIndex`, W3
// `buildMoviesHomeModel`, the W2 `mountBrowseEverything` mount, and
// the D1 `browse-instrumentation.ts` counters. The harness RETURNS
// numbers; the test file (tests/bench-0118-performance.test.ts)
// holds the DETERMINISTIC assertions (bounded work / bounded DOM).
// Millisecond figures are reported, never threshold-asserted.
// Re-run command (from the repo root):
//
//   pnpm vitest run tests/bench-0118-performance.test.ts
//
// Hermetic: seeded fixtures, jsdom DOM, no network. Poster <img>
// elements are counted, never fetched (jsdom loads no resources).

import { getCatalogIndex, invalidateCatalogIndex } from "@/scripts/lib/catalog-index"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups"
import {
  deriveBrowseGroups,
  mountBrowseEverything,
  type BrowseDataSource,
  type BrowseDeriveContext,
} from "@/scripts/lib/browse-everything"
import {
  applyFilters,
  createBrowseState,
  setSearch,
} from "@/scripts/lib/browse-state"
import {
  readBrowseInstrumentation,
  resetBrowseInstrumentation,
  type BrowseInstrumentationCounters,
} from "@/scripts/lib/browse-instrumentation"
import { buildMoviesHomeModel } from "@/scripts/movies/movies-home"
import { emptyTasteModel } from "@/scripts/lib/taste"
import {
  generateCatalogueOfSize,
  hashCatalogue,
  type CatalogEntry,
  type GeneratedCatalogue,
} from "./fixtures-0118-catalogue.ts"

export const BENCH_SIZES = [1000, 5000, 10000, 25000, 50000] as const

export interface BenchNumbers {
  size: number
  rows: number
  hash16: string
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
  pageSize: number
  posterImages: number
  heapDeltaBytes: number | null
  instrumentation: BrowseInstrumentationCounters
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

const EMPTY_SETS = {
  favouriteIds: new Set<string | number>(),
  watchLaterIds: new Set<string | number>(),
  inProgressIds: new Set<string | number>(),
  watchedIds: new Set<string | number>(),
  followedIds: new Set<string | number>(),
  newEpisodeIds: new Set<string | number>(),
}

function deriveCtx(): BrowseDeriveContext {
  return { collection: EMPTY_SETS, seasonCounts: new Map() }
}

function gridCards(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-browse-key]")]
}

async function waitForCards(host: HTMLElement, min = 1, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (gridCards(host).length >= min) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`bench: timed out waiting for ${min} cards`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function makeSource(rows: CatalogEntry[]): BrowseDataSource {
  return {
    load: async () => ({
      rows,
      playlistId: "test-playlist",
      playlistTitle: "Test",
      fromCache: false,
      loadError: false,
    }),
    toEntry: (row) => row as never,
    rowKey: (row) => `vod-${(row as CatalogEntry).id}`,
    cardView: (row) => {
      const r = row as CatalogEntry
      return {
        title: r.name,
        meta: [r.year, r.category].filter(Boolean).join(" · "),
        image: r.logo || null,
        kind: "poster" as const,
        itemKey: `vod-${r.id}`,
      }
    },
    detailId: (row) => String((row as CatalogEntry).id),
    watchSets: () => EMPTY_SETS,
    emptyTitle: "Nothing here",
    emptyMessage: "Try different filters.",
  }
}

/**
 * Run the full benchmark for one fixture size. `container` must be an
 * empty, attached DOM element (jsdom). Returns measured numbers only —
 * assertions live in the test file. The caller must stub
 * requestAnimationFrame to a timer (see the test file's beforeEach).
 */
export async function runBenchForSize(
  size: number,
  container: HTMLElement,
  revision: number
): Promise<BenchNumbers> {
  invalidateCatalogIndex()
  clearTitleGroupRegistry()
  resetBrowseInstrumentation()
  container.replaceChildren()

  const genStart = now()
  const catalogue: GeneratedCatalogue = generateCatalogueOfSize(size)
  const generateMs = now() - genStart
  const rows = catalogue.movies.length + catalogue.series.length
  const hash16 = hashCatalogue(catalogue).slice(0, 16)
  void revision

  const heapBefore = heapUsed()
  // Explicit W1 build over the harness array. The Movies Home model
  // below reuses this exact build (same array + same revision string
  // + same playlistId = cache hit), so firstShelfMs measures selector
  // composition only. The mount builds a second index over its own
  // mapped-entries array (new identity by construction) — hence
  // indexBuilds === 2 for the run, recorded honestly.
  const modelRevision = `test-playlist:${catalogue.movies.length}`
  const indexStart = now()
  getCatalogIndex("vod", catalogue.movies, modelRevision, {
    playlistId: "test-playlist",
  })
  const indexBuildMs = now() - indexStart

  // Time to first usable landing shelf: real Home model composition
  // (selectors over the cached index, no DOM).
  const shelfStart = now()
  const model = buildMoviesHomeModel({
    rows: catalogue.movies,
    playlistId: "test-playlist",
    taste: emptyTasteModel("bench", "test-playlist"),
    progressById: new Map(),
  })
  const firstShelfMs = now() - shelfStart
  void model

  // Time to enter Browse Everything: real mount + first paint.
  const enterStart = now()
  const mount = mountBrowseEverything(container, {
    kind: "movie",
    source: makeSource(catalogue.movies),
    onOpenDetail: () => {},
    onExit: () => {},
  })
  await waitForCards(container)
  const enterBrowseMs = now() - enterStart
  const pageSize = mount.getState().pageSize
  const mountedCards = gridCards(container).length
  const posterImages = container.querySelectorAll(
    '[data-nylah-rail="browse-grid"] img',
  ).length

  // Filter application: one genre + one rating change, settled.
  const filterStart = now()
  mount.setState({ filters: { genre: "action" } })
  await flush(120)
  mount.setState({ filters: { genre: "action", minRating: 7 } })
  await flush(120)
  const filterApplyMs = now() - filterStart

  // Page switching: up to 10 key-driven page turns (the real
  // controller path — gotoPage, which must NOT re-derive). Stops when
  // the filtered set fits on one page.
  const firstCard = gridCards(container)[0]
  firstCard?.focus()
  let pageSwitchCount = 0
  const pageStart = now()
  for (let i = 0; i < 10; i++) {
    const before = mount.getState().page
    ;(document.activeElement as Element)?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    )
    await flush(60)
    if (mount.getState().page === before) break
    pageSwitchCount++
  }
  const pageSwitchMsTotal = now() - pageStart

  // Controller-to-focus response: 50 focus moves via DOM focus.
  const cards = gridCards(container)
  const focusMoveCount = 50
  const focusStart = now()
  for (let i = 0; i < focusMoveCount; i++) {
    cards[i % Math.max(1, cards.length)]?.focus()
  }
  const focusMoveMsTotal = now() - focusStart

  // Rebuilds caused by scrolling: 25 scroll dispatches must replace
  // NO grid nodes (identity comparison) and derive nothing.
  const gridHost = container.querySelector<HTMLElement>('[data-nylah-rail="browse-grid"]')
  const nodesBefore = gridHost ? [...gridHost.children] : []
  const instrBeforeScroll = readBrowseInstrumentation()
  for (let i = 0; i < 25; i++) {
    if (gridHost) {
      gridHost.scrollTop = i * 40
      gridHost.dispatchEvent(new Event("scroll", { bubbles: true }))
    }
  }
  await flush(60)
  const nodesAfter = gridHost ? [...gridHost.children] : []
  let scrollRebuilds = 0
  if (nodesBefore.length !== nodesAfter.length) {
    scrollRebuilds = Math.abs(nodesBefore.length - nodesAfter.length)
  } else {
    for (let i = 0; i < nodesBefore.length; i++) {
      if (nodesBefore[i] !== nodesAfter[i]) scrollRebuilds++
    }
  }
  const instrAfterScroll = readBrowseInstrumentation()
  if (instrAfterScroll.deriveCalls !== instrBeforeScroll.deriveCalls) {
    scrollRebuilds += instrAfterScroll.deriveCalls - instrBeforeScroll.deriveCalls
  }

  const heapAfter = heapUsed()
  const instrumentation = readBrowseInstrumentation()
  const heapDeltaBytes =
    heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null

  mount.destroy()
  return {
    size,
    rows,
    hash16,
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
    pageSize,
    posterImages,
    heapDeltaBytes,
    instrumentation,
    scrollRebuilds,
    indexBuilds: instrumentation.catalogIndexBuilds,
  }
}

/** One-line summary row for the benchmark report table. */
export function formatBenchRow(numbers: BenchNumbers): string {
  const heap =
    numbers.heapDeltaBytes == null
      ? "n/a"
      : `${(numbers.heapDeltaBytes / 1048576).toFixed(1)}MB`
  return (
    `size=${numbers.size} rows=${numbers.rows} hash=${numbers.hash16} ` +
    `generate=${numbers.generateMs.toFixed(0)}ms ` +
    `index=${numbers.indexBuildMs.toFixed(0)}ms ` +
    `shelf=${numbers.firstShelfMs.toFixed(1)}ms ` +
    `enterBrowse=${numbers.enterBrowseMs.toFixed(0)}ms ` +
    `filter=${numbers.filterApplyMs.toFixed(0)}ms ` +
    `pages(${numbers.pageSwitchCount})=${numbers.pageSwitchMsTotal.toFixed(0)}ms ` +
    `focus(${numbers.focusMoveCount})=${numbers.focusMoveMsTotal.toFixed(0)}ms ` +
    `cards=${numbers.mountedCards}/${numbers.pageSize} posters=${numbers.posterImages} ` +
    `heapDelta=${heap} builds=${numbers.instrumentation.catalogIndexBuilds} ` +
    `derives=${numbers.instrumentation.deriveCalls} ` +
    `sorts=${numbers.instrumentation.decoratedSorts} groups=${numbers.instrumentation.groupRuns} ` +
    `scrollRebuilds=${numbers.scrollRebuilds}`
  )
}

/**
 * Pure-derivation work check (no DOM): what does a realistic browse
 * session cost over the real W1/W2 derive path? Six distinct
 * constraint sets (open + 2 filters + 2 sorts + 1 search) over the
 * precomputed indexes. Page turns are NOT derives (the mount's
 * gotoPage never re-derives — pinned by the mount-level test), so
 * they do not appear here. Sorts are index walks, never decorated
 * sorts; grouping runs once, at index build.
 */
export function measureDerivationWork(
  entries: CatalogEntry[],
  revision: string
): { derives: number; sorts: number; groups: number; builds: number; cacheHits: number } {
  invalidateCatalogIndex()
  clearTitleGroupRegistry()
  resetBrowseInstrumentation()
  const index = getCatalogIndex("vod", entries, revision, {
    playlistId: "bench-derivation",
  })
  const ctx = deriveCtx()
  const base = createBrowseState("movie")
  deriveBrowseGroups(index, base, ctx)
  deriveBrowseGroups(index, applyFilters(base, { genre: "action" }), ctx)
  deriveBrowseGroups(index, applyFilters(base, { genre: "action", minRating: 7 }), ctx)
  deriveBrowseGroups(index, { ...base, sort: "rating" }, ctx)
  deriveBrowseGroups(index, { ...base, sort: "az" }, ctx)
  deriveBrowseGroups(index, setSearch(base, "harbour", "all"), ctx)
  // Repeated reads of the same array + revision are cache hits.
  for (let i = 0; i < 6; i++) {
    getCatalogIndex("vod", entries, revision, { playlistId: "bench-derivation" })
  }
  const counters = readBrowseInstrumentation()
  return {
    derives: counters.deriveCalls,
    sorts: counters.decoratedSorts,
    groups: counters.groupRuns,
    builds: counters.catalogIndexBuilds,
    cacheHits: counters.catalogIndexCacheHits,
  }
}
