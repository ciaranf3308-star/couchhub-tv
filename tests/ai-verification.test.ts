// AI Discovery 3.0 (0.11.6) W2 — TMDb verification + catalogue matching.
// All TMDb access is injected fakes: no key, no network. The matcher,
// normalisation, cache and concurrency limiter run for real.
import { describe, it, expect, beforeEach, vi } from "vitest"

const tmdbState = vi.hoisted(() => ({ active: true, key: "test-tmdb-key" }))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getTmdbApiKey: () => tmdbState.key,
  isTmdbActive: () => tmdbState.active,
}))

vi.mock("@/scripts/lib/i18n.js", () => ({
  getActiveLocale: () => "en",
}))

import {
  clearVerificationCache,
  defaultTmdbSearch,
  matchVerifiedTitleToCatalog,
  pickVerifiedTmdbMatch,
  verifyRecommendations,
  type GeneratedRecommendation,
  type TmdbSearchFn,
  type VerificationDetails,
} from "@/scripts/lib/ai/verification"
import type { DiscoverCandidate } from "@/scripts/lib/discover.ts"
import type { TmdbSearchResult } from "@/scripts/lib/tmdb.ts"

beforeEach(() => {
  clearVerificationCache()
  tmdbState.active = true
  tmdbState.key = "test-tmdb-key"
})

function rec(overrides: Partial<GeneratedRecommendation> = {}): GeneratedRecommendation {
  return {
    title: "Dune",
    year: 2021,
    kind: "movie",
    reason: "Epic sci-fi.",
    tone: "sweeping",
    ...overrides,
  }
}

function movieResult(overrides: Partial<TmdbSearchResult> = {}): TmdbSearchResult {
  return {
    id: 1,
    title: "Dune",
    release_date: "2021-10-22",
    vote_count: 5000,
    popularity: 90,
    poster_path: "/dune-poster.jpg",
    backdrop_path: "/dune-backdrop.jpg",
    overview: "Paul Atreides leads a desert planet revolt.",
    ...overrides,
  }
}

function tvResult(overrides: Partial<TmdbSearchResult> = {}): TmdbSearchResult {
  return {
    id: 10,
    name: "Dark",
    first_air_date: "2017-12-01",
    vote_count: 3000,
    popularity: 80,
    poster_path: "/dark-poster.jpg",
    overview: "A missing child exposes a town's secrets.",
    ...overrides,
  }
}

function candidate(overrides: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    id: "101",
    kind: "movie",
    title: "Dune",
    year: 2021,
    genres: ["Science Fiction"],
    cast: [],
    source: "catalog",
    ...overrides,
  }
}

/** Fake search backed by a per-title result map (keyed by exact query title). */
function searchFrom(resultsByTitle: Record<string, TmdbSearchResult[]>): TmdbSearchFn {
  return async ({ title }) => resultsByTitle[title] ?? []
}

function details(overrides: Partial<VerificationDetails> = {}): VerificationDetails {
  return {
    genres: ["Science Fiction", "Adventure"],
    synopsis: "Detailed synopsis from TMDb.",
    posterUrl: "https://image.tmdb.org/t/p/w500/detail-poster.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/detail-backdrop.jpg",
    alternativeTitles: [],
    ...overrides,
  }
}

describe("pickVerifiedTmdbMatch", () => {
  it("matches on the original title when the localised title differs", () => {
    const outcome = pickVerifiedTmdbMatch(
      [movieResult({ id: 5, title: "The Intouchables", original_title: "Intouchables" })],
      rec({ title: "Intouchables", year: 2011 })
    )
    expect(outcome.status).toBe("match")
    if (outcome.status === "match") expect(outcome.result.id).toBe(5)
  })

  it("is ambiguous when the year is unknown and several same-named titles exist", () => {
    const outcome = pickVerifiedTmdbMatch(
      [
        movieResult({ id: 20, title: "The Thing", release_date: "1982-06-25" }),
        movieResult({ id: 21, title: "The Thing", release_date: "2011-10-14" }),
      ],
      rec({ title: "The Thing", year: null })
    )
    expect(outcome.status).toBe("ambiguous")
  })

  it("uses the exact year to disambiguate same-named films", () => {
    const outcome = pickVerifiedTmdbMatch(
      [
        movieResult({ id: 20, title: "The Thing", release_date: "1982-06-25" }),
        movieResult({ id: 21, title: "The Thing", release_date: "2011-10-14" }),
      ],
      rec({ title: "The Thing", year: 2011 })
    )
    expect(outcome.status).toBe("match")
    if (outcome.status === "match") expect(outcome.result.id).toBe(21)
  })

  it("returns none when no result shares the exact title", () => {
    const outcome = pickVerifiedTmdbMatch(
      [movieResult({ id: 30, title: "Dune: Part Two", release_date: "2024-03-01" })],
      rec({ title: "Dune", year: 2021 })
    )
    expect(outcome.status).toBe("none")
  })
})

describe("verifyRecommendations — identity", () => {
  it("verifies a confident match and takes title/year from TMDb", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: searchFrom({ Dune: [movieResult()] }),
      catalogue: [],
    })
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(1)
    expect(out.title).toBe("Dune")
    expect(out.year).toBe(2021)
    expect(out.kind).toBe("movie")
    expect(out.reason).toBe("Epic sci-fi.")
    expect(out.match).toBeNull()
  })

  it("corrects a wrong model year from TMDb and says so", async () => {
    const [out] = await verifyRecommendations([rec({ year: 2000 })], {
      searchTmdb: searchFrom({ Dune: [movieResult()] }),
      catalogue: [],
    })
    expect(out.verified).toBe(true)
    expect(out.year).toBe(2021)
    expect(out.verificationNote).toContain("2021")
    expect(out.verificationNote).toContain("2000")
  })

  it("searches the TV endpoint for series and reads series fields", async () => {
    const search = vi.fn(async () => [tvResult()])
    const [out] = await verifyRecommendations(
      [rec({ title: "Dark", year: 2017, kind: "series" })],
      { searchTmdb: search, catalogue: [] }
    )
    expect(search).toHaveBeenCalledWith({ title: "Dark", kind: "series", year: 2017 })
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(10)
    expect(out.title).toBe("Dark")
    expect(out.year).toBe(2017)
  })

  it("marks no-match unverified with an honest note and no catalogue match", async () => {
    const [out] = await verifyRecommendations([rec({ title: "No Such Film Ever" })], {
      searchTmdb: searchFrom({}),
      catalogue: [candidate({ title: "No Such Film Ever" })],
    })
    expect(out.verified).toBe(false)
    expect(out.tmdbId).toBeNull()
    expect(out.title).toBe("No Such Film Ever")
    expect(out.verificationNote).toMatch(/No confident TMDb match/)
    expect(out.match).toBeNull()
    expect(out.genres).toEqual([])
    expect(out.posterUrl).toBeNull()
  })

  it("marks ambiguous same-named titles unverified instead of guessing", async () => {
    const [out] = await verifyRecommendations([rec({ title: "The Thing", year: null })], {
      searchTmdb: searchFrom({
        "The Thing": [
          movieResult({ id: 20, title: "The Thing", release_date: "1982-06-25" }),
          movieResult({ id: 21, title: "The Thing", release_date: "2011-10-14" }),
        ],
      }),
      catalogue: [],
    })
    expect(out.verified).toBe(false)
    expect(out.verificationNote).toMatch(/Several TMDb titles share this name/)
  })

  it("uses search poster/backdrop/synopsis when no details fetch is wired", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: searchFrom({ Dune: [movieResult()] }),
      catalogue: [],
    })
    expect(out.posterUrl).toBe("https://image.tmdb.org/t/p/w500/dune-poster.jpg")
    expect(out.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/dune-backdrop.jpg")
    expect(out.synopsis).toBe("Paul Atreides leads a desert planet revolt.")
    expect(out.genres).toEqual([])
  })

  it("enriches genres/backdrop/synopsis from the details fetch", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: searchFrom({ Dune: [movieResult()] }),
      catalogue: [],
      fetchDetails: async () => details(),
    })
    expect(out.genres).toEqual(["Science Fiction", "Adventure"])
    expect(out.synopsis).toBe("Detailed synopsis from TMDb.")
    expect(out.posterUrl).toBe("https://image.tmdb.org/t/p/w500/detail-poster.jpg")
    expect(out.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/detail-backdrop.jpg")
  })

  it("stays verified when the details fetch fails, with a note", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: searchFrom({ Dune: [movieResult()] }),
      catalogue: [],
      fetchDetails: async () => {
        throw new Error("boom")
      },
    })
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(1)
    expect(out.genres).toEqual([])
    expect(out.posterUrl).toBe("https://image.tmdb.org/t/p/w500/dune-poster.jpg")
    expect(out.verificationNote).toMatch(/details were unavailable/)
  })

  it("does not search for an empty title", async () => {
    const search = vi.fn(async () => [movieResult()])
    const [out] = await verifyRecommendations([rec({ title: "   " })], {
      searchTmdb: search,
      catalogue: [],
    })
    expect(out.verified).toBe(false)
    expect(search).not.toHaveBeenCalled()
  })
})

describe("verifyRecommendations — external ids", () => {
  it("rejects a wrong external id and verifies by title/year", async () => {
    const [out] = await verifyRecommendations(
      [rec({ externalId: { source: "imdb", id: "tt9999999" } })],
      {
        searchTmdb: searchFrom({ Dune: [movieResult()] }),
        catalogue: [],
        resolveExternalId: async () => ({ tmdbId: 99, title: "Other Film", year: 1999 }),
      }
    )
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(1)
    expect(out.verificationNote).toMatch(/external ID.*ignored/)
  })

  it("ignores an unresolvable external id and verifies by title/year", async () => {
    const [out] = await verifyRecommendations(
      [rec({ externalId: { source: "imdb", id: "tt0000000" } })],
      {
        searchTmdb: searchFrom({ Dune: [movieResult()] }),
        catalogue: [],
        resolveExternalId: async () => null,
      }
    )
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(1)
  })

  it("ignores external ids entirely when no resolver is wired (never trusted)", async () => {
    const [out] = await verifyRecommendations(
      [rec({ externalId: { source: "tmdb", id: "999" } })],
      {
        searchTmdb: searchFrom({ Dune: [movieResult()] }),
        catalogue: [],
      }
    )
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(1)
  })

  it("marks conflicting external-id vs title identities unverified", async () => {
    const [out] = await verifyRecommendations(
      [rec({ externalId: { source: "imdb", id: "tt1234567" } })],
      {
        searchTmdb: searchFrom({ Dune: [movieResult({ id: 1 })] }),
        catalogue: [],
        resolveExternalId: async () => ({ tmdbId: 55, title: "Dune", year: 2021 }),
      }
    )
    expect(out.verified).toBe(false)
    expect(out.verificationNote).toMatch(/Conflicting identities/)
  })

  it("lets a title-agreeing external id disambiguate same-named titles", async () => {
    const [out] = await verifyRecommendations(
      [rec({ title: "The Thing", year: null, externalId: { source: "imdb", id: "tt0084787" } })],
      {
        searchTmdb: searchFrom({
          "The Thing": [
            movieResult({ id: 20, title: "The Thing", release_date: "1982-06-25" }),
            movieResult({ id: 21, title: "The Thing", release_date: "2011-10-14" }),
          ],
        }),
        catalogue: [],
        resolveExternalId: async () => ({ tmdbId: 20, title: "The Thing", year: 1982 }),
      }
    )
    expect(out.verified).toBe(true)
    expect(out.tmdbId).toBe(20)
    expect(out.year).toBe(1982)
  })
})

describe("verifyRecommendations — failure behaviour", () => {
  it("marks a failed search unverified with a note and continues the batch", async () => {
    const search: TmdbSearchFn = async ({ title }) => {
      if (title === "Bad Film") throw new Error("network down")
      return [movieResult({ title: "Good Film" })]
    }
    const results = await verifyRecommendations(
      [rec({ title: "Bad Film", year: null }), rec({ title: "Good Film", year: null })],
      { searchTmdb: search, catalogue: [] }
    )
    expect(results).toHaveLength(2)
    expect(results[0].verified).toBe(false)
    expect(results[0].verificationNote).toMatch(/verification failed/)
    expect(results[1].verified).toBe(true)
    expect(results[1].title).toBe("Good Film")
  })

  it("reports TMDb not configured honestly when the default search has no key", async () => {
    tmdbState.active = false
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: defaultTmdbSearch(),
      catalogue: [],
    })
    expect(out.verified).toBe(false)
    expect(out.verificationNote).toMatch(/not configured/)
  })

  it("verifies against an empty catalogue with all matches null (Test J)", async () => {
    const results = await verifyRecommendations([rec()], {
      searchTmdb: searchFrom({ Dune: [movieResult()] }),
      catalogue: [],
    })
    expect(results[0].verified).toBe(true)
    expect(results[0].match).toBeNull()
  })
})

describe("verifyRecommendations — caching", () => {
  it("reuses a cached identity: a second identical verification makes zero new search calls", async () => {
    const search = vi.fn(searchFrom({ Dune: [movieResult()] }))
    const deps = { searchTmdb: search, catalogue: [] as DiscoverCandidate[] }
    await verifyRecommendations([rec()], deps)
    expect(search).toHaveBeenCalledTimes(1)
    await verifyRecommendations([rec()], deps)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("caches authoritative no-matches but never caches failures", async () => {
    const noMatchSearch = vi.fn(searchFrom({}))
    await verifyRecommendations([rec({ title: "No Such Film Ever" })], {
      searchTmdb: noMatchSearch,
      catalogue: [],
    })
    await verifyRecommendations([rec({ title: "No Such Film Ever" })], {
      searchTmdb: noMatchSearch,
      catalogue: [],
    })
    expect(noMatchSearch).toHaveBeenCalledTimes(1)

    const failingSearch = vi.fn(async () => {
      throw new Error("network down")
    })
    await verifyRecommendations([rec({ title: "Flaky Film" })], {
      searchTmdb: failingSearch,
      catalogue: [],
    })
    await verifyRecommendations([rec({ title: "Flaky Film" })], {
      searchTmdb: failingSearch,
      catalogue: [],
    })
    expect(failingSearch).toHaveBeenCalledTimes(2)
  })

  it("matching stays fresh: a cached identity matches a catalogue it has never seen", async () => {
    const search = vi.fn(searchFrom({ Dune: [movieResult()] }))
    const first = await verifyRecommendations([rec()], { searchTmdb: search, catalogue: [] })
    expect(first[0].match).toBeNull()
    const second = await verifyRecommendations([rec()], {
      searchTmdb: search,
      catalogue: [candidate({ id: "77" })],
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(second[0].match?.catalogueKey).toBe("movie:77")
  })

  it("enriches a cached search-only identity with details without a new search", async () => {
    const search = vi.fn(searchFrom({ Dune: [movieResult()] }))
    await verifyRecommendations([rec()], { searchTmdb: search, catalogue: [] })
    const fetchDetails = vi.fn(async () => details())
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: search,
      catalogue: [],
      fetchDetails,
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(fetchDetails).toHaveBeenCalledTimes(1)
    expect(out.genres).toEqual(["Science Fiction", "Adventure"])
  })

  it("dedupes identical titles inside one batch to a single search", async () => {
    const search = vi.fn(searchFrom({ Dune: [movieResult()] }))
    const results = await verifyRecommendations([rec(), rec()], {
      searchTmdb: search,
      catalogue: [],
    })
    expect(results).toHaveLength(2)
    expect(results[0].verified).toBe(true)
    expect(results[1].verified).toBe(true)
    expect(search).toHaveBeenCalledTimes(1)
  })
})

describe("verifyRecommendations — concurrency", () => {
  it("respects the default concurrency cap of 3", async () => {
    let active = 0
    let maxActive = 0
    const search: TmdbSearchFn = async ({ title }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return [movieResult({ id: title.length, title, release_date: "2020-01-01" })]
    }
    const recs = Array.from({ length: 8 }, (_, i) => rec({ title: `Film Number ${i}`, year: 2020 }))
    const results = await verifyRecommendations(recs, { searchTmdb: search, catalogue: [] })
    expect(results.every((r) => r.verified)).toBe(true)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBeGreaterThan(1)
  })

  it("respects an explicit concurrency of 1", async () => {
    let active = 0
    let maxActive = 0
    const search: TmdbSearchFn = async ({ title }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return [movieResult({ id: title.length, title, release_date: "2020-01-01" })]
    }
    const recs = Array.from({ length: 4 }, (_, i) => rec({ title: `Serial Film ${i}`, year: 2020 }))
    await verifyRecommendations(recs, { searchTmdb: search, catalogue: [], concurrency: 1 })
    expect(maxActive).toBe(1)
  })
})

describe("catalogue matching", () => {
  const duneSearch = searchFrom({ Dune: [movieResult()] })

  it("matches through quality suffixes and year brackets in provider names", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: duneSearch,
      catalogue: [candidate({ id: "42", title: "Dune (2021) 2160p BluRay x265", year: undefined })],
    })
    expect(out.match?.catalogueKey).toBe("movie:42")
    expect(out.match?.compositeId).toBe("movie:42")
    expect(out.match?.kind).toBe("movie")
    expect(out.match?.title).toBe("Dune")
    expect(out.match?.year).toBe(2021)
  })

  it("matches through punctuation differences", async () => {
    const [out] = await verifyRecommendations(
      [rec({ title: "Spider-Man: Into the Spider-Verse", year: 2018 })],
      {
        searchTmdb: searchFrom({
          "Spider-Man: Into the Spider-Verse": [
            movieResult({
              id: 2,
              title: "Spider-Man: Into the Spider-Verse",
              release_date: "2018-12-14",
            }),
          ],
        }),
        catalogue: [
          candidate({
            id: "55",
            title: "Spider Man Into the Spider Verse 2018 BluRay",
            year: undefined,
          }),
        ],
      }
    )
    expect(out.match?.catalogueKey).toBe("movie:55")
  })

  it("matches through alternative titles from the details fetch", async () => {
    const [out] = await verifyRecommendations([rec({ title: "Spirited Away", year: 2001 })], {
      searchTmdb: searchFrom({
        "Spirited Away": [
          movieResult({ id: 3, title: "Spirited Away", release_date: "2001-07-20" }),
        ],
      }),
      catalogue: [
        candidate({ id: "66", title: "Sen to Chihiro no Kamikakushi (2001)", year: undefined }),
      ],
      fetchDetails: async () =>
        details({ alternativeTitles: ["Sen to Chihiro no kamikakushi"] }),
    })
    expect(out.match?.catalogueKey).toBe("movie:66")
  })

  it("collapses duplicate streams to a single best match (first in catalogue order)", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: duneSearch,
      catalogue: [
        candidate({ id: "7", title: "Dune (2021) 1080p", year: undefined }),
        candidate({ id: "9", title: "Dune (2021) 4K HDR", year: undefined }),
        candidate({ id: "11", title: "[EN] Dune 2021 BluRay", year: undefined }),
      ],
    })
    expect(out.match?.catalogueKey).toBe("movie:7")
  })

  it("disambiguates same-named different-year catalogue entries by year", async () => {
    const [out] = await verifyRecommendations([rec({ title: "The Thing", year: 1982 })], {
      searchTmdb: searchFrom({
        "The Thing": [movieResult({ id: 20, title: "The Thing", release_date: "1982-06-25" })],
      }),
      catalogue: [
        candidate({ id: "2011", title: "The Thing (2011)", year: undefined }),
        candidate({ id: "1982", title: "The Thing (1982)", year: undefined }),
      ],
    })
    expect(out.match?.catalogueKey).toBe("movie:1982")
  })

  it("returns no match when surviving catalogue years are ambiguous", () => {
    const match = matchVerifiedTitleToCatalog(
      { tmdbId: 40, title: "Hamlet", year: 2000, kind: "movie" },
      [
        candidate({ id: "a", title: "Hamlet (1999)", year: undefined }),
        candidate({ id: "b", title: "Hamlet (2001)", year: undefined }),
      ]
    )
    expect(match).toBeNull()
  })

  it("never matches across kinds", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: duneSearch,
      catalogue: [candidate({ id: "77", kind: "series", title: "Dune" })],
    })
    expect(out.match).toBeNull()
  })

  it("never matches a live entry", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: duneSearch,
      catalogue: [candidate({ id: "88", kind: "live", title: "Dune" })],
    })
    expect(out.match).toBeNull()
  })

  it("matches directly on a shared provider TMDb id despite a translated name", () => {
    const match = matchVerifiedTitleToCatalog(
      { tmdbId: 1, title: "Dune", year: 2021, kind: "movie" },
      [candidate({ id: "5", title: "Diuna — Czesci Pierwsza", tmdbId: 1, year: undefined })]
    )
    expect(match?.catalogueKey).toBe("movie:5")
  })

  it("excludes an entry whose provider TMDb id contradicts the verified id", () => {
    const match = matchVerifiedTitleToCatalog(
      { tmdbId: 1, title: "Dune", year: 2021, kind: "movie" },
      [candidate({ id: "5", title: "Dune", tmdbId: 999 })]
    )
    expect(match).toBeNull()
  })

  it("matches a yearless catalogue entry on an exact title", () => {
    const match = matchVerifiedTitleToCatalog(
      { tmdbId: 1, title: "Dune", year: 2021, kind: "movie" },
      [candidate({ id: "5", title: "Dune", year: undefined })]
    )
    expect(match?.catalogueKey).toBe("movie:5")
  })

  it("rejects a catalogue entry whose year is far from the verified year", () => {
    const match = matchVerifiedTitleToCatalog(
      { tmdbId: 1, title: "Dune", year: 2021, kind: "movie" },
      [candidate({ id: "5", title: "Dune", year: 1984 })]
    )
    expect(match).toBeNull()
  })

  it("catalogueKey is the composite key the detail flow uses", async () => {
    const [out] = await verifyRecommendations([rec()], {
      searchTmdb: duneSearch,
      catalogue: [candidate({ id: "123" })],
    })
    // candidateKey()/compositeCandidateId() shape: `${kind}:${id}`.
    // The UI opens `/movies/detail?id=123` for this key (candidateDetailHref).
    expect(out.match?.catalogueKey).toBe("movie:123")
    expect(out.match?.compositeId).toBe("movie:123")
    const [kind, id] = (out.match?.catalogueKey ?? "").split(":")
    expect(kind).toBe("movie")
    expect(`/movies/detail?id=${id}`).toBe("/movies/detail?id=123")
  })
})
