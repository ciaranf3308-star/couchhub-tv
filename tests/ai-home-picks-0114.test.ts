// Home AI core tests (0.11.14, W4). The model transport, the TMDb
// verifier and the provider identity are all faked — no key, no
// network, no real LLM/TMDb calls. Fixtures are synthetic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const { chatMock, verifyMock, provider, flags, MockAiError } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  verifyMock: vi.fn(),
  provider: { endpoint: "https://api.example.invalid/v1", model: "gpt-4o-mini" },
  flags: { enabled: true, shareTaste: false, homeAutoRefresh: false },
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

vi.mock("@/scripts/lib/ai/status.js", () => ({
  getAiShareTaste: () => flags.shareTaste,
  getAiHomeAutoRefresh: () => flags.homeAutoRefresh,
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getAiEnabled: () => flags.enabled,
  getAiEndpoint: () => provider.endpoint,
  getAiModel: () => provider.model,
}))

vi.mock("@/scripts/lib/ai/verification.js", () => ({
  verifyRecommendations: verifyMock,
  defaultTmdbSearch: vi.fn(() => async () => []),
  defaultFetchDetails: vi.fn(async () => null),
  defaultResolveExternalId: vi.fn(() => async () => null),
}))

import {
  buildHomeAiCacheKey,
  buildHomeAiLedgerKey,
  clearHomeAiAttempts,
  clearHomeAiCache,
  isHomeAiAttemptBounded,
  lastHomeAiAttemptAt,
  readHomeAiCacheEntry,
  recordHomeAiAttempt,
  writeHomeAiCacheEntry,
  HOME_AI_CACHE_MAX_ENTRIES,
  HOME_AI_CACHE_TTL_MS,
  type HomeAiPick,
} from "@/scripts/lib/ai/home-cache"
import {
  decideHomeAiAutoRefresh,
  homeAiAllowsSelectorBoost,
  homeAiSourceLabel,
  maybeAutoRefreshHomeAiPicks,
  prepareHomePool,
  readCachedHomeAiPicks,
  requestHomeAiDiscovery,
  requestHomeAiPicks,
  toSelectorAiRecommendations,
  validateHomeAiPicks,
  type HomeAiPicksRequest,
} from "@/scripts/lib/ai/home-picks"
import { clearAiRankCache } from "@/scripts/lib/ai/ranking"
import type { DiscoverCandidate } from "@/scripts/lib/discover"
import type { VerifiedRecommendation } from "@/scripts/lib/ai/verification"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    id: "1",
    kind: "movie",
    title: "Test Film",
    year: 2020,
    rating: 7.5,
    genres: ["Comedy"],
    cast: ["Someone Famous"],
    runtimeMinutes: 100,
    overview: "A cosy film about nothing much.",
    source: "catalog",
    ...overrides,
  }
}

const POOL: DiscoverCandidate[] = [
  candidate({ id: "1", title: "Alpha Film", genres: ["Comedy"] }),
  candidate({ id: "2", title: "Beta Film", year: 2021, genres: ["Drama"] }),
  candidate({ id: "3", title: "Gamma Film", year: 2019, genres: ["Thriller"] }),
]

const TASTE = {
  favouriteGenres: ["Comedy"],
  likedTitles: ["Secret Liked Title"],
  dislikedTitles: ["Secret Disliked Title"],
}

function rankReply(ids: string[]): string {
  return JSON.stringify({
    rankings: ids.map((id) => ({ id, reason: "A strong pick for tonight." })),
  })
}

function baseRequest(overrides: Partial<HomeAiPicksRequest> = {}): HomeAiPicksRequest {
  return {
    kind: "movie",
    candidates: POOL,
    taste: TASTE,
    tasteRevision: "t1",
    profileId: "profile-a",
    playlistId: "playlist-1",
    catalogueRevision: "rev-1",
    trigger: "explicit",
    ...overrides,
  }
}

function verifiedRec(
  overrides: Partial<VerifiedRecommendation> = {}
): VerifiedRecommendation {
  return {
    generated: {
      title: "Alpha Film",
      year: 2020,
      kind: "movie",
      reason: "A strong pick for tonight.",
      tone: "cosy",
    },
    verified: true,
    tmdbId: 101,
    title: "Alpha Film",
    year: 2020,
    kind: "movie",
    reason: "A strong pick for tonight.",
    tone: "cosy",
    genres: ["Comedy"],
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    match: { compositeId: "movie:1", kind: "movie", title: "Alpha Film", year: 2020, catalogueKey: "movie:1" },
    ...overrides,
  }
}

let nowMs = 1_700_000_000_000
const clock = () => nowMs

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  nowMs = 1_700_000_000_000
  flags.enabled = true
  flags.shareTaste = false
  flags.homeAutoRefresh = false
  provider.endpoint = "https://api.example.invalid/v1"
  provider.model = "gpt-4o-mini"
  clearAiRankCache()
  clearHomeAiCache()
  clearHomeAiAttempts()
  chatMock.mockResolvedValue({ text: rankReply(["movie:2", "movie:1"]), model: "gpt-4o-mini" })
  verifyMock.mockImplementation(async (recs: Array<{ title: string }>) =>
    recs.map((rec) => verifiedRec({ title: rec.title }))
  )
})

// ---------------------------------------------------------------------------
// Cache identity (§17)
// ---------------------------------------------------------------------------

describe("buildHomeAiCacheKey", () => {
  const base = {
    kind: "movie" as const,
    requestType: "picks" as const,
    profileId: "p1",
    playlistId: "pl1",
    catalogueRevision: "rev-1",
    endpoint: provider.endpoint,
    model: "gpt-4o-mini",
    pipelineVersion: "home:1|rank:2|type:picks",
    tasteRevision: "t1",
    excludeTitles: ["Seen It"],
    excludeCompositeIds: ["movie:9"],
    mood: "dark",
    maxRuntimeMinutes: 120,
  }

  it("is stable for identical inputs", () => {
    expect(buildHomeAiCacheKey(base)).toBe(buildHomeAiCacheKey({ ...base }))
  })

  it("separates profile, playlist, catalogue revision, kind, type, model, taste, exclusions, constraints", () => {
    const key = buildHomeAiCacheKey(base)
    const variants = [
      { ...base, profileId: "p2" },
      { ...base, playlistId: "pl2" },
      { ...base, catalogueRevision: "rev-2" },
      { ...base, kind: "series" as const },
      { ...base, requestType: "discovery" as const },
      { ...base, model: "gpt-4o" },
      { ...base, endpoint: "https://other.example.invalid/v1" },
      { ...base, tasteRevision: "t2" },
      { ...base, excludeTitles: ["Other"] },
      { ...base, excludeCompositeIds: ["movie:8"] },
      { ...base, mood: "funny" },
      { ...base, maxRuntimeMinutes: 90 },
      { ...base, pipelineVersion: "home:2|rank:2|type:picks" },
      { ...base, brief: "a gripping crime series" },
    ]
    for (const variant of variants) {
      expect(buildHomeAiCacheKey(variant)).not.toBe(key)
    }
  })

  it("never embeds the raw endpoint or taste content", () => {
    const key = buildHomeAiCacheKey(base)
    expect(key).not.toContain("api.example.invalid")
    expect(key).not.toContain("Seen It")
  })

  it("normalises exclusion order and case", () => {
    const a = buildHomeAiCacheKey({ ...base, excludeTitles: ["B", "a"] })
    const b = buildHomeAiCacheKey({ ...base, excludeTitles: ["a", "B"] })
    expect(a).toBe(b)
  })
})

describe("durable cache store", () => {
  const pick: HomeAiPick = {
    compositeId: "movie:1",
    kind: "movie",
    id: "1",
    title: "Alpha Film",
    year: 2020,
    score: 1,
    reason: "A strong pick for tonight.",
    tmdbId: null,
  }

  it("round-trips an entry and serves it fresh", () => {
    const key = buildHomeAiCacheKey({
      kind: "movie",
      requestType: "picks",
      pipelineVersion: "v1",
    })
    const entry = writeHomeAiCacheEntry(
      { key, kind: "movie", requestType: "picks", picks: [pick], model: "m", sentToModelCount: 3 },
      nowMs
    )
    expect(entry).not.toBeNull()
    expect(readHomeAiCacheEntry(key, nowMs)?.picks).toHaveLength(1)
  })

  it("expires entries after the TTL and never serves them frozen", () => {
    const key = buildHomeAiCacheKey({
      kind: "movie",
      requestType: "picks",
      pipelineVersion: "v1",
    })
    writeHomeAiCacheEntry(
      { key, kind: "movie", requestType: "picks", picks: [pick], model: "m", sentToModelCount: 3 },
      nowMs
    )
    expect(readHomeAiCacheEntry(key, nowMs + HOME_AI_CACHE_TTL_MS + 1)).toBeNull()
    expect(readHomeAiCacheEntry(key, nowMs)).toBeNull()
  })

  it("refuses empty pick lists and wrong-kind picks", () => {
    const key = buildHomeAiCacheKey({
      kind: "movie",
      requestType: "picks",
      pipelineVersion: "v1",
    })
    expect(
      writeHomeAiCacheEntry(
        { key, kind: "movie", requestType: "picks", picks: [], model: "m", sentToModelCount: 0 },
        nowMs
      )
    ).toBeNull()
    expect(
      writeHomeAiCacheEntry(
        {
          key,
          kind: "movie",
          requestType: "picks",
          picks: [{ ...pick, kind: "series", compositeId: "series:1" }],
          model: "m",
          sentToModelCount: 0,
        },
        nowMs
      )
    ).toBeNull()
  })

  it("bounds the store and evicts oldest first", () => {
    for (let i = 0; i < HOME_AI_CACHE_MAX_ENTRIES + 2; i++) {
      const key = buildHomeAiCacheKey({
        kind: "movie",
        requestType: "picks",
        pipelineVersion: "v1",
        profileId: `p${i}`,
      })
      writeHomeAiCacheEntry(
        { key, kind: "movie", requestType: "picks", picks: [pick], model: "m", sentToModelCount: 1 },
        nowMs + i
      )
    }
    const firstKey = buildHomeAiCacheKey({
      kind: "movie",
      requestType: "picks",
      pipelineVersion: "v1",
      profileId: "p0",
    })
    const lastKey = buildHomeAiCacheKey({
      kind: "movie",
      requestType: "picks",
      pipelineVersion: "v1",
      profileId: `p${HOME_AI_CACHE_MAX_ENTRIES + 1}`,
    })
    expect(readHomeAiCacheEntry(firstKey, nowMs + 100)).toBeNull()
    expect(readHomeAiCacheEntry(lastKey, nowMs + 100)).not.toBeNull()
  })

  it("persists through a localStorage-backed store without secrets", () => {
    const store = new Map<string, string>()
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    const previous = (globalThis as Record<string, unknown>).localStorage
    ;(globalThis as Record<string, unknown>).localStorage = fakeStorage
    try {
      const key = buildHomeAiCacheKey({
        kind: "movie",
        requestType: "picks",
        pipelineVersion: "v1",
        endpoint: provider.endpoint,
        model: provider.model,
      })
      writeHomeAiCacheEntry(
        { key, kind: "movie", requestType: "picks", picks: [pick], model: "gpt-4o-mini", sentToModelCount: 3 },
        nowMs
      )
      // A second "launch" reads the same external store.
      expect(readHomeAiCacheEntry(key, nowMs)?.picks).toHaveLength(1)
      const raw = [...store.values()].join("\n")
      expect(raw).not.toContain("api.example.invalid")
      expect(raw).not.toContain("Secret Liked Title")
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).localStorage
      else (globalThis as Record<string, unknown>).localStorage = previous
    }
  })
})

describe("attempt ledger", () => {
  const ledger = buildHomeAiLedgerKey({
    kind: "movie",
    requestType: "picks",
    profileId: "p1",
    playlistId: "pl1",
    endpoint: provider.endpoint,
    model: provider.model,
  })

  it("bounds repeats for 24h, then frees", () => {
    expect(isHomeAiAttemptBounded(ledger, nowMs)).toBe(false)
    recordHomeAiAttempt(ledger, nowMs)
    expect(lastHomeAiAttemptAt(ledger)).toBe(nowMs)
    expect(isHomeAiAttemptBounded(ledger, nowMs + HOME_AI_CACHE_TTL_MS - 1)).toBe(true)
    expect(isHomeAiAttemptBounded(ledger, nowMs + HOME_AI_CACHE_TTL_MS + 1)).toBe(false)
  })

  it("separates kinds, profiles and providers", () => {
    recordHomeAiAttempt(ledger, nowMs)
    const otherKind = buildHomeAiLedgerKey({ kind: "series", requestType: "picks", profileId: "p1" })
    const otherProfile = buildHomeAiLedgerKey({
      kind: "movie",
      requestType: "picks",
      profileId: "p2",
      playlistId: "pl1",
      endpoint: provider.endpoint,
      model: provider.model,
    })
    expect(isHomeAiAttemptBounded(otherKind, nowMs)).toBe(false)
    expect(isHomeAiAttemptBounded(otherProfile, nowMs)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pool + validation (§18)
// ---------------------------------------------------------------------------

describe("prepareHomePool / validateHomeAiPicks", () => {
  it("drops wrong-kind and live entries before ranking", () => {
    const mixed: DiscoverCandidate[] = [
      ...POOL,
      candidate({ id: "s1", kind: "series", title: "A Series" }),
      candidate({ id: "l1", kind: "live", title: "A Channel" }),
    ]
    const pool = prepareHomePool(mixed, "movie")
    expect(pool.map((c) => c.id)).toEqual(["1", "2", "3"])
  })

  it("applies id and title exclusions", () => {
    const pool = prepareHomePool(POOL, "movie", ["movie:2"], ["gamma film"])
    expect(pool.map((c) => c.id)).toEqual(["1"])
  })

  it("drops invented ids, kind mismatches and duplicates; never fabricates", () => {
    const picks: HomeAiPick[] = [
      { compositeId: "movie:1", kind: "movie", id: "1", title: "Alpha Film", year: 2020, score: 1, reason: "A strong pick for tonight.", tmdbId: null },
      { compositeId: "movie:999", kind: "movie", id: "999", title: "Invented", year: 2020, score: 0.9, reason: "A strong pick for tonight.", tmdbId: null },
      { compositeId: "series:2", kind: "series", id: "2", title: "Beta Film", year: 2021, score: 0.8, reason: "A strong pick for tonight.", tmdbId: null },
      { compositeId: "movie:1", kind: "movie", id: "1", title: "Alpha Film", year: 2020, score: 0.7, reason: "A strong pick for tonight.", tmdbId: null },
    ]
    const { picks: kept, dropped } = validateHomeAiPicks(picks, POOL, "movie")
    expect(kept.map((p) => p.compositeId)).toEqual(["movie:1"])
    expect(dropped.map((d) => d.reason).sort()).toEqual(["duplicate", "kind-mismatch", "not-in-pool"])
  })

  it("series picks resolve to the series entry, never an episode id", () => {
    const seriesPool = [candidate({ id: "s1", kind: "series", title: "Great Series" })]
    const picks: HomeAiPick[] = [
      { compositeId: "series:s1", kind: "series", id: "s1", title: "Great Series", year: 2020, score: 1, reason: "A strong pick for tonight.", tmdbId: null },
    ]
    const { picks: kept } = validateHomeAiPicks(picks, seriesPool, "series")
    expect(kept[0]?.id).toBe("s1")
    expect(kept[0]?.compositeId).toBe("series:s1")
  })
})

// ---------------------------------------------------------------------------
// Rerank path: triggers, privacy, cost controls
// ---------------------------------------------------------------------------

describe("requestHomeAiPicks", () => {
  it("ranks the pool through the model and returns fresh-ai picks in model order", async () => {
    const result = await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    expect(result.source).toBe("fresh-ai")
    expect(result.picks.map((p) => p.id)).toEqual(["2", "1"])
    expect(result.sentToModelCount).toBe(3)
    expect(result.cacheHit).toBe(false)
    expect(result.model).toBe("gpt-4o-mini")
    expect(chatMock).toHaveBeenCalledTimes(1)
  })

  it("serves a fresh cache entry with zero model calls on reopen", async () => {
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    const second = await requestHomeAiPicks(baseRequest(), { chat: chatMock, clock })
    expect(second.source).toBe("cached-ai")
    expect(second.cacheHit).toBe(true)
    expect(second.sentToModelCount).toBe(0)
    expect(second.picks.map((p) => p.id)).toEqual(["2", "1"])
    expect(chatMock).toHaveBeenCalledTimes(1)
  })

  it("forceFresh bypasses a fresh cache for Generate AI Picks", async () => {
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    clearAiRankCache()
    const fresh = await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    expect(fresh.source).toBe("fresh-ai")
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse another profile's picks", async () => {
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    clearAiRankCache()
    await requestHomeAiPicks(baseRequest({ profileId: "profile-b" }), { chat: chatMock, clock })
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("does not serve picks whose catalogue entry is gone", async () => {
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    const stale = readCachedHomeAiPicks(
      baseRequest({ candidates: [candidate({ id: "9", title: "Other Film" })] }),
      nowMs
    )
    expect(stale).toBeNull()
  })

  it("dedupes identical in-flight requests into one model call", async () => {
    const gate = deferred<{ text: string; model: string }>()
    chatMock.mockReturnValueOnce(gate.promise)
    const req = baseRequest({ forceFresh: true })
    const a = requestHomeAiPicks(req, { chat: chatMock, clock })
    const b = requestHomeAiPicks(req, { chat: chatMock, clock })
    gate.resolve({ text: rankReply(["movie:1"]), model: "gpt-4o-mini" })
    const [ra, rb] = await Promise.all([a, b])
    expect(chatMock).toHaveBeenCalledTimes(1)
    expect(ra.picks.map((p) => p.id)).toEqual(["1"])
    expect(rb.picks.map((p) => p.id)).toEqual(["1"])
  })

  it("caps the shortlist at 20 candidates", async () => {
    const big = Array.from({ length: 25 }, (_, i) =>
      candidate({ id: String(i + 1), title: `Film ${i + 1}` })
    )
    chatMock.mockResolvedValueOnce({ text: rankReply(["movie:1"]), model: "gpt-4o-mini" })
    await requestHomeAiPicks(baseRequest({ candidates: big, forceFresh: true }), { chat: chatMock, clock })
    const user = String(chatMock.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "")
    expect((user.match(/\[movie:/g) ?? []).length).toBe(20)
    expect(user).not.toContain("Film 25")
  })

  it("never sends taste content when sharing is off", async () => {
    flags.shareTaste = false
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    const user = String(chatMock.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "")
    expect(user).not.toContain("Secret Liked Title")
    expect(user).not.toContain("Secret Disliked Title")
    expect(user).toContain("none stated")
  })

  it("sends the taste summary only when sharing is on", async () => {
    flags.shareTaste = true
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    const user = String(chatMock.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "")
    expect(user).toContain("Secret Liked Title")
  })

  it("never submits series or live titles for a Movies request", async () => {
    const mixed: DiscoverCandidate[] = [
      ...POOL,
      candidate({ id: "s1", kind: "series", title: "Leaked Series" }),
      candidate({ id: "l1", kind: "live", title: "Leaked Channel" }),
    ]
    await requestHomeAiPicks(baseRequest({ candidates: mixed, forceFresh: true }), { chat: chatMock, clock })
    const user = String(chatMock.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "")
    expect(user).not.toContain("Leaked Series")
    expect(user).not.toContain("Leaked Channel")
  })

  it("drops a model-invented id and keeps the real pick", async () => {
    chatMock.mockResolvedValueOnce({
      text: rankReply(["movie:999", "movie:1"]),
      model: "gpt-4o-mini",
    })
    const result = await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    expect(result.picks.map((p) => p.id)).toEqual(["1"])
    expect(result.droppedCount).toBeGreaterThanOrEqual(0)
  })

  it("returns ai-unavailable (no retry, attempt recorded) when the provider fails", async () => {
    chatMock.mockRejectedValueOnce(new MockAiError("unavailable", "boom"))
    const result = await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    expect(result.source).toBe("ai-unavailable")
    expect(result.picks).toEqual([])
    expect(result.fallbackReason).toMatch(/couldn't answer/)
    expect(chatMock).toHaveBeenCalledTimes(1)
    // The failed attempt bounds auto-refresh: no retry storm.
    flags.homeAutoRefresh = true
    const decision = decideHomeAiAutoRefresh(baseRequest(), nowMs)
    expect(decision.shouldRefresh).toBe(false)
    expect(decision.reason).toBe("attempt-bounded")
  })

  it("makes no attempt and records none when AI is off", async () => {
    flags.enabled = false
    const result = await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    expect(result.source).toBe("ai-unavailable")
    expect(chatMock).not.toHaveBeenCalled()
    const ledger = buildHomeAiLedgerKey({
      kind: "movie",
      requestType: "picks",
      profileId: "profile-a",
      playlistId: "playlist-1",
      endpoint: provider.endpoint,
      model: provider.model,
    })
    expect(lastHomeAiAttemptAt(ledger)).toBeNull()
  })

  it("makes no model call for an empty pool", async () => {
    const result = await requestHomeAiPicks(baseRequest({ candidates: [] }), { chat: chatMock, clock })
    expect(result.source).toBe("local-only")
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("expired cache is not served and a refresh is allowed again", async () => {
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    nowMs += HOME_AI_CACHE_TTL_MS + 1
    expect(readCachedHomeAiPicks(baseRequest(), nowMs)).toBeNull()
    flags.homeAutoRefresh = true
    expect(decideHomeAiAutoRefresh(baseRequest(), nowMs).reason).toBe("refresh-allowed")
  })
})

// ---------------------------------------------------------------------------
// Auto-refresh decisions (§16)
// ---------------------------------------------------------------------------

describe("decideHomeAiAutoRefresh / maybeAutoRefreshHomeAiPicks", () => {
  it("never refreshes when the Home preference is off", async () => {
    flags.homeAutoRefresh = false
    expect(decideHomeAiAutoRefresh(baseRequest(), nowMs).reason).toBe("auto-refresh-off")
    expect(await maybeAutoRefreshHomeAiPicks(baseRequest(), { chat: chatMock, clock })).toBeNull()
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("never refreshes when AI is off", () => {
    flags.homeAutoRefresh = true
    flags.enabled = false
    expect(decideHomeAiAutoRefresh(baseRequest(), nowMs).reason).toBe("ai-off")
  })

  it("serves fresh cache immediately instead of refreshing", async () => {
    await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    flags.homeAutoRefresh = true
    const decision = decideHomeAiAutoRefresh(baseRequest(), nowMs)
    expect(decision.reason).toBe("fresh-cache")
    expect(decision.cached?.source).toBe("cached-ai")
    expect(await maybeAutoRefreshHomeAiPicks(baseRequest(), { chat: chatMock, clock })).toBeNull()
    expect(chatMock).toHaveBeenCalledTimes(1)
  })

  it("refreshes quietly once when allowed, then bounds for 24h", async () => {
    flags.homeAutoRefresh = true
    const first = await maybeAutoRefreshHomeAiPicks(baseRequest(), { chat: chatMock, clock })
    expect(first?.source).toBe("fresh-ai")
    expect(chatMock).toHaveBeenCalledTimes(1)
    // Cache now fresh, so the next mount does not refresh again.
    expect(await maybeAutoRefreshHomeAiPicks(baseRequest(), { chat: chatMock, clock })).toBeNull()
    expect(chatMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Generation + verification path (§18)
// ---------------------------------------------------------------------------

describe("requestHomeAiDiscovery", () => {
  function discoveryRequest(overrides: Record<string, unknown> = {}) {
    return {
      kind: "movie" as const,
      brief: "Something dark and tense",
      catalogue: POOL,
      tasteSummary: null,
      tasteRevision: "t1",
      profileId: "profile-a",
      playlistId: "playlist-1",
      catalogueRevision: "rev-1",
      ...overrides,
    }
  }

  function generationReply(recs: Array<Record<string, unknown>>): string {
    return JSON.stringify({ recommendations: recs })
  }

  beforeEach(() => {
    chatMock.mockResolvedValue({
      text: generationReply([
        { title: "Alpha Film", year: 2020, kind: "movie", reason: "A strong pick for tonight.", tone: "tense" },
      ]),
      model: "gpt-4o-mini",
    })
  })

  it("returns verified+matched picks as fresh-ai", async () => {
    const result = await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(result.source).toBe("fresh-ai")
    expect(result.picks.map((p) => p.compositeId)).toEqual(["movie:1"])
    expect(result.picks[0]?.tmdbId).toBe(101)
    expect(result.verifiedUnmatched).toEqual([])
  })

  it("drops wrong-kind generations before verification", async () => {
    chatMock.mockResolvedValueOnce({
      text: generationReply([
        { title: "Alpha Film", year: 2020, kind: "movie", reason: "A strong pick for tonight.", tone: "tense" },
        { title: "Some Series", year: 2021, kind: "series", reason: "A strong pick for tonight.", tone: "tense" },
      ]),
      model: "gpt-4o-mini",
    })
    const result = await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(verifyMock).toHaveBeenCalledTimes(1)
    const verifiedInput = verifyMock.mock.calls[0]?.[0] as Array<{ kind: string }>
    expect(verifiedInput.map((r) => r.kind)).toEqual(["movie"])
    expect(result.picks.map((p) => p.compositeId)).toEqual(["movie:1"])
  })

  it("never presents verified-but-unmatched or unverified titles as playable", async () => {
    chatMock.mockResolvedValueOnce({
      text: generationReply([
        { title: "Alpha Film", year: 2020, kind: "movie", reason: "A strong pick for tonight.", tone: "tense" },
        { title: "Elsewhere Film", year: 2018, kind: "movie", reason: "A strong pick for tonight.", tone: "tense" },
        { title: "Unproven Film", year: 2019, kind: "movie", reason: "A strong pick for tonight.", tone: "tense" },
      ]),
      model: "gpt-4o-mini",
    })
    verifyMock.mockResolvedValueOnce([
      verifiedRec({ title: "Alpha Film" }),
      verifiedRec({ title: "Elsewhere Film", tmdbId: 202, match: null }),
      verifiedRec({ title: "Unproven Film", verified: false, tmdbId: null, match: null }),
    ])
    const result = await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(result.picks.map((p) => p.title)).toEqual(["Alpha Film"])
    expect(result.verifiedUnmatched.map((r) => r.title)).toEqual(["Elsewhere Film"])
    expect(result.droppedCount).toBeGreaterThan(0)
  })

  it("drops a match that is not in the current pool (no stale links)", async () => {
    verifyMock.mockResolvedValueOnce([
      verifiedRec({
        title: "Alpha Film",
        match: { compositeId: "movie:999", kind: "movie", title: "Alpha Film", year: 2020, catalogueKey: "movie:999" },
      }),
    ])
    const result = await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(result.picks).toEqual([])
    expect(result.source).toBe("ai-unavailable")
  })

  it("gates taste for generation too", async () => {
    flags.shareTaste = false
    await requestHomeAiDiscovery(
      discoveryRequest({ tasteSummary: "Favourite genres: Secret Taste Words" }),
      { chat: chatMock, clock }
    )
    const user = String(chatMock.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "")
    expect(user).not.toContain("Secret Taste Words")
  })

  it("serves a fresh discovery cache entry without a new request", async () => {
    await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    const calls = chatMock.mock.calls.length
    const second = await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(second.source).toBe("cached-ai")
    expect(chatMock.mock.calls.length).toBe(calls)
  })

  it("makes no call for an empty brief or when AI is off", async () => {
    const empty = await requestHomeAiDiscovery(discoveryRequest({ brief: "   " }), { chat: chatMock, clock })
    expect(empty.source).toBe("ai-unavailable")
    flags.enabled = false
    await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("returns ai-unavailable on a generation failure, with the attempt recorded", async () => {
    chatMock.mockRejectedValueOnce(new MockAiError("rate_limited", "slow down"))
    const result = await requestHomeAiDiscovery(discoveryRequest(), { chat: chatMock, clock })
    expect(result.source).toBe("ai-unavailable")
    expect(result.fallbackReason).toMatch(/rate-limiting/)
    const ledger = buildHomeAiLedgerKey({
      kind: "movie",
      requestType: "discovery",
      profileId: "profile-a",
      playlistId: "playlist-1",
      endpoint: provider.endpoint,
      model: provider.model,
    })
    expect(lastHomeAiAttemptAt(ledger)).toBe(nowMs)
  })
})

// ---------------------------------------------------------------------------
// Source labels + selector seam
// ---------------------------------------------------------------------------

describe("source labels and selector seam", () => {
  it("labels each source honestly", () => {
    expect(homeAiSourceLabel("fresh-ai")).toBe("AI picks")
    expect(homeAiSourceLabel("cached-ai")).toContain("cached")
    expect(homeAiSourceLabel("local-only")).toBe("Local recommendations")
    expect(homeAiSourceLabel("ai-unavailable")).toContain("AI unavailable")
  })

  it("maps picks to bare selector ids with model rank", () => {
    const picks: HomeAiPick[] = [
      { compositeId: "movie:2", kind: "movie", id: "2", title: "B", year: null, score: 1, reason: "r", tmdbId: null },
      { compositeId: "movie:1", kind: "movie", id: "1", title: "A", year: null, score: 0.5, reason: "r", tmdbId: null },
    ]
    expect(toSelectorAiRecommendations(picks)).toEqual([
      { id: "2", rank: 1 },
      { id: "1", rank: 2 },
    ])
  })

  it("allows the selector boost only for real AI results with picks", async () => {
    const fresh = await requestHomeAiPicks(baseRequest({ forceFresh: true }), { chat: chatMock, clock })
    expect(homeAiAllowsSelectorBoost(fresh)).toBe(true)
    const cached = await requestHomeAiPicks(baseRequest(), { chat: chatMock, clock })
    expect(homeAiAllowsSelectorBoost(cached)).toBe(true)
    expect(homeAiAllowsSelectorBoost({ ...fresh, source: "local-only" })).toBe(false)
    expect(homeAiAllowsSelectorBoost({ ...fresh, source: "ai-unavailable" })).toBe(false)
    expect(homeAiAllowsSelectorBoost({ ...fresh, picks: [] })).toBe(false)
    expect(homeAiAllowsSelectorBoost(null)).toBe(false)
  })
})

afterEach(() => {
  clearHomeAiCache()
  clearHomeAiAttempts()
  clearAiRankCache()
})
