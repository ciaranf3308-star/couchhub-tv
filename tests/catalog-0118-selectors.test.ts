import { describe, it, expect, beforeEach } from "vitest"
import { buildCatalogIndex, type CatalogRow } from "@/scripts/lib/catalog-index.ts"
import { invalidateCatalogIndex } from "@/scripts/lib/catalog-index.ts"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups.ts"
import { emptyTasteModel, type TasteModel } from "@/scripts/lib/taste.ts"
import {
  selectFeaturedFilm,
  selectWorthWatching,
  selectRecentlyAdded,
  selectHiddenGems,
  selectContinueWatching,
  selectSeriesWorthStarting,
  reduceRepeatedExposure,
  selectorIds,
  invalidateSelectorCache,
} from "@/scripts/lib/collection-selectors.ts"

beforeEach(() => {
  invalidateCatalogIndex()
  invalidateSelectorCache()
  clearTitleGroupRegistry()
})

const ADDED = 1_700_000_000

function movieRows(): CatalogRow[] {
  return [
    { id: 1, name: "Thriller One", year: "2023", genre: "Thriller", category: "", added: ADDED + 100, tmdb: 1, logo: "http://x/1.jpg", vote_average: 8.4, vote_count: 5000 },
    { id: 2, name: "Provider Ten", year: "2024", genre: "Comedy", category: "", added: ADDED + 200, tmdb: 2, logo: "http://x/2.jpg", rating: "10" },
    { id: 3, name: "Drama Gem", year: "2015", genre: "Drama", category: "", added: ADDED + 50, tmdb: 3, logo: "http://x/3.jpg", vote_average: 7.9, vote_count: 120 },
    { id: 4, name: "Blockbuster", year: "2024", genre: "Action", category: "", added: ADDED + 300, tmdb: 4, logo: "http://x/4.jpg", vote_average: 8.1, vote_count: 50000 },
    { id: 5, name: "No Poster Drama", year: "2019", genre: "Drama", category: "", added: ADDED + 150, tmdb: 5, logo: "", vote_average: 8.0, vote_count: 3000 },
    { id: 6, name: "Unrated Comedy", year: "2022", genre: "Comedy", category: "", added: 0, tmdb: null, logo: "http://x/6.jpg" },
    { id: 7, name: "Liked Thriller", year: "2021", genre: "Thriller", category: "", added: ADDED + 250, tmdb: 7, logo: "http://x/7.jpg", vote_average: 7.5, vote_count: 2000 },
    { id: 8, name: "Horror Filler", year: "2020", genre: "Horror", category: "", added: ADDED + 80, tmdb: 8, logo: "http://x/8.jpg", vote_average: 5.5, vote_count: 800 },
    { id: 9, name: "Old Classic", year: "1972", genre: "Drama", category: "", added: ADDED + 120, tmdb: 9, logo: "http://x/9.jpg", vote_average: 8.8, vote_count: 20000 },
    { id: 99, name: "Not Interested Film", year: "2023", genre: "Thriller", category: "", added: ADDED + 950, tmdb: 99, logo: "http://x/99.jpg", vote_average: 9.5, vote_count: 9000 },
    { id: 10, name: "Recent Arrival", year: "2024", genre: "Romance", category: "", added: ADDED + 900, tmdb: 10, logo: "http://x/10.jpg", vote_average: 7.0, vote_count: 300 },
    { id: 11, name: "Ancient Arrival", year: "1998", genre: "Western", category: "", added: ADDED + 10, tmdb: 11, logo: "http://x/11.jpg", vote_average: 7.2, vote_count: 150 },
    { id: 12, name: "SciFi Epic", year: "2021", genre: "Science Fiction", category: "", added: ADDED + 400, tmdb: 12, logo: "http://x/12.jpg", vote_average: 8.2, vote_count: 8000 },
  ]
}

function movieTaste(): TasteModel {
  const taste = emptyTasteModel("p1", "pl1")
  taste.genreWeights = { thriller: 3, drama: 1.5 }
  taste.notInterestedKeys = ["movie:99"]
  taste.likedTitles = [{ kind: "movie", id: "7", title: "Liked Thriller", weight: 1, updatedAt: 1 }]
  return taste
}

function seriesRows(): CatalogRow[] {
  return [
    { id: 201, name: "Series A", year: "2020", genre: "Drama", category: "", added: ADDED + 100, tmdb: 201, logo: "http://x/a.jpg", vote_average: 8.5, vote_count: 9000 },
    { id: 202, name: "Series B", year: "2021", genre: "Comedy", category: "", added: ADDED + 200, tmdb: 202, logo: "http://x/b.jpg", vote_average: 7.8, vote_count: 4000 },
    { id: 203, name: "Series C", year: "2022", genre: "Drama", category: "", added: ADDED + 300, tmdb: 203, logo: "http://x/c.jpg", vote_average: 9.0, vote_count: 8000 },
    { id: 204, name: "Series D", year: "2019", genre: "Action", category: "", added: ADDED + 50, tmdb: 204, logo: "http://x/d.jpg", vote_average: 7.0, vote_count: 500 },
  ]
}

function seriesTaste(): TasteModel {
  const taste = emptyTasteModel("p1", "pl1")
  taste.genreWeights = { drama: 2 }
  taste.notInterestedKeys = ["series:203"]
  return taste
}

describe("selectFeaturedFilm", () => {
  it("picks a defensible, stable, poster-bearing title — never the bare provider 10", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const taste = movieTaste()
    const first = selectFeaturedFilm(index, taste)
    const second = selectFeaturedFilm(index, taste)
    expect(first).toEqual(second)
    expect(first).not.toBeNull()
    expect(["1", "9"]).toContain(first!.id)
    expect(index.meta.get(first!.id)?.hasPoster).toBe(true)
    expect(first!.reasons.length).toBeGreaterThan(0)
  })

  it("returns null only for an empty index", () => {
    expect(selectFeaturedFilm(buildCatalogIndex("vod", [], "r1"), null)).toBeNull()
    expect(selectFeaturedFilm(null, null)).toBeNull()
  })

  it("falls back gracefully when every title is watched", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const result = selectFeaturedFilm(index, null, undefined, {
      watchedIds: movieRows().map((row) => row.id),
    })
    expect(result).not.toBeNull()
  })
})

describe("selectWorthWatching", () => {
  it("returns a limited, diverse shelf honouring not-interested", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const results = selectWorthWatching(index, movieTaste(), 4)
    expect(results).toHaveLength(4)
    expect(selectorIds(results)).toContain("1")
    expect(selectorIds(results)).not.toContain("99")
    const primaryGenres = new Set(
      results.map((r) => index.meta.get(r.id)?.genreIds[0] ?? ""),
    )
    expect(primaryGenres.size).toBeGreaterThanOrEqual(3)
  })

  it("excludes watched titles outright with excludeWatched", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const results = selectWorthWatching(index, null, 12, {
      excludeWatched: true,
      watchedIds: ["1", "4", "9", "12"],
    })
    expect(selectorIds(results)).not.toContain("1")
    expect(selectorIds(results)).not.toContain("9")
  })

  it("returns [] for an empty or missing index", () => {
    expect(selectWorthWatching(buildCatalogIndex("vod", [], "r1"), null, 5)).toEqual([])
    expect(selectWorthWatching(null, null, 5)).toEqual([])
  })
})

describe("selectRecentlyAdded", () => {
  it("orders by provider added timestamps, excluding unknown dates and not-interested", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const ids = selectorIds(selectRecentlyAdded(index, movieTaste(), 20))
    expect(ids).toEqual(["10", "12", "4", "7", "2", "5", "9", "1", "8", "3", "11"])
    expect(ids).not.toContain("6")
    expect(ids).not.toContain("99")
  })

  it("is honest about cutoffs: only titles inside, never padded", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const cutoff = (ADDED + 300) * 1000
    expect(selectorIds(selectRecentlyAdded(index, null, 20, cutoff))).toEqual(["99", "10", "12", "4"])
    expect(selectRecentlyAdded(index, null, 20, Date.now() + 10_000)).toEqual([])
  })

  it("accepts the shorthand (index, limit) and (index, limit, cutoff) shapes", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    expect(selectorIds(selectRecentlyAdded(index, 2))).toEqual(["99", "10"])
    expect(selectorIds(selectRecentlyAdded(index, 20, (ADDED + 300) * 1000))).toEqual([
      "99", "10", "12", "4",
    ])
  })

  it("carries the added timestamp as score and metadata", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const [first] = selectRecentlyAdded(index, null, 1)
    expect(first.addedMs).toBe((ADDED + 950) * 1000)
    expect(first.score).toBe((ADDED + 950) * 1000)
    expect(first.reasons[0]).toMatch(/^Added \d{4}-\d{2}-\d{2}$/)
  })
})

describe("selectHiddenGems", () => {
  it("requires quality plus underexposure — never rating alone", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const ids = selectorIds(selectHiddenGems(index, movieTaste(), 12))
    expect(ids.sort()).toEqual(["10", "11", "3"])
    expect(ids).not.toContain("2")
    expect(ids).not.toContain("4")
  })

  it("names the obscurity evidence in its reasons", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const [first] = selectHiddenGems(index, movieTaste(), 1)
    expect(first.reasons.some((reason) => reason.includes("Few votes"))).toBe(true)
  })

  it("accepts the shorthand (index, limit) shape", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    expect(selectHiddenGems(index, 2)).toHaveLength(2)
  })
})

describe("selectContinueWatching", () => {
  it("returns genuinely in-progress movies only, newest first", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const results = selectContinueWatching(index, null, 12, {
      progressEntries: [
        { kind: "vod", id: 1, position: 600, duration: 3600, updatedAt: 300 },
        { kind: "vod", id: 2, position: 0, duration: 3600, updatedAt: 400 },
        { kind: "vod", id: 3, position: 3600, duration: 3600, completed: true, updatedAt: 500 },
        { kind: "vod", id: 4, position: 100, duration: 0, updatedAt: 200 },
        { kind: "vod", id: 5, progressFraction: 1, updatedAt: 600 },
        { kind: "vod", id: 999, position: 10, duration: 100, updatedAt: 700 },
      ],
    })
    expect(selectorIds(results)).toEqual(["1", "4"])
    expect(results[0].progressFraction).toBeCloseTo(1 / 6)
    expect(results[1].progressFraction).toBeUndefined()
  })

  it("rolls episode progress up to series-level entries", () => {
    const index = buildCatalogIndex("series", seriesRows(), "rev-1")
    const results = selectContinueWatching(index, null, 12, {
      progressEntries: [
        { kind: "episode", id: 9001, seriesId: 201, position: 100, duration: 1000, updatedAt: 100 },
        { kind: "episode", id: 9002, seriesId: 201, position: 200, duration: 1000, updatedAt: 500 },
        { kind: "episode", id: 9003, seriesId: 202, position: 0, duration: 1000, updatedAt: 600 },
        { kind: "episode", id: 9004, seriesId: null, position: 50, duration: 100, updatedAt: 700 },
        { kind: "vod", id: 201, position: 50, duration: 100, updatedAt: 800 },
      ],
    })
    expect(selectorIds(results)).toEqual(["201"])
    expect(results[0].updatedAt).toBe(500)
    expect(results[0].progressFraction).toBeCloseTo(0.2)
  })

  it("returns [] when there is no progress input", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    expect(selectContinueWatching(index, null, 12, {})).toEqual([])
  })
})

describe("selectSeriesWorthStarting", () => {
  it("returns series-level entries only, excluding started and not-interested series", () => {
    const index = buildCatalogIndex("series", seriesRows(), "rev-1")
    const results = selectSeriesWorthStarting(index, seriesTaste(), 12, {
      progressEntries: [
        { kind: "episode", id: 1, seriesId: 201, position: 10, duration: 100, updatedAt: 1 },
      ],
    })
    expect(selectorIds(results)).not.toContain("201")
    expect(selectorIds(results)).not.toContain("203")
    expect(selectorIds(results)).toContain("202")
  })

  it("returns [] for a movies index", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    expect(selectSeriesWorthStarting(index, null, 5)).toEqual([])
  })
})

describe("AI recommendation gate", () => {
  it("ignores AI input without the privacy permission, honours it with permission", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const ai = [{ id: 8, rank: 1 }]
    const baseline = selectWorthWatching(index, null, 12)
    const gated = selectWorthWatching(index, null, 12, { aiRecommendations: ai })
    expect(gated).toEqual(baseline)
    expect(gated.flatMap((r) => r.reasons).some((r) => r.includes("AI Discovery"))).toBe(false)
    const allowed = selectWorthWatching(index, null, 12, {
      aiRecommendations: ai,
      aiRecommendationsAllowed: true,
    })
    const horror = allowed.find((r) => r.id === "8")!
    expect(horror.reasons).toContain("Picked by AI Discovery")
  })
})

describe("selector caching", () => {
  it("returns equal results on repeat and after invalidation", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const first = selectWorthWatching(index, movieTaste(), 4)
    expect(selectWorthWatching(index, movieTaste(), 4)).toEqual(first)
    invalidateSelectorCache()
    expect(selectWorthWatching(index, movieTaste(), 4)).toEqual(first)
  })

  it("bypasses the cache for volatile exposure input without a discriminator", () => {
    const index = buildCatalogIndex("vod", movieRows(), "rev-1")
    const plain = selectWorthWatching(index, null, 4)
    const exposed = selectWorthWatching(index, null, 4, {
      exposureCounts: { "1": 10, "9": 10 },
    })
    expect(exposed).not.toEqual(plain)
    expect(selectorIds(selectWorthWatching(index, null, 4))).toEqual(selectorIds(plain))
  })
})

describe("reduceRepeatedExposure", () => {
  it("keeps the first shelf's copy and drops later repeats, excepting Continue Watching", () => {
    const shelves = [
      { name: "featured", items: [{ id: "1", score: 1, reasons: [] }, { id: "9", score: 1, reasons: [] }] },
      { name: "worth", items: [{ id: "9", score: 1, reasons: [] }, { id: "12", score: 1, reasons: [] }, { id: "12", score: 1, reasons: [] }] },
      { name: "continue-watching", items: [{ id: "1", score: 1, reasons: [] }] },
      { name: "recent", items: [{ id: "1", score: 1, reasons: [] }, { id: "4", score: 1, reasons: [] }] },
    ]
    const deduped = reduceRepeatedExposure(shelves)
    expect(selectorIds(deduped[0].items)).toEqual(["1", "9"])
    expect(selectorIds(deduped[1].items)).toEqual(["12"])
    expect(selectorIds(deduped[2].items)).toEqual(["1"])
    expect(selectorIds(deduped[3].items)).toEqual(["4"])
    expect(shelves[1].items).toHaveLength(3)
  })
})
