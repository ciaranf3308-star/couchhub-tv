// 0.11.0 W2 — Live TV programme enrichment.
// The TMDb transport is mocked (never the real API); the matcher and
// normalisation run for real.
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getTmdbApiKey: vi.fn(() => "test-tmdb-key"),
  isTmdbActive: vi.fn(() => true),
}))

vi.mock("@/scripts/lib/tmdb.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/tmdb.ts")>()
  return {
    ...actual,
    tmdbSearchMovie: vi.fn(),
    tmdbSearchTv: vi.fn(),
    tmdbMovieBundle: vi.fn(),
    tmdbTvBundle: vi.fn(),
    tmdbTvSeason: vi.fn(),
  }
})

import { getTmdbApiKey, isTmdbActive } from "@/scripts/lib/app-settings.js"
import {
  tmdbSearchMovie,
  tmdbSearchTv,
  tmdbMovieBundle,
  tmdbTvBundle,
  tmdbTvSeason,
  type TmdbSearchResult,
} from "@/scripts/lib/tmdb.ts"
import {
  enrichProgramme,
  getProgrammeArtworkSync,
  prefetchProgrammes,
  clearProgrammeArtworkCache,
  normalizeProgrammeTitle,
  parseProgrammeTitleSignals,
} from "@/scripts/lib/livetv-enrichment.ts"

const mockSearchTv = vi.mocked(tmdbSearchTv)
const mockSearchMovie = vi.mocked(tmdbSearchMovie)
const mockMovieBundle = vi.mocked(tmdbMovieBundle)
const mockTvBundle = vi.mocked(tmdbTvBundle)
const mockTvSeason = vi.mocked(tmdbTvSeason)
const mockIsTmdbActive = vi.mocked(isTmdbActive)
const mockGetTmdbApiKey = vi.mocked(getTmdbApiKey)

function searchResult(overrides: Partial<TmdbSearchResult> = {}): TmdbSearchResult {
  return {
    id: 1,
    name: "Breaking Bad",
    first_air_date: "2008-01-20",
    vote_count: 12000,
    popularity: 95,
    poster_path: "/poster.jpg",
    overview: "A chemistry teacher turns.",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsTmdbActive.mockReturnValue(true)
  mockGetTmdbApiKey.mockReturnValue("test-tmdb-key")
  mockSearchTv.mockResolvedValue([])
  mockSearchMovie.mockResolvedValue([])
  mockMovieBundle.mockResolvedValue({
    id: 1,
    title: "Inception",
    overview: "A thief steals secrets.",
    poster_path: "/inception-poster.jpg",
    backdrop_path: "/inception-backdrop.jpg",
    vote_average: 8.4,
    genres: [{ id: 1, name: "Science Fiction" }],
  })
  mockTvBundle.mockResolvedValue({
    id: 1,
    name: "Breaking Bad",
    overview: "A chemistry teacher turns.",
    poster_path: "/poster.jpg",
    backdrop_path: "/backdrop.jpg",
    vote_average: 9.5,
    genres: [{ id: 2, name: "Drama" }],
  })
  mockTvSeason.mockResolvedValue({
    episodes: [
      { episode_number: 1, name: "Pilot", overview: "Walt's first cook.", still_path: "/still-s1e1.jpg" },
      { episode_number: 2, name: "Cat's in the Bag...", overview: "", still_path: "/still-s1e2.jpg" },
    ],
  })
  clearProgrammeArtworkCache()
})

describe("normalizeProgrammeTitle / parseProgrammeTitleSignals", () => {
  it("strips a trailing HD suffix and collapses whitespace", () => {
    expect(normalizeProgrammeTitle("BBC News at Ten HD")).toBe("BBC News at Ten")
    expect(normalizeProgrammeTitle("  The   Chase  ")).toBe("The Chase")
  })

  it("strips SxxExx markers and extracts season + episode", () => {
    const signals = parseProgrammeTitleSignals("Breaking Bad S01E01")
    expect(signals.query).toBe("Breaking Bad")
    expect(signals.season).toBe(1)
    expect(signals.episode).toBe(1)
  })

  it("extracts Series N Episode M signals", () => {
    const signals = parseProgrammeTitleSignals("Doctor Who Series 3 Episode 5")
    expect(signals.query).toBe("Doctor Who")
    expect(signals.season).toBe(3)
    expect(signals.episode).toBe(5)
  })

  it("extracts a bracketed year", () => {
    const signals = parseProgrammeTitleSignals("Inception (2010)")
    expect(signals.query).toBe("Inception")
    expect(signals.year).toBe(2010)
  })

  it("strips a channel-name prefix only when it exactly equals the channel", () => {
    const signals = parseProgrammeTitleSignals("BBC One: EastEnders", "BBC One")
    expect(signals.variants).toContain("EastEnders")
    const unprefixed = parseProgrammeTitleSignals("The Chase: Celebrity Special", "ITV1")
    expect(unprefixed.variants).not.toContain("Celebrity Special")
    expect(unprefixed.variants).toContain("The Chase")
  })

  it("never strips words that could be part of the programme name", () => {
    expect(normalizeProgrammeTitle("The Good Doctor")).toBe("The Good Doctor")
    expect(normalizeProgrammeTitle("HD Ready")).toBe("HD Ready")
  })
})

describe("enrichProgramme — confident match", () => {
  it("returns series backdrop/poster for an exact TV match", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    const art = await enrichProgramme({ title: "Breaking Bad" })
    expect(art.source).toBe("tmdb-series")
    expect(art.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/backdrop.jpg")
    expect(art.posterUrl).toBe("https://image.tmdb.org/t/p/w500/poster.jpg")
    expect(art.matchedTitle).toBe("Breaking Bad")
    expect(art.synopsis).toBe("A chemistry teacher turns.")
    expect(art.genres).toEqual(["Drama"])
    expect(art.confidence).toBeGreaterThanOrEqual(0.8)
    expect(mockSearchMovie).not.toHaveBeenCalled()
  })

  it("returns episode still + episode synopsis for SxxExx titles", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    const art = await enrichProgramme({ title: "Breaking Bad S01E01" })
    expect(art.source).toBe("tmdb-episode")
    expect(art.stillUrl).toBe("https://image.tmdb.org/t/p/w300/still-s1e1.jpg")
    expect(art.synopsis).toBe("Walt's first cook.")
    expect(art.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/backdrop.jpg")
    expect(mockTvSeason).toHaveBeenCalledWith("test-tmdb-key", 1, 1, expect.any(String))
  })

  it("falls back to series art when the episode is not in the season", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    mockTvSeason.mockResolvedValue({ episodes: [{ episode_number: 9, name: "Other", still_path: "/x.jpg" }] })
    const art = await enrichProgramme({ title: "Breaking Bad S01E01" })
    expect(art.source).toBe("tmdb-series")
    expect(art.stillUrl).toBeNull()
    expect(art.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/backdrop.jpg")
  })

  it("falls back to a film match when no series matches", async () => {
    mockSearchTv.mockResolvedValue([])
    mockSearchMovie.mockResolvedValue([
      { id: 27205, title: "Inception", release_date: "2010-07-15", vote_count: 30000, popularity: 90 },
    ])
    const art = await enrichProgramme({ title: "Inception" })
    expect(art.source).toBe("tmdb-movie")
    expect(art.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/inception-backdrop.jpg")
    expect(art.posterUrl).toBe("https://image.tmdb.org/t/p/w500/inception-poster.jpg")
    expect(art.matchedTitle).toBe("Inception")
    expect(art.genres).toEqual(["Science Fiction"])
  })

  it("uses the year signal to pick the right film among same-name results", async () => {
    mockSearchMovie.mockResolvedValue([
      { id: 1, title: "Dune", release_date: "1984-12-14", vote_count: 5000, popularity: 40 },
      { id: 2, title: "Dune", release_date: "2021-09-15", vote_count: 25000, popularity: 95 },
    ])
    mockMovieBundle.mockResolvedValue({
      id: 2,
      title: "Dune",
      overview: "Paul Atreides.",
      poster_path: "/dune-poster.jpg",
      backdrop_path: "/dune-backdrop.jpg",
      vote_average: 8.0,
      genres: [{ id: 3, name: "Adventure" }],
    })
    const art = await enrichProgramme({ title: "Dune (2021)" })
    expect(art.source).toBe("tmdb-movie")
    expect(art.matchedTitle).toBe("Dune")
    expect(mockMovieBundle).toHaveBeenCalledWith("test-tmdb-key", 2, expect.any(String))
  })

  it("returns channel-source art from an explicit logo when TMDb has no match", async () => {
    const art = await enrichProgramme({
      title: "Local News Hour",
      channelLogoUrl: "https://example.com/channel-logo.png",
    })
    expect(art.source).toBe("channel")
    expect(art.posterUrl).toBe("https://example.com/channel-logo.png")
    expect(art.backdropUrl).toBeNull()
  })
})

describe("enrichProgramme — safe failure", () => {
  it("falls back to placeholder on an ambiguous title — never wrong artwork", async () => {
    mockSearchTv.mockResolvedValue([
      searchResult({ id: 10, name: "The Office", first_air_date: "2001-07-09", vote_count: 9000 }),
      searchResult({ id: 20, name: "The Office", first_air_date: "2005-03-24", vote_count: 8000 }),
    ])
    const art = await enrichProgramme({ title: "The Office" })
    expect(art.source).toBe("placeholder")
    expect(art.backdropUrl).toBeNull()
    expect(art.posterUrl).toBeNull()
    expect(art.stillUrl).toBeNull()
    expect(art.matchedTitle).toBeNull()
    expect(mockTvBundle).not.toHaveBeenCalled()
    expect(mockMovieBundle).not.toHaveBeenCalled()
  })

  it("negatively caches a failed match: the second call does no network", async () => {
    const first = await enrichProgramme({ title: "Some Show That Does Not Exist" })
    expect(first.source).toBe("placeholder")
    expect(mockSearchTv).toHaveBeenCalledTimes(1)
    expect(mockSearchMovie).toHaveBeenCalledTimes(1)

    const second = await enrichProgramme({ title: "Some Show That Does Not Exist" })
    expect(second.source).toBe("placeholder")
    expect(mockSearchTv).toHaveBeenCalledTimes(1)
    expect(mockSearchMovie).toHaveBeenCalledTimes(1)
    // The negative cache is visible synchronously too.
    expect(getProgrammeArtworkSync("Some Show That Does Not Exist")?.source).toBe("placeholder")
  })

  it("degrades silently with no key configured — no network at all", async () => {
    mockIsTmdbActive.mockReturnValue(false)
    mockGetTmdbApiKey.mockReturnValue("")
    const art = await enrichProgramme({ title: "Breaking Bad" })
    expect(art.source).toBe("placeholder")
    expect(mockSearchTv).not.toHaveBeenCalled()
    expect(mockSearchMovie).not.toHaveBeenCalled()
    expect(mockTvBundle).not.toHaveBeenCalled()
  })

  it("never throws on a network failure and does not negatively cache it", async () => {
    mockSearchTv.mockRejectedValue(new Error("network down"))
    const art = await enrichProgramme({ title: "Breaking Bad" })
    expect(art.source).toBe("placeholder")

    // Recovery must be possible: the failure was not cached.
    mockSearchTv.mockResolvedValue([searchResult()])
    const recovered = await enrichProgramme({ title: "Breaking Bad" })
    expect(recovered.source).toBe("tmdb-series")
    expect(mockSearchTv).toHaveBeenCalledTimes(2)
  })

  it("never throws on an empty or blank title", async () => {
    await expect(enrichProgramme({ title: "   " })).resolves.toMatchObject({ source: "placeholder" })
    expect(mockSearchTv).not.toHaveBeenCalled()
  })
})

describe("getProgrammeArtworkSync", () => {
  it("returns null before any enrichment and the artwork after", async () => {
    expect(getProgrammeArtworkSync("Breaking Bad")).toBeNull()
    mockSearchTv.mockResolvedValue([searchResult()])
    await enrichProgramme({ title: "Breaking Bad" })
    const art = getProgrammeArtworkSync("Breaking Bad")
    expect(art?.source).toBe("tmdb-series")
    expect(art?.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/backdrop.jpg")
  })

  it("is title-normalised: SxxExx and HD variants hit the same entry", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    await enrichProgramme({ title: "Breaking Bad S01E01" })
    expect(getProgrammeArtworkSync("Breaking Bad")).not.toBeNull()
  })
})

describe("prefetchProgrammes", () => {
  it("is non-blocking and populates the cache in the background", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    const ret = prefetchProgrammes(["Breaking Bad"])
    expect(ret).toBeUndefined()
    // Nothing cached synchronously — the work happens async.
    expect(getProgrammeArtworkSync("Breaking Bad")).toBeNull()
    // Let the microtasks + timers flush.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getProgrammeArtworkSync("Breaking Bad")?.source).toBe("tmdb-series")
  })

  it("dedupes titles and skips already-cached ones", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    await enrichProgramme({ title: "Breaking Bad" })
    expect(mockSearchTv).toHaveBeenCalledTimes(1)
    prefetchProgrammes(["Breaking Bad", "Breaking Bad", "Breaking Bad HD"])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockSearchTv).toHaveBeenCalledTimes(1)
  })

  it("never throws on bad input", () => {
    expect(() => prefetchProgrammes([])).not.toThrow()
    expect(() => prefetchProgrammes(["", "   "])).not.toThrow()
  })
})

// 0.11.0 W4 (merged) — no-key placeholder must NOT be cached, so enabling
// a TMDb key later takes effect at once. Genuine no-match placeholders
// (key active, searched, nothing found) ARE negative-cached 24h — see
// "negatively caches a failed match" above.
describe("enrichProgramme — no-key placeholder is transient", () => {
  it("does not cache the placeholder when TMDb is inactive", async () => {
    mockIsTmdbActive.mockReturnValue(false)
    mockGetTmdbApiKey.mockReturnValue("")
    clearProgrammeArtworkCache()
    expect(getProgrammeArtworkSync("F1: Brazilian Grand Prix — Qualifying")).toBeNull()
    const art = await enrichProgramme({ title: "F1: Brazilian Grand Prix — Qualifying", channelName: "Sky Sports F1" })
    expect(art.source).toBe("placeholder")
    expect(art.confidence).toBe(0)
    expect(getProgrammeArtworkSync("F1: Brazilian Grand Prix — Qualifying")).toBeNull()
  })
})
