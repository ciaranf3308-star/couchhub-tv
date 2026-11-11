// RedSilk Home — ranking + rails data layer (W2).
// Synthetic fixtures only; no live catalogue, no AI key, no EPG fetch,
// no real IPTV subscription.
import { describe, it, expect, beforeEach } from "vitest"
// jsdom ships no types and @types/jsdom is not installed; test-only.
// @ts-ignore
import { JSDOM } from "jsdom"
import {
  bayesianRating,
  confidenceTier,
  BAYESIAN_PRIOR_MEAN,
  BAYESIAN_PRIOR_WEIGHT,
} from "../src/scripts/lib/rating-confidence"
import {
  loadHomeRails,
  getCachedHomeRails,
  clearHomeRailsCache,
  mergeHomePayload,
  HERO_MIN_BAYESIAN,
  type HomePayload,
  type HomeRail,
  type HomeRailItem,
} from "../src/scripts/lib/home-rails"
import {
  recordCouchFocus,
  restoreCouchFocus,
  readCouchFocusMemory,
} from "../src/scripts/lib/couch-focus"
import { emptyTasteModel, recordFeedback } from "../src/scripts/lib/taste"
import type {
  DiscoverCandidate,
  DiscoverData,
  FollowedEpisode,
} from "../src/scripts/lib/discover"

function candidate(
  partial: Partial<DiscoverCandidate> & { id: string; title: string },
): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    posterUrl: `https://provider.example/posters/${partial.id}.jpg`,
    ...partial,
  }
}

function discoverData(
  partial: Partial<DiscoverData> & { candidates: DiscoverCandidate[] },
): DiscoverData {
  return {
    candidates: partial.candidates,
    taste: partial.taste ?? emptyTasteModel("profile-1", "playlist-1"),
    hasHistory: partial.hasHistory ?? false,
    watchedKeys: partial.watchedKeys ?? new Set<string>(),
    continueWatching: partial.continueWatching ?? [],
    recentlyAdded: partial.recentlyAdded ?? [],
    nowPlaying: partial.nowPlaying ?? [],
    becauseItems: partial.becauseItems ?? [],
  }
}

/** A realistic small catalogue: 36 bulk titles + named edge cases. */
function mainCatalogue(): {
  candidates: DiscoverCandidate[]
  named: Record<string, DiscoverCandidate>
} {
  const bulk: DiscoverCandidate[] = []
  const genres = ["Drama", "Crime", "Comedy", "Science Fiction", "Documentary", "Horror"]
  for (let i = 0; i < 36; i++) {
    const genre = genres[i % genres.length] as string
    bulk.push(
      candidate({
        id: `bulk-${i}`,
        title: `Bulk ${genre} ${i}`,
        genres: [genre],
        // Ratings 7.0–7.9, votes 1,500–19,500: ordinary catalogue fare.
        rating: 7.0 + (((i * 7) % 10) / 10),
        voteCount: 1500 + ((i * 1373) % 18000),
        year: 2022 + (i % 3),
        runtimeMinutes: 90 + ((i * 13) % 70),
      }),
    )
  }
  const named: Record<string, DiscoverCandidate> = {
    beloved: candidate({
      id: "beloved",
      title: "Beloved Epic",
      genres: ["Drama"],
      rating: 8.4,
      voteCount: 50000,
      year: 2023,
      runtimeMinutes: 150,
    }),
    gem: candidate({
      id: "gem",
      title: "Quiet Gem",
      genres: ["Drama"],
      rating: 8.1,
      voteCount: 800,
      year: 2022,
      runtimeMinutes: 110,
    }),
    obscure: candidate({
      id: "obscure",
      title: "Obscure Perfect",
      genres: ["Drama"],
      rating: 10.0,
      // No voteCount on purpose: a perfect score with no evidence.
      year: 2024,
      runtimeMinutes: 95,
    }),
    crowd: candidate({
      id: "crowd",
      title: "Crowd Favourite",
      genres: ["Comedy"],
      rating: 8.0,
      voteCount: 120000,
      year: 2024,
      runtimeMinutes: 105,
    }),
    crimeClassic: candidate({
      id: "crime-classic",
      title: "Crime Classic",
      genres: ["Crime"],
      rating: 8.6,
      voteCount: 30000,
      year: 2021,
      runtimeMinutes: 130,
    }),
    crimeNewcomer: candidate({
      id: "crime-newcomer",
      title: "Crime Newcomer",
      genres: ["Crime", "Mystery"],
      rating: 7.8,
      voteCount: 300,
      year: 2024,
      runtimeMinutes: 100,
    }),
    short: candidate({
      id: "short",
      title: "Short Charmer",
      genres: ["Comedy"],
      rating: 8.2,
      voteCount: 5000,
      year: 2023,
      runtimeMinutes: 88,
    }),
    long: candidate({
      id: "long",
      title: "Long Haul",
      genres: ["Drama"],
      rating: 8.3,
      voteCount: 4000,
      year: 2020,
      runtimeMinutes: 200,
    }),
    noRuntime: candidate({
      id: "no-runtime",
      title: "No Runtime Gem",
      genres: ["Comedy"],
      rating: 8.5,
      voteCount: 9000,
      year: 2023,
      // No runtimeMinutes on purpose: must never appear as "short".
    }),
    binge: candidate({
      id: "binge",
      kind: "series",
      title: "Binge Series",
      genres: ["Drama"],
      rating: 8.7,
      voteCount: 60000,
      year: 2022,
    }),
    watched: candidate({
      id: "watched",
      title: "Watched Classic",
      genres: ["Drama"],
      rating: 9.0,
      voteCount: 80000,
      year: 2019,
      runtimeMinutes: 140,
    }),
    dismissed: candidate({
      id: "dismissed",
      title: "Dismissed Hit",
      genres: ["Drama"],
      rating: 8.9,
      voteCount: 70000,
      year: 2023,
      runtimeMinutes: 120,
    }),
    alreadySeen: candidate({
      id: "already-seen",
      title: "Already Seen",
      genres: ["Comedy"],
      rating: 8.8,
      voteCount: 40000,
      year: 2023,
      runtimeMinutes: 115,
    }),
    noPoster: candidate({
      id: "no-poster",
      title: "No Poster Star",
      genres: ["Drama"],
      rating: 9.2,
      voteCount: 90000,
      year: 2024,
      runtimeMinutes: 125,
      posterUrl: undefined,
    }),
  }
  return { candidates: [...bulk, ...Object.values(named)], named }
}

function mainTaste() {
  const taste = emptyTasteModel("profile-1", "playlist-1")
  taste.genreWeights = { drama: 5, crime: 3 }
  taste.likedTitles = [
    { kind: "movie", id: "watched", title: "Watched Classic", weight: 1, updatedAt: 1000 },
  ]
  taste.notInterestedKeys = ["movie:dismissed"]
  // Explicit already-watched feedback: no progress signal, only a
  // likedTitles record at weight 0.6 — it must still stay out of
  // recommendations.
  return recordFeedback(taste, {
    kind: "movie",
    id: "already-seen",
    title: "Already Seen",
    action: "already-watched",
  })
}

function mainData() {
  const { candidates, named } = mainCatalogue()
  const data = discoverData({
    candidates,
    taste: mainTaste(),
    hasHistory: true,
    watchedKeys: new Set(["movie:watched", "movie:beloved", "series:binge"]),
    continueWatching: [named["beloved"] as DiscoverCandidate, named["binge"] as DiscoverCandidate],
    recentlyAdded: [named["crowd"] as DiscoverCandidate, named["binge"] as DiscoverCandidate],
    nowPlaying: [
      candidate({
        id: "ch-1",
        kind: "live",
        title: "Evening Channel",
        source: "epg",
        overview: "Now: Evening News · Next: Late Film",
        posterUrl: "https://provider.example/logos/ch-1.png",
      }),
    ],
  })
  return { data, named }
}

const PROGRESS_ROWS = [
  {
    kind: "vod",
    id: "beloved",
    position: 1800,
    duration: 3600,
    completed: false,
    updatedAt: 5000,
  },
  {
    kind: "episode",
    id: "ep-203",
    position: 600,
    duration: 1200,
    completed: false,
    updatedAt: 6000,
    seriesId: "binge",
    seriesName: "Binge Series",
    season: 2,
    episodeNum: 3,
    episodeTitle: "The Turn",
  },
  // Live-channel history: must never appear in Continue Watching.
  { kind: "live", id: "ch-1", position: 100, duration: 3600, completed: false, updatedAt: 7000 },
] as const

const FOLLOWED: FollowedEpisode[] = [
  {
    seriesId: "binge",
    seriesTitle: "Binge Series",
    season: 2,
    episode: 4,
    episodeTitle: "The Return",
    detectedAt: "2026-11-10T10:00:00.000Z",
    watched: false,
  },
  {
    seriesId: "old-show",
    seriesTitle: "Old Show",
    season: 1,
    episode: 2,
    detectedAt: "2026-11-09T10:00:00.000Z",
    watched: true,
  },
]

function railById(payload: Awaited<ReturnType<typeof loadHomeRails>>, id: string) {
  return payload.rails.find((rail) => rail.id === id)
}

function allKeys(payload: Awaited<ReturnType<typeof loadHomeRails>>): string[] {
  return payload.rails.flatMap((rail) => rail.items.map((item) => item.key))
}

beforeEach(() => {
  clearHomeRailsCache()
})

describe("bayesianRating", () => {
  it("a high-vote 8.0 beats a low-vote 10.0", () => {
    expect(bayesianRating(8.0, 5000)).toBeGreaterThan(bayesianRating(10.0, 3))
  })

  it("a 10.0 with no votes scores exactly the prior mean", () => {
    expect(bayesianRating(10.0, undefined)).toBe(BAYESIAN_PRIOR_MEAN)
    expect(bayesianRating(10.0, 0)).toBe(BAYESIAN_PRIOR_MEAN)
    expect(bayesianRating(9.5, undefined)).toBe(BAYESIAN_PRIOR_MEAN)
  })

  it("small samples are pulled toward the prior", () => {
    const small = bayesianRating(9.0, 10)
    expect(small).toBeLessThan(9.0)
    expect(small).toBeGreaterThan(BAYESIAN_PRIOR_MEAN)
    // (6.5 * 100 + 9 * 10) / 110
    expect(small).toBeCloseTo((BAYESIAN_PRIOR_MEAN * BAYESIAN_PRIOR_WEIGHT + 90) / 110, 10)
  })

  it("large samples converge on the title's own rating", () => {
    expect(bayesianRating(8.0, 100000)).toBeCloseTo(8.0, 2)
  })

  it("a missing rating is the prior mean, never a guess", () => {
    expect(bayesianRating(undefined, 5000)).toBe(BAYESIAN_PRIOR_MEAN)
  })
})

describe("confidenceTier", () => {
  it("tiers follow vote counts, with absent counts low", () => {
    expect(confidenceTier(undefined)).toBe("low")
    expect(confidenceTier(0)).toBe("low")
    expect(confidenceTier(99)).toBe("low")
    expect(confidenceTier(100)).toBe("medium")
    expect(confidenceTier(999)).toBe("medium")
    expect(confidenceTier(1000)).toBe("high")
  })
})

describe("loadHomeRails", () => {
  it("excludes a no-vote 10.0 from Hidden Gems and from the hero", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    const gems = railById(payload, "hidden-gems")
    expect(gems).toBeDefined()
    expect(gems?.items.map((item) => item.key)).not.toContain("movie:obscure")
    for (const item of gems?.items ?? []) {
      expect(item.voteCount ?? 0).toBeGreaterThanOrEqual(100)
      expect(bayesianRating(item.rating, item.voteCount)).toBeGreaterThanOrEqual(7.5)
    }
    expect(payload.hero?.item.key).not.toBe("movie:obscure")
    expect(payload.hero?.item.key).not.toBe("movie:no-poster")
    expect(payload.hero?.item.posterUrl).toBeTruthy()
    expect(payload.hero?.item.voteCount ?? 0).toBeGreaterThanOrEqual(100)
    expect(
      bayesianRating(payload.hero?.item.rating, payload.hero?.item.voteCount),
    ).toBeGreaterThanOrEqual(HERO_MIN_BAYESIAN)
  })

  it("keeps every title in at most 2 rails and never in adjacent rails", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    const counts = new Map<string, number>()
    for (const key of allKeys(payload)) {
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    for (const [key, count] of counts) {
      expect(count, key).toBeLessThanOrEqual(2)
    }
    for (let i = 0; i + 1 < payload.rails.length; i++) {
      const a = payload.rails[i] as (typeof payload.rails)[number]
      const b = payload.rails[i + 1] as (typeof payload.rails)[number]
      const shared = a.items
        .map((item) => item.key)
        .filter((key) => b.items.some((item) => item.key === key))
      const exempt =
        a.id === "continue-watching" ||
        a.id === "continue-series" ||
        b.id === "continue-watching" ||
        b.id === "continue-series"
      if (!exempt) expect(shared, `${a.id} / ${b.id}`).toEqual([])
    }
  })

  it("drops trending extras with no catalogue match and blank titles", async () => {
    const { data } = mainData()
    const blank = candidate({ id: "blank", title: "   ", genres: ["Comedy"], rating: 9.9, voteCount: 99999, year: 2024 })
    const payload = await loadHomeRails(
      discoverData({ ...data, candidates: [...data.candidates, blank] }),
      [],
      {
        trending: [
          { kind: "movie", id: "crowd", title: "Crowd Favourite", rating: 8.0 },
          { kind: "movie", id: "9999", title: "Ghost Title", rating: 9.9 },
          // H06: a recommendation rail needs at least 4 items to
          // show, so the fixture carries three more real trending
          // matches (horror bulk titles, low taste affinity — they
          // do not crowd the Next Obsession rail). The drop claim
          // under test (ghost + blank) is unchanged.
          { kind: "movie", id: "bulk-5", title: "Bulk Horror 5", rating: 7.5 },
          { kind: "movie", id: "bulk-11", title: "Bulk Horror 11", rating: 7.7 },
          { kind: "movie", id: "bulk-17", title: "Bulk Horror 17", rating: 7.9 },
        ],
      },
    )
    const trending = railById(payload, "trending")
    expect(trending?.items.map((item) => item.key)).toContain("movie:crowd")
    expect(trending?.items.map((item) => item.key)).not.toContain("movie:9999")
    expect(allKeys(payload)).not.toContain("movie:blank")
  })

  it("omits empty rails instead of showing shells", async () => {
    const empty = await loadHomeRails(discoverData({ candidates: [] }), [])
    expect(empty.hero).toBeNull()
    expect(empty.rails).toEqual([])

    const { data } = mainData()
    const noFollowed = await loadHomeRails(data, [])
    expect(railById(noFollowed, "new-episodes")).toBeUndefined()

    const noRecent = discoverData({ ...data, recentlyAdded: [] })
    const payload = await loadHomeRails(noRecent, FOLLOWED)
    expect(railById(payload, "recently-added")).toBeUndefined()
  })

  it("suppresses Not Interested titles from every personalised section", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    expect(allKeys(payload)).not.toContain("movie:dismissed")
  })

  it("suppresses Already Watched titles from recommendations", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    // Already Seen has no progress signal and is not in watchedKeys —
    // only the explicit already-watched feedback marks it watched.
    expect(data.watchedKeys.has("movie:already-seen")).toBe(false)
    expect(allKeys(payload)).not.toContain("movie:already-seen")
    expect(payload.hero?.item.key).not.toBe("movie:already-seen")
  })

  it("a well-supported 8.0 outranks a no-vote 10.0 with equal taste", async () => {
    const supported = candidate({
      id: "supported",
      title: "Supported Eight",
      genres: ["Drama"],
      rating: 8.0,
      voteCount: 5000,
      year: 2024,
    })
    const perfect = candidate({
      id: "perfect",
      title: "Perfect Nobody",
      genres: ["Drama"],
      rating: 10.0,
      year: 2024,
    })
    // H06: a recommendation rail needs at least 4 items to show, so
    // the fixture carries two more mid-tier dramas (the ranking
    // claim under test is unchanged).
    const fillerA = candidate({
      id: "filler-a",
      title: "Filler A",
      genres: ["Drama"],
      rating: 7.5,
      voteCount: 500,
      year: 2024,
    })
    const fillerB = candidate({
      id: "filler-b",
      title: "Filler B",
      genres: ["Drama"],
      rating: 7.2,
      voteCount: 300,
      year: 2024,
    })
    const taste = emptyTasteModel("profile-1", "playlist-1")
    taste.genreWeights = { drama: 5 }
    const payload = await loadHomeRails(
      discoverData({ candidates: [perfect, supported, fillerA, fillerB], taste, hasHistory: true }),
      [],
    )
    const picks = railById(payload, "next-obsession")
    expect(picks).toBeDefined()
    const keys = picks?.items.map((item) => item.key) ?? []
    expect(keys.indexOf("movie:supported")).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf("movie:supported")).toBeLessThan(keys.indexOf("movie:perfect"))
  })

  it("Continue Watching is VOD only, with real progress", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    const cw = railById(payload, "continue-watching")
    expect(cw?.items).toHaveLength(2)
    expect(cw?.items.map((item) => item.key)).toEqual([
      "movie:beloved",
      "series:binge",
    ])
    for (const item of cw?.items ?? []) {
      expect(item.progress).toBeCloseTo(0.5, 5)
      expect(item.playHref).toContain("autoplay=1")
    }
    const series = railById(payload, "continue-series")
    expect(series?.items.map((item) => item.key)).toEqual(["series:binge"])
    expect(series?.items[0]?.season).toBe(2)
    expect(series?.items[0]?.episode).toBe(3)
    expect(series?.items[0]?.episodeTitle).toBe("The Turn")
  })

  it("New Episodes shows unwatched followed episodes, newest first", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED)
    const rail = railById(payload, "new-episodes")
    expect(rail?.items).toHaveLength(1)
    expect(rail?.items[0]?.key).toBe("followed:binge:S2E4")
    expect(rail?.items[0]?.playHref).toContain("autoplay=1")
  })

  it("Short & Sweet needs verified runtime and real support", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    const short = railById(payload, "short")
    expect(short).toBeDefined()
    const keys = short?.items.map((item) => item.key) ?? []
    expect(keys).toContain("movie:short")
    expect(keys).not.toContain("movie:no-runtime")
    expect(keys).not.toContain("movie:long")
    expect(keys).not.toContain("movie:obscure")
    for (const item of short?.items ?? []) {
      expect(item.runtimeMinutes).toBeGreaterThan(0)
      expect(item.runtimeMinutes).toBeLessThan(120)
    }
  })

  it("Tonight's Picks carries real live now/next from EPG data", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    const tonight = railById(payload, "tonight")
    expect(tonight).toBeDefined()
    const live = tonight?.items.find((item) => item.isLive)
    expect(live?.nowTitle).toBe("Evening News")
    expect(live?.nextTitle).toBe("Late Film")
  })

  it("Recently Added is movies only, from real addition evidence", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED)
    const rail = railById(payload, "recently-added")
    expect(rail).toBeDefined()
    expect(rail?.items.map((item) => item.key)).toContain("movie:crowd")
    for (const item of rail?.items ?? []) {
      expect(item.kind).toBe("movie")
    }
  })

  it("genre rails are capped, populated, and genre-honest", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED, {
      progressRows: [...PROGRESS_ROWS],
    })
    const genreRails = payload.rails.filter((rail) => rail.kind === "genre")
    expect(genreRails.length).toBeGreaterThanOrEqual(1)
    expect(genreRails.length).toBeLessThanOrEqual(3)
    expect(genreRails.map((rail) => rail.id)).toContain("genre-crime-mystery")
    for (const rail of genreRails) {
      expect(rail.items.length).toBeGreaterThanOrEqual(4)
    }
    const crime = genreRails.find((rail) => rail.id === "genre-crime-mystery")
    expect(crime).toBeDefined()
  })

  it("More Like This boosts similar titles in Next Obsession", async () => {
    const seed = candidate({
      id: "seed",
      title: "Seed Crime",
      genres: ["Crime"],
      cast: ["Ada Star"],
      rating: 8.0,
      voteCount: 5000,
      year: 2023,
    })
    const crimeHopeful = candidate({
      id: "crime-hopeful",
      title: "Crime Hopeful",
      genres: ["Crime"],
      rating: 7.5,
      voteCount: 500,
      year: 2024,
    })
    const comedyHopeful = candidate({
      id: "comedy-hopeful",
      title: "Comedy Hopeful",
      genres: ["Comedy"],
      rating: 7.5,
      voteCount: 500,
      year: 2024,
    })
    // H06: a recommendation rail needs at least 4 items to show, so
    // the fixture carries two more hopefuls (the boost claim under
    // test — crime first, comedy second — is unchanged).
    const dramaHopeful = candidate({
      id: "drama-hopeful",
      title: "Drama Hopeful",
      genres: ["Drama"],
      rating: 7.5,
      voteCount: 500,
      year: 2024,
    })
    const horrorHopeful = candidate({
      id: "horror-hopeful",
      title: "Horror Hopeful",
      genres: ["Horror"],
      rating: 7.4,
      voteCount: 500,
      year: 2024,
    })
    let taste = emptyTasteModel("profile-1", "playlist-1")
    taste = recordFeedback(taste, {
      kind: "movie",
      id: "seed",
      title: "Seed Crime",
      action: "more-like-this",
      genres: ["Crime"],
      cast: ["Ada Star"],
    })
    const payload = await loadHomeRails(
      discoverData({
        candidates: [seed, crimeHopeful, comedyHopeful, dramaHopeful, horrorHopeful],
        taste,
        hasHistory: true,
        watchedKeys: new Set(["movie:seed"]),
      }),
      [],
    )
    const picks = railById(payload, "next-obsession")
    const keys = picks?.items.map((item) => item.key) ?? []
    expect(keys.slice(0, 2)).toEqual(["movie:crime-hopeful", "movie:comedy-hopeful"])
  })

  it("sparse-profile hero is the best-supported title, not catalogue order", async () => {
    const mid = candidate({
      id: "mid",
      title: "Mid Movie",
      genres: ["Drama"],
      rating: 7.5,
      voteCount: 200,
      year: 2023,
    })
    const best = candidate({
      id: "best",
      title: "Best Movie",
      genres: ["Drama"],
      rating: 9.1,
      voteCount: 50000,
      year: 2023,
    })
    const payload = await loadHomeRails(
      discoverData({ candidates: [mid, best] }),
      [],
    )
    // The best title is last in catalogue order; the hero must still
    // be it — never provider ordering, never random.
    expect(payload.hero?.item.key).toBe("movie:best")
  })

  it("hero avoids repetition across loads, then repeats the least-recent", async () => {
    const a = candidate({
      id: "hero-a",
      title: "Hero A",
      genres: ["Drama"],
      rating: 9.0,
      voteCount: 50000,
      year: 2023,
    })
    const b = candidate({
      id: "hero-b",
      title: "Hero B",
      genres: ["Drama"],
      rating: 8.9,
      voteCount: 40000,
      year: 2023,
    })
    const data = discoverData({ candidates: [a, b] })
    const first = await loadHomeRails(data, [])
    const second = await loadHomeRails(data, [])
    const third = await loadHomeRails(data, [])
    expect(first.hero?.item.key).toBe("movie:hero-a")
    expect(second.hero?.item.key).toBe("movie:hero-b")
    expect(third.hero?.item.key).toBe("movie:hero-a")
  })

  it("getCachedHomeRails paints instantly after a load", async () => {
    expect(getCachedHomeRails()).toBeNull()
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED)
    expect(getCachedHomeRails()).toEqual(payload)
  })

  it("a metadata failure returns the cached payload, not an error", async () => {
    const { data } = mainData()
    const payload = await loadHomeRails(data, FOLLOWED)
    const fallback = await loadHomeRails(null as never, [])
    expect(fallback).toEqual(payload)
    const emptyFallback = await loadHomeRails(undefined as never, [])
    expect(emptyFallback).toEqual(payload)
  })
})

describe("mergeHomePayload (metadata failure keeps cached content)", () => {
  function item(partial: Partial<HomeRailItem> & { id: string; title: string }): HomeRailItem {
    return {
      key: `${partial.kind ?? "movie"}:${partial.id}`,
      kind: partial.kind ?? "movie",
      detailHref: `/movies/detail?id=${partial.id}`,
      ...partial,
    }
  }

  function rail(partial: Partial<HomeRail> & { id: string; title: string }): HomeRail {
    return { kind: "trending", items: [], ...partial }
  }

  const cached: HomePayload = {
    hero: { item: item({ id: "1", title: "Cached Hero" }) },
    rails: [rail({ id: "trending", title: "Trending", items: [item({ id: "2", title: "T" })] })],
  }

  it("keeps cached content when the fresh load fails (null)", () => {
    expect(mergeHomePayload(cached, null)).toBe(cached)
  })

  it("keeps cached content when the fresh load is empty", () => {
    expect(mergeHomePayload(cached, { hero: null, rails: [] })).toBe(cached)
  })

  it("replaces the cache when the fresh load has real content", () => {
    const fresh: HomePayload = {
      hero: { item: item({ id: "3", title: "Fresh Hero" }) },
      rails: [],
    }
    expect(mergeHomePayload(cached, fresh)).toBe(fresh)
  })

  it("returns null when there is nothing cached and nothing fresh", () => {
    expect(mergeHomePayload(null, null)).toBeNull()
    expect(mergeHomePayload(null, { hero: null, rails: [] })).toBeNull()
  })
})

describe("focus restoration (same rail + card after a detail return)", () => {
  function setupDom(): { doc: Document; win: Window } {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <section data-nylah-rail="continue-watching">
          <a data-nylah-item data-couch-key="movie:1" href="/movies/detail?id=1">Dune</a>
          <a data-nylah-item data-couch-key="movie:2" href="/movies/detail?id=2">Arrival</a>
        </section>
        <section data-nylah-rail="trending">
          <a data-nylah-item data-couch-key="movie:3" href="/movies/detail?id=3">Boring</a>
        </section>
      </body></html>`,
      { url: "http://localhost/" },
    )
    const win = dom.window as unknown as Window
    // jsdom reports zero-size rects; the focus layer treats those as
    // invisible, so give every element a visible box for this test.
    const elementCtor = (win as unknown as { Element: typeof Element }).Element
    elementCtor.prototype.getBoundingClientRect = () =>
      ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(globalThis as Record<string, unknown>).window = win
    ;(globalThis as Record<string, unknown>).document = win.document
    ;(globalThis as Record<string, unknown>).sessionStorage = win.sessionStorage
    ;(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win)
    return { doc: win.document, win }
  }

  it("restores the same card by stable key after returning from detail", () => {
    const { doc } = setupDom()
    recordCouchFocus({ route: "/", rail: "continue-watching", index: 1, key: "movie:2" })
    expect(readCouchFocusMemory()).toMatchObject({ rail: "continue-watching", key: "movie:2" })
    const restored = restoreCouchFocus(doc)
    expect(restored?.getAttribute("data-couch-key")).toBe("movie:2")
    expect(doc.activeElement?.getAttribute("data-couch-key")).toBe("movie:2")
  })

  it("falls back to rail + index when the remembered card is gone", () => {
    const { doc } = setupDom()
    recordCouchFocus({ route: "/", rail: "trending", index: 0, key: "movie:gone" })
    const restored = restoreCouchFocus(doc)
    expect(restored?.getAttribute("data-couch-key")).toBe("movie:3")
  })

  it("restores nothing for a different route", () => {
    const { doc } = setupDom()
    recordCouchFocus({ route: "/discover", rail: "continue-watching", index: 0, key: "movie:1" })
    expect(restoreCouchFocus(doc)).toBeNull()
    expect(doc.activeElement).toBe(doc.body)
  })
})

describe("vote-count decision — tiered eligibility (integration, 0.6.0)", () => {
  // No voteCount anywhere in this catalogue: the day-one shape, where
  // provider rows carry ratings but no counts (see home-rails.ts).
  // 30+ titles: the dedupe rule (at most 2 rails per title) starves
  // the later rails on a tiny library, so the fixture is catalogue-
  // sized — the same reason the main fixture has 36 bulk titles.
  function tmdbCatalogue(): DiscoverCandidate[] {
    const generated: DiscoverCandidate[] = []
    for (let i = 0; i < 30; i++) {
      generated.push(
        candidate({
          id: `tmdb-gen-${i}`,
          title: `TMDB Title ${i}`,
          genres: [i % 2 === 0 ? "Drama" : "Comedy"],
          rating: 7.6 + ((i % 10) / 10),
          tmdbId: 10000 + i,
          year: 2022,
          runtimeMinutes: 90 + ((i * 7) % 60),
        }),
      )
    }
    return [
      candidate({
        id: "matched-epic",
        title: "Matched Epic",
        genres: ["Drama"],
        rating: 8.6,
        tmdbId: 12345,
        year: 2023,
        runtimeMinutes: 140,
        overview: "An epic matched to TMDb by the provider.",
      }),
      candidate({
        id: "matched-gem",
        title: "Matched Gem",
        genres: ["Drama"],
        rating: 8.1,
        tmdbId: 23456,
        year: 2022,
        runtimeMinutes: 105,
      }),
      candidate({
        id: "unmatched-perfect",
        title: "Unmatched Perfect",
        genres: ["Drama"],
        rating: 10.0,
        year: 2024,
        runtimeMinutes: 95,
      }),
      ...generated,
    ]
  }

  it("shows a credible hero and Hidden Gems from TMDb-matched titles when no vote counts exist", async () => {
    const data = discoverData({ candidates: tmdbCatalogue() })
    const payload = await loadHomeRails(data, [])
    expect(payload.hero?.item.key).toBe("movie:matched-epic")
    expect(payload.hero?.item.overview).toBe("An epic matched to TMDb by the provider.")
    // Backdrop falls back to the poster: never a broken hero image.
    expect(payload.hero?.item.backdropUrl).toBe(payload.hero?.item.posterUrl)
    const gems = railById(payload, "hidden-gems")
    expect(gems).toBeDefined()
    expect(gems?.items.length).toBeGreaterThan(0)
    // Every gem is Tier 2 (TMDb-matched, no vote count surfaced) —
    // never the unmatched 10.0, never a fabricated count.
    for (const item of gems?.items ?? []) {
      expect(item.rating ?? 0).toBeGreaterThanOrEqual(7.5)
      expect(item.voteCount).toBeUndefined()
    }
    expect(gems?.items.map((item) => item.key)).not.toContain("movie:unmatched-perfect")
  })

  it("still excludes an unmatched no-vote 10.0 when nothing else qualifies", async () => {
    const data = discoverData({
      candidates: [
        candidate({
          id: "only-perfect",
          title: "Only Perfect",
          genres: ["Drama"],
          rating: 10.0,
          year: 2024,
          runtimeMinutes: 95,
        }),
      ],
    })
    const payload = await loadHomeRails(data, [])
    expect(payload.hero).toBeNull()
    expect(railById(payload, "hidden-gems")).toBeUndefined()
  })

  it("prefers vote-backed titles over TMDb-matched ones when both exist", async () => {
    const data = discoverData({
      candidates: [
        ...tmdbCatalogue(),
        candidate({
          id: "backed-modest",
          title: "Backed Modest",
          genres: ["Drama"],
          rating: 7.2,
          voteCount: 5000,
          year: 2023,
          runtimeMinutes: 120,
        }),
      ],
    })
    const payload = await loadHomeRails(data, [])
    // Tier 1 pool is non-empty, so the hero comes from vote-backed
    // titles even though a TMDb-matched 8.6 exists.
    expect(payload.hero?.item.key).toBe("movie:backed-modest")
  })

  it("throws AbortError on an already-aborted signal instead of serving cache", async () => {
    const { data } = mainData()
    const controller = new AbortController()
    controller.abort()
    await expect(loadHomeRails(data, [], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})
