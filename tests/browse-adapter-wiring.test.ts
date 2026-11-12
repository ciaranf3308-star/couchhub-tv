/**
 * @vitest-environment jsdom
 */
// Movies / Series adapter wiring tests (0.11.5, W4).
//
// Proves the adapters route natural-language search through the
// shared relevance engine (browse-recommendations.ts) while plain
// title/genre queries keep the exact substring matcher:
//
//   - NL query ("something intense for tonight") → mood/text
//     relevance search, kind-scoped, relevance order preserved by
//     applySort.
//   - Plain query ("star voyage") → unchanged substring behaviour.
//   - No AI request anywhere on these paths (local only).
//
// jsdom + in-memory storage stubs, same approach as
// tests/couch-browse-pillfest.test.ts. Fake rows only — no provider,
// no catalogue load.

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { MovieRow } from "@/scripts/movies/couch-movies"
import type { SeriesRow } from "@/scripts/series/couch-series"
import type { CouchBrowseFilter } from "@/scripts/movies/couch-browse"

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

Object.defineProperty(window, "sessionStorage", { value: makeStorage() })
Object.defineProperty(window, "localStorage", { value: makeStorage() })
window.scrollTo = () => {}

const { moviesAdapter } = await import("@/scripts/movies/couch-movies-adapter.ts")
const { seriesAdapter } = await import("@/scripts/series/couch-series-adapter.ts")

function movieRow(overrides: Partial<MovieRow> = {}): MovieRow {
  return {
    id: 1,
    name: "Test Film",
    logo: null,
    year: "2024",
    rating: "8.4",
    duration: "125",
    category: "Action",
    plot: "",
    added: 100,
    norm: "test film action 2024",
    tmdb: null,
    ...overrides,
  }
}

function seriesRow(overrides: Partial<SeriesRow> = {}): SeriesRow {
  return {
    id: 1,
    name: "Test Show",
    logo: null,
    year: "2024",
    rating: "8.4",
    category: "Drama",
    plot: "",
    added: 100,
    norm: "test show drama 2024",
    tmdb: null,
    ...overrides,
  }
}

const MOVIE_ROWS: MovieRow[] = [
  movieRow({ id: 1, name: "Alpha Strike", year: "2024", rating: "8.4", added: 300, category: "Action", norm: "alpha strike action 2024" }),
  movieRow({ id: 2, name: "Beta Drama", year: "1998", rating: "6.1", added: 100, category: "Drama", norm: "beta drama 1998" }),
  movieRow({ id: 3, name: "Gamma Heist", year: "2020", rating: "7.7", added: 200, category: "Thriller", norm: "gamma heist thriller 2020" }),
  movieRow({ id: 4, name: "Delta Laughs", year: "2015", rating: "7.2", added: 250, category: "Comedy", norm: "delta laughs comedy 2015" }),
]

const SERIES_ROWS: SeriesRow[] = [
  seriesRow({ id: 11, name: "Alpha Strike: The Series", year: "2024", rating: "8.1", added: 300, category: "Action", norm: "alpha strike the series action 2024" }),
  seriesRow({ id: 12, name: "Beta Drama", year: "1998", rating: "6.1", added: 100, category: "Drama", norm: "beta drama 1998" }),
  seriesRow({ id: 13, name: "Gamma Heist", year: "2020", rating: "7.7", added: 200, category: "Thriller", norm: "gamma heist thriller 2020" }),
]

function filter(query: string, list: CouchBrowseFilter["list"] = "all"): CouchBrowseFilter {
  return { query, genre: "", year: "", minRating: 0, maxRuntime: 0, sort: "default", list }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe("moviesAdapter search wiring", () => {
  it("routes a natural-language question through the relevance engine (intense movies only)", () => {
    const out = moviesAdapter.applyFilter(MOVIE_ROWS, filter("something intense for tonight"), "pl1")
    expect(out.map((r) => r.id).sort()).toEqual([1, 3])
    expect(out.every((r) => ["Action", "Thriller"].includes(r.category))).toBe(true)
  })

  it("keeps plain title search on the unchanged substring matcher", () => {
    const out = moviesAdapter.applyFilter(MOVIE_ROWS, filter("alpha strike"), "pl1")
    expect(out.map((r) => r.id)).toEqual([1])
    const none = moviesAdapter.applyFilter(MOVIE_ROWS, filter("zzz no such title"), "pl1")
    expect(none).toEqual([])
  })

  it("applySort preserves relevance order for NL queries and sorts normally otherwise", () => {
    const ranked = moviesAdapter.applyFilter(MOVIE_ROWS, filter("something intense for tonight"), "pl1")
    expect(moviesAdapter.applySort(ranked, filter("something intense for tonight"))).toEqual(ranked)
    const sorted = moviesAdapter.applySort(MOVIE_ROWS, filter(""))
    // "default" keeps catalogue (input) order.
    expect(sorted.map((r) => r.name)).toEqual([
      "Alpha Strike",
      "Beta Drama",
      "Gamma Heist",
      "Delta Laughs",
    ])
  })

  it("still applies the other filters on top of a relevance search", () => {
    const out = moviesAdapter.applyFilter(
      MOVIE_ROWS,
      { ...filter("something intense for tonight"), minRating: 8 },
      "pl1",
    )
    expect(out.map((r) => r.id)).toEqual([1])
  })
})

describe("seriesAdapter search wiring", () => {
  it("routes a natural-language question through the relevance engine, series-scoped", () => {
    const out = seriesAdapter.applyFilter(SERIES_ROWS, filter("something intense for tonight"), "pl1")
    expect(out.map((r) => r.id).sort()).toEqual([11, 13])
    expect(out.every((r) => ["Action", "Thriller"].includes(r.category))).toBe(true)
  })

  it("keeps plain title search on the unchanged substring matcher", () => {
    const out = seriesAdapter.applyFilter(SERIES_ROWS, filter("gamma heist"), "pl1")
    expect(out.map((r) => r.id)).toEqual([13])
  })

  it("applySort preserves relevance order for NL queries", () => {
    const ranked = seriesAdapter.applyFilter(SERIES_ROWS, filter("something intense for tonight"), "pl1")
    expect(seriesAdapter.applySort(ranked, filter("something intense for tonight"))).toEqual(ranked)
  })
})
