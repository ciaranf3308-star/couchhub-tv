/**
 * @vitest-environment jsdom
 */
// W2 (0.11.5): AI reranking + validation + composite IDs + cache identity.
// The model client is mocked — no key, no network. Fixtures are synthetic.
import { describe, it, expect, beforeEach, vi } from "vitest"

function makeStorageMock(store: Map<string, string>): Storage {
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
  }
}
vi.stubGlobal("localStorage", makeStorageMock(new Map<string, string>()))
vi.stubGlobal("sessionStorage", makeStorageMock(new Map<string, string>()))

const { chatMock, aiEnabled, aiModel, MockAiError } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  aiEnabled: { value: true },
  aiModel: { value: "gpt-4o-mini" },
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
  getAiEndpoint: () => "https://api.openai.com/v1",
  getAiModel: () => aiModel.value,
}))

import {
  aiRanker,
  buildAiPrompt,
  parseAiRankResponse,
  validateAiRankings,
  compositeCandidateId,
  clearAiRankCache,
  clearAiUsageState,
  subscribeAiRankStatus,
  getLastAiRankStatus,
  type AiRankStatus,
  type DiscoverCandidate,
  type TasteSummary,
} from "@/scripts/lib/ai/ranking"

const taste: TasteSummary = {
  favouriteGenres: ["Comedy", "Drama"],
  likedTitles: ["The Office"],
  dislikedTitles: ["Saw"],
}

function candidate(overrides: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    id: "c1",
    kind: "movie",
    title: "Test Film",
    year: 2020,
    rating: 7.5,
    genres: ["Comedy"],
    cast: ["Someone Famous"],
    runtimeMinutes: 100,
    overview: "A cosy film about nothing much.",
    posterUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
    source: "tmdb",
    ...overrides,
  }
}

function modelReply(rankings: Array<{ id: string; reason?: string }>): string {
  return JSON.stringify({ intent: { genres: ["Comedy"], mood: "cosy" }, rankings })
}

const anime = candidate({
  id: "7",
  kind: "series",
  title: "Attack on Titan",
  year: 2013,
  rating: 9.0,
  genres: ["Animation", "Action", "Horror"],
  cast: [],
  runtimeMinutes: 24,
  overview: "Dark fantasy anime about humanity's fight against giants.",
})
const gMen = candidate({
  id: "8",
  kind: "movie",
  title: "'G' Men",
  year: 1935,
  rating: 6.5,
  genres: ["Crime", "Drama"],
  cast: [],
  runtimeMinutes: 85,
  overview: "A lawyer joins the FBI to fight gangsters.",
})

beforeEach(() => {
  vi.resetAllMocks()
  aiEnabled.value = true
  aiModel.value = "gpt-4o-mini"
  localStorage.clear()
  sessionStorage.clear()
  clearAiRankCache()
  clearAiUsageState()
  chatMock.mockResolvedValue({
    text: modelReply([
      { id: "movie:c1", reason: "Cosy and funny." },
      { id: "movie:c2", reason: "Gentle drama." },
    ]),
    model: "gpt-4o-mini",
  })
})

/** Phases emitted for one query, in order (late-subscriber replay filtered out by query + start time). */
function collectPhasesFor(query: string): { phases: string[]; unsubscribe: () => void } {
  const phases: string[] = []
  const since = Date.now()
  const unsubscribe = subscribeAiRankStatus((status: AiRankStatus) => {
    if (status.query === query && status.startedAt >= since) phases.push(status.phase)
  })
  // The subscribe replays the last known status synchronously (a
  // late-subscriber feature for W3's UI); drop that replay so the
  // phases below are only this test's own lifecycle.
  phases.length = 0
  return { phases, unsubscribe }
}

describe("composite IDs (Bug 5)", () => {
  it("prompts with kind:id so a movie and a series sharing 123 stay distinct", () => {
    const movie123 = candidate({ id: "123", kind: "movie", title: "Movie 123" })
    const series123 = candidate({ id: "123", kind: "series", title: "Series 123" })
    const { user } = buildAiPrompt("x", [movie123, series123], taste)
    expect(user).toContain("[movie:123] Movie 123")
    expect(user).toContain("[series:123] Series 123")
    expect(compositeCandidateId(movie123)).toBe("movie:123")
    expect(compositeCandidateId(series123)).toBe("series:123")
  })

  it("resolves series:123 to the series, never the movie", async () => {
    const movie123 = candidate({ id: "123", kind: "movie", title: "Movie 123" })
    const series123 = candidate({ id: "123", kind: "series", title: "Series 123" })
    chatMock.mockResolvedValueOnce({
      text: modelReply([{ id: "series:123", reason: "The series one." }]),
      model: "gpt-4o-mini",
    })
    const ranked = await aiRanker.rank("x", [movie123, series123], taste)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].candidate.kind).toBe("series")
    expect(ranked[0].candidate.title).toBe("Series 123")
  })

  it("drops an ambiguous bare ID instead of guessing movie vs series", () => {
    const movie123 = candidate({ id: "123", kind: "movie", title: "Movie 123" })
    const series123 = candidate({ id: "123", kind: "series", title: "Series 123" })
    expect(() =>
      parseAiRankResponse(modelReply([{ id: "123", reason: "Which one?" }]), [
        movie123,
        series123,
      ])
    ).toThrow()
  })

  it("still accepts an unambiguous bare ID (back-compat with older replies)", () => {
    const parsed = parseAiRankResponse(modelReply([{ id: "c1", reason: "Cosy." }]), [
      candidate({ id: "c1" }),
    ])
    expect(parsed.rankings).toHaveLength(1)
    expect(parsed.rankings[0].candidate.title).toBe("Test Film")
  })

  it("never serves a cached movie as the series (or vice versa) for shared id 123", async () => {
    const movie123 = candidate({ id: "123", kind: "movie", title: "Movie 123" })
    const series123 = candidate({ id: "123", kind: "series", title: "Series 123" })
    chatMock.mockResolvedValueOnce({
      text: modelReply([{ id: "movie:123", reason: "The movie one." }]),
      model: "gpt-4o-mini",
    })
    const first = await aiRanker.rankShortlist({
      query: "something 123",
      shortlist: [movie123],
      tasteSummary: taste,
    })
    expect(first.rankings[0].candidate.kind).toBe("movie")
    expect(chatMock).toHaveBeenCalledTimes(1)

    // Same query, different candidate selection, memory cache cleared:
    // the session cache must NOT answer with the movie.
    clearAiRankCache()
    clearAiUsageState() // reset the 60s repeat guard so a fresh request is possible
    chatMock.mockResolvedValueOnce({
      text: modelReply([{ id: "series:123", reason: "The series one." }]),
      model: "gpt-4o-mini",
    })
    const second = await aiRanker.rankShortlist({
      query: "something 123",
      shortlist: [series123],
      tasteSummary: taste,
    })
    expect(chatMock).toHaveBeenCalledTimes(2)
    expect(second.rankings).toHaveLength(1)
    expect(second.rankings[0].candidate.kind).toBe("series")
    expect(second.rankings[0].candidate.title).toBe("Series 123")
  })
})

describe("cache identity (Bug 6)", () => {
  const two = [candidate({ id: "c1" }), candidate({ id: "c2", title: "Second Film" })]

  it("reuses a valid previous result and labels it cached", async () => {
    const first = await aiRanker.rankShortlist({
      query: "something cosy",
      shortlist: two,
      tasteSummary: taste,
    })
    expect(first.source).toBe("ai")
    expect(chatMock).toHaveBeenCalledTimes(1)
    const second = await aiRanker.rankShortlist({
      query: "something cosy",
      shortlist: two,
      tasteSummary: taste,
    })
    expect(chatMock).toHaveBeenCalledTimes(1)
    expect(second.source).toBe("cached")
    expect(second.status.phase).toBe("cached")
    expect(second.status.cacheHit).toBe(true)
    expect(second.rankings.map((r) => r.candidate.id)).toEqual(
      first.rankings.map((r) => r.candidate.id)
    )
  })

  it("does not reuse a result for a different query", async () => {
    await aiRanker.rankShortlist({ query: "cosy", shortlist: two, tasteSummary: taste })
    clearAiUsageState()
    await aiRanker.rankShortlist({ query: "tense", shortlist: two, tasteSummary: taste })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a result against a different playlist", async () => {
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: taste,
      context: { playlistId: "playlist-a" },
    })
    clearAiRankCache()
    clearAiUsageState()
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: taste,
      context: { playlistId: "playlist-b" },
    })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a result against a different profile", async () => {
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: taste,
      context: { playlistId: "p", profileId: "alice" },
    })
    clearAiRankCache()
    clearAiUsageState()
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: taste,
      context: { playlistId: "p", profileId: "bob" },
    })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a result when the catalogue stamp changed", async () => {
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: taste,
      context: { playlistId: "p", catalogueStamp: 100 },
    })
    clearAiRankCache()
    clearAiUsageState()
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: taste,
      context: { playlistId: "p", catalogueStamp: 200 },
    })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a result when the model changed", async () => {
    await aiRanker.rankShortlist({ query: "cosy", shortlist: two, tasteSummary: taste })
    clearAiRankCache()
    clearAiUsageState()
    aiModel.value = "gpt-4o"
    await aiRanker.rankShortlist({ query: "cosy", shortlist: two, tasteSummary: taste })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a result when the candidate selection changed", async () => {
    await aiRanker.rankShortlist({ query: "cosy", shortlist: two, tasteSummary: taste })
    clearAiRankCache()
    clearAiUsageState()
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: [candidate({ id: "c1" })],
      tasteSummary: taste,
    })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a result when taste changed (taste sharing opted in)", async () => {
    // Taste only affects the request when the user opted into sharing
    // it — with sharing off, a taste change correctly does NOT bust
    // the cache, because the sent payload is identical.
    localStorage.setItem("xt_ai_share_taste", "1")
    await aiRanker.rankShortlist({ query: "cosy", shortlist: two, tasteSummary: taste })
    clearAiRankCache()
    clearAiUsageState()
    await aiRanker.rankShortlist({
      query: "cosy",
      shortlist: two,
      tasteSummary: { ...taste, favouriteGenres: ["Horror"] },
    })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })
})

describe("post-ranking validation (Bug 7)", () => {
  it("drops the production failure: a crime drama is not a dark anime", async () => {
    chatMock.mockResolvedValueOnce({
      text: modelReply([
        { id: "movie:8", reason: "Dark and gritty." },
        { id: "series:7", reason: "Dark anime." },
      ]),
      model: "gpt-4o-mini",
    })
    const ranked = await aiRanker.rank("some fucked up dark anime", [anime, gMen], taste)
    expect(ranked.map((r) => r.candidate.title)).toEqual(["Attack on Titan"])
  })

  it("returns [] (not an error) when every model pick is unrelated", async () => {
    const { phases, unsubscribe } = collectPhasesFor("some fucked up dark anime")
    try {
      chatMock.mockResolvedValueOnce({
        text: modelReply([{ id: "movie:8", reason: "Dark and gritty." }]),
        model: "gpt-4o-mini",
      })
      const ranked = await aiRanker.rank("some fucked up dark anime", [gMen], taste)
      expect(ranked).toEqual([])
      const status = getLastAiRankStatus()
      expect(status?.phase).toBe("rejected")
      expect(status?.keptCount).toBe(0)
      expect(status?.droppedCount).toBe(1)
      expect(status?.droppedReasons?.[0].reason).toBe("unrelated-medium")
      expect(phases).toEqual(["sending", "response-received", "rejected"])
    } finally {
      unsubscribe()
    }
  })

  it("allows the model to reject every candidate with an empty list", async () => {
    const { phases, unsubscribe } = collectPhasesFor("dark anime")
    try {
      chatMock.mockResolvedValueOnce({
        text: JSON.stringify({ intent: {}, rankings: [] }),
        model: "gpt-4o-mini",
      })
      const ranked = await aiRanker.rank("dark anime", [anime, gMen], taste)
      expect(ranked).toEqual([])
      expect(getLastAiRankStatus()?.phase).toBe("rejected")
      expect(phases).toEqual(["sending", "response-received", "rejected"])
      // ...and the empty rejection is cached: no second paid request.
      const again = await aiRanker.rank("dark anime", [anime, gMen], taste)
      expect(again).toEqual([])
      expect(chatMock).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it("drops hard-constraint violations from the model", () => {
    const long = candidate({ id: "long", title: "Epic", runtimeMinutes: 180 })
    const { rankings, report } = validateAiRankings(
      [{ candidate: long, score: 1, reason: "Great epic." }],
      [long],
      { maxRuntimeMinutes: 60 },
      "something short"
    )
    expect(rankings).toEqual([])
    expect(report.dropped).toHaveLength(1)
    expect(report.dropped[0].reason).toBe("constraint-runtime")
  })

  it("drops a movie when the intent says series", () => {
    const movie = candidate({ id: "m", kind: "movie", title: "A Film" })
    const { rankings, report } = validateAiRankings(
      [{ candidate: movie, score: 1, reason: "Good." }],
      [movie],
      { kind: "series" },
      "a gripping series"
    )
    expect(rankings).toEqual([])
    expect(report.dropped[0].reason).toBe("constraint-kind")
  })

  it("drops a same-title re-listing and keeps model order for the rest", () => {
    const first = candidate({ id: "a1", title: "Same Title", year: 2020 })
    const second = candidate({ id: "a2", title: "Same Title", year: 2020 })
    const { rankings, report } = validateAiRankings(
      [
        { candidate: first, score: 1, reason: "Good." },
        { candidate: second, score: 0.5, reason: "Also good." },
      ],
      [first, second],
      undefined,
      "same title"
    )
    expect(rankings.map((r) => r.candidate.id)).toEqual(["a1"])
    expect(report.dropped[0].reason).toBe("title-group-duplicate")
  })

  it("replaces a reason that claims a genre the title does not have", () => {
    const comedy = candidate({ id: "c1", genres: ["Comedy"] })
    const { rankings } = validateAiRankings(
      [{ candidate: comedy, score: 1, reason: "A terrifying horror classic." }],
      [comedy],
      undefined,
      "something funny"
    )
    expect(rankings).toHaveLength(1)
    expect(rankings[0].reason).toBe("Ranked by AI for this search.")
  })
})

describe("rerank prompt (Bug 1)", () => {
  it("renders the whole relevance-ranked shortlist — no first-20 truncation in the prompt", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      candidate({ id: `c${index}`, title: `Film ${index}` })
    )
    const { user } = buildAiPrompt("x", many, taste)
    expect(user).toContain("Film 19")
    expect(user).toContain("Film 20")
    expect(user).toContain("Film 24")
  })

  it("tells the model it may return an empty list and names the constraints", () => {
    const { system, user } = buildAiPrompt("dark anime", [anime], taste, {
      kind: "series",
      maxRuntimeMinutes: 30,
    })
    expect(system).toContain("empty rankings list")
    expect(user).toContain("Only series titles.")
    expect(user).toContain("No title longer than 30 minutes.")
  })
})

describe("lifecycle status for W3", () => {
  it("emits sending → response-received → validated for a good call", async () => {
    const { phases, unsubscribe } = collectPhasesFor("something cosy")
    try {
      const result = await aiRanker.rankShortlist({
        query: "something cosy",
        shortlist: [candidate({ id: "c1" }), candidate({ id: "c2", title: "Second" })],
        tasteSummary: taste,
      })
      expect(result.status.phase).toBe("validated")
      expect(result.status.model).toBe("gpt-4o-mini")
      expect(result.status.durationMs).not.toBeNull()
      expect(result.status.cacheHit).toBe(false)
      expect(result.status.requestedCount).toBe(2)
      expect(result.status.keptCount).toBe(2)
      expect(phases).toEqual(["sending", "response-received", "validated"])
    } finally {
      unsubscribe()
    }
  })

  it("emits an error status with the kind when the provider fails", async () => {
    const { phases, unsubscribe } = collectPhasesFor("something cosy")
    try {
      chatMock.mockRejectedValueOnce(new MockAiError("rate_limited", "slow down"))
      await expect(
        aiRanker.rankShortlist({
          query: "something cosy",
          shortlist: [candidate({ id: "c1" })],
          tasteSummary: taste,
        })
      ).rejects.toMatchObject({ kind: "rate_limited" })
      expect(getLastAiRankStatus()?.phase).toBe("error")
      expect(getLastAiRankStatus()?.errorKind).toBe("rate_limited")
      expect(phases).toEqual(["sending", "error"])
    } finally {
      unsubscribe()
    }
  })
})
