/**
 * @vitest-environment jsdom
 */
// Movies & Series 2.0 (0.11.8, W5) acceptance tests 11–20: SERIES.
//
// Followed-series behaviour is tested against the REAL followed.ts
// store + snapshot/diff functions (createMemoryFollowedStore,
// followSeries, unfollowSeries, listSubscriptions, normalizeSnapshot,
// diffSnapshots, isSaneSnapshot) and the REAL series helpers
// (groupEpisodesBySeason, nextEpisode, resumeEpisode,
// resumeOrNextEpisode, selectSeason, seriesDetailViewModel). The
// shelf/index/browse surface is the contract stub. No network, no
// provider calls: snapshots are fixture payloads.

import { describe, it, expect, beforeEach } from "vitest"
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
  mountBrowseEverything,
  mountHomeShelves,
  normaliseRating,
  selectHomeShelves,
  selectSeriesWorthStarting,
  type CatalogEntry,
  type CatalogIndex,
} from "./movies-series-2.0-stubs.ts"
import {
  adversarialFixture,
  buildChurnScenario,
  generateCatalogue,
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

let revisionCounter = 2000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex(kind, entries, revisionCounter)
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

    const index = freshIndex("series", ADV.series)
    const shelves = selectHomeShelves(index, {
      followedIds: await followedIds(store),
    })
    expect(shelves.followedSeries.map((e) => e.id)).toEqual([7101, 7102])
    // Title order, matching listSubscriptions.
    expect(shelves.followedSeries.map((e) => e.displayTitle)).toEqual([
      "The Crossing",
      "The Long Watch",
    ])
    // Never-followed series never appear, however highly rated.
    expect(shelves.followedSeries.map((e) => e.id)).not.toContain(7104)
    expect(shelves.followedSeries.map((e) => e.id)).not.toContain(7105)

    // The shelf renders from the store read, through the home mount.
    const container = document.createElement("div")
    document.body.appendChild(container)
    const home = mountHomeShelves(container, shelves)
    expect(home.getShelfCounts()["followed-series"]).toBe(2)
    home.unmount()
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
    const result = selectSeriesWorthStarting(index)
    expect(result.length).toBeGreaterThan(0)
    const seen = new Set<number>()
    for (const entry of result) {
      expect(entry.kind).toBe("series")
      // Series-level: the entry IS a catalogue series row (id, season
      // info, episode list) — never an episode row.
      expect(index.byId.get(entry.id)).toBe(entry)
      expect(Array.isArray(entry.episodes)).toBe(true)
      expect(seen.has(entry.id)).toBe(false)
      seen.add(entry.id)
      const rating = normaliseRating(entry)
      expect(rating.hasEvidence).toBe(true)
      expect(rating.value as number).toBeGreaterThanOrEqual(7)
    }
    expect(result.map((e) => e.id)).toContain(7101)
    expect(result.map((e) => e.id)).toContain(7102)
    expect(result.map((e) => e.id)).not.toContain(7104) // confirmed 0 episodes
    expect(result.map((e) => e.id)).not.toContain(7105) // unrated
    // Rating-evidence order, deterministic.
    const values = result.map((e) => normaliseRating(e).value as number)
    expect([...values].sort((a, b) => b - a)).toEqual(values)
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
    const catalogue = generateCatalogue({ seed: 0x1018, movieCount: 0, seriesCount: 120 })
    const index = freshIndex("series", catalogue.series)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const mount = mountBrowseEverything(container, { index })
    await mount.awaitSettled()
    const focused = mount.focusCard(3)
    expect(focused).not.toBeNull()
    const key = focused?.getAttribute("data-group-key")
    expect(key).toBeTruthy()
    // Record through the REAL focus memory, then navigate away and back.
    recordCouchFocus({
      route: window.location.pathname,
      rail: "browse-grid",
      index: 3,
      key: key as string,
    })
    expect(readCouchFocusMemory()?.key).toBe(key)
    mount.openDetail(key as string)
    expect(mount.isDetailOpen()).toBe(true)
    mount.returnFromDetail()
    await mount.awaitSettled()
    const restored = mount.getFocusedCard()
    expect(restored?.getAttribute("data-group-key")).toBe(key)

    // The REAL restore path: a fresh mount, nothing focused, memory
    // intact → restoreCouchFocus lands on the same poster.
    mount.unmount()
    const container2 = document.createElement("div")
    document.body.appendChild(container2)
    const mount2 = mountBrowseEverything(container2, { index })
    await mount2.awaitSettled()
    container2.querySelectorAll("[data-browse-card]").forEach(makeVisible)
    const rail = container2.querySelector("[data-nylah-rail]")
    if (rail) makeVisible(rail)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect(document.activeElement).toBe(document.body)
    const target = restoreCouchFocus(document)
    expect(target).not.toBeNull()
    expect(target?.getAttribute("data-group-key")).toBe(key)
    expect(document.activeElement).toBe(target)
    mount2.unmount()
  })

  it("19. Unfollow updates shelves without restart", async () => {
    const store = createMemoryFollowedStore()
    await follow(store, 7101, "The Crossing")
    await follow(store, 7102, "The Long Watch")
    const index = freshIndex("series", ADV.series)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const render = async () =>
      selectHomeShelves(index, { followedIds: await followedIds(store) })
    const home = mountHomeShelves(container, await render())
    expect(home.getShelfCounts()["followed-series"]).toBe(2)

    // The real store emits the change event the home subscribes to.
    let events = 0
    const listener = (): void => {
      events += 1
    }
    document.addEventListener(FOLLOWED_CHANGED_EVENT, listener)
    await unfollowSeries(PLAYLIST, "7101", store)
    document.removeEventListener(FOLLOWED_CHANGED_EVENT, listener)
    expect(events).toBe(1)

    // Same mount, same container — a re-render from the live store
    // drops the unfollowed show. No restart, no remount.
    home.reRender(await render())
    expect(home.getShelfCounts()["followed-series"]).toBe(1)
    const remaining = container.querySelector(
      '[data-nylah-rail="followed-series"] [data-entry-id]'
    )
    expect(remaining?.getAttribute("data-entry-id")).toBe("7102")
    expect(await followedIds(store)).toEqual([7102])
    home.unmount()
  })

  it("20. No extra provider requests from opening a large grid", async () => {
    const catalogue = generateCatalogue({ seed: 0x1020, movieCount: 8000, seriesCount: 2000 })
    const index = freshIndex("vod", catalogue.movies)
    let loaderCalls = 0
    const container = document.createElement("div")
    document.body.appendChild(container)
    const mount = mountBrowseEverything(container, {
      index,
      loader: () => {
        loaderCalls += 1
        return null
      },
    })
    await mount.awaitSettled()
    // Paging, scrolling, category switches, filters: all from the index.
    for (let page = 1; page <= 5; page++) {
      mount.setPage(page)
      await mount.awaitSettled()
    }
    for (let i = 0; i < 20; i++) mount.scrollWithinPage(1)
    const firstCategory = index.categories[0]
    mount.setCategory(firstCategory.id)
    await mount.awaitSettled()
    mount.applyFilters({ minRating: 7 })
    await mount.awaitSettled()
    mount.setSearch("harbour", "all")
    await mount.awaitSettled()
    expect(loaderCalls).toBe(0)
    expect(mount.getMountedCardCount()).toBeGreaterThan(0)
    mount.unmount()
  })
})
