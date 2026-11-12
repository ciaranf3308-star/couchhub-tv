import { describe, it, expect, beforeEach } from "vitest"
import {
  buildCatalogIndex,
  getCatalogIndex,
  invalidateCatalogIndex,
  createProfileLayer,
  type CatalogRow,
} from "@/scripts/lib/catalog-index.ts"
import { UNCATEGORISED_ID, providerCategoryInfo, clearProviderCategoryRegistry } from "@/scripts/lib/genres.ts"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups.ts"

beforeEach(() => {
  invalidateCatalogIndex()
  clearProviderCategoryRegistry()
  clearTitleGroupRegistry()
})

const ADDED_BASE = 1_700_000_000 // epoch seconds

function vodFixture(): CatalogRow[] {
  return [
    { id: 1, name: "EN - The Batman (2022)", year: "2022", rating: "7.8", duration: "176 min", category: "EN - Action Movies", added: ADDED_BASE + 300, tmdb: 500, logo: "http://x/batman.jpg" },
    { id: 2, name: "DE - The Batman (2022)", year: "2022", rating: "7.8", duration: "176 min", category: "DE - Action", added: ADDED_BASE + 400, tmdb: 500, logo: "http://x/batman.jpg" },
    { id: 3, name: "Dune: Part Two", year: "2024", rating: "", duration: "166 min", category: "Sci-Fi Movies", added: ADDED_BASE + 500, tmdb: 501, logo: "http://x/dune2.jpg" },
    { id: 4, name: "Amélie", year: "", rating: "8.3", duration: "122 min", category: "Comedy", added: 0, tmdb: null, logo: "" },
    { id: 5, name: "Untitled Dump 4K HDR", year: "not-a-year", rating: "10", duration: "", category: "New Releases", added: ADDED_BASE + 100, tmdb: null },
    { id: 6, name: "Casablanca", year: "1942", rating: "8.5", duration: "102 min", category: "Classics", added: ADDED_BASE + 200, tmdb: 502, logo: "http://x/casa.jpg", vote_average: 8.5, vote_count: 9000 },
  ]
}

describe("buildCatalogIndex", () => {
  it("builds id/meta/group lookups without copying rows", () => {
    const rows = vodFixture()
    const index = buildCatalogIndex("vod", rows, "rev-1")
    expect(index.kind).toBe("vod")
    expect(index.revision).toBe("rev-1")
    expect(index.totalEntries).toBe(6)
    expect(index.totalGroups).toBe(5)
    expect(index.byId.get("1")).toBe(rows[0])
    expect(index.entries).toBe(rows)
    expect(index.groups).toHaveLength(5)
    const batman = index.groupById.get("vod:t:500")!
    expect(batman.variantIds).toEqual(["1", "2"])
    expect(index.groupIdByEntryId.get("2")).toBe("vod:t:500")
  })

  it("computes normalised titles, years, decades, added ms and runtimes once", () => {
    const index = buildCatalogIndex("vod", vodFixture(), "rev-1")
    const batman = index.meta.get("1")!
    expect(batman.normalisedTitle).toBe("the batman")
    expect(batman.year).toBe(2022)
    expect(batman.decade).toBe("2020s")
    expect(batman.addedMs).toBe((ADDED_BASE + 300) * 1000)
    expect(batman.runtimeMinutes).toBe(176)
    expect(batman.languageTag).toBe("EN")
    expect(batman.tmdbId).toBe(500)
    expect(batman.hasPoster).toBe(true)

    const amelie = index.meta.get("4")!
    expect(amelie.normalisedTitle).toBe("amelie")
    expect(amelie.year).toBeNull()
    expect(amelie.decade).toBe("")
    expect(amelie.addedMs).toBeNull()
    expect(amelie.hasPoster).toBe(false)

    const dump = index.meta.get("5")!
    expect(dump.year).toBeNull()
    expect(dump.runtimeMinutes).toBeNull()
    expect(dump.rating?.score10).toBe(10)
    expect(dump.rating?.source).toBe("provider")
  })

  it("extracts the year from the title when the year field is sparse", () => {
    const index = buildCatalogIndex(
      "vod",
      [{ id: 1, name: "Heat (1995)", year: "" }],
      "r1",
    )
    expect(index.meta.get("1")?.year).toBe(1995)
  })

  it("skips rows without usable ids and dedupes duplicate ids (first wins)", () => {
    const index = buildCatalogIndex(
      "vod",
      [
        { id: 1, name: "First" },
        { id: 1, name: "Duplicate" },
        { id: "", name: "No id" },
        { id: null as unknown as number, name: "Null id" },
      ],
      "r1",
    )
    expect(index.totalEntries).toBe(1)
    expect(index.skippedRows).toBe(2)
    expect(index.duplicateIdsSkipped).toBe(1)
    expect(index.byId.get("1")?.name).toBe("First")
  })

  it("counts distinct displayed titles per genre (post-grouping)", () => {
    const index = buildCatalogIndex("vod", vodFixture(), "rev-1")
    const action = index.idsByGenre.get("action")!
    expect(action).toEqual(["1"])
    expect(index.idsByGenre.get(UNCATEGORISED_ID)).toContain("5")
    expect(index.allEntryIdsByGenre.get("action")).toEqual(["1", "2"])
    expect(index.idsByGenre.get("sci-fi")).toEqual(["3"])
  })

  it("indexes provider categories and registers them for providerCategoryInfo", () => {
    const index = buildCatalogIndex("vod", vodFixture(), "rev-1")
    const key = index.meta.get("1")!.providerCategoryKey
    expect(key).toBe("label:en action movies")
    expect(index.idsByProviderCategory.get(key)).toEqual(["1"])
    const info = providerCategoryInfo(key)
    expect(info.rawLabel).toBe("EN - Action Movies")
    expect(info.derivedGenreIds).toEqual(["action"])
  })

  it("keeps numeric provider category ids distinct from labels", () => {
    const index = buildCatalogIndex(
      "vod",
      [{ id: 1, name: "Film", category: "Action", category_id: 42 }],
      "r1",
    )
    expect(index.meta.get("1")?.providerCategoryKey).toBe("id:42")
    expect(providerCategoryInfo("id:42").rawId).toBe("42")
  })

  it("honours verified genre notes over row/category evidence", () => {
    const index = buildCatalogIndex("vod", vodFixture(), "rev-1", {
      genreNotes: { "5": ["horror"] },
    })
    expect(index.meta.get("5")?.genreIds).toEqual(["horror"])
    expect(index.meta.get("5")?.genreProvenance).toBe("verified")
    expect(index.idsByGenre.get("horror")).toEqual(["5"])
  })

  it("provides reusable sorted id indexes with unknown values last", () => {
    const index = buildCatalogIndex("vod", vodFixture(), "rev-1")
    expect(index.sortedIds.catalogue).toEqual(["1", "3", "4", "5", "6"])
    expect(index.sortedIds.added).toEqual(["3", "1", "6", "5", "4"])
    expect(index.sortedIds.yearDesc).toEqual(["3", "1", "6", "4", "5"])
    expect(index.sortedIds.yearAsc).toEqual(["6", "1", "3", "4", "5"])
    expect(index.sortedIds.titleAsc).toEqual(["4", "6", "3", "1", "5"])
    // Rating evidence: Casablanca (TMDb 8.5, 9000 votes) outranks the
    // provider 10 with no votes; unrated Dune: Part Two sorts last.
    const rating = index.sortedIds.rating
    expect(rating[0]).toBe("6")
    expect(rating[rating.length - 1]).toBe("3")
    expect(rating.indexOf("6")).toBeLessThan(rating.indexOf("5"))
    expect(index.sortedIds.runtimeAsc).toEqual(["6", "4", "3", "1", "5"])
  })

  it("aggregates group ratings from the best-evidenced member", () => {
    const index = buildCatalogIndex(
      "vod",
      [
        { id: 1, name: "EN - Split (2016)", tmdb: 9, rating: "6" },
        { id: 2, name: "DE - Split (2016)", tmdb: 9, vote_average: 7.3, vote_count: 4000 },
      ],
      "r1",
    )
    const aggregate = index.groupAggregates.get("vod:t:9")!
    expect(aggregate.rating?.score10).toBe(7.3)
    expect(aggregate.rating?.source).toBe("tmdb")
  })
})

describe("season counts (§15.6 guardrail)", () => {
  it("consumes cached season counts only, via the caller-supplied reader", () => {
    let calls = 0
    const reader = (id: string) => {
      calls++
      return id === "10" ? 4 : null
    }
    const index = buildCatalogIndex(
      "series",
      [
        { id: 10, name: "Reacher", year: "2022" },
        { id: 11, name: "Slow Horses", year: "2022" },
      ],
      "r1",
      { seasonCountReader: reader },
    )
    expect(index.meta.get("10")?.seasonCount).toBe(4)
    expect(index.meta.get("11")?.seasonCount).toBeNull()
    expect(calls).toBe(2)
  })

  it("never reads season counts for movies and tolerates a throwing reader", () => {
    const reader = () => {
      throw new Error("must not be called for vod")
    }
    const index = buildCatalogIndex("vod", [{ id: 1, name: "Film" }], "r1", {
      seasonCountReader: reader,
    })
    expect(index.meta.get("1")?.seasonCount).toBeNull()

    const throwing = () => {
      throw new Error("cache unavailable")
    }
    const series = buildCatalogIndex("series", [{ id: 1, name: "Show" }], "r1", {
      seasonCountReader: throwing,
    })
    expect(series.meta.get("1")?.seasonCount).toBeNull()
  })

  it("reads a season count carried on the row itself", () => {
    const index = buildCatalogIndex(
      "series",
      [{ id: 1, name: "Show", seasonCount: 3 }],
      "r1",
    )
    expect(index.meta.get("1")?.seasonCount).toBe(3)
  })
})

describe("getCatalogIndex caching", () => {
  it("returns the cached index for the same revision + playlist + array", () => {
    const rows = vodFixture()
    const first = getCatalogIndex("vod", rows, "rev-1", { playlistId: "p1" })
    const second = getCatalogIndex("vod", rows, "rev-1", { playlistId: "p1" })
    expect(second).toBe(first)
  })

  it("rebuilds on catalogue revision, metadata revision or playlist change", () => {
    const rows = vodFixture()
    const base = getCatalogIndex("vod", rows, "rev-1", { playlistId: "p1" })
    expect(getCatalogIndex("vod", rows, "rev-2", { playlistId: "p1" })).not.toBe(base)
    expect(
      getCatalogIndex("vod", rows, "rev-1", { playlistId: "p1", metadataRevision: "m2" }),
    ).not.toBe(base)
    expect(getCatalogIndex("vod", rows, "rev-1", { playlistId: "p2" })).not.toBe(base)
    expect(getCatalogIndex("vod", rows, { catalogue: "rev-1", metadata: "m1" })).not.toBe(base)
  })

  it("rebuilds when the catalogue array identity changes", () => {
    const first = getCatalogIndex("vod", vodFixture(), "rev-1")
    const second = getCatalogIndex("vod", vodFixture(), "rev-1")
    expect(second).not.toBe(first)
    expect(second.totalEntries).toBe(first.totalEntries)
  })

  it("rebuilds after invalidateCatalogIndex for the kind only", () => {
    const rows = vodFixture()
    const vod = getCatalogIndex("vod", rows, "rev-1")
    const series = getCatalogIndex("series", rows, "rev-1")
    invalidateCatalogIndex("vod")
    expect(getCatalogIndex("vod", rows, "rev-1")).not.toBe(vod)
    expect(getCatalogIndex("series", rows, "rev-1")).toBe(series)
    invalidateCatalogIndex()
    expect(getCatalogIndex("series", rows, "rev-1")).not.toBe(series)
  })

  it("accepts kind aliases and rejects unknown kinds", () => {
    expect(getCatalogIndex("movie", [], "r1").kind).toBe("vod")
    expect(getCatalogIndex("tv", [], "r1").kind).toBe("series")
    expect(() => getCatalogIndex("live", [], "r1")).toThrow()
  })
})

describe("createProfileLayer", () => {
  it("layers profile state separately from the provider index", () => {
    const rows = vodFixture()
    const index = getCatalogIndex("vod", rows, "rev-1")
    const layer = createProfileLayer(
      {
        progress: { "1": { fraction: 0.5, updatedAt: 123 } },
        favouriteIds: [3, "6"],
        watchLaterIds: ["4"],
      },
      "profile-7",
    )
    expect(layer.revision).toBe("profile-7")
    expect(layer.progressById.get("1")).toEqual({
      fraction: 0.5,
      completed: false,
      updatedAt: 123,
      seriesId: null,
    })
    expect(layer.favouriteIds).toEqual(new Set(["3", "6"]))
    expect(layer.watchLaterIds).toEqual(new Set(["4"]))
    // Changing profile state never rebuilds the provider index.
    expect(getCatalogIndex("vod", rows, "rev-1")).toBe(index)
  })

  it("clamps fractions and accepts Map inputs", () => {
    const layer = createProfileLayer({
      progress: new Map([["1", { fraction: 2, completed: true }]]),
    })
    expect(layer.progressById.get("1")?.fraction).toBe(1)
    expect(layer.revision).toBe("")
  })
})
