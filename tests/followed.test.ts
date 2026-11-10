// Followed Series — detection engine, false-positive guards, notification
// grouping, and the launcher notifications.json contract.
// Synthetic fixtures only; no live IPTV subscription is required.
import { describe, it, expect, beforeEach } from "vitest"
import {
  normalizeSnapshot,
  diffSnapshots,
  isSaneSnapshot,
  episodeKey,
  followSeries,
  unfollowSeries,
  isFollowing,
  listSubscriptions,
  rebaselineSeries,
  runFollowedCheck,
  listNotificationGroups,
  getUnreadCount,
  getUnreadEpisodes,
  markNotificationRead,
  dismissNotification,
  clearUnreadForEpisode,
  serializeNotificationsFile,
  parseNotificationsFile,
  followedProvider,
  ensureFollowedLoaded,
  refreshFollowedCache,
  createMemoryFollowedStore,
  setFollowedStore,
  getFollowedCheckIntervalHours,
  setFollowedCheckIntervalHours,
  parseDeepLinkTarget,
  buildSeriesDetailUrl,
  type FollowedStore,
  type FollowedNotificationGroup,
} from "../src/scripts/lib/followed"

// get_series_info-shaped fixtures -------------------------------------------------

function infoFromMap(episodes: Record<string, Array<Record<string, unknown>>>): unknown {
  return { info: { name: "Some Show" }, episodes }
}

function infoFromArray(episodes: Array<Record<string, unknown>>): unknown {
  return { info: { name: "Some Show" }, episodes }
}

const BASE_INFO = infoFromMap({
  "1": [
    { id: 101, season: 1, episode_num: 1, title: "Pilot" },
    { id: 102, season: 1, episode_num: 2, title: "Second" },
    { id: 103, season: 1, episode_num: 3, title: "Third" },
  ],
  "2": [
    { id: 201, season: 2, episode_num: 1, title: "Return" },
    { id: 202, season: 2, episode_num: 2, title: "Again" },
  ],
})

const BASE_PLUS_ONE = infoFromMap({
  "1": [
    { id: 101, season: 1, episode_num: 1, title: "Pilot" },
    { id: 102, season: 1, episode_num: 2, title: "Second" },
    { id: 103, season: 1, episode_num: 3, title: "Third" },
  ],
  "2": [
    { id: 201, season: 2, episode_num: 1, title: "Return" },
    { id: 202, season: 2, episode_num: 2, title: "Again" },
    { id: 203, season: 2, episode_num: 3, title: "Brand New" },
  ],
})

const BASE_PLUS_THREE = infoFromMap({
  "1": [
    { id: 101, season: 1, episode_num: 1, title: "Pilot" },
    { id: 102, season: 1, episode_num: 2, title: "Second" },
    { id: 103, season: 1, episode_num: 3, title: "Third" },
  ],
  "2": [
    { id: 201, season: 2, episode_num: 1, title: "Return" },
    { id: 202, season: 2, episode_num: 2, title: "Again" },
    { id: 203, season: 2, episode_num: 3, title: "New One" },
    { id: 204, season: 2, episode_num: 4, title: "New Two" },
    { id: 205, season: 2, episode_num: 5, title: "New Three" },
  ],
})

let store: FollowedStore

beforeEach(async () => {
  store = createMemoryFollowedStore()
  setFollowedStore(store)
  // The Discover-seam cache is module-level: reset it against the fresh store.
  await refreshFollowedCache(store)
})

async function followBaseline(): Promise<void> {
  const res = await followSeries(
    {
      playlistId: "pl-1",
      seriesId: "42",
      seriesTitle: "Some Show",
      posterUrl: "https://provider.example/poster.jpg",
      seriesInfo: BASE_INFO,
    },
    store
  )
  expect(res.ok).toBe(true)
}

const xtreamDeps = {
  resolveEntry: async () => ({ entryId: "pl-1", kind: "xtream" as const }),
}

// Pure engine --------------------------------------------------------------------

describe("normalizeSnapshot", () => {
  it("flattens the season-keyed object form, sorted by season then episode", () => {
    const snap = normalizeSnapshot(BASE_INFO)
    expect(snap.map((e) => e.episodeId)).toEqual([101, 102, 103, 201, 202])
    expect(snap[0]).toEqual({ season: 1, episode: 1, episodeId: 101, title: "Pilot" })
  })

  it("flattens the flat array form", () => {
    const snap = normalizeSnapshot(
      infoFromArray([
        { id: 202, season: 2, episode_num: 2, title: "Again" },
        { id: 101, season: 1, episode_num: 1, title: "Pilot" },
      ])
    )
    expect(snap.map((e) => e.episodeId)).toEqual([101, 202])
  })

  it("dedupes provider duplicates by identity, keeping the titled entry", () => {
    const snap = normalizeSnapshot(
      infoFromMap({
        "1": [
          { id: 101, season: 1, episode_num: 1, title: "" },
          { id: 101, season: 1, episode_num: 1, title: "Pilot" },
        ],
      })
    )
    expect(snap).toHaveLength(1)
    expect(snap[0].title).toBe("Pilot")
  })

  it("drops entries with no usable identity", () => {
    const snap = normalizeSnapshot(infoFromMap({ "1": [{ season: 1 }, { id: 5, season: 1, episode_num: 1, title: "Ok" }] }))
    expect(snap.map((e) => e.episodeId)).toEqual([5])
  })

  it("returns [] for null / non-object payloads", () => {
    expect(normalizeSnapshot(null)).toEqual([])
    expect(normalizeSnapshot("nope")).toEqual([])
    expect(normalizeSnapshot({})).toEqual([])
  })
})

describe("episodeKey", () => {
  it("prefers the provider episode id", () => {
    expect(episodeKey({ season: 1, episode: 1, episodeId: 101, title: "Pilot" })).toBe("id:101")
  })
  it("falls back to S/E numbers, then normalised title", () => {
    expect(episodeKey({ season: 2, episode: 3, episodeId: null, title: "" })).toBe("se:2:3")
    expect(episodeKey({ season: 2, episode: 0, episodeId: null, title: "  Special  One " })).toBe("t:2:special one")
  })
})

describe("diffSnapshots", () => {
  it("detects a genuinely new episode", () => {
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(BASE_PLUS_ONE))
    expect(diff.newEpisodes).toHaveLength(1)
    expect(diff.newEpisodes[0]).toMatchObject({ season: 2, episode: 3, episodeId: 203 })
    expect(diff.bulkRemapSuspected).toBe(false)
    expect(diff.truncated).toBe(false)
  })

  it("ignores a pure reorder of seasons/episodes", () => {
    const reordered = infoFromMap({
      "2": [
        { id: 202, season: 2, episode_num: 2, title: "Again" },
        { id: 201, season: 2, episode_num: 1, title: "Return" },
      ],
      "1": [
        { id: 103, season: 1, episode_num: 3, title: "Third" },
        { id: 101, season: 1, episode_num: 1, title: "Pilot" },
        { id: 102, season: 1, episode_num: 2, title: "Second" },
      ],
    })
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(reordered))
    expect(diff.newEpisodes).toEqual([])
    expect(diff.removedCount).toBe(0)
  })

  it("ignores renames (same provider id, different title)", () => {
    const renamed = infoFromMap({
      "1": [
        { id: 101, season: 1, episode_num: 1, title: "Pilot (Remastered)" },
        { id: 102, season: 1, episode_num: 2, title: "Second" },
        { id: 103, season: 1, episode_num: 3, title: "Third" },
      ],
      "2": [
        { id: 201, season: 2, episode_num: 1, title: "Return" },
        { id: 202, season: 2, episode_num: 2, title: "Again" },
      ],
    })
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(renamed))
    expect(diff.newEpisodes).toEqual([])
  })

  it("ignores duplicate rows in the fresh payload", () => {
    const duped = infoFromMap({
      "1": [
        { id: 101, season: 1, episode_num: 1, title: "Pilot" },
        { id: 101, season: 1, episode_num: 1, title: "Pilot" },
        { id: 102, season: 1, episode_num: 2, title: "Second" },
        { id: 103, season: 1, episode_num: 3, title: "Third" },
      ],
      "2": [
        { id: 201, season: 2, episode_num: 1, title: "Return" },
        { id: 202, season: 2, episode_num: 2, title: "Again" },
      ],
    })
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(duped))
    expect(diff.newEpisodes).toEqual([])
  })

  it("flags a wholesale id remap instead of alerting", () => {
    const remapped = infoFromMap({
      "1": [
        { id: 901, season: 1, episode_num: 1, title: "Pilot" },
        { id: 902, season: 1, episode_num: 2, title: "Second" },
        { id: 903, season: 1, episode_num: 3, title: "Third" },
      ],
      "2": [
        { id: 904, season: 2, episode_num: 1, title: "Return" },
        { id: 905, season: 2, episode_num: 2, title: "Again" },
      ],
    })
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(remapped))
    expect(diff.bulkRemapSuspected).toBe(true)
    expect(diff.newEpisodes).toHaveLength(5)
  })

  it("does not flag a genuine new season as a remap (nothing old removed)", () => {
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(BASE_PLUS_THREE))
    expect(diff.bulkRemapSuspected).toBe(false)
    expect(diff.newEpisodes).toHaveLength(3)
  })

  it("flags a truncated snapshot", () => {
    const tiny = infoFromMap({ "1": [{ id: 101, season: 1, episode_num: 1, title: "Pilot" }] })
    const diff = diffSnapshots(normalizeSnapshot(BASE_INFO), normalizeSnapshot(tiny))
    expect(diff.truncated).toBe(true)
  })
})

describe("isSaneSnapshot", () => {
  it("rejects a null payload and a missing episodes member", () => {
    expect(isSaneSnapshot(null, 5)).toBe(false)
    expect(isSaneSnapshot({ info: {} }, 5)).toBe(false)
  })
  it("rejects an empty episode list when a baseline exists", () => {
    expect(isSaneSnapshot({ episodes: {} }, 5)).toBe(false)
    expect(isSaneSnapshot({ episodes: [] }, 5)).toBe(false)
  })
  it("accepts an empty list when there is no baseline yet", () => {
    expect(isSaneSnapshot({ episodes: {} }, 0)).toBe(true)
  })
  it("accepts a non-empty payload", () => {
    expect(isSaneSnapshot(BASE_INFO, 5)).toBe(true)
  })
})

// Follow / unfollow ---------------------------------------------------------------

describe("followSeries", () => {
  it("creates a baseline and raises NO notifications for the back catalogue", async () => {
    const res = await followSeries(
      { playlistId: "pl-1", seriesId: "42", seriesTitle: "Some Show", seriesInfo: BASE_INFO },
      store
    )
    expect(res.ok).toBe(true)
    expect(res.subscription?.baseline).toHaveLength(5)
    expect(await listNotificationGroups({}, store)).toEqual([])
    expect(await isFollowing("pl-1", "42", store)).toBe(true)
  })

  it("refuses to follow when no episodes can be baselined", async () => {
    const res = await followSeries(
      { playlistId: "pl-1", seriesId: "42", seriesTitle: "Some Show", seriesInfo: { episodes: {} } },
      store
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("no-episodes")
    expect(await listSubscriptions(store)).toEqual([])
  })

  it("unfollow removes the subscription and its unread notifications", async () => {
    await followBaseline()
    // Seed one unread group, then unfollow.
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => BASE_PLUS_ONE },
    })
    expect(summary.groupsCreated).toBe(1)
    await unfollowSeries("pl-1", "42", store)
    expect(await isFollowing("pl-1", "42", store)).toBe(false)
    expect(await listNotificationGroups({}, store)).toEqual([])
  })
})

// Check runner --------------------------------------------------------------------

describe("runFollowedCheck", () => {
  it("detects one new episode and groups it into a single notification", async () => {
    await followBaseline()
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => BASE_PLUS_ONE },
    })
    expect(summary.newEpisodes).toBe(1)
    expect(summary.groupsCreated).toBe(1)
    const groups = await listNotificationGroups({}, store)
    expect(groups).toHaveLength(1)
    expect(groups[0].episodes).toHaveLength(1)
    expect(groups[0].episodes[0]).toMatchObject({ season: 2, episode: 3, episodeId: 203 })
    expect(groups[0].read).toBe(false)
  })

  it("groups three new episodes from one provider update into ONE notification", async () => {
    await followBaseline()
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => BASE_PLUS_THREE },
    })
    expect(summary.newEpisodes).toBe(3)
    expect(summary.groupsCreated).toBe(1)
    const groups = await listNotificationGroups({}, store)
    expect(groups[0].episodes).toHaveLength(3)
  })

  it("does not repeat alerts for already-seen episodes on the next scan", async () => {
    await followBaseline()
    const fetch = async () => BASE_PLUS_ONE
    await runFollowedCheck({ manual: true, store, deps: { ...xtreamDeps, fetchSeriesInfo: fetch } })
    const second = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: fetch },
    })
    expect(second.newEpisodes).toBe(0)
    expect(second.groupsCreated).toBe(0)
    expect(await listNotificationGroups({}, store)).toHaveLength(1)
  })

  it("keeps the old baseline and backs off on an empty provider response", async () => {
    await followBaseline()
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => ({ episodes: {} }) },
    })
    expect(summary.newEpisodes).toBe(0)
    const subs = await listSubscriptions(store)
    expect(subs[0].baseline).toHaveLength(5)
    expect(subs[0].lastCheckStatus).toBe("incomplete")
    expect(subs[0].consecutiveFailures).toBe(1)
    expect(subs[0].nextCheckNotBefore).not.toBeNull()
    expect(await listNotificationGroups({}, store)).toEqual([])
  })

  it("keeps the old baseline on a provider error and records the failure", async () => {
    await followBaseline()
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: {
        ...xtreamDeps,
        fetchSeriesInfo: async () => {
          throw new Error("network down")
        },
      },
    })
    expect(summary.errors).toBe(1)
    const subs = await listSubscriptions(store)
    expect(subs[0].baseline).toHaveLength(5)
    expect(subs[0].lastCheckStatus).toBe("error")
  })

  it("raises no alert on reorder / rename / duplicates in the fresh payload", async () => {
    await followBaseline()
    const reordered = infoFromMap({
      "2": [
        { id: 202, season: 2, episode_num: 2, title: "Again (Extended Cut)" },
        { id: 201, season: 2, episode_num: 1, title: "Return" },
      ],
      "1": [
        { id: 103, season: 1, episode_num: 3, title: "Third" },
        { id: 102, season: 1, episode_num: 2, title: "Second" },
        { id: 102, season: 1, episode_num: 2, title: "Second" },
        { id: 101, season: 1, episode_num: 1, title: "Pilot" },
      ],
    })
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => reordered },
    })
    expect(summary.newEpisodes).toBe(0)
    expect(summary.groupsCreated).toBe(0)
  })

  it("flags a bulk remap, keeps the baseline, and raises no notification", async () => {
    await followBaseline()
    const remapped = infoFromMap({
      "1": [
        { id: 901, season: 1, episode_num: 1, title: "Pilot" },
        { id: 902, season: 1, episode_num: 2, title: "Second" },
        { id: 903, season: 1, episode_num: 3, title: "Third" },
      ],
      "2": [
        { id: 904, season: 2, episode_num: 1, title: "Return" },
        { id: 905, season: 2, episode_num: 2, title: "Again" },
      ],
    })
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => remapped },
    })
    expect(summary.remapSuspects).toEqual(["42"])
    expect(summary.newEpisodes).toBe(0)
    const subs = await listSubscriptions(store)
    expect(subs[0].baseline).toHaveLength(5)
    expect(subs[0].baseline[0].episodeId).toBe(101)
    expect(subs[0].needsRebaseline).toBe(true)
    expect(subs[0].lastCheckStatus).toBe("bulk-remap-suspected")
    expect(await listNotificationGroups({}, store)).toEqual([])
  })

  it("re-baseline after a remap adopts the new ids silently", async () => {
    await followBaseline()
    const remapped = infoFromMap({
      "1": [
        { id: 901, season: 1, episode_num: 1, title: "Pilot" },
        { id: 902, season: 1, episode_num: 2, title: "Second" },
        { id: 903, season: 1, episode_num: 3, title: "Third" },
      ],
      "2": [
        { id: 904, season: 2, episode_num: 1, title: "Return" },
        { id: 905, season: 2, episode_num: 2, title: "Again" },
      ],
    })
    await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => remapped },
    })
    const res = await rebaselineSeries("pl-1", "42", remapped, store)
    expect(res.ok).toBe(true)
    expect(res.subscription?.baseline[0].episodeId).toBe(901)
    expect(res.subscription?.needsRebaseline).toBe(false)
    // A follow-up check against the same payload now finds nothing new.
    const second = await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => remapped },
    })
    expect(second.newEpisodes).toBe(0)
    expect(await listNotificationGroups({}, store)).toEqual([])
  })

  it("skips M3U playlists without touching the baseline", async () => {
    await followSeries(
      {
        playlistId: "pl-m3u",
        seriesId: "7",
        seriesTitle: "M3U Show",
        sourceKind: "m3u",
        seriesInfo: BASE_INFO,
      },
      store
    )
    let fetched = false
    const summary = await runFollowedCheck({
      manual: true,
      store,
      deps: {
        resolveEntry: async () => ({ entryId: "pl-m3u", kind: "m3u" as const }),
        fetchSeriesInfo: async () => {
          fetched = true
          return BASE_PLUS_ONE
        },
      },
    })
    expect(fetched).toBe(false)
    expect(summary.checked).toBe(0)
    const subs = await listSubscriptions(store)
    expect(subs[0].lastCheckStatus).toBe("unsupported-m3u")
    expect(subs[0].baseline).toHaveLength(5)
  })

  it("collapses concurrent runs into one", async () => {
    await followBaseline()
    let calls = 0
    const fetch = async () => {
      calls++
      return BASE_PLUS_ONE
    }
    const deps = { ...xtreamDeps, fetchSeriesInfo: fetch }
    const [a, b] = await Promise.all([
      runFollowedCheck({ manual: true, store, deps }),
      runFollowedCheck({ manual: true, store, deps }),
    ])
    expect(calls).toBe(1)
    expect(a.newEpisodes).toBe(1)
    expect(b.newEpisodes).toBe(1)
  })
})

// Notifications -------------------------------------------------------------------

describe("notifications", () => {
  async function seedOneGroup(): Promise<FollowedNotificationGroup[]> {
    await followBaseline()
    await runFollowedCheck({
      manual: true,
      store,
      deps: { ...xtreamDeps, fetchSeriesInfo: async () => BASE_PLUS_THREE },
    })
    return listNotificationGroups({}, store)
  }

  it("mark read hides the group from the unread set but keeps it in history", async () => {
    const [group] = await seedOneGroup()
    expect(await getUnreadCount(store)).toBe(3)
    await markNotificationRead(group.id, store)
    expect(await getUnreadCount(store)).toBe(0)
    // Read groups stay visible in history (read, not dismissed)...
    const visible = await listNotificationGroups({}, store)
    expect(visible).toHaveLength(1)
    expect(visible[0].read).toBe(true)
    // ...and are included with includeDismissed as well.
    expect(await listNotificationGroups({ includeDismissed: true }, store)).toHaveLength(1)
  })

  it("dismiss marks the group read and dismissed", async () => {
    const [group] = await seedOneGroup()
    await dismissNotification(group.id, store)
    const all = await listNotificationGroups({ includeDismissed: true }, store)
    expect(all[0].dismissed).toBe(true)
    expect(all[0].read).toBe(true)
    expect(await getUnreadCount(store)).toBe(0)
  })

  it("clearing one watched episode removes just that episode from its group", async () => {
    const [group] = await seedOneGroup()
    const cleared = await clearUnreadForEpisode(
      "pl-1",
      "42",
      { season: 2, episode: 4, episodeId: 204 },
      store
    )
    expect(cleared).toBe(true)
    expect(await getUnreadCount(store)).toBe(2)
    const groups = await listNotificationGroups({}, store)
    expect(groups[0].episodes.map((e) => e.episode)).toEqual([3, 5])
    // Clearing the rest removes the emptied group entirely.
    await clearUnreadForEpisode("pl-1", "42", { season: 2, episode: 3, episodeId: 203 }, store)
    await clearUnreadForEpisode("pl-1", "42", { season: 2, episode: 5, episodeId: 205 }, store)
    expect(await getUnreadCount(store)).toBe(0)
    expect(await listNotificationGroups({}, store)).toEqual([])
  })

  it("followedProvider.getNewEpisodes reflects the unread set after load", async () => {
    await seedOneGroup()
    // The check run itself hydrates the seam cache, so the episodes are
    // visible immediately; ensureFollowedLoaded re-hydrates from the store.
    await ensureFollowedLoaded(store)
    const eps = followedProvider.getNewEpisodes()
    expect(eps).toHaveLength(3)
    expect(eps[0]).toMatchObject({ seriesId: "42", seriesTitle: "Some Show", season: 2, episode: 3 })
    expect(eps[0].watched).toBe(false)
    // Refreshing after a mark-read drops it from the seam too.
    const [readGroup] = await listNotificationGroups({}, store)
    await markNotificationRead(readGroup.id, store)
    await refreshFollowedCache(store)
    expect(followedProvider.getNewEpisodes()).toEqual([])
  })

  it("getUnreadEpisodes returns newest first", async () => {
    await seedOneGroup()
    const eps = await getUnreadEpisodes(store)
    expect(eps.map((e) => e.episode)).toEqual([3, 4, 5])
  })
})

// notifications.json ----------------------------------------------------------------

describe("notifications.json contract", () => {
  const group: FollowedNotificationGroup = {
    id: "pl-1::42::2026-11-10T10:00:00.000Z",
    playlistId: "pl-1",
    seriesId: "42",
    seriesTitle: "Some Show",
    posterUrl: "https://provider.example/poster.jpg",
    episodes: [
      {
        seriesId: "42",
        seriesTitle: "Some Show",
        season: 2,
        episode: 3,
        episodeTitle: "Brand New",
        episodeId: 203,
        detectedAt: "2026-11-10T10:00:00.000Z",
        posterUrl: "https://provider.example/poster.jpg",
        watched: false,
      },
    ],
    detectedAt: "2026-11-10T10:00:00.000Z",
    read: false,
    dismissed: false,
  }

  it("serialises schema v1 with one entry per episode and no provider URLs", () => {
    const json = serializeNotificationsFile({ lastCheck: "2026-11-10T10:00:00.000Z", groups: [group] })
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.lastCheck).toBe("2026-11-10T10:00:00.000Z")
    expect(parsed.unreadCount).toBe(1)
    expect(parsed.notifications).toHaveLength(1)
    expect(parsed.notifications[0]).toEqual({
      seriesId: "42",
      seriesTitle: "Some Show",
      season: 2,
      episode: 3,
      episodeTitle: "Brand New",
      detectedAt: "2026-11-10T10:00:00.000Z",
    })
    expect(JSON.stringify(parsed)).not.toContain("provider.example")
    expect(JSON.stringify(parsed)).not.toContain("password")
  })

  it("keeps a local/cache poster URL and drops a remote one", () => {
    const local = { ...group, posterUrl: "file:///C:/Users/x/AppData/Local/cache/poster.jpg" }
    const parsed = JSON.parse(serializeNotificationsFile({ lastCheck: null, groups: [local] }))
    expect(parsed.notifications[0].posterUrl).toBe("file:///C:/Users/x/AppData/Local/cache/poster.jpg")
  })

  it("bounds the list to the latest 10 episodes", () => {
    const groups: FollowedNotificationGroup[] = Array.from({ length: 12 }, (_, i) => ({
      ...group,
      id: `g-${i}`,
      seriesId: `s-${i}`,
      seriesTitle: `Show ${i}`,
      detectedAt: `2026-11-10T10:${String(i).padStart(2, "0")}:00.000Z`,
      episodes: [
        {
          ...group.episodes[0],
          seriesId: `s-${i}`,
          seriesTitle: `Show ${i}`,
          detectedAt: `2026-11-10T10:${String(i).padStart(2, "0")}:00.000Z`,
        },
      ],
    }))
    const parsed = JSON.parse(serializeNotificationsFile({ lastCheck: null, groups }))
    expect(parsed.notifications).toHaveLength(10)
    expect(parsed.unreadCount).toBe(10)
    // Newest first: the 11:xx entries win over the 10:00 one.
    expect(parsed.notifications[0].seriesId).toBe("s-11")
  })

  it("excludes read and dismissed groups", () => {
    const read = { ...group, id: "read-1", read: true }
    const dismissed = { ...group, id: "dis-1", dismissed: true, read: true }
    const parsed = JSON.parse(serializeNotificationsFile({ lastCheck: null, groups: [read, dismissed, group] }))
    expect(parsed.notifications).toHaveLength(1)
    expect(parsed.unreadCount).toBe(1)
  })

  it("parses a valid file back (round-trip)", () => {
    const json = serializeNotificationsFile({ lastCheck: "2026-11-10T10:00:00.000Z", groups: [group] })
    const parsed = parseNotificationsFile(json)
    expect(parsed?.schemaVersion).toBe(1)
    expect(parsed?.notifications).toHaveLength(1)
    expect(parsed?.notifications[0]).toMatchObject({ seriesId: "42", season: 2, episode: 3 })
  })

  it("tolerates malformed input", () => {
    expect(parseNotificationsFile("not json at all")).toBeNull()
    expect(parseNotificationsFile("")).toBeNull()
    expect(parseNotificationsFile("[]")).toBeNull()
    expect(parseNotificationsFile(JSON.stringify({ schemaVersion: 2, notifications: [] }))).toBeNull()
    expect(parseNotificationsFile(JSON.stringify({ schemaVersion: 1, notifications: "junk" }))).not.toBeNull()
  })

  it("drops invalid entries but keeps the valid ones", () => {
    const parsed = parseNotificationsFile(
      JSON.stringify({
        schemaVersion: 1,
        lastCheck: "2026-11-10T10:00:00.000Z",
        unreadCount: 99,
        notifications: [
          { seriesId: "42", seriesTitle: "Ok", season: 2, episode: 3, episodeTitle: "Fine", detectedAt: "2026-11-10T10:00:00.000Z" },
          { seriesId: "", season: 1, episode: 1 },
          { seriesId: "43", season: "two", episode: 1 },
          "junk",
          null,
        ],
      })
    )
    expect(parsed?.notifications).toHaveLength(1)
    expect(parsed?.unreadCount).toBe(1)
  })
})

// Settings + deep links --------------------------------------------------------------

describe("settings validation", () => {
  it("accepts only 3/6/12/24 hour intervals and defaults to 6", () => {
    // Node has no localStorage: the guarded getters fall back to defaults.
    expect(getFollowedCheckIntervalHours()).toBe(6)
    expect(setFollowedCheckIntervalHours(5)).toBe(false)
    expect(setFollowedCheckIntervalHours(12)).toBe(true)
    expect(getFollowedCheckIntervalHours()).toBe(6)
  })
})

describe("deep links", () => {
  it("validates payloads and drops bad values", () => {
    expect(parseDeepLinkTarget({ seriesId: "42", season: 2, episode: 3 })).toEqual({
      seriesId: "42",
      season: 2,
      episode: 3,
    })
    expect(parseDeepLinkTarget({ seriesId: "  " })).toBeNull()
    expect(parseDeepLinkTarget(null)).toBeNull()
    expect(parseDeepLinkTarget({ seriesId: "42", season: 0, episode: -1 })).toEqual({ seriesId: "42" })
  })

  it("builds the detail URL, autoplaying only when an episode is given", () => {
    expect(buildSeriesDetailUrl({ seriesId: "42" })).toBe("/series/detail?id=42")
    expect(buildSeriesDetailUrl({ seriesId: "42", season: 2, episode: 3 })).toBe(
      "/series/detail?id=42&season=2&epnum=3&autoplay=1"
    )
  })
})
