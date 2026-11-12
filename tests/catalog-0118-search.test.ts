import { describe, it, expect, beforeEach } from "vitest"
import { buildCatalogIndex, type CatalogRow } from "@/scripts/lib/catalog-index.ts"
import { invalidateCatalogIndex } from "@/scripts/lib/catalog-index.ts"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups.ts"
import { searchCatalogIndex } from "@/scripts/lib/catalog-index.ts"

beforeEach(() => {
  invalidateCatalogIndex()
  clearTitleGroupRegistry()
})

function fixture() {
  const rows: CatalogRow[] = [
    { id: 1, name: "Dune (2021)", year: "2021", category: "Sci-Fi Movies", tmdb: 101 },
    { id: 2, name: "Dune: Part Two (2024)", year: "2024", category: "Sci-Fi Movies", tmdb: 102 },
    { id: 3, name: "EN - The Batman (2022)", year: "2022", category: "Action Movies", tmdb: 103 },
    { id: 4, name: "Amélie", year: "2001", category: "Comedy", tmdb: 104 },
    { id: 5, name: "The Godfather", year: "1972", category: "Crime", tmdb: 105, original_title: "Il Padrino" },
    { id: 6, name: "Heat 4K HDR", year: "1995", category: "Action Movies", tmdb: 106 },
  ]
  return buildCatalogIndex("vod", rows, "r1")
}

describe("searchCatalogIndex", () => {
  it("matches full and partial titles, ignoring provider prefixes and quality suffixes", () => {
    const index = fixture()
    expect(searchCatalogIndex(index, "Batman", null)).toEqual(["3"])
    expect(searchCatalogIndex(index, "Heat", null)).toEqual(["6"])
    expect(searchCatalogIndex(index, "Godfather", null)).toEqual(["5"])
    expect(searchCatalogIndex(index, "Dune", null)).toEqual(["1", "2"])
  })

  it("normalises punctuation and diacritics", () => {
    const index = fixture()
    // Full match first; the first film still matches partially (shared token).
    expect(searchCatalogIndex(index, "dune part two", null)).toEqual(["2", "1"])
    expect(searchCatalogIndex(index, "amelie", null)).toEqual(["4"])
    expect(searchCatalogIndex(index, "Amélie!", null)).toEqual(["4"])
  })

  it("matches alternative/original titles", () => {
    const index = fixture()
    expect(searchCatalogIndex(index, "Padrino", null)).toEqual(["5"])
  })

  it("uses a query year to disambiguate without excluding strong title matches", () => {
    const index = fixture()
    expect(searchCatalogIndex(index, "Dune 2021", null)).toEqual(["1", "2"])
    expect(searchCatalogIndex(index, "Dune 2024", null)).toEqual(["2", "1"])
  })

  it("answers year-only queries with exact-year groups", () => {
    const index = fixture()
    expect(searchCatalogIndex(index, "2021", null)).toEqual(["1"])
    expect(searchCatalogIndex(index, "1995", null)).toEqual(["6"])
  })

  it("scopes results to a genre and returns [] for empty queries", () => {
    const index = fixture()
    expect(searchCatalogIndex(index, "Batman", { genreId: "action" })).toEqual(["3"])
    expect(searchCatalogIndex(index, "Batman", { genreId: "crime" })).toEqual([])
    expect(searchCatalogIndex(index, "Godfather", { genreId: "crime" })).toEqual(["5"])
    expect(searchCatalogIndex(index, "", null)).toEqual([])
    expect(searchCatalogIndex(index, "   ", null)).toEqual([])
    expect(searchCatalogIndex(index, "zzzznope", null)).toEqual([])
  })

  it("returns displayed group primaries once, honouring the limit", () => {
    const index = buildCatalogIndex(
      "vod",
      [
        { id: 1, name: "EN - Heat (1995)", tmdb: 9 },
        { id: 2, name: "DE - Heat (1995)", tmdb: 9 },
        { id: 3, name: "Heat 2 (1996)", tmdb: 10 },
      ],
      "r1",
    )
    expect(searchCatalogIndex(index, "Heat", null)).toEqual(["1", "3"])
    expect(searchCatalogIndex(index, "Heat", null, 1)).toEqual(["1"])
  })
})
