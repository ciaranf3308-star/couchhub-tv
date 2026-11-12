/**
 * @vitest-environment jsdom
 */
// Benchmarks + instrumentation assertions (0.11.8 — brief §20/§15).
//
// INTEGRATION REWRITE: the W5 version ran against the contract stubs.
// This version asserts the REAL modules (W1 index, W2 mount/derive,
// D1 instrumentation). DETERMINISTIC assertions only: bounded DOM
// counts, zero derives/sorts/grouping on focus movement, scrolling
// and key-driven page turns, one index build per revision. Millisecond
// figures are REPORTED via console (captured into
// tests/bench-0118-baseline.md) and NEVER threshold-asserted.
//
//   pnpm vitest run tests/bench-0118-performance.test.ts
//
// No physical-PC performance is claimed anywhere in this file.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  BENCH_SIZES,
  formatBenchRow,
  measureDerivationWork,
  runBenchForSize,
  type BenchNumbers,
} from "./bench-0118-harness.ts"
import { getCatalogIndex, invalidateCatalogIndex } from "@/scripts/lib/catalog-index"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups"
import {
  deriveBrowseGroups,
  mountBrowseEverything,
  type BrowseDataSource,
} from "@/scripts/lib/browse-everything"
import { createBrowseState } from "@/scripts/lib/browse-state"
import {
  readBrowseInstrumentation,
  resetBrowseInstrumentation,
} from "@/scripts/lib/browse-instrumentation"
import {
  generateCatalogueOfSize,
  type CatalogEntry,
} from "./fixtures-0118-catalogue.ts"

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number,
  )
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
  window.history.replaceState({}, "", "/movies")
  document.body.replaceChildren()
  invalidateCatalogIndex()
  clearTitleGroupRegistry()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, "", "/")
  document.body.replaceChildren()
})

const EMPTY_SETS = {
  favouriteIds: new Set<string | number>(),
  watchLaterIds: new Set<string | number>(),
  inProgressIds: new Set<string | number>(),
  watchedIds: new Set<string | number>(),
  followedIds: new Set<string | number>(),
  newEpisodeIds: new Set<string | number>(),
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
        meta: "",
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

async function waitForCards(host: HTMLElement, min = 1, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (host.querySelectorAll("[data-browse-key]").length >= min) return
    if (Date.now() - start > timeoutMs) throw new Error("bench: timed out waiting for cards")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

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
        expect(numbers.mountedCards).toBeLessThanOrEqual(numbers.pageSize)
        expect(numbers.mountedCards).toBeGreaterThan(0)
        expect(numbers.posterImages).toBeLessThanOrEqual(numbers.mountedCards)
        // DETERMINISTIC: scrolling rebuilds nothing.
        expect(numbers.scrollRebuilds).toBe(0)
        // Two index builds per run: the harness's explicit build
        // (shared with the Home model via the cache) + the mount's
        // build over its own mapped-entries array. No per-render
        // rebuilds: filter/page/focus phases add zero builds.
        expect(numbers.indexBuilds).toBe(2)
        // Generation produced at least the requested size.
        expect(numbers.rows).toBeGreaterThanOrEqual(size)
        console.log(`bench-0118 [production] ${formatBenchRow(numbers)}`)
      }
      // DOM boundedness is size-independent: the 50k mount holds no
      // more cards than the 1k mount.
      const cards = rows.map((r) => r.mountedCards)
      expect(Math.max(...cards)).toBeLessThanOrEqual(rows[0].pageSize)
      expect(rows[rows.length - 1].mountedCards).toBeLessThanOrEqual(
        rows[0].mountedCards,
      )
    },
    300000,
  )

  it("a realistic browse session costs 6 derives, 1 grouping run, 0 decorated sorts", () => {
    const catalogue = generateCatalogueOfSize(10000, 0x0118)
    const work = measureDerivationWork(catalogue.movies, "bench-session-9101")
    // 6 distinct constraint sets (open + 2 filters + 2 sorts + 1
    // search) → 6 derives over the precomputed indexes, 1 grouping
    // run (at index build), 0 decorated sorts (index-walk sorts),
    // 1 index build, 6 cache hits on repeated reads.
    expect(work.derives).toBe(6)
    expect(work.groups).toBe(1)
    expect(work.sorts).toBe(0)
    expect(work.builds).toBe(1)
    expect(work.cacheHits).toBe(6)
  }, 120000)

  it("focus movement, scrolling and page turns cost zero derives, sorts and grouping runs", async () => {
    const catalogue = generateCatalogueOfSize(5000, 0x0118)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const mount = mountBrowseEverything(container, {
      kind: "movie",
      source: makeSource(catalogue.movies),
      onOpenDetail: () => {},
      onExit: () => {},
    })
    try {
      await waitForCards(container)
      resetBrowseInstrumentation()
      const gridHost = container.querySelector<HTMLElement>('[data-nylah-rail="browse-grid"]')

      // 100 focus moves + 50 scroll rows.
      const cards = [...container.querySelectorAll<HTMLElement>("[data-browse-key]")]
      for (let i = 0; i < 100; i++) cards[i % cards.length].focus()
      for (let i = 0; i < 50; i++) {
        if (gridHost) {
          gridHost.scrollTop = i * 40
          gridHost.dispatchEvent(new Event("scroll", { bubbles: true }))
        }
      }
      // 10 key-driven page turns (the real controller path).
      for (let i = 0; i < 10; i++) {
        const key = i % 2 === 0 ? "PageDown" : "PageUp"
        ;(document.activeElement as Element)?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        )
        await flush(60)
      }
      await flush(60)

      const after = readBrowseInstrumentation()
      expect(after.deriveCalls).toBe(0)
      expect(after.decoratedSorts).toBe(0)
      expect(after.groupRuns).toBe(0)
      expect(after.catalogIndexBuilds).toBe(0)
      expect(after.focusMoves).toBeGreaterThan(0)
      expect(after.pageTurns).toBe(10)
      // Scrolling replaced no grid nodes (the harness's
      // scrollRebuilds pins the scroll-only half); the grid stays
      // bounded to one page plus the one spared focused node the
      // keyed pool keeps across a render.
      const nodesAfter = gridHost ? [...gridHost.children] : []
      expect(nodesAfter.length).toBeLessThanOrEqual(mount.getState().pageSize + 1)

      // Key-driven arrows likewise cost nothing (headless they are
      // no-ops without spatial navigation; the requirement is that
      // they never derive, sort, or regroup).
      const before = readBrowseInstrumentation()
      for (let i = 0; i < 20; i++) {
        ;(document.activeElement as Element)?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        )
      }
      const afterKeys = readBrowseInstrumentation()
      expect(afterKeys.deriveCalls).toBe(before.deriveCalls)
      expect(afterKeys.decoratedSorts).toBe(before.decoratedSorts)
      expect(afterKeys.groupRuns).toBe(before.groupRuns)
    } finally {
      mount.destroy()
    }
  }, 120000)

  it("the index builds once per revision and never per render", () => {
    const catalogue = generateCatalogueOfSize(5000, 0x0118)
    invalidateCatalogIndex()
    clearTitleGroupRegistry()
    resetBrowseInstrumentation()
    const index = getCatalogIndex("vod", catalogue.movies, "bench-rev-9103", {
      playlistId: "bench-rev",
    })
    expect(readBrowseInstrumentation().catalogIndexBuilds).toBe(1)
    // Repeated reads + derivations never rebuild.
    for (let i = 0; i < 10; i++) {
      expect(
        getCatalogIndex("vod", catalogue.movies, "bench-rev-9103", {
          playlistId: "bench-rev",
        }),
      ).toBe(index)
      deriveBrowseGroups(index, createBrowseState("movie"), {
        collection: EMPTY_SETS,
        seasonCounts: new Map(),
      })
    }
    expect(readBrowseInstrumentation().catalogIndexBuilds).toBe(1)
    expect(readBrowseInstrumentation().catalogIndexCacheHits).toBe(10)
    // A new revision rebuilds exactly once.
    getCatalogIndex("vod", catalogue.movies, "bench-rev-9104", {
      playlistId: "bench-rev",
    })
    expect(readBrowseInstrumentation().catalogIndexBuilds).toBe(2)
  }, 120000)
})
