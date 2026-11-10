// RedSilk Couch — Home + Discover + Followed (W2).
// Synthetic fixtures only; no live catalogue, no AI key, no EPG fetch,
// no real IPTV subscription.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildHomeRails,
  filterVodProgress,
  vodProgressCards,
  seriesProgressCards,
  rankedCards,
  candidateCards,
  newEpisodeCards,
  newEpisodeHref,
  trendingCards,
  favouriteChannelCards,
  hiddenGemCards,
  pickHero,
  HOME_RAIL_ORDER,
  type HomeCard,
  type HomeProgressRow,
} from "../src/scripts/lib/couch-home"
import {
  getDiscoverRows,
  registerFollowedProvider,
  candidateKey,
  type DiscoverCandidate,
  type FollowedEpisode,
  type RankedCandidate,
} from "../src/scripts/lib/discover"
import { emptyTasteModel } from "../src/scripts/lib/taste"
import { trendingSourceLabel } from "../src/scripts/lib/trending"
import {
  followSeries,
  unfollowSeries,
  listSubscriptions,
  listNotificationGroups,
  getUnreadCount,
  markNotificationRead,
  dismissNotification,
  followedProvider,
  refreshFollowedCache,
  createMemoryFollowedStore,
  setFollowedStore,
  buildSeriesDetailUrl,
  type FollowedStore,
  type FollowedNotificationGroup,
} from "../src/scripts/lib/followed"

function candidate(
  partial: Partial<DiscoverCandidate> & { id: string; title: string },
): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

const MOVIE_A = candidate({
  id: "1",
  title: "Star Voyage",
  genres: ["Sci-Fi"],
  cast: ["Ada Star"],
  rating: 8.4,
  year: 2024,
  posterUrl: "https://provider.example/posters/1.jpg",
})
const MOVIE_B = candidate({
  id: "2",
  title: "Quiet Drama",
  genres: ["Drama"],
  rating: 7.9,
  year: 2023,
  posterUrl: "https://provider.example/posters/2.jpg",
})
const SERIES_A = candidate({
  id: "7",
  title: "Epic Binge",
  kind: "series",
  genres: ["Drama"],
  rating: 8.6,
  year: 2024,
  posterUrl: "https://provider.example/posters/7.jpg",
})

function byKey(candidates: DiscoverCandidate[]): Map<string, DiscoverCandidate> {
  return new Map(candidates.map((c) => [candidateKey(c), c]))
}

function card(title: string, key = title): HomeCard {
  return { key, title, kind: "poster", href: `/movies/detail?id=${key}` }
}

function fullRailsInput(): Parameters<typeof buildHomeRails>[0] {
  return {
    continueWatching: [card("Continue One")],
    newEpisodes: [card("New Episode One")],
    picked: [card("Picked One")],
    trendingSource: "google",
    trending: [card("Trending One")],
    recentlyAdded: [card("Recent One")],
    continueSeries: [card("Series One")],
    favouriteChannels: [card("Channel One", "live:1")],
    hiddenGems: [card("Gem One")],
  }
}

describe("buildHomeRails — order and conditional rendering", () => {
  it("renders every non-empty rail in the fixed order", () => {
    const rails = buildHomeRails(fullRailsInput())
    expect(rails.map((r) => r.id)).toEqual([...HOME_RAIL_ORDER])
    expect(rails.map((r) => r.title)).toEqual([
      "Continue Watching",
      "New Episodes",
      "Picked for You",
      "Trending on Google this week",
      "Recently Added Movies",
      "Continue Your Series",
      "Favourite Live Channels",
      "Hidden Gems",
    ])
  })

  it("omits empty rails entirely — never an empty shell", () => {
    const rails = buildHomeRails({
      ...fullRailsInput(),
      continueWatching: [],
      newEpisodes: [],
      trending: [],
      recentlyAdded: [],
      continueSeries: [],
      favouriteChannels: [],
      hiddenGems: [],
    })
    expect(rails.map((r) => r.id)).toEqual(["picked-for-you"])
  })

  it("returns no rails when there is nothing meaningful to show", () => {
    const rails = buildHomeRails({
      continueWatching: [],
      newEpisodes: [],
      picked: [],
      trendingSource: "none",
      trending: [],
      recentlyAdded: [],
      continueSeries: [],
      favouriteChannels: [],
      hiddenGems: [],
    })
    expect(rails).toEqual([])
  })

  it("labels the trending rail by its live source", () => {
    const tmdb = buildHomeRails({
      ...fullRailsInput(),
      trendingSource: "tmdb",
    })
    expect(tmdb.find((r) => r.id === "trending")?.title).toBe("Trending this week")
    expect(trendingSourceLabel("google")).toBe("Trending on Google this week")
    expect(trendingSourceLabel("tmdb")).toBe("Trending this week")
  })

  it("links rails to their real destinations", () => {
    const rails = buildHomeRails(fullRailsInput())
    const byId = new Map(rails.map((r) => [r.id, r]))
    expect(byId.get("new-episodes")?.href).toBe("/followed")
    expect(byId.get("picked-for-you")?.href).toBe("/discover")
    expect(byId.get("recently-added")?.href).toBe("/recently-added")
    expect(byId.get("favourite-channels")?.href).toBe("/livetv")
    expect(byId.get("continue-watching")?.href).toBeUndefined()
  })
})

describe("Continue Watching — Movies & Series only, never live channels", () => {
  const rows: HomeProgressRow[] = [
    { kind: "vod", id: "1", position: 600, duration: 1200, updatedAt: 300 },
    {
      kind: "episode",
      id: "55",
      seriesId: "7",
      seriesName: "Epic Binge",
      season: 2,
      episodeNum: 3,
      episodeTitle: "Return",
      position: 300,
      duration: 1800,
      updatedAt: 200,
    },
    // Live-channel history: tuning back in is not resuming. Must never
    // appear in Continue Watching, however recent it is.
    { kind: "live", id: "9", position: 999, duration: 999, updatedAt: 400 },
    { kind: "live", id: "10", position: 500, duration: 900, updatedAt: 350 },
    // Completed / no-progress rows are not "continue" either.
    { kind: "vod", id: "2", position: 1200, duration: 1200, completed: true, updatedAt: 100 },
    { kind: "vod", id: "2", position: 0, duration: 1200, updatedAt: 90 },
  ]

  it("filterVodProgress drops live, completed and zero-progress rows", () => {
    const kept = filterVodProgress(rows)
    expect(kept.map((r) => `${r.kind}:${r.id}`)).toEqual(["vod:1", "episode:55"])
  })

  it("vodProgressCards maps films and episodes with real progress, skipping live", () => {
    const cards = vodProgressCards(rows, byKey([MOVIE_A, MOVIE_B, SERIES_A]))
    expect(cards.map((c) => c.title)).toEqual(["Star Voyage", "Epic Binge"])
    expect(cards[0].progress).toBeCloseTo(0.5)
    expect(cards[0].href).toContain("autoplay=1")
    expect(cards[1].subtitle).toBe("S2E3 — Return")
    expect(cards[1].progress).toBeCloseTo(300 / 1800)
    expect(cards[1].href).toContain("/series/detail?id=7")
    expect(cards[1].href).toContain("episode=55")
  })

  it("skips progress rows whose title is not in the catalogue — never invents a card", () => {
    const cards = vodProgressCards(
      [{ kind: "vod", id: "999", position: 10, duration: 100 }],
      byKey([MOVIE_A]),
    )
    expect(cards).toEqual([])
  })

  it("seriesProgressCards keeps episode rows only, one card per series", () => {
    const cards = seriesProgressCards(
      [
        ...rows,
        {
          kind: "episode",
          id: "56",
          seriesId: "7",
          seriesName: "Epic Binge",
          season: 2,
          episodeNum: 4,
          position: 60,
          duration: 1800,
          updatedAt: 250,
        },
      ],
      byKey([MOVIE_A, SERIES_A]),
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].kind).toBe("landscape")
    expect(cards[0].title).toBe("Epic Binge")
  })
})

describe("home card builders", () => {
  it("rankedCards and candidateCards link to the real detail pages", () => {
    const ranked: RankedCandidate[] = [
      { candidate: MOVIE_A, score: 90, reason: "Because you watched Star Voyage" },
    ]
    const cards = rankedCards(ranked)
    expect(cards[0].href).toBe("/movies/detail?id=1")
    expect(cards[0].subtitle).toBe("Because you watched Star Voyage")
    expect(cards[0].meta).toBe("2024 · ★ 8.4")
    expect(candidateCards([SERIES_A])[0].href).toBe("/series/detail?id=7")
  })

  it("newEpisodeCards shows unwatched episodes only, with Watch Now hrefs", () => {
    const episodes: FollowedEpisode[] = [
      {
        seriesId: "7",
        seriesTitle: "Epic Binge",
        season: 2,
        episode: 3,
        episodeTitle: "Brand New",
        detectedAt: "2026-11-10T10:00:00.000Z",
        posterUrl: "https://provider.example/posters/7.jpg",
        watched: false,
      },
      {
        seriesId: "7",
        seriesTitle: "Epic Binge",
        season: 2,
        episode: 2,
        detectedAt: "2026-11-09T10:00:00.000Z",
        watched: true,
      },
    ]
    const cards = newEpisodeCards(episodes)
    expect(cards).toHaveLength(1)
    expect(cards[0].subtitle).toBe("New: S2 E3 — Brand New")
    expect(cards[0].kind).toBe("landscape")
    expect(cards[0].href).toContain("autoplay=1")
    // The home href agrees exactly with the Followed page's builder.
    expect(newEpisodeHref(episodes[0])).toBe(
      buildSeriesDetailUrl({ seriesId: "7", season: 2, episode: 3 }),
    )
  })

  it("trendingCards uses the rail hrefs for library-matched titles", () => {
    const cards = trendingCards([
      { kind: "vod", id: 1, name: "Star Voyage", logo: null, year: "2024", rating: "8.4" },
      { kind: "series", id: 7, name: "Epic Binge", logo: null, year: "2024", rating: "8.6" },
    ])
    expect(cards.map((c) => c.href)).toEqual([
      "/movies/detail?id=1",
      "/series/detail?id=7",
    ])
  })

  it("favouriteChannelCards keeps real now/next and never invents a programme", () => {
    const cards = favouriteChannelCards([
      { id: 9, name: "Channel Nine", logo: "https://provider.example/logo9.png", nowTitle: "Evening News", nextTitle: "Late Film" },
      { id: 10, name: "Channel Ten", logo: null },
    ])
    expect(cards[0].subtitle).toBe("Evening News")
    expect(cards[0].meta).toBe("Next: Late Film")
    expect(cards[0].kind).toBe("channel")
    expect(cards[0].href).toBe("/livetv?channel=9")
    expect(cards[1].subtitle).toBe("Live TV")
    expect(cards[1].meta).toBeUndefined()
  })

  it("hiddenGemCards: highly rated, unwatched, best first — live never qualifies", () => {
    const gems = hiddenGemCards(
      [
        candidate({ id: "20", title: "Loved Gem", rating: 9.0, year: 2024 }),
        candidate({ id: "21", title: "Top Gem", rating: 8.5, year: 2024 }),
        candidate({ id: "22", title: "Good Gem", rating: 7.5, year: 2023 }),
        candidate({ id: "23", title: "Almost Gem", rating: 7.4, year: 2023 }),
        candidate({ id: "24", title: "Live Gem", kind: "live", rating: 9.5 }),
        candidate({ id: "25", title: "Low Gem", rating: 6.0, year: 2024 }),
      ],
      new Set(["movie:20"]),
      new Set(["movie:21"]),
    )
    expect(gems.map((g) => g.title)).toEqual(["Good Gem"])
  })

  it("pickHero prefers in-progress, then picked, then recently added — null when nothing has art", () => {
    const noArt = candidate({ id: "30", title: "No Art Film", rating: 8.0 })
    expect(
      pickHero({
        continueWatching: [noArt],
        picked: [{ candidate: MOVIE_A, score: 90, reason: "x" }],
        recentlyAdded: [MOVIE_B],
      })?.eyebrow,
    ).toBe("Picked for You")
    expect(
      pickHero({
        continueWatching: [MOVIE_A],
        picked: [{ candidate: MOVIE_B, score: 90, reason: "x" }],
        recentlyAdded: [MOVIE_B],
      }),
    ).toMatchObject({ eyebrow: "Continue Watching", candidate: MOVIE_A })
    expect(
      pickHero({ continueWatching: [], picked: [], recentlyAdded: [MOVIE_B] })?.eyebrow,
    ).toBe("Recently Added")
    expect(
      pickHero({ continueWatching: [noArt], picked: [], recentlyAdded: [noArt] }),
    ).toBeNull()
  })
})

describe("Discover rows from the engine", () => {
  const taste = emptyTasteModel("shared", "pl1")
  const base = {
    candidates: [MOVIE_A, MOVIE_B, SERIES_A],
    taste,
    continueWatching: [MOVIE_A],
    recentlyAdded: [MOVIE_B],
    nowPlaying: [],
    becauseItems: [
      { candidate: SERIES_A, score: 80, reason: "Because you watched Quiet Drama" },
    ] as RankedCandidate[],
    watchedKeys: new Set<string>(),
    excludeWatched: true,
  }

  afterEach(() => {
    registerFollowedProvider(null)
  })

  it("builds Picked for You, Because and Continue Watching rows from real data", () => {
    const rows = getDiscoverRows(base)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get("picked-for-you")?.items.length).toBeGreaterThan(0)
    expect(byId.get("because-you-watched")?.items[0].candidate.id).toBe("7")
    expect(byId.get("continue-watching")?.items[0].candidate.id).toBe("1")
  })

  it("shows the New Episodes row only when the followed provider reports episodes", () => {
    const episode: FollowedEpisode = {
      seriesId: "7",
      seriesTitle: "Epic Binge",
      season: 2,
      episode: 3,
      detectedAt: "2026-11-10T10:00:00.000Z",
      watched: false,
    }
    registerFollowedProvider({ getNewEpisodes: () => [episode] })
    const withProvider = getDiscoverRows(base)
    expect(withProvider.find((r) => r.id === "new-episodes")?.items).toHaveLength(1)
    expect(withProvider.find((r) => r.id === "new-episodes")?.items[0].reason).toContain("S2 E3")

    registerFollowedProvider(null)
    const withoutProvider = getDiscoverRows(base)
    expect(withoutProvider.find((r) => r.id === "new-episodes")).toBeUndefined()
  })

  it("hides watched followed episodes from the New Episodes row", () => {
    registerFollowedProvider({
      getNewEpisodes: () => [
        {
          seriesId: "7",
          seriesTitle: "Epic Binge",
          season: 2,
          episode: 3,
          detectedAt: "2026-11-10T10:00:00.000Z",
          watched: true,
        },
      ],
    })
    const rows = getDiscoverRows(base)
    expect(rows.find((r) => r.id === "new-episodes")).toBeUndefined()
  })
})

describe("Followed actions (memory store)", () => {
  let store: FollowedStore

  const group = (): FollowedNotificationGroup => ({
    id: "pl-1::7::2026-11-10T10:00:00.000Z",
    playlistId: "pl-1",
    seriesId: "7",
    seriesTitle: "Epic Binge",
    posterUrl: "https://provider.example/posters/7.jpg",
    episodes: [
      {
        seriesId: "7",
        seriesTitle: "Epic Binge",
        season: 2,
        episode: 3,
        episodeTitle: "Brand New",
        episodeId: 203,
        detectedAt: "2026-11-10T10:00:00.000Z",
        watched: false,
      },
    ],
    detectedAt: "2026-11-10T10:00:00.000Z",
    read: false,
    dismissed: false,
  })

  beforeEach(async () => {
    store = createMemoryFollowedStore()
    setFollowedStore(store)
    await refreshFollowedCache(store)
  })

  it("feeds the home New Episodes row from unread notification groups", async () => {
    await store.putNotification(group())
    await refreshFollowedCache(store)
    const episodes = followedProvider.getNewEpisodes()
    expect(episodes).toHaveLength(1)
    expect(episodes[0].seriesTitle).toBe("Epic Binge")
    expect(newEpisodeCards(episodes)).toHaveLength(1)
  })

  it("Mark Read clears the unread count and the provider feed", async () => {
    await store.putNotification(group())
    await refreshFollowedCache(store)
    expect(await getUnreadCount(store)).toBe(1)
    await markNotificationRead(group().id, store)
    expect(await getUnreadCount(store)).toBe(0)
    const groups = await listNotificationGroups({}, store)
    expect(groups[0].read).toBe(true)
  })

  it("Dismiss hides the group from the list", async () => {
    await store.putNotification(group())
    await dismissNotification(group().id, store)
    expect(await listNotificationGroups({}, store)).toEqual([])
    expect(await listNotificationGroups({ includeDismissed: true }, store)).toHaveLength(1)
  })

  it("Unfollow removes the subscription", async () => {
    const res = await followSeries(
      {
        playlistId: "pl-1",
        seriesId: "7",
        seriesTitle: "Epic Binge",
        posterUrl: "https://provider.example/posters/7.jpg",
        seriesInfo: {
          info: { name: "Epic Binge" },
          episodes: {
            "1": [{ id: 101, season: 1, episode_num: 1, title: "Pilot" }],
          },
        },
      },
      store,
    )
    expect(res.ok).toBe(true)
    expect(await listSubscriptions(store)).toHaveLength(1)
    await unfollowSeries("pl-1", "7", store)
    expect(await listSubscriptions(store)).toEqual([])
  })
})
