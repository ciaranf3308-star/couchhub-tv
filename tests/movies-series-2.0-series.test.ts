/**
 * @vitest-environment jsdom
 */
// Movies & Series 2.0 (0.11.8) acceptance tests 11–20: SERIES.
//
// Adapted at integration from the W5 stub contract to the REAL W1/W2/W4
// modules (see tests/movies-series-2.0-contract-map.md + the
// integration adaptations recorded in docs/validation-0118.md).
// Followed-series behaviour was already tested against the REAL
// followed.ts store + snapshot/diff functions and the REAL series
// helpers — tests 11/13/14/16/17 are UNCHANGED. Tests 12/15/18/19/20
// were rewired to the real W4 Home composition/render and the real W2
// browse mount; each adaptation is marked ADAPTED.
//
// Key contract resolutions in this file:
// - Worth Starting has NO rating floor and NO rating-descending
//   order (stub decision 10; brief §4.4 mandates neither): the
//   unrated series MAY appear under composite scoring. What is
//   pinned: series-level, deterministic, contains the known-good
//   series, excludes the confirmed-empty one (D28 fix).
// - Detail return is page navigation + focus memory + URL mode in
//   production: the stub's in-mount openDetail/returnFromDetail half
//   has no real equivalent and was dropped; the remount half IS the
//   real restore path (W2 mount + restoreCouchFocus).
// - The real mount loads the catalogue ONCE (initial load); the
//   stub asserted 0 loads because the index was injected.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FOLLOWED_CHANGED_EVENT,
  createMemoryFollowedStore,
  diffSnapshots,
  followSeries,
  isSaneSnapshot,
  listSubscriptions,
  normalizeSnapshot,
  unfollowSeries,
  type FollowedStore,
} from "@/scripts/lib/followed.ts"
import {
  groupEpisodesBySeason,
  nextEpisode,
  resumeEpisode,
  resumeOrNextEpisode,
  selectSeason,
  seriesDetailMetaLine,
  seriesDetailViewModel,
  type EpisodeProgress,
} from "@/scripts/series/couch-series.ts"
import {
  clearCouchFocusMemory,
  readCouchFocusMemory,
  recordCouchFocus,
  restoreCouchFocus,
} from "@/scripts/lib/couch-focus.ts"
import {
  getCatalogIndex,
  invalidateCatalogIndex,
  type CatalogIndex,
} from "@/scripts/lib/catalog-index.ts"
import {
  selectSeriesWorthStarting,
  selectorIds,
} from "@/scripts/lib/collection-selectors.ts"
import { emptyTasteModel } from "@/scripts/lib/taste.ts"
import {
  mountBrowseEverything,
  type BrowseController,
  type BrowseDataSource,
} from "@/scripts/lib/browse-everything.ts"
import { assembleSeriesHomeSections } from "@/scripts/series/series-home-model.ts"
import { renderSeriesHome } from "@/scripts/series/series-home-render.ts"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups.ts"
import {
  adversarialFixture,
  buildChurnScenario,
  generateCatalogue,
  type CatalogEntry,
} from "./fixtures-0118-catalogue.ts"

// Node 24+ ships a native sessionStorage that shadows jsdom's; stub
// it with real in-memory Storage (same approach as
// tests/couch-movies-series.test.ts).
function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

const TASTE = emptyTasteModel("acceptance", "acceptance-playlist")

let revisionCounter = 2000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex(kind, [...entries], `acceptance:${revisionCounter}`, {
    playlistId: "acceptance-playlist",
  })
}

function makeVisible(el: Element): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      width: 120, height: 180, top: 0, left: 0,
      right: 120, bottom: 180, x: 0, y: 0, toJSON: () => ({}),
    }),
    configurable: true,
  })
}

const ADV = adversarialFixture()
const PLAYLIST = "playlist-test-0118"

beforeEach(() => {
  document.body.innerHTML = ""
  Object.defineProperty(globalThis, "sessionStorage", {
    value: makeStorage(),
    configurable: true,
  })
  clearCouchFocusMemory()
  // The W2 mount renders through requestAnimationFrame; drive it
  // with timers (the browse-0118-mount.test.ts settle pattern).
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  )
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
  invalidateCatalogIndex()
  clearTitleGroupRegistry()
  window.history.replaceState(null, "", "/series")
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

/** Episode progress: S1 complete, S2E1 in progress, rest untouched. */
function longWatchProgress(): Map<number, EpisodeProgress> {
  const info = ADV.seriesInfo.get(7102) as {
    episodes: Record<string, Array<{ id: number }>>
  }
  const progress = new Map<number, EpisodeProgress>()
  for (const ep of info.episodes["1"]) {
    progress.set(ep.id, { position: 2700, duration: 2700, completed: true, updatedAt: 100 })
  }
  const s2e1 = info.episodes["2"][0].id
  progress.set(s2e1, { position: 900, duration: 2700, completed: false, updatedAt: 500 })
  return progress
}

async function follow(
  store: FollowedStore,
  seriesId: number,
  title: string
): Promise<void> {
  const result = await followSeries(
    {
      playlistId: PLAYLIST,
      seriesId: String(seriesId),
      seriesTitle: title,
      seriesInfo: ADV.seriesInfo.get(seriesId),
    },
    store
  )
  expect(result.ok).toBe(true)
}

async function followedIds(store: FollowedStore): Promise<number[]> {
  const subs = await listSubscriptions(store)
  return subs.map((s) => Number(s.seriesId))
}

/** A real W2 data source over fixture rows (cf. browse-0118-mount.test.ts). */
function makeSource(
  rows: CatalogEntry[],
  kind: "movie" | "series",
  onLoad?: () => void
): BrowseDataSource {
  return {
    load: async () => {
      onLoad?.()
      return {
        rows,
        playlistId: PLAYLIST,
        playlistTitle: "Test Playlist",
        fromCache: false,
        loadError: false,
      }
    },
    toEntry: (row) => row as CatalogEntry,
    rowKey: (row) => `${kind === "movie" ? "vod" : "series"}-${(row as CatalogEntry).id}`,
    cardView: (row) => {
      const r = row as CatalogEntry
      return {
        title: r.name,
        meta: [r.year, r.category].filter(Boolean).join(" · "),
        image: r.logo,
        kind: "poster",
        itemKey: `${kind === "movie" ? "vod" : "series"}-${r.id}`,
      }
    },
    detailId: (row) => String((row as CatalogEntry).id),
    watchSets: () => ({
      favouriteIds: new Set(),
      watchLaterIds: new Set(),
      inProgressIds: new Set(),
      watchedIds: new Set(),
      followedIds: new Set(),
      newEpisodeIds: new Set(),
    }),
    emptyTitle: "No titles yet",
    emptyMessage: "Empty.",
  }
}

function gridCards(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-browse-key]")]
}

async function waitForCards(host: HTMLElement, min = 1, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (gridCards(host).length >= min) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${min} browse cards (have ${gridCards(host).length})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("0.11.8 series acceptance (tests 11–20)", { timeout: 120000 }, () => {
  it("11. Home prioritises actual next episodes", () => {
    const group = groupEpisodesBySeason(ADV.seriesInfo.get(7102))
    expect(group.seasons).toEqual([1, 2])
    expect(group.totalEpisodes).toBe(8)
    const progress = longWatchProgress()
    // Resume wins: the in-progress S2E1 is the thing to watch now.
    const resumed = resumeEpisode(group, progress)
    expect(resumed).not.toBeNull()
    expect(resumed?.season).toBe(2)
    expect(resumed?.episodeNum).toBe(1)
    const resumeOrNext = resumeOrNextEpisode(group, progress)
    expect(resumeOrNext?.label).toBe("Resume")
    expect(resumeOrNext?.episode.episodeNum).toBe(1)
    // Once S2E1 completes, the next episode is S2E2 — never S1E1 again.
    const s2e1 = group.bySeason.get(2)?.[0]
    progress.set(s2e1?.id as number, {
      position: 2700, duration: 2700, completed: true, updatedAt: 600,
    })
    expect(nextEpisode(group, progress)?.episodeNum).toBe(2)
    expect(nextEpisode(group, progress)?.season).toBe(2)
    expect(resumeOrNextEpisode(group, progress)?.label).toBe("Next Episode")
    // Untouched series: next is the very first episode.
    const fresh = groupEpisodesBySeason(ADV.seriesInfo.get(7101))
    expect(nextEpisode(fresh, new Map())?.episodeNum).toBe(1)
    expect(nextEpisode(fresh, new Map())?.season).toBe(1)
    // Fully watched: no next episode is invented.
    const allWatched = new Map<number, EpisodeProgress>()
    for (const eps of group.bySeason.values()) {
      for (const ep of eps) {
        allWatched.set(ep.id, { position: 2700, duration: 2700, completed: true, updatedAt: 1 })
      }
    }
    expect(nextEpisode(group, allWatched)).toBeNull()
    expect(resumeOrNextEpisode(group, allWatched)).toBeNull()
  })

  it("12. Followed Series populated from the real subscription store", async () => {
    const store = createMemoryFollowedStore()
    await follow(store, 7101, "The Crossing")
    await follow(store, 7102, "The Long Watch")
    // A series with no episodes cannot be followed (no baseline to
    // diff against — following it would alert on the whole catalogue).
    const refused = await followSeries(
      {
        playlistId: PLAYLIST,
        seriesId: "7103",
        seriesTitle: "Mystery Seasons Show",
        seriesInfo: ADV.seriesInfo.get(7103),
      },
      store
    )
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe("no-episodes")

    // ADAPTED: the real W4 composition over the real store read.
    const index = freshIndex("series", ADV.series)
    const subscriptions = (await listSubscriptions(store)).filter(
      (s) => s.playlistId === PLAYLIST
    )
    const sections = assembleSeriesHomeSections({
      index,
      rowsById: new Map(ADV.series.map((e) => [e.id, e])),
      continueInputs: [],
      notificationGroups: [],
      subscriptions,
      taste: TASTE,
      startedIds: [],
      isEpisodeWatched: () => false,
    })
    const followed = sections.find((s) => s.kind === "followed")
    expect(followed).toBeDefined()
    if (followed?.kind !== "followed") throw new Error("unreachable")
    expect(followed.items.map((i) => i.seriesId)).toEqual(["7101", "7102"])
    // Title order, matching listSubscriptions.
    expect(followed.items.map((i) => i.title)).toEqual([
      "The Crossing",
      "The Long Watch",
    ])
    // Never-followed series never appear, however highly rated.
    expect(followed.items.map((i) => i.seriesId)).not.toContain("7104")
    expect(followed.items.map((i) => i.seriesId)).not.toContain("7105")

    // The shelf renders from the store read, through the real render.
    const container = document.createElement("div")
    document.body.appendChild(container)
    renderSeriesHome(container, sections, { playlistId: PLAYLIST })
    expect(
      container.querySelectorAll('[data-nylah-rail="series-home-followed"] .rs-card').length
    ).toBe(2)
  })

  it("13. Newly detected provider episodes appear accurately", async () => {
    const store = createMemoryFollowedStore()
    const { baseline, genuinelyNew } = buildChurnScenario()
    const result = await followSeries(
      {
        playlistId: PLAYLIST,
        seriesId: "7101",
        seriesTitle: "The Crossing",
        seriesInfo: baseline,
      },
      store
    )
    expect(result.ok).toBe(true)
    expect(result.subscription?.baseline).toHaveLength(10)

    const snapshot = normalizeSnapshot(genuinelyNew)
    expect(snapshot).toHaveLength(12)
    const diff = diffSnapshots(result.subscription?.baseline ?? [], snapshot)
    expect(diff.bulkRemapSuspected).toBe(false)
    expect(diff.truncated).toBe(false)
    expect(diff.removedCount).toBe(0)
    expect(
      diff.newEpisodes.map((ep) => `${ep.season}x${ep.episode}`)
    ).toEqual(["1x11", "1x12"])
    // Reordering + renaming the same episodes diffs to nothing.
    const reordered = {
      info: { name: "Churn Show" },
      episodes: {
        "1": [...(genuinelyNew as { episodes: { "1": unknown[] } }).episodes["1"]]
          .reverse()
          .map((ep) => ({ ...(ep as object), title: "Renamed Title" })),
      },
    }
    const noDiff = diffSnapshots(
      normalizeSnapshot(genuinelyNew),
      normalizeSnapshot(reordered)
    )
    expect(noDiff.newEpisodes).toEqual([])
    expect(noDiff.removedCount).toBe(0)
  })

  it("14. No false new episodes from provider ID churn", () => {
    const { baseline, remapped } = buildChurnScenario()
    const base = normalizeSnapshot(baseline)
    const snap = normalizeSnapshot(remapped)
    expect(base).toHaveLength(10)
    expect(snap).toHaveLength(10)
    const diff = diffSnapshots(base, snap)
    // Same S/E numbers, same titles, all-new provider ids: this is a
    // bulk remap, not ten new episodes. The guard must fire.
    expect(diff.bulkRemapSuspected).toBe(true)
    expect(diff.truncated).toBe(false)
    // A consumer that honours the guard alerts on ZERO episodes.
    const alertable = diff.bulkRemapSuspected || diff.truncated ? [] : diff.newEpisodes
    expect(alertable).toEqual([])
    // A truncated response (provider hiccup) is likewise not news.
    const truncated = normalizeSnapshot({
      info: { name: "Churn Show" },
      episodes: { "1": [{ id: 101, season: 1, episode_num: 1, title: "Episode 1" }] },
    })
    const truncDiff = diffSnapshots(base, truncated)
    expect(truncDiff.truncated).toBe(true)
    // A payload with no episodes member at all is not a sane baseline
    // replacement while a baseline exists.
    expect(isSaneSnapshot({ info: { name: "Churn Show" } }, base.length)).toBe(false)
    expect(isSaneSnapshot(baseline, base.length)).toBe(true)
  })

  it("15. Worth Starting returns series-level entries", () => {
    const index = freshIndex("series", ADV.series)
    const result = selectSeriesWorthStarting(index, TASTE, 12, { cacheKey: "t15" })
    const ids = selectorIds(result)
    expect(ids.length).toBeGreaterThan(0)
    // Deterministic: a fresh index over the same rows selects identically.
    const again = selectSeriesWorthStarting(freshIndex("series", ADV.series), TASTE, 12, {
      cacheKey: "t15",
    })
    expect(selectorIds(again)).toEqual(ids)
    const seen = new Set<string>()
    for (const id of ids) {
      // Series-level: the id resolves (by reference) to a catalogue
      // series row — never an episode row.
      const row = index.byId.get(id) as CatalogEntry | undefined
      expect(row).toBeDefined()
      expect(row?.kind).toBe("series")
      expect(Array.isArray(row?.episodes)).toBe(true)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
    expect(ids).toContain("7101")
    expect(ids).toContain("7102")
    expect(ids).not.toContain("7104") // confirmed 0 episodes (D28)
    // ADAPTED: the stub's ≥7 floor, rating-evidence requirement, and
    // rating-descending order were stub decision 10 — brief §4.4
    // mandates none of them. The unrated series (7105) MAY appear
    // under composite scoring; nothing about it is asserted.
  })

  it("16. Season filters use confirmed counts", () => {
    const group = groupEpisodesBySeason(ADV.seriesInfo.get(7102))
    expect(group.seasons).toEqual([1, 2])
    expect(group.bySeason.get(1)).toHaveLength(4)
    expect(group.bySeason.get(2)).toHaveLength(4)
    // Selecting season 2 yields exactly season 2's episodes.
    const selected = selectSeason(group, 2)
    expect(selected).toBe(2)
    expect(group.bySeason.get(selected as number)?.map((e) => e.episodeNum)).toEqual([1, 2, 3, 4])
    // A season that does not exist falls back to the first confirmed one.
    expect(selectSeason(group, 9)).toBe(1)
    // The entry's confirmed counts match the payload exactly.
    const entry = ADV.series.find((e) => e.id === 7102)
    expect(entry?.seasonCount).toBe(2)
    expect(entry?.episodeCount).toBe(8)
    // Generated catalogues: confirmed counts always match payloads.
    const catalogue = generateCatalogue({ seed: 0x1016, movieCount: 0, seriesCount: 100 })
    for (const series of catalogue.series) {
      const payload = catalogue.seriesInfo.get(series.id)
      const g = groupEpisodesBySeason(payload)
      expect(series.seasonCount).toBe(
        catalogue.seasonCounts.get(series.id) ?? null
      )
      if (series.seasonCount != null) {
        expect(g.seasons.length).toBe(series.seasonCount)
        expect(g.totalEpisodes).toBe(series.episodeCount)
      }
    }
  })

  it("17. Unknown season counts are not fabricated", () => {
    const entry = ADV.series.find((e) => e.id === 7103)
    expect(entry?.seasonCount).toBeNull()
    expect(entry?.episodeCount).toBeNull()
    const group = groupEpisodesBySeason(ADV.seriesInfo.get(7103))
    expect(group.seasons).toEqual([])
    expect(group.totalEpisodes).toBe(0)
    expect(selectSeason(group)).toBeNull()
    // The real detail view model: 0 confirmed seasons, and the meta
    // line carries NO season claim at all.
    const detail = seriesDetailViewModel(ADV.seriesInfo.get(7103))
    expect(detail.seasonsCount).toBe(0)
    expect(seriesDetailMetaLine(detail)).not.toMatch(/season/i)
    // The 0-episode payload is likewise honest: confirmed empty.
    const empty = seriesDetailViewModel(ADV.seriesInfo.get(7104))
    expect(empty.seasonsCount).toBe(0)
    expect(seriesDetailMetaLine(empty)).not.toMatch(/season/i)
  })

  it("18. Detail return restores the selected poster", async () => {
    // ADAPTED: the real W2 mount + the real focus memory. The stub's
    // in-mount openDetail/returnFromDetail half has no real
    // equivalent (detail is page navigation); the remount half IS
    // the production restore path.
    const catalogue = generateCatalogue({ seed: 0x1018, movieCount: 0, seriesCount: 120 })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const mount: BrowseController = mountBrowseEverything(container, {
      kind: "series",
      source: makeSource(catalogue.series, "series"),
      onOpenDetail: () => {},
      onExit: () => {},
    })
    await waitForCards(container, 4)
    const cards = gridCards(container)
    const focused = cards[3]
    focused.focus()
    const key = focused.getAttribute("data-couch-key")
    expect(key).toBeTruthy()
    // Record through the REAL focus memory, then navigate away and back.
    recordCouchFocus({
      route: window.location.pathname,
      rail: "browse-grid",
      index: 3,
      key: key as string,
    })
    expect(readCouchFocusMemory()?.key).toBe(key)
    mount.destroy()

    // The REAL restore path: a fresh mount, nothing focused, memory
    // intact → restoreCouchFocus lands on the same poster.
    const container2 = document.createElement("div")
    document.body.appendChild(container2)
    const mount2 = mountBrowseEverything(container2, {
      kind: "series",
      source: makeSource(catalogue.series, "series"),
      onOpenDetail: () => {},
      onExit: () => {},
    })
    await waitForCards(container2, 4)
    gridCards(container2).forEach(makeVisible)
    const rail = container2.querySelector("[data-nylah-rail]")
    if (rail) makeVisible(rail)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect(document.activeElement).toBe(document.body)
    const target = restoreCouchFocus(document)
    expect(target).not.toBeNull()
    expect(target?.getAttribute("data-couch-key")).toBe(key)
    expect(document.activeElement).toBe(target)
    mount2.destroy()
  })

  it("19. Unfollow updates shelves without restart", async () => {
    const store = createMemoryFollowedStore()
    await follow(store, 7101, "The Crossing")
    await follow(store, 7102, "The Long Watch")
    const index = freshIndex("series", ADV.series)
    const container = document.createElement("div")
    document.body.appendChild(container)
    // ADAPTED: the real W4 composition + render, re-rendered into
    // the same container from the live store read.
    const render = async () => {
      const subscriptions = (await listSubscriptions(store)).filter(
        (s) => s.playlistId === PLAYLIST
      )
      const sections = assembleSeriesHomeSections({
        index,
        rowsById: new Map(ADV.series.map((e) => [e.id, e])),
        continueInputs: [],
        notificationGroups: [],
        subscriptions,
        taste: TASTE,
        startedIds: [],
        isEpisodeWatched: () => false,
      })
      renderSeriesHome(container, sections, { playlistId: PLAYLIST })
    }
    const followedCards = () =>
      container.querySelectorAll('[data-nylah-rail="series-home-followed"] .rs-card')
    await render()
    expect(followedCards().length).toBe(2)

    // The real store emits the change event the home subscribes to.
    let events = 0
    const listener = (): void => {
      events += 1
    }
    document.addEventListener(FOLLOWED_CHANGED_EVENT, listener)
    await unfollowSeries(PLAYLIST, "7101", store)
    document.removeEventListener(FOLLOWED_CHANGED_EVENT, listener)
    expect(events).toBe(1)

    // Same container — a re-render from the live store drops the
    // unfollowed show. No restart, no remount.
    await render()
    expect(followedCards().length).toBe(1)
    const remaining = container.querySelector(
      '[data-nylah-rail="series-home-followed"] [data-couch-key]'
    )
    expect(remaining?.getAttribute("data-couch-key")).toBe("series-7102")
    expect(await followedIds(store)).toEqual([7102])
  })

  it("20. No extra provider requests from opening a large grid", async () => {
    // ADAPTED: the real mount loads the catalogue ONCE (initial
    // load); paging/scrolling/category/filter/search must add ZERO
    // further loads. The stub asserted 0 because the index was
    // injected — the real contract is exactly-one.
    const catalogue = generateCatalogue({ seed: 0x1020, movieCount: 8000, seriesCount: 0 })
    let loaderCalls = 0
    const container = document.createElement("div")
    document.body.appendChild(container)
    const mount = mountBrowseEverything(container, {
      kind: "movie",
      source: makeSource(catalogue.movies, "movie", () => {
        loaderCalls += 1
      }),
      onOpenDetail: () => {},
      onExit: () => {},
    })
    await waitForCards(container, 1)
    expect(loaderCalls).toBe(1)
    // Paging, scrolling, category switches, filters: all from the index.
    for (let page = 1; page <= 5; page++) {
      mount.setState({ page })
      await flush()
    }
    const grid = container.querySelector("[data-nylah-rail='browse-grid']") ?? container
    for (let i = 0; i < 20; i++) grid.dispatchEvent(new Event("scroll", { bubbles: true }))
    await flush()
    mount.setState({ category: { kind: "genre", id: "action", label: "Action" } })
    await flush()
    mount.setState({ filters: { minRating: 7 } })
    await flush()
    mount.setState({ search: "harbour", searchScope: "all" })
    await flush()
    expect(loaderCalls).toBe(1)
    expect(gridCards(container).length).toBeGreaterThan(0)
    mount.destroy()
  })
})
