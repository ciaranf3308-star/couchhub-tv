// 0.11.12 W5 — hierarchy level 3 (team/venue) resolution, alias matching,
// provenance and the composite sports-entry cache. The TMDb transport, the
// artwork manifest and the sports provider are all mocked (never the real
// APIs); the classifier, hierarchy, cache and display-rule picker run for
// real. The mocked manifest deliberately carries subjects on only some
// entries: subject-less entries must stay generic-fallback-only, and the
// Manchester United entry carries ONLY the canonical subject so the
// "Man Utd" title exercises the alias map rather than a direct hit.
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

vi.mock("@/scripts/lib/sports-artwork-manifest.ts", () => {
  const base = {
    orientation: "landscape",
    width: 1600,
    height: 900,
    creator: "Test Photographer",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Test.jpg",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Test Photographer, CC BY-SA 4.0",
  }
  return {
    SPORT_ARTWORK_MANIFEST: [
      { ...base, sport: "football", path: "/art/football-generic.jpg" },
      { ...base, sport: "football", path: "/art/man-utd.jpg", subjects: ["manchester united", "old trafford"] },
      { ...base, sport: "football", path: "/art/man-utd-2.jpg", subjects: ["manchester united"] },
      { ...base, sport: "football", path: "/art/sunderland.jpg", subjects: ["sunderland", "stadium of light"] },
      { ...base, sport: "football", path: "/art/arsenal.jpg", subjects: ["arsenal", "emirates stadium"] },
      { ...base, sport: "ice-hockey", path: "/art/hockey-generic.jpg" },
      { ...base, sport: "ice-hockey", path: "/art/leafs.jpg", subjects: ["toronto maple leafs", "leafs", "scotiabank arena"] },
      { ...base, sport: "ice-hockey", path: "/art/bruins.jpg", subjects: ["boston bruins", "bruins", "td garden"] },
      // Sport-scope trap: a football team name on an ice-hockey entry
      // must never win for a football fixture.
      { ...base, sport: "ice-hockey", path: "/art/hockey-arsenal.jpg", subjects: ["arsenal"] },
      { ...base, sport: "snooker", path: "/art/snooker-generic.jpg" },
      { ...base, sport: "snooker", path: "/art/crucible.jpg", subjects: ["world snooker championship", "crucible theatre"] },
    ],
  }
})

vi.mock("@/scripts/lib/thesportsdb-provider.ts", () => ({
  lookupSportsEventArtwork: vi.fn(),
}))

import { getTmdbApiKey, isTmdbActive } from "@/scripts/lib/app-settings.js"
import {
  tmdbSearchMovie,
  tmdbSearchTv,
  tmdbMovieBundle,
  tmdbTvBundle,
  type TmdbSearchResult,
} from "@/scripts/lib/tmdb.ts"
import { lookupSportsEventArtwork } from "@/scripts/lib/thesportsdb-provider.ts"
import {
  enrichProgramme,
  getProgrammeArtworkSync,
  clearProgrammeArtworkCache,
  pickArtworkUrl,
  type ProgrammeArtwork,
} from "@/scripts/lib/livetv-enrichment.ts"

const mockSearchTv = vi.mocked(tmdbSearchTv)
const mockSearchMovie = vi.mocked(tmdbSearchMovie)
const mockMovieBundle = vi.mocked(tmdbMovieBundle)
const mockTvBundle = vi.mocked(tmdbTvBundle)
const mockIsTmdbActive = vi.mocked(isTmdbActive)
const mockGetTmdbApiKey = vi.mocked(getTmdbApiKey)
const mockProvider = vi.mocked(lookupSportsEventArtwork)

function searchResult(overrides: Partial<TmdbSearchResult> = {}): TmdbSearchResult {
  return {
    id: 1,
    name: "EastEnders",
    first_air_date: "1985-02-19",
    vote_count: 5000,
    popularity: 80,
    poster_path: "/eastenders-poster.jpg",
    overview: "Life in Albert Square.",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsTmdbActive.mockReturnValue(true)
  mockGetTmdbApiKey.mockReturnValue("test-tmdb-key")
  mockSearchTv.mockResolvedValue([])
  mockSearchMovie.mockResolvedValue([])
  mockTvBundle.mockResolvedValue({
    id: 1,
    name: "EastEnders",
    overview: "Life in Albert Square.",
    poster_path: "/eastenders-poster.jpg",
    backdrop_path: "/eastenders-backdrop.jpg",
    vote_average: 7.0,
    genres: [{ id: 2, name: "Drama" }],
  })
  mockMovieBundle.mockResolvedValue({
    id: 2,
    title: "Inception",
    overview: "A thief steals secrets.",
    poster_path: "/inception-poster.jpg",
    backdrop_path: "/inception-backdrop.jpg",
    vote_average: 8.4,
    genres: [{ id: 1, name: "Science Fiction" }],
  })
  mockProvider.mockResolvedValue(null)
  clearProgrammeArtworkCache()
})

describe("level 3 — team matching", () => {
  it("Man Utd v Sunderland resolves to the team photo with the league-team kind", async () => {
    const art = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(art.source).toBe("sports")
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/man-utd.jpg")
    expect(art.posterUrl).toBe("/art/man-utd.jpg")
    // A team/venue photo is NOT the fixture: identity confidence stays 0.
    expect(art.confidence).toBe(0)
    expect(art.matchedTitle).toBe("Man Utd v Sunderland")
    expect(art.synopsis).toBeNull()
    expect(art.genres).toEqual([])
  })

  it("team A wins: reversing the fixture reverses the pick", async () => {
    const art = await enrichProgramme({ title: "Sunderland v Man Utd" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/sunderland.jpg")
  })

  it("team B wins when team A has no photo", async () => {
    const art = await enrichProgramme({ title: "Chelsea v Sunderland" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/sunderland.jpg")
  })

  it("the pick is deterministic: the first matching entry in manifest order always wins", async () => {
    const first = await enrichProgramme({ title: "Man Utd v Sunderland" })
    const second = await enrichProgramme({ title: "Man Utd v Arsenal" })
    expect(first.backdropUrl).toBe("/art/man-utd.jpg")
    expect(second.backdropUrl).toBe("/art/man-utd.jpg")
    expect(first.backdropUrl).not.toBe("/art/man-utd-2.jpg")
  })

  it("Toronto Maple Leafs vs Boston Bruins resolves to the team photo", async () => {
    const art = await enrichProgramme({ title: "Toronto Maple Leafs vs Boston Bruins" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/leafs.jpg")
    expect(art.confidence).toBe(0)
  })

  it("short-form subjects match directly, even when the sport is ambiguous", async () => {
    // "Leafs" / "Bruins" are not classifier team aliases, so the sport
    // is null — level 3 searches all sports and the keys disambiguate.
    const art = await enrichProgramme({ title: "Leafs vs Bruins" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/leafs.jpg")
  })

  it("unknown teams fall through to the generic sport photo, never to wrong team art", async () => {
    const art = await enrichProgramme({ title: "Burnley v Luton Town" })
    expect(art.artworkKind).toBe("generic-sport")
    expect(art.backdropUrl).toBe("/art/football-generic.jpg")
  })

  it("a competition/venue match serves the venue photo", async () => {
    const art = await enrichProgramme({ title: "World Snooker Championship" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/crucible.jpg")
  })

  it("entries without subjects never match level 3", async () => {
    // The generic entries sit FIRST in the mocked manifest: if level 3
    // ever matched a subject-less entry, the generic path would win.
    // A matched team must skip straight past them to its own photo.
    const art = await enrichProgramme({ title: "Arsenal v Chelsea" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/arsenal.jpg")
  })

  it("matching is scoped to the classified sport", async () => {
    const art = await enrichProgramme({ title: "Arsenal v Chelsea" })
    expect(art.backdropUrl).not.toBe("/art/hockey-arsenal.jpg")
  })

  it("non-sport titles are unaffected", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    const art = await enrichProgramme({ title: "EastEnders" })
    expect(art.source).toBe("tmdb-series")
    expect(art.artworkKind).toBe("exact-programme")
    expect(mockProvider).not.toHaveBeenCalled()
  })

  it("a bare sport title with no teams or competition keeps the generic photo", async () => {
    const art = await enrichProgramme({ title: "Snooker" })
    expect(art.artworkKind).toBe("generic-sport")
    expect(art.backdropUrl).toBe("/art/snooker-generic.jpg")
  })
})

describe("level 3 — aliases and normalisation", () => {
  it("Man Utd matches via the alias map (the entry carries only the canonical name)", async () => {
    const art = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(art.backdropUrl).toBe("/art/man-utd.jpg")
  })

  it("an unmatched alias falls through to team B", async () => {
    // "Spurs" aliases to "tottenham hotspur", which no mocked entry
    // carries — so team B (Arsenal) wins instead of failing outright.
    const art = await enrichProgramme({ title: "Spurs v Arsenal" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/arsenal.jpg")
  })

  it("trailing FC/AFC suffixes are stripped before matching", async () => {
    const art = await enrichProgramme({ title: "Manchester United FC v Sunderland AFC" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/man-utd.jpg")
  })

  it("a trailing Women suffix is stripped before matching", async () => {
    const art = await enrichProgramme({ title: "Manchester United Women v Sunderland Women" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/man-utd.jpg")
  })

  it("matching is case-insensitive", async () => {
    const art = await enrichProgramme({ title: "MAN UTD v SUNDERLAND" })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/man-utd.jpg")
  })
})

describe("level 3 — hierarchy precedence and provenance", () => {
  it("verified provider art (level 2) wins over team/venue art", async () => {
    mockProvider.mockResolvedValue({
      backdropUrl: "https://example.com/event-backdrop.jpg",
      posterUrl: "https://example.com/event-poster.jpg",
      source: "thesportsdb",
      eventName: "Manchester United vs Sunderland",
      rightsBasis: "CC BY-SA 4.0 via Wikimedia Commons",
    })
    const art = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(art.artworkKind).toBe("exact-sports-event")
    expect(art.backdropUrl).toBe("https://example.com/event-backdrop.jpg")
  })

  it("team/venue art wins over channel branding", async () => {
    const art = await enrichProgramme({
      title: "Man Utd v Sunderland",
      channelLogoUrl: "https://example.com/channel-logo.png",
    })
    expect(art.artworkKind).toBe("league-team")
    expect(art.backdropUrl).toBe("/art/man-utd.jpg")
  })

  it("league-team provenance carries the manifest licence and attribution", async () => {
    const art = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(art.provenance).toEqual({
      source: "Wikimedia Commons",
      attribution: "Test Photographer, CC BY-SA 4.0",
      licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      sourcePage: "https://commons.wikimedia.org/wiki/File:Test.jpg",
    })
  })

  it("pickArtworkUrl shows league-team art regardless of identity confidence", () => {
    const art: ProgrammeArtwork = {
      backdropUrl: "/art/man-utd.jpg",
      posterUrl: "/art/man-utd.jpg",
      stillUrl: null,
      source: "sports",
      artworkKind: "league-team",
      confidence: 0,
      matchedTitle: "Man Utd v Sunderland",
      synopsis: null,
      genres: [],
    }
    expect(pickArtworkUrl(art, "hero")).toBe("/art/man-utd.jpg")
    expect(pickArtworkUrl(art, "card")).toBe("/art/man-utd.jpg")
  })
})

describe("level 3 — sports-entry cache", () => {
  it("a cached team photo wins without re-consulting the provider", async () => {
    const first = await enrichProgramme({ title: "Man Utd v Sunderland" })
    const second = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(first).toEqual(second)
    expect(mockProvider).toHaveBeenCalledTimes(1)
    // The sync peek finds the same-date entry without a network call.
    expect(getProgrammeArtworkSync("Man Utd v Sunderland")?.artworkKind).toBe("league-team")
    expect(getProgrammeArtworkSync("Man Utd v Sunderland")?.backdropUrl).toBe("/art/man-utd.jpg")
  })

  it("another broadcast date re-resolves: the provider is consulted again", async () => {
    const dayOne = Date.now()
    const dayTwo = dayOne + 24 * 60 * 60 * 1000
    const first = await enrichProgramme({ title: "Man Utd v Sunderland", startMs: dayOne })
    const second = await enrichProgramme({ title: "Man Utd v Sunderland", startMs: dayTwo })
    expect(first.backdropUrl).toBe("/art/man-utd.jpg")
    expect(second.backdropUrl).toBe("/art/man-utd.jpg")
    expect(mockProvider).toHaveBeenCalledTimes(2)
  })

  it("team/venue entries expire on the short sports TTL", async () => {
    vi.useFakeTimers()
    try {
      const first = await enrichProgramme({ title: "Man Utd v Sunderland" })
      expect(first.artworkKind).toBe("league-team")
      expect(mockProvider).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
      const second = await enrichProgramme({ title: "Man Utd v Sunderland" })
      expect(second.artworkKind).toBe("league-team")
      expect(mockProvider).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("team/venue art is NOT title-cached: a different date's peek misses", async () => {
    // Enriched for a fixed past date; the sync peek checks today's
    // sports key, and no title-keyed entry may serve yesterday's art.
    await enrichProgramme({ title: "Man Utd v Sunderland", startMs: Date.UTC(2026, 0, 5, 20, 0, 0) })
    expect(getProgrammeArtworkSync("Man Utd v Sunderland")).toBeNull()
  })
})
