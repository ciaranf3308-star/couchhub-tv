// Discover CORE — local engine tests (W1).
// Synthetic fixtures only; no live catalogue, no AI key, no EPG fetch.
import { describe, it, expect } from "vitest"
import {
  rankCandidates,
  searchDiscover,
  getDiscoverRows,
  validateRankedCandidates,
  rankWithAI,
  rankDiscover,
  registerAIRanker,
  getAIRanker,
  moodPreset,
  isNaturalLanguageQuery,
  detectMoodPresets,
  pickRandomCandidate,
  catalogRowToCandidate,
  liveChannelToCandidate,
  candidateDetailHref,
  candidateKey,
  type DiscoverCandidate,
  type RankedCandidate,
} from "../src/scripts/lib/discover"
import {
  emptyTasteModel,
  recordFeedback,
  type TasteModel,
} from "../src/scripts/lib/taste"

function candidate(partial: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

function tasteWithLikes(): TasteModel {
  let model = emptyTasteModel("shared", "pl1")
  model = recordFeedback(model, {
    kind: "movie",
    id: "1",
    title: "Space Heist",
    action: "like",
    genres: ["Sci-Fi", "Action"],
    cast: ["Ada Star"],
    director: "Jane Doe",
    runtimeMinutes: 120,
  })
  model = recordFeedback(model, {
    kind: "movie",
    id: "2",
    title: "Quiet Drama",
    action: "favourite",
    genres: ["Drama"],
    cast: [],
    runtimeMinutes: 95,
  })
  return model
}

const CATALOG: DiscoverCandidate[] = [
  candidate({ id: "10", title: "Star Voyage", genres: ["Sci-Fi"], cast: ["Ada Star"], director: "Jane Doe", rating: 7.2, year: 2024 }),
  candidate({ id: "11", title: "Galaxy Run", genres: ["Sci-Fi", "Action"], cast: ["Bob Nova"], rating: 6.5, year: 2023 }),
  candidate({ id: "12", title: "Superhero Smash", genres: ["Action"], cast: [], rating: 9.8, year: 2025 }),
  candidate({ id: "13", title: "Tearful Drama", genres: ["Drama"], cast: [], rating: 8.0, year: 2022 }),
  candidate({ id: "14", title: "Slapstick Comedy", genres: ["Comedy"], cast: [], rating: 5.0, year: 2021 }),
  candidate({ id: "15", title: "Star Voyage 2", genres: ["Sci-Fi"], cast: ["Ada Star"], rating: 7.0, year: 2025 }),
  candidate({ id: "16", title: "Star Voyage 3", genres: ["Sci-Fi"], cast: ["Ada Star"], rating: 6.9, year: 2025 }),
  candidate({ id: "17", title: "Cosy Romance", genres: ["Romance"], cast: [], rating: 7.9, year: 2024, runtimeMinutes: 95 }),
  candidate({ id: "18", title: "Quick Short", genres: ["Drama"], cast: [], rating: 7.4, year: 2024, runtimeMinutes: 22 }),
  candidate({ id: "19", title: "Epic Binge", kind: "series", genres: ["Drama"], cast: [], rating: 8.6, year: 2024 }),
]

describe("rankCandidates", () => {
  it("prefers taste matches over pure popularity", () => {
    const ranked = rankCandidates(CATALOG, tasteWithLikes())
    // "Superhero Smash" is the highest-rated title (9.8) but matches no
    // taste; "Star Voyage" matches genre + cast + director and must win.
    expect(ranked[0].candidate.id).toBe("10")
    expect(ranked.find((r) => r.candidate.id === "12")!.score).toBeLessThan(ranked[0].score)
  })

  it("explains the pick with a real signal, not a generic line", () => {
    const ranked = rankCandidates(CATALOG, tasteWithLikes())
    expect(ranked[0].reason).toMatch(/sci-fi|Ada Star|Jane Doe/i)
  })

  it("filters watched titles when asked, keeps them otherwise", () => {
    const watched = new Set(["movie:10", "movie:11"])
    const filtered = rankCandidates(CATALOG, tasteWithLikes(), {
      excludeWatched: true,
      watchedKeys: watched,
    })
    expect(filtered.map((r) => r.candidate.id)).not.toContain("10")
    expect(filtered.map((r) => r.candidate.id)).not.toContain("11")
    const kept = rankCandidates(CATALOG, tasteWithLikes(), {
      excludeWatched: false,
      watchedKeys: watched,
    })
    expect(kept.map((r) => r.candidate.id)).toContain("10")
  })

  it("honours not-interested exclusions and explicit dislikes", () => {
    let model = tasteWithLikes()
    model = recordFeedback(model, { kind: "movie", id: "13", title: "Tearful Drama", action: "not-interested" })
    const ranked = rankCandidates(CATALOG, model)
    expect(ranked.map((r) => r.candidate.id)).not.toContain("13")
  })

  it("caps one title-group so a franchise cannot fill the row", () => {
    const ranked = rankCandidates(CATALOG, emptyTasteModel("shared", "pl1"), { limit: 12 })
    const starVoyage = ranked.filter((r) => r.candidate.title.startsWith("Star Voyage"))
    // Distinct titles (Voyage / Voyage 2 / Voyage 3) are different groups,
    // so the cap under test is per-GROUP: duplicates of the same title
    // collapse. Build that case explicitly below.
    expect(starVoyage.length).toBeLessThanOrEqual(3)
    const dupes = [
      candidate({ id: "20", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.2, year: 2024 }),
      candidate({ id: "21", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.1, year: 2024 }),
      candidate({ id: "22", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.0, year: 2024 }),
    ]
    const rankedDupes = rankCandidates([...CATALOG, ...dupes], emptyTasteModel("shared", "pl1"), { limit: 12 })
    const voyage = rankedDupes.filter((r) => r.candidate.title === "Star Voyage")
    expect(voyage).toHaveLength(1)
  })

  it("is deterministic: same inputs, same order", () => {
    const a = rankCandidates(CATALOG, tasteWithLikes())
    const b = rankCandidates(CATALOG, tasteWithLikes())
    expect(a.map((r) => r.candidate.id)).toEqual(b.map((r) => r.candidate.id))
  })

  it("cold start still ranks, honestly (B10: a bare rating with no votes earns nothing)", () => {
    const ranked = rankCandidates(CATALOG, emptyTasteModel("shared", "pl1"))
    expect(ranked.length).toBeGreaterThan(0)
    // No title in CATALOG carries votes, so no rating term is awarded
    // at all: the order is recency + novelty, and the bare 9.8 with
    // nobody behind it must NOT win on rating.
    expect(ranked[0].candidate.id).not.toBe("12")
    // A vote-backed 8.0 beats the no-vote 9.8 outright.
    const withVotes = [
      candidate({ id: "30", title: "Proven Eight", genres: ["Drama"], cast: [], rating: 8.0, voteCount: 1200, tmdbId: 999, year: 2022 }),
      candidate({ id: "12", title: "Superhero Smash", genres: ["Action"], cast: [], rating: 9.8, year: 2025 }),
    ]
    expect(rankCandidates(withVotes, emptyTasteModel("shared", "pl1"))[0].candidate.id).toBe("30")
  })
})

describe("searchDiscover", () => {
  it("matches titles, genres, cast and directors by text", () => {
    const results = searchDiscover("ada star", CATALOG, tasteWithLikes())
    expect(results.map((r) => r.candidate.id)).toContain("10")
    expect(results[0].candidate.cast).toContain("Ada Star")
  })

  it("applies mood words from the query (intense / easy / short / binge)", () => {
    const intense = searchDiscover("something intense", CATALOG, emptyTasteModel("shared", "pl1"))
    expect(intense[0].candidate.genres.map((g) => g.toLowerCase())).toEqual(
      expect.arrayContaining(["action"])
    )
    const short = searchDiscover("something short", CATALOG, emptyTasteModel("shared", "pl1"), { moodId: "short" })
    expect(short[0].candidate.id).toBe("18")
    const binge = searchDiscover("binge", CATALOG, emptyTasteModel("shared", "pl1"))
    expect(binge[0].candidate.kind).toBe("series")
  })

  it("hidden gems are highly rated but never watched titles", () => {
    const preset = moodPreset("hidden-gems")!
    expect(preset.minRating).toBe(7.5)
    const results = searchDiscover("", CATALOG, emptyTasteModel("shared", "pl1"), {
      moodId: "hidden-gems",
      excludeWatched: true,
      watchedKeys: new Set(["movie:12"]),
    })
    expect(results.map((r) => r.candidate.id)).not.toContain("12")
    expect(results.every((r) => (r.candidate.rating ?? 0) >= 7.5)).toBe(true)
  })

  it("surprise-me returns exactly one pick", () => {
    const results = searchDiscover("surprise me", CATALOG, emptyTasteModel("shared", "pl1"))
    expect(results).toHaveLength(1)
  })

  it("empty query returns the ranked catalogue", () => {
    const results = searchDiscover("", CATALOG, tasteWithLikes())
    expect(results.length).toBeGreaterThan(0)
  })
})

describe("mood detection", () => {
  it("distinguishes natural-language questions from title searches", () => {
    expect(isNaturalLanguageQuery("something intense for tonight?")).toBe(true)
    expect(isNaturalLanguageQuery("what should we watch, I fancy a comedy")).toBe(true)
    expect(isNaturalLanguageQuery("star voyage")).toBe(false)
    expect(isNaturalLanguageQuery("ada star")).toBe(false)
  })

  it("detects mood presets from query words", () => {
    expect(detectMoodPresets("something intense").map((m) => m.id)).toContain("intense")
    expect(detectMoodPresets("star voyage").map((m) => m.id)).toEqual([])
  })
})

describe("pickRandomCandidate", () => {
  it("uses the injected random source (deterministic under test)", () => {
    const ranked: RankedCandidate[] = CATALOG.slice(0, 3).map((c) => ({ candidate: c, score: 1, reason: "" }))
    expect(pickRandomCandidate(ranked, { random: () => 0 })?.candidate.id).toBe("10")
    expect(pickRandomCandidate(ranked, { random: () => 0.99 })?.candidate.id).toBe("12")
    expect(pickRandomCandidate([])).toBeNull()
  })
})

describe("validateRankedCandidates", () => {
  it("drops unknown ids silently and keeps real ones", () => {
    const ranked: RankedCandidate[] = [
      { candidate: CATALOG[0], score: 99, reason: "real" },
      { candidate: candidate({ id: "999", title: "Hallucinated Film" }), score: 100, reason: "fake" },
    ]
    const valid = validateRankedCandidates(ranked, CATALOG)
    expect(valid).toHaveLength(1)
    expect(valid[0].candidate.id).toBe("10")
  })
})

describe("rankWithAI fallback", () => {
  it("uses local ranking when no ranker is registered", async () => {
    registerAIRanker(null)
    expect(getAIRanker()).toBeNull()
    const ranked = await rankWithAI("something intense", CATALOG, tasteWithLikes())
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0].candidate.genres.map((g) => g.toLowerCase())).toEqual(
      expect.arrayContaining(["action"])
    )
  })

  it("uses the registered ranker for NL questions and validates its ids", async () => {
    registerAIRanker({
      rank: async (_query, candidates) => [
        // Real id first, hallucinated id second: only the real one survives.
        { candidate: candidates.find((c) => c.id === "13")!, score: 99, reason: "AI pick" },
        { candidate: candidate({ id: "999", title: "Not In The Library" }), score: 100, reason: "AI hallucination" },
      ],
    })
    try {
      const ranked = await rankWithAI("something moving for tonight?", CATALOG, tasteWithLikes())
      expect(ranked).toHaveLength(1)
      expect(ranked[0].candidate.id).toBe("13")
    } finally {
      registerAIRanker(null)
    }
  })

  it("falls back to local ranking when the ranker throws or returns nothing usable", async () => {
    registerAIRanker({
      rank: async () => {
        throw new Error("AI unavailable")
      },
    })
    try {
      const ranked = await rankWithAI("something intense for tonight?", CATALOG, tasteWithLikes())
      expect(ranked.length).toBeGreaterThan(0)
    } finally {
      registerAIRanker(null)
    }
    registerAIRanker({ rank: async () => [] })
    try {
      const ranked = await rankWithAI("something intense for tonight?", CATALOG, tasteWithLikes())
      expect(ranked.length).toBeGreaterThan(0)
    } finally {
      registerAIRanker(null)
    }
  })

  it("never calls the ranker for a plain title search", async () => {
    let called = false
    registerAIRanker({
      rank: async (_q, candidates) => {
        called = true
        return candidates.map((c) => ({ candidate: c, score: 1, reason: "" }))
      },
    })
    try {
      await rankWithAI("star voyage", CATALOG, tasteWithLikes())
      expect(called).toBe(false)
    } finally {
      registerAIRanker(null)
    }
  })
})

describe("getDiscoverRows", () => {
  const base = {
    candidates: CATALOG,
    taste: tasteWithLikes(),
    continueWatching: [CATALOG[3]],
    recentlyAdded: [CATALOG[0], CATALOG[5]],
    nowPlaying: [candidate({ id: "ch1", kind: "live", title: "RTÉ One", genres: [], cast: [], source: "epg", overview: "Now: Evening News · Next: Drama" })],
    watchedKeys: new Set(["movie:10"]),
    excludeWatched: true,
  }

  it("builds the full row set, watched-filtered", () => {
    const rows = getDiscoverRows(base)
    const ids = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(ids["picked-for-you"]).toBeDefined()
    expect(ids["picked-for-you"].items.map((i: RankedCandidate) => i.candidate.id)).not.toContain("10")
    expect(ids["continue-watching"].items).toHaveLength(1)
    expect(ids["new-and-worth-watching"].items.map((i: RankedCandidate) => i.candidate.id)).toEqual(["15"])
    // Discover is separate from Live TV (0.10.0): even supplied
    // now-playing data renders no Live TV row here.
    expect(ids["on-tv-now"]).toBeUndefined()
  })

  it("labels cold start honestly instead of claiming personalisation", () => {
    const rows = getDiscoverRows({ ...base, taste: emptyTasteModel("shared", "pl1"), watchedKeys: new Set() })
    expect(rows[0].title).toBe("Highly Rated in Your Library")
    expect(rows[0].subtitle).toMatch(/No watch history yet/)
  })

  it("never renders a Live TV row in Discover", () => {
    const rows = getDiscoverRows(base)
    expect(rows.map((r) => r.id)).not.toContain("on-tv-now")
  })

  it("hides the followed row when no provider is registered", () => {
    const rows = getDiscoverRows(base)
    expect(rows.map((r) => r.id)).not.toContain("new-episodes")
  })

  it("renders the followed row from supplied episodes", () => {
    const rows = getDiscoverRows({
      ...base,
      followedEpisodes: [
        { seriesId: "19", seriesTitle: "Epic Binge", season: 2, episode: 3, episodeTitle: "The Return", detectedAt: new Date().toISOString(), watched: false },
        { seriesId: "19", seriesTitle: "Epic Binge", season: 2, episode: 2, detectedAt: new Date().toISOString(), watched: true },
      ],
    })
    const row = rows.find((r) => r.id === "new-episodes")
    expect(row?.items).toHaveLength(1)
    expect(row?.items[0].reason).toMatch(/S2 E3/)
  })

  it("includes the because row only when seeds produced items", () => {
    const withBecause = getDiscoverRows({
      ...base,
      becauseItems: [{ candidate: CATALOG[1], score: 80, reason: "Because you watched Space Heist" }],
    })
    expect(withBecause.map((r) => r.id)).toContain("because-you-watched")
    const withoutBecause = getDiscoverRows(base)
    expect(withoutBecause.map((r) => r.id)).not.toContain("because-you-watched")
  })
})

describe("catalogue mapping", () => {
  it("maps a provider row to a candidate (genres, year, rating, poster)", () => {
    const c = catalogRowToCandidate(
      "movie",
      { id: 42, name: "Test Film", category: "Action / Adventure", rating: "8.4", year: "2023", logo: "https://x/poster.jpg", tmdb: 12345 },
      { castNames: ["Ada Star"], directorName: "Jane Doe" },
      "A plot."
    )
    expect(c).toMatchObject({
      id: "42",
      kind: "movie",
      title: "Test Film",
      year: 2023,
      rating: 8.4,
      genres: ["Action", "Adventure"],
      cast: ["Ada Star"],
      director: "Jane Doe",
      overview: "A plot.",
      posterUrl: "https://x/poster.jpg",
      tmdbId: 12345,
      source: "catalog",
    })
  })

  it("leaves tmdbId undefined when the provider attached no TMDb id", () => {
    const without = catalogRowToCandidate("movie", { id: 43, name: "No Match Film" }, null)
    expect(without.tmdbId).toBeUndefined()
    const invalid = catalogRowToCandidate("movie", { id: 44, name: "Bad Match Film", tmdb: 0 }, null)
    expect(invalid.tmdbId).toBeUndefined()
  })

  it("never invents a rating or year the provider did not supply", () => {
    const c = catalogRowToCandidate("series", { id: 7, name: "No Meta Show" }, null)
    expect(c.rating).toBeUndefined()
    expect(c.year).toBeUndefined()
    expect(c.genres).toEqual([])
  })

  it("maps a live channel with only real programme info", () => {
    const withEpg = liveChannelToCandidate({ id: 5, name: "RTÉ One" }, "Evening News", "Drama Hour")
    expect(withEpg.source).toBe("epg")
    expect(withEpg.overview).toBe("Now: Evening News · Next: Drama Hour")
    const withoutEpg = liveChannelToCandidate({ id: 5, name: "RTÉ One" })
    expect(withoutEpg.overview).toBeUndefined()
  })

  it("builds real detail/playback hrefs", () => {
    expect(candidateDetailHref(candidate({ id: "1", title: "M" }))).toBe("/movies/detail?id=1")
    expect(candidateDetailHref(candidate({ id: "2", title: "S", kind: "series" }))).toBe("/series/detail?id=2")
    expect(candidateDetailHref(candidate({ id: "3", title: "L", kind: "live" }))).toBe("/livetv?channel=3")
    expect(candidateKey(candidate({ id: "1", title: "M" }))).toBe("movie:1")
  })
})

describe("rankDiscover (AI04 / AI06)", () => {
  it("reports source 'ai' and only catalogue titles when the ranker answers", async () => {
    registerAIRanker({
      rank: async (_q, candidates) => [
        { candidate: candidates[0], score: 1, reason: "Cosy and funny." },
        // Invented id: must be dropped, never surfaced.
        {
          candidate: {
            id: "invented",
            kind: "movie",
            title: "Made Up Film",
            genres: [],
            cast: [],
            source: "catalog",
          } as DiscoverCandidate,
          score: 0.9,
          reason: "Hallucinated.",
        },
      ],
    })
    try {
      const out = await rankDiscover("something cosy for tonight please", CATALOG, tasteWithLikes())
      expect(out.source).toBe("ai")
      expect(out.results.map((r) => r.candidate.id)).toEqual([CATALOG[0].id])
      expect(out.fallbackReason).toBeUndefined()
    } finally {
      registerAIRanker(null)
    }
  })

  it("falls back to local ranking and says so when the ranker fails", async () => {
    registerAIRanker({
      rank: async () => {
        throw Object.assign(new Error("provider down"), { kind: "unavailable" })
      },
    })
    try {
      const out = await rankDiscover("something cosy for tonight please", CATALOG, tasteWithLikes())
      expect(out.source).toBe("local")
      expect(out.fallbackReason).toMatch(/couldn't answer/)
      expect(out.results.length).toBeGreaterThan(0)
    } finally {
      registerAIRanker(null)
    }
  })

  it("never sends a plain title search to the ranker", async () => {
    let called = false
    registerAIRanker({
      rank: async (_q, candidates) => {
        called = true
        return candidates.map((c) => ({ candidate: c, score: 1, reason: "" }))
      },
    })
    try {
      const out = await rankDiscover("Space Heist", CATALOG, tasteWithLikes())
      expect(called).toBe(false)
      expect(out.source).toBe("local")
    } finally {
      registerAIRanker(null)
    }
  })

  it("reaches the ranker for a short keyword query when explicitly forced (Ask AI)", async () => {
    // 0.11.4: the user typed "COMEDY" with AI connected and got a rail
    // titled "Local recommendations" — the natural-language gate vetoed
    // the one-word query silently, so even an explicit Ask AI tap never
    // reached the ranker. An explicit ask consents to the request.
    let asked = ""
    registerAIRanker({
      rank: async (q, candidates) => {
        asked = q
        return candidates.map((c) => ({ candidate: c, score: 1, reason: "" }))
      },
    })
    try {
      const out = await rankDiscover("COMEDY", CATALOG, tasteWithLikes(), { forceAi: true })
      expect(asked).toBe("COMEDY")
      expect(out.source).toBe("ai")
      expect(out.fallbackReason).toBeUndefined()
    } finally {
      registerAIRanker(null)
    }
  })

  it("still keeps the natural-language gate without force", async () => {
    let called = false
    registerAIRanker({
      rank: async (_q, candidates) => {
        called = true
        return candidates.map((c) => ({ candidate: c, score: 1, reason: "" }))
      },
    })
    try {
      const out = await rankDiscover("COMEDY", CATALOG, tasteWithLikes())
      expect(called).toBe(false)
      expect(out.source).toBe("local")
    } finally {
      registerAIRanker(null)
    }
  })

  it("quick picks carry one icon each (B04)", async () => {
    const { MOOD_PRESETS, EXAMPLE_PROMPTS } = await import("../src/scripts/lib/discover")
    expect(MOOD_PRESETS).toHaveLength(6)
    for (const preset of MOOD_PRESETS) {
      expect(preset.icon).toBeTruthy()
    }
    expect(EXAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(4)
    for (const prompt of EXAMPLE_PROMPTS) {
      expect(prompt.length).toBeGreaterThan(10)
    }
  })
})
