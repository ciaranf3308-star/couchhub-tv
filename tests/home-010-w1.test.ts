// RedSilk Home 0.10.0 — W1 issues H01–H07.
// Synthetic fixtures only; no live catalogue, no AI key, no real EPG fetch.
import { describe, it, expect, beforeEach } from "vitest"
import {
  loadHomeRails,
  clearHomeRailsCache,
  contentKindOf,
  typeLineFor,
  kindPluralLabel,
  contentTypeSuffix,
  variantForRail,
  RECO_RAIL_MIN_ITEMS,
  type HomeRail,
} from "../src/scripts/lib/home-rails"
import {
  candidateTypeLine,
  hiddenGemCards,
} from "../src/scripts/lib/couch-home"
import { epgTimeRangeLabel } from "../src/scripts/lib/couch-livetv-epg"
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

function railById(
  payload: Awaited<ReturnType<typeof loadHomeRails>>,
  id: string,
): HomeRail | undefined {
  return payload.rails.find((rail) => rail.id === id)
}

/** Vote-backed film/series factory (rating, votes, year, runtime). */
function backed(
  partial: Partial<DiscoverCandidate> & { id: string; title: string },
): DiscoverCandidate {
  return candidate({
    rating: 8.0,
    voteCount: 5000,
    year: 2023,
    runtimeMinutes: 110,
    ...partial,
  })
}

beforeEach(() => {
  clearHomeRailsCache()
})

// ---------------------------------------------------------------------------
// H01 — every Home collection identifies its content type
// ---------------------------------------------------------------------------

describe("H01 — rail titles name their content type", () => {
  /** Rich catalogue: crime films, true-crime doc series/films, drama
   * series, and bulk filler across genres so rails separate. */
  function richCatalogue(): DiscoverCandidate[] {
    const bulk: DiscoverCandidate[] = []
    const genres = ["Drama", "Crime", "Comedy", "Science Fiction", "Horror", "Action"]
    // 36 bulk titles: the catalogue has to be this big because the
    // dedupe rule (at most 2 rails, never adjacent) starves the
    // later rails on a tiny library — the same reason the main
    // home-rails fixture has 36 bulk titles.
    for (let i = 0; i < 36; i++) {
      const genre = genres[i % genres.length] as string
      bulk.push(
        candidate({
          id: `bulk-${i}`,
          title: `Bulk ${genre} ${i}`,
          genres: [genre],
          rating: 7.0 + (((i * 7) % 10) / 10),
          voteCount: 1500 + ((i * 1373) % 18000),
          year: 2022 + (i % 3),
          runtimeMinutes: 90 + ((i * 13) % 70),
        }),
      )
    }
    const crimeFilms = [0, 1, 2, 3].map((n) =>
      backed({
        id: `crime-film-${n}`,
        title: `Crime Film ${n}`,
        genres: ["Crime"],
        rating: 8.0 + n / 10,
        runtimeMinutes: 105 + n * 5,
      }),
    )
    const crimeDocs = [0, 1, 2, 3].map((n) =>
      backed({
        id: `crime-doc-${n}`,
        title: `True Crime Doc ${n}`,
        kind: "series",
        genres: ["True Crime", "Documentary"],
        rating: 8.5,
        runtimeMinutes: undefined,
      }),
    )
    const docFilms = [0, 1].map((n) =>
      backed({
        id: `doc-film-${n}`,
        title: `Nature Doc ${n}`,
        genres: ["Documentary"],
        // Rated low on purpose: the high-rated titles are consumed
        // by Next Obsession + Hidden Gems + Trending (2-rail cap),
        // so the doc films must rank below those rails' floors —
        // 6.9 misses Trending (7.0) and Hidden Gems, and Tonight's
        // Picks is the only rail that claims them — leaving them
        // free for the Documentary rail, which then holds both kinds.
        rating: 6.9,
        runtimeMinutes: 95,
      }),
    )
    const dramaSeries = [0, 1].map((n) =>
      backed({
        id: `drama-series-${n}`,
        title: `Drama Series ${n}`,
        kind: "series",
        genres: ["Drama"],
        rating: 8.2,
      }),
    )
    return [...bulk, ...crimeFilms, ...crimeDocs, ...docFilms, ...dramaSeries]
  }

  it("a mixed documentary + fiction rail collapses to the broad types", () => {
    // "Documentary Series & Films & Series" reads like a bug on the
    // TV; the broad types are honest and the documentary detail
    // stays on the cards themselves.
    expect(
      contentTypeSuffix([
        { contentKind: "documentary-series" } as never,
        { contentKind: "movie" } as never,
        { contentKind: "series" } as never,
      ]),
    ).toBe("Films & Series")
    expect(
      contentTypeSuffix([
        { contentKind: "documentary-series" } as never,
        { contentKind: "movie" } as never,
      ]),
    ).toBe("Films & Series")
    // All-documentary rails keep the precise labels.
    expect(
      contentTypeSuffix([
        { contentKind: "documentary-series" } as never,
        { contentKind: "documentary-film" } as never,
      ]),
    ).toBe("Documentary Series & Documentary Films")
  })

  it("genre rails carry a content-type suffix, from the kinds they hold", async () => {
    const taste = emptyTasteModel("profile-1", "playlist-1")
    taste.genreWeights = { drama: 5, crime: 3 }
    const payload = await loadHomeRails(
      discoverData({ candidates: richCatalogue(), taste, hasHistory: true }),
      [],
    )
    const crime = railById(payload, "genre-crime-mystery")
    expect(crime).toBeDefined()
    // Crime fiction here is films only — the suffix says so.
    expect(crime?.title).toBe("Crime & Mystery — Films")
    for (const item of crime?.items ?? []) {
      expect(item.contentKind).toBe("movie")
    }
    const doc = payload.rails.find((rail) => rail.id === "genre-documentary")
    expect(doc).toBeDefined()
    // Mixed doc films + doc series: both kinds named, in the order
    // the rail holds them (series first here — they rank higher).
    expect(doc?.title).toBe("Documentary — Documentary Series & Documentary Films")
    for (const item of doc?.items ?? []) {
      expect(["documentary-film", "documentary-series"]).toContain(item.contentKind)
    }
  })

  it("focused cards carry the kind label and runtime, never a bare title", async () => {
    const film = backed({
      id: "film-1",
      title: "A Film",
      genres: ["Crime"],
      rating: 8.0,
      runtimeMinutes: 118,
    })
    const docSeries = backed({
      id: "doc-1",
      title: "A Doc Series",
      kind: "series",
      genres: ["True Crime", "Documentary"],
      rating: 8.5,
    })
    expect(contentKindOf(film)).toBe("movie")
    expect(typeLineFor(film)).toBe("Movie · 1h 58m")
    expect(contentKindOf(docSeries)).toBe("documentary-series")
    expect(typeLineFor(docSeries)).toBe("Documentary Series")
    expect(kindPluralLabel("movie")).toBe("Films")
    expect(kindPluralLabel("documentary-series")).toBe("Documentary Series")
    expect(
      contentTypeSuffix([
        { contentKind: "movie" } as never,
        { contentKind: "series" } as never,
      ]),
    ).toBe("Films & Series")
    // And the legacy assembly agrees (same C1 labels).
    expect(candidateTypeLine(film)).toBe("Movie · 1h 58m")
    expect(candidateTypeLine(docSeries)).toBe("Documentary Series")
  })

  it("New Episodes names its type and Tonight's Picks names Live TV when live is present", async () => {
    const taste = emptyTasteModel("profile-1", "playlist-1")
    taste.genreWeights = { drama: 5, crime: 3 }
    const followed: FollowedEpisode[] = [
      {
        seriesId: "drama-series-0",
        seriesTitle: "Drama Series 0",
        season: 1,
        episode: 2,
        episodeTitle: "Second",
        detectedAt: "2026-11-10T10:00:00.000Z",
        watched: false,
      },
    ]
    const payload = await loadHomeRails(
      discoverData({
        candidates: richCatalogue(),
        taste,
        hasHistory: true,
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
      }),
      followed,
    )
    expect(railById(payload, "new-episodes")?.title).toBe("New Episodes — Series")
    expect(railById(payload, "tonight")?.title).toBe("Tonight's Picks — Live TV")
  })
})

// ---------------------------------------------------------------------------
// H02 — confidence engine: a 10.0 with no votes never headlines
// ---------------------------------------------------------------------------

describe("H02 — no-vote 10.0 never headlines", () => {
  function sixteenPlusPerfect(): DiscoverCandidate[] {
    const titles: DiscoverCandidate[] = []
    // 16 vote-backed titles, distinct ratings 7.2–8.7, two genres with
    // no taste weight — the lowest-rated fall out of Next Obsession
    // (top 12) and stay fresh for Trending. Ratings start at 7.2 so
    // every one clears the 7.0 Bayesian floor (a 7.0 with 1000 votes
    // scores 6.95 and would fall out of the pool entirely).
    for (let i = 0; i < 16; i++) {
      titles.push(
        backed({
          id: `t-${i}`,
          title: `Title ${String(i).padStart(2, "0")}`,
          genres: [i % 2 === 0 ? "Horror" : "Science Fiction"],
          rating: 7.2 + i / 10,
          voteCount: 1000 + i * 500,
          year: 2023,
        }),
      )
    }
    titles.push(
      candidate({
        id: "perfect",
        title: "Perfect Nobody",
        genres: ["Drama"],
        rating: 10.0,
        year: 2024,
      }),
    )
    return titles
  }

  it("excludes the no-vote 10.0 from the hero, gems and every headline rail", async () => {
    const payload = await loadHomeRails(
      discoverData({ candidates: sixteenPlusPerfect() }),
      [],
    )
    expect(payload.hero?.item.key).not.toBe("movie:perfect")
    for (const rail of payload.rails) {
      expect(
        rail.items.map((item) => item.key),
        rail.id,
      ).not.toContain("movie:perfect")
    }
    const picks = railById(payload, "next-obsession")
    expect(picks?.items[0]?.key).not.toBe("movie:perfect")
  })

  it("a trending extra pointing at a no-vote 10.0 is dropped, not headlined", async () => {
    const titles = sixteenPlusPerfect()
    const payload = await loadHomeRails(discoverData({ candidates: titles }), [], {
      trending: [
        { kind: "movie", id: "perfect", title: "Perfect Nobody", rating: 10.0 },
        { kind: "movie", id: "t-0", title: "Title 00", rating: 7.0 },
        { kind: "movie", id: "t-1", title: "Title 01", rating: 7.1 },
        { kind: "movie", id: "t-2", title: "Title 02", rating: 7.2 },
        { kind: "movie", id: "t-3", title: "Title 03", rating: 7.3 },
      ],
    })
    const trending = railById(payload, "trending")
    expect(trending).toBeDefined()
    expect(trending?.items.map((item) => item.key)).not.toContain("movie:perfect")
    expect(trending?.items.map((item) => item.key)).toEqual([
      "movie:t-3",
      "movie:t-2",
      "movie:t-1",
      "movie:t-0",
    ])
  })

  it("legacy Hidden Gems order by confidence, not raw rating", () => {
    const gems = hiddenGemCards(
      [
        candidate({ id: "a", title: "No Vote Ten", rating: 10.0, year: 2024 }),
        candidate({ id: "b", title: "Backed Seven Six", rating: 7.6, voteCount: 5000, year: 2024 }),
      ],
      new Set(),
    )
    expect(gems.map((g) => g.title)).toEqual(["Backed Seven Six", "No Vote Ten"])
  })
})

// ---------------------------------------------------------------------------
// H03 — taxonomy: a crime documentary is a documentary, not crime drama
// ---------------------------------------------------------------------------

describe("H03 — documentaries stay out of fiction genre rails", () => {
  it("crime docs sit in the Documentary rail, never in Crime & Mystery", async () => {
    const taste = emptyTasteModel("profile-1", "playlist-1")
    taste.genreWeights = { drama: 5, crime: 3 }
    const docs = [0, 1, 2, 3].map((n) =>
      backed({
        id: `crime-doc-${n}`,
        title: `True Crime Doc ${n}`,
        kind: "series",
        genres: ["True Crime", "Documentary"],
        rating: 8.5,
      }),
    )
    const dramas = [0, 1, 2, 3].map((n) =>
      backed({
        id: `crime-film-${n}`,
        title: `Crime Film ${n}`,
        genres: ["Crime"],
        rating: 8.0 + n / 10,
      }),
    )
    // Low-rated crime films: the high-rated titles are consumed by
    // Next Obsession + Hidden Gems (2-rail cap), so the Crime rail
    // needs titles that rank low enough to survive for it.
    const crimeLow = [0, 1, 2, 3].map((n) =>
      backed({
        id: `crime-low-${n}`,
        title: `Crime Low ${n}`,
        genres: ["Crime"],
        rating: 7.0 + n / 10,
        voteCount: 1500,
      }),
    )
    // Barely-supported crime films (6.5, old year, no novelty
    // bonus): they miss Next Obsession's top 12, Trending (7.0
    // floor) and Hidden Gems, and Tonight's Picks is the only rail
    // that claims them — so they survive with count 1 for the
    // Crime & Mystery rail, which otherwise starves entirely.
    const crimeBare = [0, 1, 2, 3].map((n) =>
      backed({
        id: `crime-bare-${n}`,
        title: `Crime Bare ${n}`,
        genres: ["Crime"],
        rating: 6.5,
        voteCount: 1500,
        year: 2019,
      }),
    )
    const filler = [0, 1, 2, 3, 4, 5, 6, 7].map((n) =>
      backed({
        id: `filler-${n}`,
        title: `Filler ${n}`,
        genres: ["Comedy"],
        rating: 7.5,
        voteCount: 2000,
      }),
    )
    // 24 bulk titles across genres: the dedupe rule (at most 2 rails,
    // never adjacent) starves the later genre rails on a tiny library.
    const bulkGenres = ["Drama", "Crime", "Comedy", "Science Fiction", "Horror", "Action"]
    const bulk = Array.from({ length: 24 }, (_, i) =>
      candidate({
        id: `bulk-${i}`,
        title: `Bulk ${bulkGenres[i % bulkGenres.length]} ${i}`,
        genres: [bulkGenres[i % bulkGenres.length] as string],
        rating: 7.0 + (((i * 7) % 10) / 10),
        voteCount: 1500 + ((i * 1373) % 18000),
        year: 2022 + (i % 3),
        runtimeMinutes: 90 + ((i * 13) % 70),
      }),
    )
    const payload = await loadHomeRails(
      discoverData({ candidates: [...docs, ...dramas, ...crimeLow, ...crimeBare, ...filler, ...bulk], taste, hasHistory: true }),
      [],
    )
    const crime = railById(payload, "genre-crime-mystery")
    expect(crime).toBeDefined()
    expect(crime?.items.map((item) => item.key)).not.toContain("series:crime-doc-0")
    for (const item of crime?.items ?? []) {
      expect(item.contentKind).not.toBe("documentary-series")
      expect(item.contentKind).not.toBe("documentary-film")
    }
    const doc = payload.rails.find((rail) => rail.id === "genre-documentary")
    expect(doc).toBeDefined()
    expect(doc?.items.map((item) => item.key)).toContain("series:crime-doc-0")
  })
})

// ---------------------------------------------------------------------------
// H04 — rail variants (view renders rs-rail--<variant>)
// ---------------------------------------------------------------------------

describe("H04 — rails declare a visual variant", () => {
  it("film / series / documentary / followed / live / mixed are distinct", async () => {
    // A catalogue big enough for the dedupe rule (at most 2 rails,
    // never adjacent) to leave titles for the later rails.
    const bulkGenres = ["Drama", "Crime", "Comedy", "Science Fiction", "Horror", "Action"]
    const bulk = Array.from({ length: 24 }, (_, i) =>
      candidate({
        id: `bulk-${i}`,
        title: `Bulk ${bulkGenres[i % bulkGenres.length]} ${i}`,
        genres: [bulkGenres[i % bulkGenres.length] as string],
        rating: 7.0 + (((i * 7) % 10) / 10),
        voteCount: 1500 + ((i * 1373) % 18000),
        year: 2022 + (i % 3),
        runtimeMinutes: 90 + ((i * 13) % 70),
      }),
    )
    // Low-rated in-progress series: it must NOT make the Next
    // Obsession top 12, or the 2-rail cap would block it from
    // Continue Your Series (a watched series is excluded from
    // recommendations; an unwatched low scorer simply ranks below).
    const slowSeries = backed({
      id: "slow-series",
      title: "Slow Series",
      kind: "series",
      genres: ["Drama"],
      rating: 7.1,
      voteCount: 200,
      year: 2022,
    })
    const followed: FollowedEpisode[] = [
      {
        seriesId: "slow-series",
        seriesTitle: "Slow Series",
        season: 1,
        episode: 2,
        detectedAt: "2026-11-10T10:00:00.000Z",
        watched: false,
      },
    ]
    const taste = emptyTasteModel("profile-1", "playlist-1")
    taste.genreWeights = { drama: 5, crime: 3 }
    const payload = await loadHomeRails(
      discoverData({
        candidates: [
          ...bulk,
          ...[0, 1, 2, 3].map((n) =>
            backed({ id: `crime-film-${n}`, title: `Crime Film ${n}`, genres: ["Crime"], rating: 8.0 }),
          ),
          ...[0, 1, 2, 3].map((n) =>
            backed({ id: `crime-doc-${n}`, title: `True Crime Doc ${n}`, kind: "series", genres: ["True Crime", "Documentary"], rating: 8.5 }),
          ),
          ...[0, 1, 2, 3].map((n) =>
            backed({ id: `drama-${n}`, title: `Drama ${n}`, genres: ["Drama"], rating: 7.8, runtimeMinutes: 95 }),
          ),
          ...[0, 1].map((n) =>
            backed({ id: `drama-series-${n}`, title: `Drama Series ${n}`, kind: "series", genres: ["Drama"], rating: 8.2 }),
          ),
          slowSeries,
        ],
        taste,
        hasHistory: true,
        nowPlaying: [
          candidate({
            id: "ch-1",
            kind: "live",
            title: "Evening Channel",
            source: "epg",
            overview: "Now: Evening News · Next: Late Film",
          }),
        ],
        continueWatching: [],
      }),
      followed,
      {
        progressRows: [
          { kind: "episode", id: "ep-1", position: 600, duration: 1200, seriesId: "slow-series", season: 1, episodeNum: 1, episodeTitle: "Pilot" },
        ],
      },
    )
    for (const rail of payload.rails) {
      // A variant is one of W5's five names, or absent (neutral
      // default) — never an invented value.
      expect(
        rail.variant === undefined ||
          ["film", "series", "documentary", "followed", "live"].includes(rail.variant),
        rail.id,
      ).toBe(true)
    }
    expect(railById(payload, "new-episodes")?.variant).toBe("followed")
    expect(railById(payload, "continue-series")?.variant).toBe("series")
    expect(railById(payload, "tonight")?.variant).toBe("live")
    // Mixed collections are the neutral default: no variant prop
    // (W5's TvRail omits it; `.rs-rail--variant-*` is only for the
    // five named variants).
    expect(railById(payload, "next-obsession")?.variant).toBeUndefined()
    const doc = payload.rails.find((rail) => rail.id === "genre-documentary")
    if (doc) expect(doc.variant).toBe("documentary")
    const short = railById(payload, "short")
    if (short) expect(short.variant).toBe("film")
    expect(
      variantForRail("genre", [
        { contentKind: "movie" } as never,
        { contentKind: "series" } as never,
      ]),
    ).toBeUndefined()
    expect(
      variantForRail("genre", [{ contentKind: "documentary-film" } as never]),
    ).toBe("documentary")
  })
})

// ---------------------------------------------------------------------------
// H05 — personalisation claims need a real signal, else a neutral label
// ---------------------------------------------------------------------------

describe("H05 — reasons are signal-backed or neutral", () => {
  function sixBacked(): DiscoverCandidate[] {
    return [0, 1, 2, 3, 4, 5].map((n) =>
      backed({
        id: `d-${n}`,
        title: `Drama ${n}`,
        genres: ["Drama"],
        rating: 7.5 + n / 10,
        voteCount: 1000 + n * 100,
      }),
    )
  }

  it("with no taste signals, Next Obsession reasons are neutral, never 'Matches your taste'", async () => {
    const payload = await loadHomeRails(discoverData({ candidates: sixBacked() }), [])
    const picks = railById(payload, "next-obsession")
    expect(picks).toBeDefined()
    for (const item of picks?.items ?? []) {
      expect(item.reason ?? "").toMatch(/^Featured /)
      expect(item.reason ?? "").not.toContain("Matches your taste")
    }
    expect(picks?.items[0]?.reason).toBe("Featured Drama Movie")
  })

  it("with real genre affinity, explain() cites it", async () => {
    const taste = emptyTasteModel("profile-1", "playlist-1")
    taste.genreWeights = { drama: 5 }
    const payload = await loadHomeRails(
      discoverData({ candidates: sixBacked(), taste, hasHistory: true }),
      [],
    )
    const picks = railById(payload, "next-obsession")
    expect(picks).toBeDefined()
    expect(picks?.items.map((item) => item.reason)).toContain("Because you liked Drama")
  })

  it("with a More Like This seed, the reason cites the watched seed", async () => {
    const seed = backed({
      id: "seed",
      title: "Seed Crime",
      genres: ["Crime"],
      cast: ["Ada Star"],
      rating: 8.0,
      voteCount: 5000,
      year: 2023,
    })
    const hopeful = backed({
      id: "hopeful",
      title: "Crime Hopeful",
      genres: ["Crime"],
      rating: 7.5,
      voteCount: 500,
      year: 2024,
    })
    const fillers = [0, 1, 2].map((n) =>
      backed({
        id: `fill-${n}`,
        title: `Filler ${n}`,
        genres: ["Comedy"],
        rating: 7.5,
        voteCount: 500,
        year: 2024,
      }),
    )
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
        candidates: [seed, hopeful, ...fillers],
        taste,
        hasHistory: true,
        watchedKeys: new Set(["movie:seed"]),
      }),
      [],
    )
    const picks = railById(payload, "next-obsession")
    expect(picks?.items.map((item) => item.reason)).toContain("Because you watched Seed Crime")
  })

  it("a true-crime doc with no signals is neutrally a documentary, not a crime series", async () => {
    const doc = backed({
      id: "doc-0",
      title: "True Crime Doc 0",
      kind: "series",
      genres: ["True Crime", "Documentary"],
      rating: 8.5,
    })
    const fillers = [0, 1, 2, 3].map((n) =>
      backed({ id: `f-${n}`, title: `Filler ${n}`, genres: ["Comedy"], rating: 7.5, voteCount: 1000 }),
    )
    const payload = await loadHomeRails(
      discoverData({ candidates: [doc, ...fillers] }),
      [],
    )
    const picks = railById(payload, "next-obsession")
    const docItem = picks?.items.find((item) => item.key === "series:doc-0")
    expect(docItem?.reason).toBe("Featured True Crime Documentary Series")
  })
})

// ---------------------------------------------------------------------------
// H06 — sparse rails hide; factual rails show from 1 item
// ---------------------------------------------------------------------------

describe("H06 — minimum population rules", () => {
  it("recommendation rails with 3 items hide; Continue Watching with 2 shows", async () => {
    const films = [0, 1, 2].map((n) =>
      backed({
        id: `film-${n}`,
        title: `Film ${n}`,
        genres: ["Drama"],
        rating: 8.0,
        voteCount: 5000,
        runtimeMinutes: 95,
      }),
    )
    const payload = await loadHomeRails(
      discoverData({
        candidates: films,
      }),
      [],
      {
        progressRows: [
          { kind: "vod", id: "film-0", position: 600, duration: 1200 },
          { kind: "vod", id: "film-1", position: 300, duration: 1200 },
        ],
      },
    )
    expect(railById(payload, "next-obsession")).toBeUndefined()
    expect(railById(payload, "trending")).toBeUndefined()
    expect(railById(payload, "hidden-gems")).toBeUndefined()
    expect(railById(payload, "short")).toBeUndefined()
    expect(railById(payload, "tonight")).toBeUndefined()
    // Factual rails are status, not collections: they show from 1.
    expect(railById(payload, "continue-watching")).toBeDefined()
    // The content itself is not lost: the hero still headlines it.
    expect(payload.hero).not.toBeNull()
  })

  it("a factual rail shows from 1 item", async () => {
    // One unproven film: Tonight's Picks fillers need evidence, so
    // the film is never consumed there — and it is marked watched,
    // so the hidden Next Obsession never claims its second placement
    // slot either. The factual rails still show it.
    const film = candidate({
      id: "solo",
      title: "Solo Film",
      genres: ["Drama"],
      rating: 8.0,
      year: 2024,
      runtimeMinutes: 100,
    })
    const payload = await loadHomeRails(
      discoverData({
        candidates: [film],
        recentlyAdded: [film],
        watchedKeys: new Set(["movie:solo"]),
      }),
      [],
      {
        progressRows: [{ kind: "vod", id: "solo", position: 600, duration: 1200 }],
      },
    )
    expect(railById(payload, "recently-added")).toBeDefined()
    expect(railById(payload, "recently-added")?.items).toHaveLength(1)
    expect(railById(payload, "recently-added")?.sparse).toBe(true)
    expect(railById(payload, "continue-watching")).toBeDefined()
    expect(railById(payload, "continue-watching")?.sparse).toBe(true)
    expect(railById(payload, "next-obsession")).toBeUndefined()
    expect(railById(payload, "tonight")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// H07 — Tonight's Picks shows what is actually airing, from real EPG
// ---------------------------------------------------------------------------

describe("H07 — Tonight's Picks from real EPG", () => {
  const NOW_MS = Date.parse("2026-11-10T20:00:00Z")

  function sixteenBacked(): DiscoverCandidate[] {
    const titles: DiscoverCandidate[] = []
    for (let i = 0; i < 16; i++) {
      titles.push(
        backed({
          id: `v-${i}`,
          title: `Title ${String(i).padStart(2, "0")}`,
          genres: [i % 2 === 0 ? "Horror" : "Science Fiction"],
          rating: 7.2 + i / 10,
          voteCount: 1000 + i * 500,
          year: 2023,
        }),
      )
    }
    return titles
  }

  it("shows programme title, channel, start time and on-now status from EPG slots", async () => {
    const payload = await loadHomeRails(discoverData({ candidates: sixteenBacked() }), [], {
      nowMs: NOW_MS,
      tonightEpg: [
        {
          channelId: "ch-1",
          channelName: "Evening Channel",
          channelLogo: "https://provider.example/logos/ch-1.png",
          nowTitle: "Planet Earth III",
          nowStartMs: Date.parse("2026-11-10T19:30:00Z"),
          nowStopMs: Date.parse("2026-11-10T21:00:00Z"),
          nextTitle: "The Traitors",
          nextStartMs: Date.parse("2026-11-10T21:00:00Z"),
          nextStopMs: Date.parse("2026-11-10T22:30:00Z"),
        },
        {
          channelId: "ch-2",
          channelName: "News Channel",
          nowTitle: "Evening News",
          nowStartMs: Date.parse("2026-11-10T20:00:00Z"),
          nowStopMs: Date.parse("2026-11-10T20:30:00Z"),
          nextTitle: "Late Film",
          nextStartMs: Date.parse("2026-11-10T20:30:00Z"),
          nextStopMs: Date.parse("2026-11-10T22:00:00Z"),
        },
      ],
    })
    const tonight = railById(payload, "tonight")
    expect(tonight).toBeDefined()
    expect(tonight?.title).toBe("Tonight's Picks — Live TV")
    expect(tonight?.variant).toBe("live")
    const live = (tonight?.items ?? []).filter((item) => item.isLive)
    expect(live).toHaveLength(2)
    const first = live[0] as (typeof live)[number]
    expect(first.title).toBe("Evening Channel")
    expect(first.nowTitle).toContain("Planet Earth III")
    expect(first.nowTitle).toContain("On now")
    expect(first.nowTitle).toContain(
      epgTimeRangeLabel(
        Date.parse("2026-11-10T19:30:00Z"),
        Date.parse("2026-11-10T21:00:00Z"),
      ),
    )
    expect(first.nextTitle).toContain("The Traitors")
    expect(first.nowStartMs).toBe(Date.parse("2026-11-10T19:30:00Z"))
    expect(first.nowStopMs).toBe(Date.parse("2026-11-10T21:00:00Z"))
    expect(first.programmeStatus).toBe("now")
    expect(first.contentKind).toBe("live")
    expect(first.detailHref).toBe("/livetv?channel=ch-1")
  })

  it("drops a stale slot whose programme already ended — never shown as on now", async () => {
    const payload = await loadHomeRails(discoverData({ candidates: sixteenBacked() }), [], {
      nowMs: NOW_MS,
      tonightEpg: [
        {
          channelId: "ch-stale",
          channelName: "Stale Channel",
          nowTitle: "Old Show",
          nowStartMs: Date.parse("2026-11-10T17:00:00Z"),
          nowStopMs: Date.parse("2026-11-10T18:00:00Z"),
        },
        {
          channelId: "ch-1",
          channelName: "Evening Channel",
          nowTitle: "Planet Earth III",
          nowStartMs: Date.parse("2026-11-10T19:30:00Z"),
          nowStopMs: Date.parse("2026-11-10T21:00:00Z"),
        },
      ],
    })
    const tonight = railById(payload, "tonight")
    const live = (tonight?.items ?? []).filter((item) => item.isLive)
    expect(live.map((item) => item.key)).not.toContain("live:ch-stale")
    expect(live.map((item) => item.key)).toContain("live:ch-1")
  })

  it("with no EPG at all, Tonight's Picks is VOD-only and says so", async () => {
    const payload = await loadHomeRails(discoverData({ candidates: sixteenBacked() }), [])
    const tonight = railById(payload, "tonight")
    expect(tonight).toBeDefined()
    // The fixture holds films only, so the suffix says Films.
    expect(tonight?.title).toBe("Tonight's Picks — Films")
    expect(tonight?.description).toBe("For tonight, from your library")
    expect((tonight?.items ?? []).some((item) => item.isLive)).toBe(false)
  })

  it("without EPG slots, nowPlaying titles carry no invented times", async () => {
    const payload = await loadHomeRails(
      discoverData({
        candidates: sixteenBacked(),
        nowPlaying: [
          candidate({
            id: "ch-1",
            kind: "live",
            title: "Evening Channel",
            source: "epg",
            overview: "Now: Evening News · Next: Late Film",
          }),
        ],
      }),
      [],
    )
    const tonight = railById(payload, "tonight")
    const live = (tonight?.items ?? []).find((item) => item.isLive)
    expect(live?.nowTitle).toBe("Evening News")
    expect(live?.nextTitle).toBe("Late Film")
    expect(live?.nowStartMs).toBeUndefined()
  })
})
