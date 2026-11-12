import { describe, it, expect, beforeEach } from "vitest"
import {
  CANONICAL_MOVIE_GENRES,
  CANONICAL_SERIES_GENRES,
  UNCATEGORISED_ID,
  genresForEntry,
  genresForEntryWithEvidence,
  providerCategoryInfo,
  registerProviderCategory,
  clearProviderCategoryRegistry,
  seriesFamiliesForTmdbIds,
  seriesFamiliesForGenreIds,
  parseSeriesGenreString,
  genreLabelForId,
  isKindOnlyCategory,
  genresForTmdbIds,
} from "@/scripts/lib/genres.ts"
import { buildFamilyIndexFromRows } from "@/scripts/lib/genre-index.ts"

describe("canonical taxonomies (brief §5)", () => {
  it("defines 18 movie genres in brief order with Science Fiction as the one label", () => {
    expect(CANONICAL_MOVIE_GENRES.map((g) => g.label)).toEqual([
      "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
      "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
      "Romance", "Science Fiction", "Thriller", "War", "Western",
    ])
    expect(CANONICAL_MOVIE_GENRES.find((g) => g.id === "sci-fi")?.label).toBe("Science Fiction")
    expect(CANONICAL_MOVIE_GENRES.filter((g) => g.label === "Sci-Fi")).toHaveLength(0)
    for (const genre of CANONICAL_MOVIE_GENRES) {
      expect(genre.id).toBeTruthy()
      expect(Array.isArray(genre.aliases)).toBe(true)
    }
  })

  it("defines 15 series families with combined genres as aliases", () => {
    expect(CANONICAL_SERIES_GENRES.map((f) => f.label)).toEqual([
      "Action & Adventure", "Animation", "Comedy", "Crime", "Documentary",
      "Drama", "Family", "Kids", "Mystery", "Reality",
      "Science Fiction & Fantasy", "Soap", "Talk", "War & Politics", "Western",
    ])
    const actionAdventure = CANONICAL_SERIES_GENRES.find((f) => f.id === "action-adventure")!
    expect(actionAdventure.memberGenreIds).toEqual(["action", "adventure"])
    expect(actionAdventure.tmdbTvIds).toEqual([10759])
    const sciFiFantasy = CANONICAL_SERIES_GENRES.find((f) => f.id === "sci-fi-fantasy")!
    expect(sciFiFantasy.memberGenreIds).toEqual(["sci-fi", "fantasy"])
    expect(sciFiFantasy.tmdbTvIds).toEqual([10765])
  })

  it("exposes the uncategorised bucket id", () => {
    expect(UNCATEGORISED_ID).toBe("uncategorised")
  })

  it("resolves display labels per kind", () => {
    expect(genreLabelForId("sci-fi", "vod")).toBe("Science Fiction")
    expect(genreLabelForId("sci-fi-fantasy", "series")).toBe("Science Fiction & Fantasy")
    expect(genreLabelForId("nope", "vod")).toBe("nope")
  })
})

describe("series family mappings", () => {
  it("maps TMDb TV ids to families, including TV-only families", () => {
    expect(seriesFamiliesForTmdbIds([10759])).toEqual(["action-adventure"])
    expect(seriesFamiliesForTmdbIds([10765])).toEqual(["sci-fi-fantasy"])
    expect(seriesFamiliesForTmdbIds([10762])).toEqual(["kids"])
    expect(seriesFamiliesForTmdbIds([10764])).toEqual(["reality"])
    expect(seriesFamiliesForTmdbIds([10766])).toEqual(["soap"])
    expect(seriesFamiliesForTmdbIds([10767])).toEqual(["talk"])
    expect(seriesFamiliesForTmdbIds([10768])).toEqual(["war-politics"])
    expect(seriesFamiliesForTmdbIds([16])).toEqual(["animation"])
    expect(seriesFamiliesForTmdbIds([10763])).toEqual([])
    expect(seriesFamiliesForTmdbIds([10770])).toEqual([])
  })

  it("does not leak Kids into Family (unlike the legacy TV map)", () => {
    expect(genresForTmdbIds("series", [10762])).toEqual(["family"])
    expect(seriesFamiliesForTmdbIds([10762])).not.toContain("family")
  })

  it("expands canonical genre ids to families", () => {
    expect(seriesFamiliesForGenreIds(["action"])).toEqual(["action-adventure"])
    expect(seriesFamiliesForGenreIds(["sci-fi", "fantasy"])).toEqual(["sci-fi-fantasy"])
    expect(seriesFamiliesForGenreIds(["war"])).toEqual(["war-politics"])
    expect(seriesFamiliesForGenreIds(["drama", "mystery"])).toEqual(["drama", "mystery"])
  })

  it("parses series genre strings including TV-only phrases", () => {
    expect(parseSeriesGenreString("Kids")).toEqual(["kids"])
    expect(parseSeriesGenreString("Reality TV")).toEqual(["reality"])
    expect(parseSeriesGenreString("Action & Adventure")).toEqual(["action-adventure"])
    expect(parseSeriesGenreString("Soap Opera")).toEqual(["soap"])
    expect(parseSeriesGenreString("Talk Show")).toEqual(["talk"])
    expect(parseSeriesGenreString("War & Politics")).toEqual(["war-politics"])
  })
})

describe("genresForEntry evidence precedence", () => {
  it("prefers verified TMDb ids over the provider category (no union on top)", () => {
    expect(
      genresForEntry({ genre_ids: [27], category: "Comedy Movies" }, "vod"),
    ).toEqual(["horror"])
  })

  it("uses verified enrichment names over provider data", () => {
    expect(
      genresForEntry({ enrichmentGenres: ["Science Fiction"], genre: "Comedy" }, "vod"),
    ).toEqual(["sci-fi"])
  })

  it("falls back to the provider genre string (genres are not exclusive)", () => {
    expect(genresForEntry({ genre: "Action, Crime, Comedy" }, "vod")).toEqual([
      "action", "comedy", "crime",
    ])
  })

  it("falls back to the provider category label", () => {
    expect(genresForEntry({ category: "Horror Movies" }, "vod")).toEqual(["horror"])
  })

  it("never classifies from a kind-only provider category", () => {
    for (const category of ["Series", "TV Shows", "TV Series", "EN | Series", "Movies", "VOD"]) {
      expect(genresForEntry({ category }, "series")).toEqual([])
      expect(genresForEntry({ category }, "vod")).toEqual([])
    }
    expect(isKindOnlyCategory("Series")).toBe(true)
    expect(isKindOnlyCategory("Drama Series")).toBe(false)
  })

  it("maps series entries to families, not movie ids", () => {
    expect(genresForEntry({ genre: "Action" }, "series")).toEqual(["action-adventure"])
    expect(genresForEntry({ genre_ids: [10759] }, "series")).toEqual(["action-adventure"])
    expect(genresForEntry({ genre: "Drama" }, "series")).toEqual(["drama"])
    expect(genresForEntry({ genre: "Science Fiction" }, "series")).toEqual(["sci-fi-fantasy"])
  })

  it("resolves kind from an index-like object and from entry fields", () => {
    expect(genresForEntry({ genre: "Action" }, { kind: "series" })).toEqual(["action-adventure"])
    expect(genresForEntry({ genre: "Action", type: "series" })).toEqual(["action-adventure"])
    expect(genresForEntry({ genre: "Action", kind: "movie" })).toEqual(["action"])
  })

  it("returns [] with provenance none when there is no evidence", () => {
    expect(genresForEntry({ name: "Untitled" }, "vod")).toEqual([])
    expect(genresForEntry(null, "vod")).toEqual([])
    const result = genresForEntryWithEvidence({ category: "New Releases" }, "vod")
    expect(result).toEqual({ genreIds: [], provenance: "none", confidence: "low" })
  })

  it("reports provenance tiers", () => {
    expect(genresForEntryWithEvidence({ genre_ids: [35] }, "vod").provenance).toBe("verified")
    expect(genresForEntryWithEvidence({ genre: "Comedy" }, "vod").provenance).toBe("provider")
    expect(genresForEntryWithEvidence({ category: "Comedy" }, "vod").provenance).toBe("category")
  })
})

describe("providerCategoryInfo", () => {
  beforeEach(() => clearProviderCategoryRegistry())

  it("preserves the raw id and label of a registered category", () => {
    registerProviderCategory("id:42", 42, "EN - Horror Movies")
    const info = providerCategoryInfo("id:42")
    expect(info.rawId).toBe("42")
    expect(info.rawLabel).toBe("EN - Horror Movies")
    expect(info.normalisedLabel).toBe("en horror movies")
    expect(info.derivedGenreIds).toEqual(["horror"])
    expect(info.provenance).toBe("provider-category")
    expect(info.confidence).toBe("low")
  })

  it("derives from an unregistered label without inventing an id", () => {
    const info = providerCategoryInfo("FR - Comédie")
    expect(info.rawLabel).toBe("FR - Comédie")
    expect(info.derivedGenreIds).toEqual(["comedy"])
    expect(info.provenance).toBe("unregistered-label")
  })

  it("never invents a label or genres for an unknown numeric id", () => {
    const info = providerCategoryInfo("id:9999")
    expect(info.rawId).toBe("9999")
    expect(info.rawLabel).toBe("")
    expect(info.derivedGenreIds).toEqual([])
  })

  it("derives no genres from a kind-only label", () => {
    expect(providerCategoryInfo("TV Shows").derivedGenreIds).toEqual([])
  })
})

describe("buildFamilyIndexFromRows", () => {
  it("builds kind-aware family sets with an uncategorised bucket", () => {
    const index = buildFamilyIndexFromRows(
      [
        { id: 1, category: "", genre: "Action" },
        { id: 2, category: "Series", genre: "" },
        { id: 3, category: "Kids Shows", genre: "" },
      ],
      "series",
    )
    expect(index.sets.get("action-adventure")).toEqual(new Set([1]))
    expect(index.sets.get("kids")).toEqual(new Set([3]))
    expect(index.uncategorised).toEqual(new Set([2]))
    expect(index.classifiedCount).toBe(2)
    expect(index.totalCount).toBe(3)
  })

  it("builds movie-genre sets for vod rows", () => {
    const index = buildFamilyIndexFromRows(
      [{ id: 1, category: "Sci-Fi Movies", genre: "" }],
      "vod",
    )
    expect(index.sets.get("sci-fi")).toEqual(new Set([1]))
    expect(index.uncategorised.size).toBe(0)
  })
})
