// Home / Movies / Series reuse tests (0.11.5, W4).
//
// The browse surfaces rank and search through ONE engine —
// src/scripts/lib/browse-recommendations.ts, which wraps the
// Discover local engine (discover.ts) — never a second engine, and
// never the AI ranker. These tests prove the wiring:
//
//   - kind scoping (movies stay movies, series stay series),
//   - hard exclusions (not-interested / disliked) applied the same
//     way as Discover,
//   - composite identity (movie:123 vs series:123),
//   - the Home ranked pass is behaviour-identical through the
//     shared wrapper (rankCandidates equivalence),
//   - T10 (cost controls): Home load, rail refresh, controller
//     focus moves, typing and scrolling fire ZERO paid model calls
//     even with a ranker registered and AI enabled.
//
// Deterministic, mocked transport, no live network. The module under
// test never imports the AI client, so the zero-call assertions
// hold by construction — the tests pin that construction down.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const { chatMock, aiEnabled, MockAiError } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  aiEnabled: { value: true },
  MockAiError: class extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.name = "AiError"
      this.kind = kind
    }
  },
}))

vi.mock("@/scripts/lib/ai/client.js", () => ({
  AiError: MockAiError,
  chatCompletions: chatMock,
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getAiEnabled: () => aiEnabled.value,
}))

import { aiRanker, clearAiRankCache } from "@/scripts/lib/ai/ranking"
import {
  rankCandidates,
  searchDiscover,
  getDiscoverRows,
  registerAIRanker,
  type DiscoverCandidate,
} from "@/scripts/lib/discover"
import { emptyTasteModel, recordFeedback, type TasteModel } from "@/scripts/lib/taste"
import {
  rankBrowseCandidates,
  searchBrowse,
  recommendForBrowse,
  browseExcludeKeys,
  browseResultKey,
} from "@/scripts/lib/browse-recommendations"
import { COMPOSITE_MOVIE_123, COMPOSITE_SERIES_123 } from "./fixtures/ai-discovery-catalogue"

function candidate(partial: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

const MIXED: DiscoverCandidate[] = [
  candidate({ id: "1", kind: "movie", title: "Star Voyage", genres: ["Sci-Fi"], cast: ["Ada Star"], rating: 7.2, voteCount: 1200, year: 2024 }),
  candidate({ id: "2", kind: "movie", title: "Slapstick Comedy", genres: ["Comedy"], rating: 5.0, voteCount: 300, year: 2021 }),
  candidate({ id: "3", kind: "series", title: "Epic Binge", genres: ["Drama"], rating: 8.6, voteCount: 2500, year: 2024 }),
  candidate({ id: "4", kind: "series", title: "Galaxy Run", genres: ["Sci-Fi", "Action"], cast: ["Bob Nova"], rating: 6.5, voteCount: 800, year: 2023 }),
  candidate({ id: "5", kind: "movie", title: "Tearful Drama", genres: ["Drama"], rating: 8.0, voteCount: 1500, year: 2022 }),
  candidate({ id: "6", kind: "series", title: "Cosy Romance", genres: ["Romance"], rating: 7.9, voteCount: 900, year: 2024 }),
  candidate({ id: "7", kind: "movie", title: "Superhero Smash", genres: ["Action"], rating: 9.8, voteCount: 4000, year: 2025 }),
  COMPOSITE_MOVIE_123,
  COMPOSITE_SERIES_123,
]

function tasteWithLikes(): TasteModel {
  let model = emptyTasteModel("shared", "pl1")
  model = recordFeedback(model, {
    kind: "movie", id: "1", title: "Star Voyage", action: "like",
    genres: ["Sci-Fi", "Action"], cast: ["Ada Star"], director: "Jane Doe", runtimeMinutes: 120,
  })
  return model
}

beforeEach(() => {
  vi.resetAllMocks()
  aiEnabled.value = true
  clearAiRankCache()
  registerAIRanker(null)
})

afterEach(() => {
  registerAIRanker(null)
})

describe("rankBrowseCandidates", () => {
  it("scopes to one kind: Movies never sees series, Series never sees movies", () => {
    const taste = tasteWithLikes()
    const movies = rankBrowseCandidates(MIXED, taste, { kind: "movie" })
    expect(movies.length).toBeGreaterThan(0)
    expect(movies.every((r) => r.candidate.kind === "movie")).toBe(true)
    const series = rankBrowseCandidates(MIXED, taste, { kind: "series" })
    expect(series.length).toBeGreaterThan(0)
    expect(series.every((r) => r.candidate.kind === "series")).toBe(true)
    const all = rankBrowseCandidates(MIXED, taste, { kind: "all" })
    expect(all.length).toBe(MIXED.length)
  })

  it("is behaviour-identical to the engine Home already used (the Home swap changes no order)", () => {
    const taste = tasteWithLikes()
    const opts = {
      excludeKeys: new Set(taste.notInterestedKeys),
      excludeWatched: false,
      limit: 12,
      perGroupCap: 1,
    }
    const direct = rankCandidates(MIXED, taste, opts)
    const wrapped = rankBrowseCandidates(MIXED, taste, { ...opts, kind: "all" })
    expect(wrapped.map((r) => r.candidate.id)).toEqual(direct.map((r) => r.candidate.id))
    expect(wrapped.map((r) => r.score)).toEqual(direct.map((r) => r.score))
  })

  it("honours not-interested and disliked titles as hard exclusions, like Discover", () => {
    let taste = tasteWithLikes()
    taste = recordFeedback(taste, { kind: "movie", id: "5", title: "Tearful Drama", action: "not-interested" })
    taste = recordFeedback(taste, { kind: "series", id: "3", title: "Epic Binge", action: "dislike", genres: ["Drama"], cast: [] })
    const ranked = rankBrowseCandidates(MIXED, taste, { kind: "all" })
    expect(ranked.map((r) => r.candidate.id)).not.toContain("5")
    expect(ranked.map((r) => r.candidate.id)).not.toContain("3")
    expect(browseExcludeKeys(taste).has("movie:5")).toBe(true)
  })

  it("keeps movie:123 and series:123 apart as two titles", () => {
    const ranked = rankBrowseCandidates(MIXED, tasteWithLikes(), { kind: "all" })
    const keys = ranked.map(browseResultKey)
    expect(keys).toContain("movie:123")
    expect(keys).toContain("series:123")
    expect(ranked.filter((r) => r.candidate.id === "123")).toHaveLength(2)
  })

  it("is deterministic and cold-start safe with no taste at all", () => {
    const a = rankBrowseCandidates(MIXED, undefined, { kind: "all" }, "pl1")
    const b = rankBrowseCandidates(MIXED, undefined, { kind: "all" }, "pl1")
    expect(a.map((r) => r.candidate.id)).toEqual(b.map((r) => r.candidate.id))
    expect(a.length).toBeGreaterThan(0)
  })
})

describe("searchBrowse", () => {
  it("finds mood queries kind-scoped (Movies: 'something intense' stays movies)", () => {
    const results = searchBrowse("something intense", MIXED, tasteWithLikes(), { kind: "movie" })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.candidate.kind === "movie")).toBe(true)
    expect(results[0]!.candidate.genres.map((g) => g.toLowerCase())).toEqual(
      expect.arrayContaining(["action"]),
    )
  })

  it("matches plain title queries kind-scoped", () => {
    const results = searchBrowse("star voyage", MIXED, tasteWithLikes(), { kind: "movie" })
    expect(results.map((r) => r.candidate.id)).toContain("1")
  })

  it("keeps distinct entries that share a title (no title-group dedup in search)", () => {
    const dupes = [
      candidate({ id: "d1", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.2, voteCount: 100, year: 2024 }),
      candidate({ id: "d2", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.1, voteCount: 100, year: 2024 }),
      candidate({ id: "d3", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.0, voteCount: 100, year: 2024 }),
    ]
    const results = searchBrowse("star voyage", [...MIXED, ...dupes], tasteWithLikes(), { kind: "movie" })
    expect(results.map((r) => r.candidate.id)).toEqual(
      expect.arrayContaining(["d1", "d2", "d3"]),
    )
  })

  it("never truncates a search to rail length", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      candidate({ id: `m${i}`, title: `Star Voyage ${i}`, genres: ["Sci-Fi"], rating: 7, voteCount: 100, year: 2024 }),
    )
    const results = searchBrowse("star voyage", many, tasteWithLikes(), { kind: "movie" })
    expect(results).toHaveLength(40)
  })
})

describe("recommendForBrowse", () => {
  it("always answers local, never AI, with kind-scoped items", () => {
    registerAIRanker(aiRanker)
    const out = recommendForBrowse(MIXED, tasteWithLikes(), { kind: "movie" })
    expect(out.source).toBe("local")
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.items.every((r) => r.candidate.kind === "movie")).toBe(true)
    expect(chatMock).not.toHaveBeenCalled()
  })
})

describe("T10 — cost controls on the browse surfaces", () => {
  it("Home load + rail refresh + focus moves fire zero model calls", () => {
    registerAIRanker(aiRanker)
    const taste = tasteWithLikes()
    // Home load: one ranked pass + rows.
    rankBrowseCandidates(MIXED, taste, { kind: "all", limit: 48 })
    getDiscoverRows({
      candidates: MIXED,
      taste,
      continueWatching: [],
      recentlyAdded: MIXED.slice(0, 2),
      nowPlaying: [],
      watchedKeys: new Set(),
    })
    // Rail refresh + controller focus moves: the same local pass,
    // repeated — still no model call, however often it runs.
    for (let i = 0; i < 5; i++) {
      rankBrowseCandidates(MIXED, taste, { kind: "all", limit: 12 })
      recommendForBrowse(MIXED, taste, { kind: "movie" })
      recommendForBrowse(MIXED, taste, { kind: "series" })
    }
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("Movies / Series typing + scrolling fire zero model calls", () => {
    registerAIRanker(aiRanker)
    const taste = tasteWithLikes()
    // Typing, keystroke by keystroke, on both surfaces.
    for (const keystroke of ["s", "st", "sta", "star", "star ", "star v"]) {
      searchBrowse(keystroke, MIXED, taste, { kind: "movie" })
      searchBrowse(keystroke, MIXED, taste, { kind: "series" })
    }
    // Scrolling / re-rendering the grid re-runs the same local search.
    for (let i = 0; i < 5; i++) {
      searchBrowse("star voyage", MIXED, taste, { kind: "movie" })
      searchDiscover("star voyage", MIXED, taste)
    }
    expect(chatMock).not.toHaveBeenCalled()
  })
})
