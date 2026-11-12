// AI Discovery adversarial regression tests (0.11.5, W4).
//
// These tests prove the 2026-11-12 production failure dead: query
// "some fucked up dark anime" returned 'G' Men (1935), .com for
// Murder, .raw (2018), '71 (2014), ...And Justice for All, because
// ranking.ts sliced the first 20 catalogue entries before any
// relevance ranking, and tests/ai-ranking.test.ts ASSERTED that
// behaviour (first 20 in, later entries out).
//
// How they test (read before touching them):
//   - Through the PUBLIC surface only: `rankDiscover` (discover.ts)
//     with the REAL `aiRanker` registered, and `aiRanker.rank`
//     directly. W1 (retrieval/intent/hard-filtering) and W2
//     (rerank/validation/cache) own the fix; these tests assert the
//     outcome at the seam, never the implementation — so they pass
//     whichever of the two modules the fix lands in.
//   - The model transport is mocked (`chatCompletions`) with the
//     relevance-model mock (tests/helpers/relevance-model.ts): a
//     stand-in for a real LLM that can ONLY rank the IDs in its
//     prompt. No live network, no real API calls, no key.
//   - Every test FAILS on the 0.11.4 base for the right reason
//     (verified — see the W4 report) and PASSES on fixed code
//     (verified against a throwaway local fix, reverted before
//     commit; the fix itself belongs to W1/W2).
//   - No test asserts that the first N catalogue entries are
//     included or that later entries are excluded. The old
//     assumption is gone (see tests/ai-ranking.test.ts).
//   - Deterministic: seeded fixture, mocked transports, no
//     Math.random / Date.now in any assertion path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const { chatMock, aiEnabled, aiModel, shareTaste, MockAiError } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  aiEnabled: { value: true },
  aiModel: { value: "gpt-4o-mini" },
  shareTaste: { value: false },
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
  getAiModel: () => aiModel.value,
}))

vi.mock("@/scripts/lib/ai/status.js", () => ({
  getAiShareTaste: () => shareTaste.value,
}))

import {
  aiRanker,
  clearAiRankCache,
  clearAiUsageState,
} from "@/scripts/lib/ai/ranking"
import {
  rankDiscover,
  registerAIRanker,
  searchDiscover,
  rankCandidates,
  getDiscoverRows,
  type DiscoverCandidate,
} from "@/scripts/lib/discover"
import {
  emptyTasteModel,
  recordFeedback,
  type TasteModel,
} from "@/scripts/lib/taste"
import {
  AI_DISCOVERY_CATALOGUE,
  NO_ANIME_CATALOGUE,
  DARK_ANIME_QUERY,
  PUNCTUATION_TITLES,
  ANIME_IDS,
  COMEDY_IDS,
  WAR_IDS,
  ROMANCE_IDS,
  SCIFI_SERIES_IDS,
  SPARSE_IDS,
  COMPOSITE_MOVIE_123,
  COMPOSITE_SERIES_123,
  hasAnimeSignal,
  catalogueIndexOf,
} from "./fixtures/ai-discovery-catalogue"
import {
  relevanceModelReply,
  promptCandidateIds,
  jaccard,
} from "./helpers/relevance-model"

const FIRST_TWENTY_IDS = new Set(AI_DISCOVERY_CATALOGUE.slice(0, 20).map((c) => c.id))

function plainTaste(): TasteModel {
  return emptyTasteModel("shared", "pl1")
}

/** User prompt text of the nth model call (0-based). */
function promptOf(callIndex: number): string {
  const options = chatMock.mock.calls[callIndex]?.[0] as
    | { messages: Array<{ role: string; content: string }> }
    | undefined
  const user = options?.messages.find((m) => m.role === "user")
  return user?.content ?? ""
}

/** Candidate ids the model was shown on the nth call. Composite ids
 * ("movie:123") are normalised to bare provider ids ("123") here:
 * the pool assertions compare against the fixture's bare id sets,
 * and the id FORMAT is the ranker's business, not the pool's. */
function poolOf(callIndex: number): Set<string> {
  const ids = promptCandidateIds(promptOf(callIndex))
  return new Set(ids.map((id) => (id.includes(":") ? (id.split(":").pop() ?? id) : id)))
}

function candidate(partial: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

/** Small catalogue for tests that must not be affected by the
 * 20-cap at all: 4 dark anime, 2 comedy, 2 war, 2 romance, 2 sci-fi. */
function smallMixedCatalogue(): DiscoverCandidate[] {
  return [
    candidate({ id: "n-a1", kind: "movie", title: "Black Sakura", genres: ["Animation", "Horror"], overview: "A dark anime about a cursed shrine — disturbing and violent.", rating: 8.1, voteCount: 900 }),
    candidate({ id: "n-a2", kind: "movie", title: "Crimson Ronin", genres: ["Animation", "Thriller"], overview: "A dark anime about a ronin who cannot die.", rating: 8.4, voteCount: 1200 }),
    candidate({ id: "n-a3", kind: "series", title: "The Hollow School", genres: ["Animation", "Horror"], overview: "A dark anime series set in an abandoned school.", rating: 7.9, voteCount: 800 }),
    candidate({ id: "n-a4", kind: "movie", title: "Ashen Blades", genres: ["Animation", "Drama"], overview: "A quiet anime drama about swordsmiths.", rating: 7.2, voteCount: 600 }),
    candidate({ id: "n-c1", kind: "movie", title: "The Awkward Reunion", genres: ["Comedy"], overview: "A funny comedy about a family reunion.", rating: 7.0, voteCount: 700 }),
    candidate({ id: "n-c2", kind: "movie", title: "Lawn Order", genres: ["Comedy"], overview: "A funny comedy about suburban rivalry.", rating: 6.8, voteCount: 500 }),
    candidate({ id: "n-w1", kind: "movie", title: "The Winter Offensive", genres: ["War"], overview: "A historical war film about the winter campaign.", rating: 7.5, voteCount: 1100 }),
    candidate({ id: "n-w2", kind: "movie", title: "No Man's Land", genres: ["War", "History"], overview: "A historical war film about two soldiers.", rating: 7.8, voteCount: 950 }),
    candidate({ id: "n-r1", kind: "movie", title: "Letters in June", genres: ["Romance"], overview: "A romantic story told in letters.", rating: 7.3, voteCount: 650 }),
    candidate({ id: "n-r2", kind: "movie", title: "The Summer We Met", genres: ["Romance"], overview: "A romantic summer by the sea.", rating: 7.1, voteCount: 550 }),
    candidate({ id: "n-s1", kind: "series", title: "Station Nine", genres: ["Sci-Fi"], overview: "A science-fiction series aboard a deep-space station.", rating: 8.2, voteCount: 2000 }),
    candidate({ id: "n-s2", kind: "series", title: "Quantum Drift", genres: ["Sci-Fi"], overview: "A science-fiction series about drifting between stars.", rating: 7.7, voteCount: 1400 }),
  ]
}

function installSessionStorageStub(): Map<string, string> {
  const store = new Map<string, string>()
  const stub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
  }
  Object.defineProperty(globalThis, "sessionStorage", { value: stub, configurable: true })
  return store
}

beforeEach(() => {
  vi.resetAllMocks()
  aiEnabled.value = true
  aiModel.value = "gpt-4o-mini"
  shareTaste.value = false
  clearAiRankCache()
  clearAiUsageState()
  registerAIRanker(null)
  chatMock.mockImplementation((options: { messages: Array<{ role: string; content: string }> }) =>
    Promise.resolve(relevanceModelReply(options.messages)),
  )
})

afterEach(() => {
  registerAIRanker(null)
  if ("sessionStorage" in globalThis) {
    try {
      delete (globalThis as Record<string, unknown>).sessionStorage
    } catch {
      // ignore
    }
  }
})

describe("fixture sanity (guards the fixture, not production)", () => {
  it("holds ~590 entries with the punctuation block first and every intent group beyond index 20", () => {
    expect(AI_DISCOVERY_CATALOGUE.length).toBeGreaterThanOrEqual(500)
    expect(AI_DISCOVERY_CATALOGUE.slice(0, 5).map((c) => c.title)).toEqual([...PUNCTUATION_TITLES])
    expect(AI_DISCOVERY_CATALOGUE.slice(0, 20).every((c) => !hasAnimeSignal(c))).toBe(true)
    for (const id of ANIME_IDS) expect(catalogueIndexOf(id)).toBeGreaterThanOrEqual(100)
    for (const id of COMEDY_IDS) expect(catalogueIndexOf(id)).toBeGreaterThan(20)
    for (const id of WAR_IDS) expect(catalogueIndexOf(id)).toBeGreaterThan(20)
    for (const id of ROMANCE_IDS) expect(catalogueIndexOf(id)).toBeGreaterThan(20)
    for (const id of SCIFI_SERIES_IDS) expect(catalogueIndexOf(id)).toBeGreaterThan(20)
    expect(catalogueIndexOf("123", "movie")).toBe(320)
    expect(catalogueIndexOf("123", "series")).toBe(321)
  })

  it("keeps intent groups disjoint and filler free of intent keywords", () => {
    const groups = [ANIME_IDS, COMEDY_IDS, WAR_IDS, ROMANCE_IDS, SCIFI_SERIES_IDS]
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        for (const id of groups[i]!) expect(groups[j]!.has(id)).toBe(false)
      }
    }
    const intentWord = /anime|comedy|war|romance|sci-?fi|science[- ]fiction|dark/i
    for (const c of AI_DISCOVERY_CATALOGUE) {
      if (c.id.startsWith("f")) {
        expect(`${c.title} ${c.overview ?? ""}`).not.toMatch(intentWord)
      }
    }
    expect(NO_ANIME_CATALOGUE.every((c) => !hasAnimeSignal(c))).toBe(true)
    expect(NO_ANIME_CATALOGUE.length).toBeLessThan(AI_DISCOVERY_CATALOGUE.length)
  })
})

describe("T1 — the actual production failure", () => {
  it("query 'some fucked up dark anime' retrieves relevant anime and never returns the punctuation-first films", async () => {
    registerAIRanker(aiRanker)
    const out = await rankDiscover(DARK_ANIME_QUERY, AI_DISCOVERY_CATALOGUE, plainTaste())

    expect(out.source).toBe("ai")
    expect(chatMock).toHaveBeenCalledTimes(1)
    // The model must have been SHOWN relevant anime (beyond index
    // 20), not just the punctuation block it was fed on base.
    const shown = poolOf(0)
    expect([...shown].some((id) => ANIME_IDS.has(id))).toBe(true)
    // Results: anime present and prioritised, punctuation excluded.
    const animeResults = out.results.filter((r) => hasAnimeSignal(r.candidate))
    expect(animeResults.length).toBeGreaterThanOrEqual(3)
    expect(hasAnimeSignal(out.results[0]!.candidate)).toBe(true)
    const titles = out.results.map((r) => r.candidate.title)
    for (const bad of PUNCTUATION_TITLES) expect(titles).not.toContain(bad)
    // Every anime ranks above every non-anime in the results.
    const lastAnime = Math.max(...out.results.map((r, i) => (hasAnimeSignal(r.candidate) ? i : -1)))
    const firstNonAnime = out.results.findIndex((r) => !hasAnimeSignal(r.candidate))
    expect(lastAnime).toBeLessThan(firstNonAnime === -1 ? Number.POSITIVE_INFINITY : firstNonAnime)
  })
})

describe("T2 — unrelated prompts must not share one arbitrary shortlist", () => {
  it("five unrelated prompts get five substantially different, intent-relevant candidate pools", async () => {
    registerAIRanker(aiRanker)
    const prompts: Array<{ query: string; intentIds: Set<string> }> = [
      { query: "comedy", intentIds: COMEDY_IDS },
      { query: "dark anime", intentIds: ANIME_IDS },
      { query: "historical war films", intentIds: WAR_IDS },
      { query: "light-hearted romance", intentIds: ROMANCE_IDS },
      { query: "science-fiction series", intentIds: SCIFI_SERIES_IDS },
    ]
    const pools: Array<Set<string>> = []
    for (const { query } of prompts) {
      await rankDiscover(query, AI_DISCOVERY_CATALOGUE, plainTaste(), { forceAi: true })
      pools.push(poolOf(pools.length))
    }
    expect(chatMock).toHaveBeenCalledTimes(5)
    for (let i = 0; i < prompts.length; i++) {
      const pool = pools[i]!
      // Intent-relevant: at least one title from the intent's group.
      expect([...pool].some((id) => prompts[i]!.intentIds.has(id))).toBe(true)
      // Not the arbitrary first page: the pool is not the first 20.
      expect(pool).not.toEqual(FIRST_TWENTY_IDS)
      for (let j = i + 1; j < prompts.length; j++) {
        // Substantially different pools per intent.
        expect(jaccard(pool, pools[j]!)).toBeLessThan(0.5)
      }
    }
  })
})

describe("T3 — explicit short-query AI", () => {
  it("'comedy' + manual Ask AI calls the model when configured, with comedy-relevant candidates", async () => {
    registerAIRanker(aiRanker)
    const out = await rankDiscover("comedy", AI_DISCOVERY_CATALOGUE, plainTaste(), { forceAi: true })

    expect(chatMock).toHaveBeenCalledTimes(1)
    expect(out.source).toBe("ai")
    expect([...poolOf(0)].some((id) => COMEDY_IDS.has(id))).toBe(true)
    expect(out.results.length).toBeGreaterThan(0)
    expect(
      out.results.every((r) => r.candidate.genres.map((g) => g.toLowerCase()).includes("comedy")),
    ).toBe(true)
  })

  it("does not call the model when AI is off, and says so honestly", async () => {
    registerAIRanker(aiRanker)
    aiEnabled.value = false
    const out = await rankDiscover("comedy", AI_DISCOVERY_CATALOGUE, plainTaste(), { forceAi: true })
    expect(chatMock).not.toHaveBeenCalled()
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toMatch(/isn't set up/)
  })
})

describe("T4 — composite identity (movie:123 vs series:123)", () => {
  it("returns both the movie and the series sharing provider id 123, with correct kinds — including from cache", async () => {
    // Focused catalogue: both 123s are plainly retrievable for a
    // comedy query, so this test isolates IDENTITY (do the two
    // kinds survive as two titles?) from retrieval (T1's job).
    registerAIRanker(aiRanker)
    const focused = [
      COMPOSITE_MOVIE_123,
      COMPOSITE_SERIES_123,
      candidate({ id: "c0", title: "The Awkward Reunion", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "c1", title: "My Neighbour's Goat", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "c2", title: "Lawn Order", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "c3", title: "Flatpack", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "w0", title: "The Winter Offensive", genres: ["War"], overview: "A historical war film." }),
      candidate({ id: "w1", title: "No Man's Land", genres: ["War"], overview: "A historical war film." }),
    ]
    const out = await rankDiscover("comedy", focused, plainTaste(), { forceAi: true })
    const keys = out.results.map((r) => `${r.candidate.kind}:${r.candidate.id}`)
    expect(keys).toContain("movie:123")
    expect(keys).toContain("series:123")
    expect(out.results.find((r) => r.candidate.kind === "movie" && r.candidate.id === "123")?.candidate.title).toBe(
      "The 123rd Laugh",
    )
    expect(out.results.find((r) => r.candidate.kind === "series" && r.candidate.id === "123")?.candidate.title).toBe(
      "The 123rd Laugh: The Series",
    )
    // Second identical ask: the cached answer must keep both kinds.
    const again = await rankDiscover("comedy", focused, plainTaste(), { forceAi: true })
    const keysAgain = again.results.map((r) => `${r.candidate.kind}:${r.candidate.id}`)
    expect(keysAgain).toContain("movie:123")
    expect(keysAgain).toContain("series:123")
    expect(chatMock).toHaveBeenCalledTimes(1)
  })

  it("keeps both kinds apart at the ranker level on a small candidate list", async () => {
    const small = [
      COMPOSITE_MOVIE_123,
      COMPOSITE_SERIES_123,
      candidate({ id: "c0", title: "The Awkward Reunion", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "c1", title: "My Neighbour's Goat", genres: ["Comedy"], overview: "A funny comedy." }),
    ]
    const ranked = await aiRanker.rank("comedy", small, {
      favouriteGenres: [],
      likedTitles: [],
      dislikedTitles: [],
    })
    const keys = ranked.map((r) => `${r.candidate.kind}:${r.candidate.id}`)
    expect(keys).toContain("movie:123")
    expect(keys).toContain("series:123")
    expect(ranked).toHaveLength(4)
  })
})

describe("T5 — cache isolation", () => {
  function smallList(): DiscoverCandidate[] {
    return [
      candidate({ id: "c1", title: "Alpha", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "c2", title: "Beta", genres: ["Comedy"], overview: "A funny comedy." }),
    ]
  }

  const taste = {
    favouriteGenres: [],
    likedTitles: [],
    dislikedTitles: [],
  }

  it("a different query is a fresh request, not a stale hit", async () => {
    await aiRanker.rank("cosy", smallList(), taste)
    await aiRanker.rank("funny", smallList(), taste)
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("a different playlist (different candidates) is a fresh request", async () => {
    await aiRanker.rank("comedy", smallList(), taste)
    await aiRanker.rank(
      "comedy",
      [candidate({ id: "d1", title: "Gamma", genres: ["Comedy"], overview: "A funny comedy." })],
      taste,
    )
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("the same query under a different profile (taste) must not serve the other profile's cached ranking", async () => {
    installSessionStorageStub()
    shareTaste.value = true
    registerAIRanker(aiRanker)
    const mixed = [
      candidate({ id: "m-a1", kind: "movie", title: "Crimson Ronin", genres: ["Animation", "Thriller"], overview: "A dark anime." }),
      candidate({ id: "m-a2", kind: "movie", title: "Black Sakura", genres: ["Animation", "Horror"], overview: "A dark anime." }),
      candidate({ id: "m-c1", kind: "movie", title: "The Awkward Reunion", genres: ["Comedy"], overview: "A funny comedy." }),
      candidate({ id: "m-c2", kind: "movie", title: "Lawn Order", genres: ["Comedy"], overview: "A funny comedy." }),
    ]
    const animeLover = recordFeedback(plainTaste(), {
      kind: "movie", id: "m-a1", title: "Crimson Ronin", action: "like",
      genres: ["Animation"], cast: [],
    })
    const comedyLover = recordFeedback(plainTaste(), {
      kind: "movie", id: "m-c1", title: "The Awkward Reunion", action: "like",
      genres: ["Comedy"], cast: [],
    })
    const first = await rankDiscover("something for tonight", mixed, animeLover)
    expect(first.results[0]!.candidate.genres).toContain("Animation")
    // Same query, different profile: the answer must reflect THIS
    // profile's taste, not the first profile's cached ranking.
    // (Deliberately through rankDiscover, not the ranker directly:
    // a context-changed repeat may legitimately be answered by a
    // fresh AI call OR by an honest local fallback — what it must
    // never be is the other profile's stale AI ranking. The 60s
    // repeat guard still stands for identical requests; see
    // tests/ai-usage.test.ts.)
    const second = await rankDiscover("something for tonight", mixed, comedyLover)
    expect(second.results[0]!.candidate.genres).toContain("Comedy")
    expect(second.results.map((r) => r.candidate.id)).not.toEqual(
      first.results.map((r) => r.candidate.id),
    )
  })

  it("a catalogue refresh reusing the same ids must not serve stale titles", async () => {
    const v1 = [
      candidate({ id: "c1", title: "Alpha", genres: ["Comedy"], overview: "A funny comedy about Alpha." }),
      candidate({ id: "c2", title: "Beta", genres: ["Comedy"], overview: "A funny comedy about Beta." }),
    ]
    const v2 = [
      candidate({ id: "c1", title: "Alpha (Remastered)", genres: ["Comedy"], overview: "A funny comedy about Alpha, remastered." }),
      candidate({ id: "c2", title: "Beta (Remastered)", genres: ["Comedy"], overview: "A funny comedy about Beta, remastered." }),
    ]
    await aiRanker.rank("comedy", v1, taste)
    const second = await aiRanker.rank("comedy", v2, taste)
    expect(second.map((r) => r.candidate.title)).toEqual(["Alpha (Remastered)", "Beta (Remastered)"])
  })

  it("a model change is a fresh request, not a stale hit", async () => {
    aiModel.value = "gpt-4o-mini"
    await aiRanker.rank("comedy", smallList(), taste)
    aiModel.value = "gpt-4o"
    await aiRanker.rank("comedy", smallList(), taste)
    expect(chatMock).toHaveBeenCalledTimes(2)
  })
})

describe("T6 — bad model output", () => {
  it("an invented id is rejected and the UI is told the recommendation did not succeed", async () => {
    registerAIRanker(aiRanker)
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({ intent: {}, rankings: [{ id: "ghost-999", reason: "Trust me." }] }),
      model: "gpt-4o-mini",
    })
    const out = await rankDiscover(DARK_ANIME_QUERY, AI_DISCOVERY_CATALOGUE, plainTaste())
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toBeTruthy()
    expect(out.results.map((r) => r.candidate.id)).not.toContain("ghost-999")
  })

  it("a real-but-unrelated candidate from the model is rejected, not presented as a relevant pick", async () => {
    registerAIRanker(aiRanker)
    // The model ranks ONLY 'G' Men — a real catalogue id, but not a
    // dark anime. Post-ranking validation must reject it.
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({
        intent: { genres: ["Animation"], mood: "dark" },
        rankings: [{ id: "p0", reason: "Dark and gritty." }],
      }),
      model: "gpt-4o-mini",
    })
    const out = await rankDiscover(DARK_ANIME_QUERY, AI_DISCOVERY_CATALOGUE, plainTaste())
    expect(out.results.map((r) => r.candidate.title)).not.toContain("'G' Men")
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toBeTruthy()
  })
})

describe("T7 — missing metadata", () => {
  const sparseCatalogue = AI_DISCOVERY_CATALOGUE.filter((c) => SPARSE_IDS.has(c.id))

  it("titles with no genres, synopsis, rating or year rank honestly — no fabricated attributes, no crash", () => {
    const results = searchDiscover("anime", sparseCatalogue, plainTaste())
    expect(results.length).toBeGreaterThan(0)
    // The sparse anime titles are found by title text.
    expect(results.map((r) => r.candidate.id)).toEqual(
      expect.arrayContaining(["sp0", "sp1"]),
    )
    const genreWords = /animation|comedy|drama|horror|thriller|romance|war|sci-?fi/i
    for (const entry of results) {
      // No fabricated metadata on the candidate itself.
      // (sp5/sp6/sp7 carry a rating or year by design; the rest do not.)
      if (SPARSE_IDS.has(entry.candidate.id) && !["sp5", "sp6", "sp7"].includes(entry.candidate.id)) {
        expect(entry.candidate.rating).toBeUndefined()
      }
      // No reason may claim a genre the title does not carry, or a
      // rating it does not have.
      if (entry.candidate.genres.length === 0) {
        expect(entry.reason).not.toMatch(genreWords)
        expect(entry.reason).not.toMatch(/rated|★/i)
      }
    }
  })

  it("a catalogue row arriving without genres at all must not crash search", () => {
    const broken = {
      id: "xx",
      kind: "movie",
      title: "No Genres At All",
      genres: undefined,
      cast: [],
      source: "catalog",
    } as unknown as DiscoverCandidate
    expect(() =>
      searchDiscover("anime", [broken, ...sparseCatalogue], plainTaste()),
    ).not.toThrow()
    expect(() =>
      rankCandidates([broken, ...sparseCatalogue], plainTaste()),
    ).not.toThrow()
  })

  it("the same row must not crash Discover's AI-failure fallback either", async () => {
    registerAIRanker({
      rank: async () => {
        throw Object.assign(new Error("provider down"), { kind: "unavailable" })
      },
    })
    const broken = {
      id: "xx",
      kind: "movie",
      title: "No Genres At All",
      genres: undefined,
      cast: [],
      source: "catalog",
    } as unknown as DiscoverCandidate
    // forceAi: the one-word query would otherwise never reach the
    // ranker at all (plain title search), so there would be no
    // fallback to exercise.
    const out = await rankDiscover("anime", [broken, ...sparseCatalogue], plainTaste(), { forceAi: true })
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toBeTruthy()
  })
})

describe("T8 — empty matches", () => {
  it("with no verified anime in the catalogue, nothing is presented as an anime match — and the UI gets its broaden hook", async () => {
    registerAIRanker(aiRanker)
    const out = await rankDiscover(DARK_ANIME_QUERY, NO_ANIME_CATALOGUE, plainTaste())
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toBeTruthy()
    expect(out.results).toEqual([])
    expect(out.results.some((r) => hasAnimeSignal(r.candidate))).toBe(false)
  })
})

describe("T9 — personalisation", () => {
  function tasteLiking(title: string, id: string, genres: string[]): TasteModel {
    return recordFeedback(plainTaste(), {
      kind: "movie", id, title, action: "like", genres, cast: [],
    })
  }

  it("identical catalogue and query, different established tastes → different relevant ordering", () => {
    const catalogue = smallMixedCatalogue()
    const animeLover = tasteLiking("Crimson Ronin", "n-a2", ["Animation", "Thriller"])
    const comedyLover = tasteLiking("The Awkward Reunion", "n-c1", ["Comedy"])
    const forAnime = searchDiscover("something for tonight", catalogue, animeLover)
    const forComedy = searchDiscover("something for tonight", catalogue, comedyLover)
    expect(forAnime[0]!.candidate.genres).toContain("Animation")
    expect(forComedy[0]!.candidate.genres).toContain("Comedy")
    expect(forAnime.map((r) => r.candidate.id)).not.toEqual(
      forComedy.map((r) => r.candidate.id),
    )
  })

  it("a disliked title is a hard constraint: it never surfaces as an AI pick, however relevant", async () => {
    registerAIRanker(aiRanker)
    let taste = plainTaste()
    taste = recordFeedback(taste, {
      kind: "movie", id: "n-a1", title: "Black Sakura", action: "dislike",
      genres: ["Animation", "Horror"], cast: [],
    })
    const out = await rankDiscover(DARK_ANIME_QUERY, smallMixedCatalogue(), taste)
    expect(out.results.map((r) => r.candidate.id)).not.toContain("n-a1")
    // The constraint is surgical: the other dark anime still surface.
    expect(out.results.map((r) => r.candidate.id)).toEqual(
      expect.arrayContaining(["n-a2", "n-a3"]),
    )
    expect(hasAnimeSignal(out.results[0]!.candidate)).toBe(true)
  })

  it("a not-interested title is a hard constraint too", async () => {
    registerAIRanker(aiRanker)
    let taste = plainTaste()
    taste = recordFeedback(taste, {
      kind: "movie", id: "n-a2", title: "Crimson Ronin", action: "not-interested",
      genres: ["Animation", "Thriller"], cast: [],
    })
    const out = await rankDiscover(DARK_ANIME_QUERY, smallMixedCatalogue(), taste)
    expect(out.results.map((r) => r.candidate.id)).not.toContain("n-a2")
    expect(out.results.map((r) => r.candidate.id)).toEqual(
      expect.arrayContaining(["n-a1", "n-a3"]),
    )
  })
})

describe("T10 — cost controls: no unrequested paid calls", () => {
  it("typing a search fires zero model calls (local search only)", () => {
    registerAIRanker(aiRanker)
    for (const keystroke of ["c", "co", "com", "come", "comed", "comedy"]) {
      searchDiscover(keystroke, AI_DISCOVERY_CATALOGUE, plainTaste())
    }
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("opening Discover rows / re-ranking locally fires zero model calls", () => {
    registerAIRanker(aiRanker)
    const rows = getDiscoverRows({
      candidates: AI_DISCOVERY_CATALOGUE,
      taste: plainTaste(),
      continueWatching: [],
      recentlyAdded: AI_DISCOVERY_CATALOGUE.slice(100, 110),
      nowPlaying: [],
      watchedKeys: new Set(),
    })
    expect(rows.length).toBeGreaterThan(0)
    rankCandidates(AI_DISCOVERY_CATALOGUE, plainTaste(), { limit: 12 })
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("a short keyword query without an explicit Ask AI never reaches the model", async () => {
    registerAIRanker(aiRanker)
    const out = await rankDiscover("comedy", AI_DISCOVERY_CATALOGUE, plainTaste())
    expect(chatMock).not.toHaveBeenCalled()
    expect(out.source).toBe("local")
  })
})
