// 0.11.12 W1 — sports-aware hierarchy, provenance and cache versioning.
// The TMDb transport, the artwork manifest and the sports provider are
// all mocked (never the real APIs); the classifier, hierarchy, cache and
// display-rule picker run for real.
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
    width: 1920,
    height: 1080,
    creator: "Test Photographer",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Test.jpg",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Test Photographer, CC BY-SA 4.0",
  }
  return {
    SPORT_ARTWORK_MANIFEST: [
      { ...base, sport: "ice-hockey", path: "/art/ice-hockey-landscape.jpg" },
      { ...base, sport: "football", path: "/art/football-portrait.jpg", orientation: "portrait", width: 1080, height: 1920 },
      { ...base, sport: "football", path: "/art/football-landscape.jpg" },
      { ...base, sport: "snooker", path: "/art/snooker-portrait.jpg", orientation: "portrait", width: 1080, height: 1920 },
      { ...base, sport: "motorsport", path: "/art/motorsport-landscape.jpg" },
      { ...base, sport: "rugby", path: "/art/rugby-landscape.jpg" },
      // Deliberately no darts entry: darts titles exercise the fall-through
      // to channel branding / placeholder with an empty manifest slice.
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

function localDateString(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

describe("hierarchy — level 1 exact TMDb art is unchanged", () => {
  it("EastEnders returns exact TMDb art with the exact-programme kind", async () => {
    mockSearchTv.mockResolvedValue([searchResult()])
    const art = await enrichProgramme({ title: "EastEnders" })
    expect(art.source).toBe("tmdb-series")
    expect(art.artworkKind).toBe("exact-programme")
    expect(art.provenance).toEqual({ source: "TMDb" })
    expect(art.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/eastenders-backdrop.jpg")
    expect(art.confidence).toBeGreaterThanOrEqual(0.8)
    expect(mockProvider).not.toHaveBeenCalled()
  })

  it("Peppa Pig returns exact TMDb art", async () => {
    mockSearchTv.mockResolvedValue([searchResult({ id: 3, name: "Peppa Pig", first_air_date: "2004-05-31" })])
    mockTvBundle.mockResolvedValue({
      id: 3,
      name: "Peppa Pig",
      overview: "Peppa and friends.",
      poster_path: "/peppa-poster.jpg",
      backdrop_path: "/peppa-backdrop.jpg",
      vote_average: 6.5,
      genres: [{ id: 4, name: "Animation" }],
    })
    const art = await enrichProgramme({ title: "Peppa Pig" })
    expect(art.source).toBe("tmdb-series")
    expect(art.artworkKind).toBe("exact-programme")
    expect(art.matchedTitle).toBe("Peppa Pig")
    expect(mockProvider).not.toHaveBeenCalled()
  })

  it("a genuine film returns exact TMDb movie art, even on a sports channel", async () => {
    mockSearchMovie.mockResolvedValue([
      { id: 27205, title: "Inception", release_date: "2010-07-15", vote_count: 30000, popularity: 90 },
    ])
    const art = await enrichProgramme({ title: "Inception", channelName: "Sky Sports Main Event", category: "Sports" })
    expect(art.source).toBe("tmdb-movie")
    expect(art.artworkKind).toBe("exact-programme")
    expect(mockProvider).not.toHaveBeenCalled()
  })

  it("a film-shaped fixture tries TMDb first and the provider never runs when TMDb wins", async () => {
    mockSearchMovie.mockResolvedValue([
      { id: 9, title: "Kramer vs Kramer", release_date: "1979-12-19", vote_count: 8000, popularity: 50 },
    ])
    mockMovieBundle.mockResolvedValue({
      id: 9,
      title: "Kramer vs Kramer",
      overview: "A custody battle.",
      poster_path: "/kramer-poster.jpg",
      backdrop_path: "/kramer-backdrop.jpg",
      vote_average: 7.8,
      genres: [{ id: 5, name: "Drama" }],
    })
    const art = await enrichProgramme({ title: "Kramer vs Kramer" })
    expect(art.source).toBe("tmdb-movie")
    expect(art.artworkKind).toBe("exact-programme")
    expect(mockProvider).not.toHaveBeenCalled()
  })
})

describe("hierarchy — high-confidence sport skips the blind TMDb search", () => {
  it("NHL Hockey never searches TMDb and resolves to generic ice-hockey art", async () => {
    const art = await enrichProgramme({ title: "NHL Hockey" })
    expect(mockSearchTv).not.toHaveBeenCalled()
    expect(mockSearchMovie).not.toHaveBeenCalled()
    expect(mockProvider).toHaveBeenCalledTimes(1)
    expect(art.source).toBe("sports")
    expect(art.artworkKind).toBe("generic-sport")
    expect(art.backdropUrl).toBe("/art/ice-hockey-landscape.jpg")
    expect(art.posterUrl).toBe("/art/ice-hockey-landscape.jpg")
    // Generic art is suitable without being evidence of the fixture.
    expect(art.confidence).toBe(0)
    expect(art.matchedTitle).toBe("NHL Hockey")
    expect(art.synopsis).toBeNull()
  })

  it("generic-sport provenance carries the manifest licence and attribution", async () => {
    const art = await enrichProgramme({ title: "NHL Hockey" })
    expect(art.provenance).toEqual({
      source: "Wikimedia Commons",
      attribution: "Test Photographer, CC BY-SA 4.0",
      licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      sourcePage: "https://commons.wikimedia.org/wiki/File:Test.jpg",
    })
  })

  it("prefers a landscape manifest entry for the wide slots", async () => {
    const art = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(art.artworkKind).toBe("generic-sport")
    expect(art.backdropUrl).toBe("/art/football-landscape.jpg")
  })

  it("uses a portrait-only entry when that is all the manifest has", async () => {
    const art = await enrichProgramme({ title: "Snooker" })
    expect(art.artworkKind).toBe("generic-sport")
    expect(art.backdropUrl).toBe("/art/snooker-portrait.jpg")
    expect(art.posterUrl).toBe("/art/snooker-portrait.jpg")
  })

  it("low-confidence sport never calls the provider, only the generic fallback", async () => {
    const art = await enrichProgramme({ title: "Snooker" })
    expect(mockProvider).not.toHaveBeenCalled()
    expect(art.artworkKind).toBe("generic-sport")
  })

  it("works with no TMDb key: no network, generic art, nothing cached", async () => {
    mockIsTmdbActive.mockReturnValue(false)
    mockGetTmdbApiKey.mockReturnValue("")
    const art = await enrichProgramme({ title: "NHL Hockey" })
    expect(art.artworkKind).toBe("generic-sport")
    expect(mockSearchTv).not.toHaveBeenCalled()
    expect(getProgrammeArtworkSync("NHL Hockey")).toBeNull()
  })
})

describe("hierarchy — provider levels 2/3", () => {
  it("verified provider art wins over the generic fallback, with distinct provenance", async () => {
    mockProvider.mockResolvedValue({
      backdropUrl: "https://example.com/event-backdrop.jpg",
      posterUrl: "https://example.com/event-poster.jpg",
      source: "thesportsdb",
      eventName: "Manchester United vs Sunderland",
      rightsBasis: "CC BY-SA 4.0 via Wikimedia Commons",
    })
    const art = await enrichProgramme({ title: "Man Utd v Sunderland" })
    expect(art.source).toBe("sports")
    expect(art.artworkKind).toBe("exact-sports-event")
    expect(art.backdropUrl).toBe("https://example.com/event-backdrop.jpg")
    expect(art.posterUrl).toBe("https://example.com/event-poster.jpg")
    expect(art.matchedTitle).toBe("Manchester United vs Sunderland")
    expect(art.confidence).toBe(0.85)
    expect(art.provenance).toEqual({
      source: "TheSportsDB",
      licence: "CC BY-SA 4.0 via Wikimedia Commons",
    })
  })

  it("a poster-only provider result still fills the backdrop slot", async () => {
    mockProvider.mockResolvedValue({
      posterUrl: "https://example.com/event-poster.jpg",
      source: "thesportsdb",
      eventName: "Some Event",
      rightsBasis: "CC BY 4.0",
    })
    const art = await enrichProgramme({ title: "NHL Hockey" })
    expect(art.artworkKind).toBe("exact-sports-event")
    expect(art.backdropUrl).toBe("https://example.com/event-poster.jpg")
    expect(art.posterUrl).toBe("https://example.com/event-poster.jpg")
  })

  it("a provider result with no usable image falls through to generic art", async () => {
    mockProvider.mockResolvedValue({
      source: "thesportsdb",
      eventName: "Some Event",
      rightsBasis: "CC BY 4.0",
    })
    const art = await enrichProgramme({ title: "NHL Hockey" })
    expect(art.artworkKind).toBe("generic-sport")
  })

  it("the provider receives the classification and the broadcast date", async () => {
    const startMs = Date.UTC(2026, 10, 13, 20, 0, 0)
    await enrichProgramme({ title: "NHL Hockey", startMs })
    expect(mockProvider).toHaveBeenCalledWith(
      expect.objectContaining({ isSport: true, sport: "ice-hockey", confidence: "high" }),
      { title: "NHL Hockey", broadcastDate: localDateString(startMs) }
    )
  })

  it("a dateless call defaults the broadcast date to today", async () => {
    await enrichProgramme({ title: "NHL Hockey" })
    expect(mockProvider).toHaveBeenCalledWith(expect.anything(), {
      title: "NHL Hockey",
      broadcastDate: localDateString(Date.now()),
    })
  })

  it("provider failure never breaks resolution and is not cached", async () => {
    mockIsTmdbActive.mockReturnValue(false)
    mockGetTmdbApiKey.mockReturnValue("")
    mockProvider.mockRejectedValue(new Error("provider down"))
    // Darts has no manifest entry and no logo: placeholder, uncached.
    const first = await enrichProgramme({ title: "PDC World Darts Championship" })
    expect(first.source).toBe("placeholder")
    const second = await enrichProgramme({ title: "PDC World Darts Championship" })
    expect(second.source).toBe("placeholder")
    // The failure was not cached: the provider was consulted again.
    expect(mockProvider).toHaveBeenCalledTimes(2)
  })

  it("provider timeout falls through to generic art", async () => {
    vi.useFakeTimers()
    try {
      mockProvider.mockImplementation(() => new Promise(() => {}))
      const pending = enrichProgramme({ title: "NHL Hockey" })
      await vi.advanceTimersByTimeAsync(3000)
      const art = await pending
      expect(art.artworkKind).toBe("generic-sport")
    } finally {
      vi.useRealTimers()
    }
  })

  it("concurrent enrichments for one fixture call the provider once", async () => {
    mockProvider.mockResolvedValue({
      backdropUrl: "https://example.com/event.jpg",
      source: "thesportsdb",
      eventName: "Some Event",
      rightsBasis: "CC BY 4.0",
    })
    const [first, second] = await Promise.all([
      enrichProgramme({ title: "NHL Hockey" }),
      enrichProgramme({ title: "NHL Hockey" }),
    ])
    expect(first).toEqual(second)
    expect(mockProvider).toHaveBeenCalledTimes(1)
  })
})

describe("hierarchy — fall-through to channel branding and placeholder", () => {
  it("a sport title with no manifest entry falls through to channel branding", async () => {
    const art = await enrichProgramme({
      title: "PDC World Darts Championship",
      channelLogoUrl: "https://example.com/channel-logo.png",
    })
    expect(mockProvider).toHaveBeenCalledTimes(1)
    expect(art.source).toBe("channel")
    expect(art.artworkKind).toBe("channel-branding")
    expect(art.posterUrl).toBe("https://example.com/channel-logo.png")
    expect(art.backdropUrl).toBeNull()
  })

  it("a sport title with no art anywhere resolves to placeholder, not wrong art", async () => {
    const art = await enrichProgramme({ title: "PDC World Darts Championship" })
    expect(art.source).toBe("placeholder")
    expect(art.artworkKind).toBe("placeholder")
    expect(art.backdropUrl).toBeNull()
    expect(art.posterUrl).toBeNull()
    expect(art.confidence).toBe(0)
  })
})

describe("cache — sports-event keys, negatives and versioning", () => {
  it("provider art is cached per broadcast date: same date reuses, another date re-queries", async () => {
    mockProvider.mockResolvedValue({
      backdropUrl: "https://example.com/event.jpg",
      source: "thesportsdb",
      eventName: "Some Event",
      rightsBasis: "CC BY 4.0",
    })
    const dayOne = Date.now()
    const dayTwo = dayOne + 24 * 60 * 60 * 1000
    await enrichProgramme({ title: "NHL Hockey", startMs: dayOne })
    await enrichProgramme({ title: "NHL Hockey", startMs: dayOne })
    expect(mockProvider).toHaveBeenCalledTimes(1)
    // The sync peek finds the same-date entry without a network call.
    expect(getProgrammeArtworkSync("NHL Hockey")?.artworkKind).toBe("exact-sports-event")
    await enrichProgramme({ title: "NHL Hockey", startMs: dayTwo })
    expect(mockProvider).toHaveBeenCalledTimes(2)
  })

  it("an authoritative provider null is cached: the provider is consulted once", async () => {
    mockIsTmdbActive.mockReturnValue(false)
    mockGetTmdbApiKey.mockReturnValue("")
    await enrichProgramme({ title: "PDC World Darts Championship" })
    await enrichProgramme({ title: "PDC World Darts Championship" })
    expect(mockProvider).toHaveBeenCalledTimes(1)
  })

  it("sport placeholder negatives expire on the short sports TTL", async () => {
    vi.useFakeTimers()
    try {
      const first = await enrichProgramme({ title: "PDC World Darts Championship" })
      expect(first.source).toBe("placeholder")
      expect(mockProvider).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
      const second = await enrichProgramme({ title: "PDC World Darts Championship" })
      expect(second.source).toBe("placeholder")
      expect(mockProvider).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a v1 persisted negative must not suppress the new sport fallbacks", async () => {
    const store = new Map<string, string>([
      [
        "xt_livetv_enrichment_v1",
        JSON.stringify({
          "NHL Hockey": {
            art: {
              backdropUrl: null,
              posterUrl: null,
              stillUrl: null,
              source: "placeholder",
              confidence: 0,
              matchedTitle: null,
              synopsis: null,
              genres: [],
            },
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            negative: true,
          },
        }),
      ],
    ])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    })
    try {
      vi.resetModules()
      const fresh = await import("@/scripts/lib/livetv-enrichment.ts")
      const art = await fresh.enrichProgramme({ title: "NHL Hockey" })
      expect(art.artworkKind).toBe("generic-sport")
      expect(art.backdropUrl).toBe("/art/ice-hockey-landscape.jpg")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("clearProgrammeArtworkCache removes both the v1 and v2 persisted blobs", () => {
    const store = new Map<string, string>([
      ["xt_livetv_enrichment_v1", "{}"],
      ["xt_livetv_enrichment_v2", "{}"],
    ])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    })
    try {
      clearProgrammeArtworkCache()
      expect(store.has("xt_livetv_enrichment_v1")).toBe(false)
      expect(store.has("xt_livetv_enrichment_v2")).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("pickArtworkUrl — display rule", () => {
  function art(overrides: Partial<ProgrammeArtwork>): ProgrammeArtwork {
    return {
      backdropUrl: null,
      posterUrl: null,
      stillUrl: null,
      source: "placeholder",
      confidence: 0,
      matchedTitle: null,
      synopsis: null,
      genres: [],
      ...overrides,
    }
  }

  it("a displayable kind shows regardless of identity confidence", () => {
    const generic = art({
      backdropUrl: "/art/hockey.jpg",
      posterUrl: "/art/hockey.jpg",
      source: "sports",
      artworkKind: "generic-sport",
      confidence: 0,
    })
    expect(pickArtworkUrl(generic, "hero")).toBe("/art/hockey.jpg")
    expect(pickArtworkUrl(generic, "card")).toBe("/art/hockey.jpg")
  })

  it("channel-branding and placeholder kinds never paint", () => {
    const channel = art({ posterUrl: "https://example.com/logo.png", source: "channel", artworkKind: "channel-branding" })
    expect(pickArtworkUrl(channel, "card")).toBeNull()
    expect(pickArtworkUrl(channel, "hero")).toBeNull()
    const placeholder = art({ backdropUrl: "/art/x.jpg", artworkKind: "placeholder" })
    expect(pickArtworkUrl(placeholder, "hero")).toBeNull()
  })

  it("a missing kind keeps the legacy slot order unchanged", () => {
    const legacy = art({
      backdropUrl: "/art/backdrop.jpg",
      posterUrl: "/art/poster.jpg",
      stillUrl: "/art/still.jpg",
      source: "tmdb-series",
      confidence: 0.9,
    })
    expect(pickArtworkUrl(legacy, "card")).toBe("/art/poster.jpg")
    expect(pickArtworkUrl(legacy, "hero")).toBe("/art/backdrop.jpg")
    const legacyChannel = art({ posterUrl: "https://example.com/logo.png", source: "channel", confidence: 0.5 })
    expect(pickArtworkUrl(legacyChannel, "card")).toBe("https://example.com/logo.png")
  })

  it("exact sports kinds use the wide slot first on wide variants", () => {
    const event = art({
      backdropUrl: "/art/event-backdrop.jpg",
      posterUrl: "/art/event-poster.jpg",
      source: "sports",
      artworkKind: "exact-sports-event",
      confidence: 0.85,
    })
    expect(pickArtworkUrl(event, "hero")).toBe("/art/event-backdrop.jpg")
    expect(pickArtworkUrl(event, "feature")).toBe("/art/event-backdrop.jpg")
    expect(pickArtworkUrl(event, "card")).toBe("/art/event-poster.jpg")
  })
})
