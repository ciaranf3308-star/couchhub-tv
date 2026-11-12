// AI Discovery orchestrator tests (AI Discovery 3.0, 0.11.6). The model
// transport, the TMDB verifier and the provider identity are all faked —
// no key, no network. The verifier fake mirrors the frozen W2 contract:
// verifyRecommendations(recs, { searchTmdb, catalogue }).
import { describe, it, expect, beforeEach, vi } from "vitest"

const { chatMock, verifyMock, provider, shareTaste } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  verifyMock: vi.fn(),
  provider: { endpoint: "https://api.example.invalid/v1", model: "gpt-4o-mini" },
  shareTaste: { value: false },
}))

vi.mock("@/scripts/lib/ai/client.js", () => ({
  AiError: class extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.name = "AiError"
      this.kind = kind
    }
  },
  chatCompletions: chatMock,
}))

vi.mock("@/scripts/lib/ai/status.js", () => ({
  getAiShareTaste: () => shareTaste.value,
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getAiEndpoint: () => provider.endpoint,
  getAiModel: () => provider.model,
}))

vi.mock("@/scripts/lib/ai/verification.js", () => ({
  verifyRecommendations: verifyMock,
  defaultTmdbSearch: vi.fn().mockRejectedValue(new Error("no default TMDB search in tests")),
  // Integration (seam 1): the orchestrator imports these defaults too
  // and CALLS defaultResolveExternalId(); the mock must export the
  // same names as the real module or the call throws inside the
  // verifier try block and every result comes back unverified.
  defaultFetchDetails: vi.fn(),
  defaultResolveExternalId: vi.fn(),
}))

import {
  runAiDiscovery,
  clearAiDiscoveryCache,
  subscribeAiDiscoveryPhase,
  DISCOVERY_PIPELINE_VERSION,
} from "@/scripts/lib/ai/discovery-orchestrator"
import { newConversation, type ConversationState } from "@/scripts/lib/ai/generation"
import type { DiscoverCandidate } from "@/scripts/lib/discover"

function modelReply(recs: Array<Record<string, unknown>>): string {
  return JSON.stringify({ recommendations: recs })
}

const REC_A = {
  title: "Synthetic Film One",
  year: 2019,
  kind: "movie",
  reason: "A dark, specific reason.",
  tone: "dark thriller",
}
const REC_B = {
  title: "Synthetic Series Two",
  year: 2021,
  kind: "series",
  reason: "A second specific reason.",
  tone: "slow mystery",
}
const REC_UNMATCHED = {
  title: "Not In Library",
  year: 2018,
  kind: "movie",
  reason: "A third specific reason.",
  tone: "quiet drama",
}

function catalogueCandidate(overrides: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    id: "101",
    kind: "movie",
    title: "Synthetic Film One",
    year: 2019,
    genres: ["Thriller"],
    cast: [],
    source: "catalog",
    ...overrides,
  }
}

const CATALOGUE: DiscoverCandidate[] = [
  catalogueCandidate({ id: "101", kind: "movie", title: "Synthetic Film One", year: 2019 }),
  catalogueCandidate({ id: "202", kind: "series", title: "Synthetic Series Two", year: 2021 }),
]

/** Fake W2 verifier: verifies everything, matches catalogue titles by name. */
function fakeVerify(recs: Array<{ title: string; year: number | null; kind: "movie" | "series"; reason: string; tone: string }>, opts: { catalogue?: DiscoverCandidate[] }) {
  return recs.map((generated, index) => {
    const found = (opts.catalogue ?? []).find(
      (c) => c.title.toLowerCase() === generated.title.toLowerCase() && c.kind === generated.kind
    )
    return {
      generated,
      verified: true,
      tmdbId: 1000 + index,
      title: generated.title,
      year: generated.year,
      kind: generated.kind,
      reason: generated.reason,
      tone: generated.tone,
      genres: ["Drama"],
      synopsis: "A synopsis from the verifier fake.",
      posterUrl: null,
      backdropUrl: null,
      match: found
        ? {
            compositeId: `${found.kind}:${found.id}`,
            kind: found.kind as "movie" | "series",
            title: found.title,
            year: found.year ?? null,
            catalogueKey: `${found.kind}:${found.id}`,
          }
        : null,
    }
  })
}

function fakeChat(text: string) {
  return vi.fn().mockResolvedValue({ text, model: "gpt-4o-mini" })
}

beforeEach(() => {
  vi.resetAllMocks()
  clearAiDiscoveryCache()
  provider.endpoint = "https://api.example.invalid/v1"
  provider.model = "gpt-4o-mini"
  shareTaste.value = false
  chatMock.mockResolvedValue({ text: modelReply([REC_A, REC_B]), model: "gpt-4o-mini" })
  verifyMock.mockImplementation(fakeVerify)
})

async function runOnce(overrides: {
  query?: string
  conversation?: ConversationState
  availableOnly?: boolean
  count?: number
  chat?: ReturnType<typeof fakeChat>
  catalogue?: DiscoverCandidate[]
  tasteSummary?: string | null
  profileId?: string
  signal?: AbortSignal
} = {}) {
  const chat = overrides.chat ?? fakeChat(modelReply([REC_A, REC_B]))
  const result = await runAiDiscovery(
    {
      query: overrides.query ?? "something dark and unsettling for tonight",
      conversation: overrides.conversation ?? newConversation(),
      availableOnly: overrides.availableOnly ?? false,
      count: overrides.count,
      tasteSummary: overrides.tasteSummary,
      signal: overrides.signal,
    },
    { chat, catalogue: overrides.catalogue ?? CATALOGUE, profileId: overrides.profileId }
  )
  return { result, chat }
}

// ---------------------------------------------------------------------------
// Happy path + phases
// ---------------------------------------------------------------------------

describe("runAiDiscovery", () => {
  it("generates, verifies and returns presentation data with a ready receipt", async () => {
    const phases: string[] = []
    const unsubscribe = subscribeAiDiscoveryPhase((phase) => phases.push(phase))
    const { result, chat } = await runOnce()
    unsubscribe()

    expect(chat).toHaveBeenCalledTimes(1)
    expect(verifyMock).toHaveBeenCalledTimes(1)
    expect(result.results).toHaveLength(2)
    expect(result.results[0]?.verified).toBe(true)
    expect(result.results[0]?.match?.compositeId).toBe("movie:101")
    expect(result.receipt.phase).toBe("ready")
    expect(result.receipt.engine).toBe("ai")
    expect(result.receipt.cacheHit).toBe(false)
    expect(typeof result.receipt.answeredAt).toBe("number")
    expect(result.diagnostics.generatedCount).toBe(2)
    expect(result.diagnostics.verifiedCount).toBe(2)
    expect(result.diagnostics.matchedCount).toBe(2)
    expect(result.diagnostics.verificationFailures).toBe(0)
    expect(result.diagnostics.acceptedCount).toBe(2)
    // Generation sends no candidate list to the model — by design.
    expect(result.diagnostics.sentToModelCount).toBe(0)
    expect(result.conversation.turns).toHaveLength(1)
    expect(result.conversation.turns[0]?.generatedTitles).toEqual([
      "Synthetic Film One",
      "Synthetic Series Two",
    ])
    // Phases transition in order (the last events of this run).
    expect(phases.slice(-4)).toEqual(["asking-ai", "verifying-tmdb", "checking-library", "ready"])
    expect(DISCOVERY_PIPELINE_VERSION).toBe(1)
  })

  it("returns ALL verified recommendations even with availableOnly on — the toggle is a view filter", async () => {
    const chat = fakeChat(modelReply([REC_A, REC_B, REC_UNMATCHED]))
    const result = await runAiDiscovery(
      {
        query: "something for tonight please",
        conversation: newConversation(),
        availableOnly: true,
      },
      { chat, catalogue: CATALOGUE }
    )
    expect(result.results).toHaveLength(3)
    const unmatched = result.results.find((r) => r.title === "Not In Library")
    expect(unmatched).toBeDefined()
    expect(unmatched?.match).toBeNull()
    expect(unmatched?.verified).toBe(true)
  })

  it("defaults to 10 recommendations and honours an explicit count", async () => {
    const { chat } = await runOnce()
    const sent = chat.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join("\n")
    expect(sent).toContain("exactly 10 titles")
    clearAiDiscoveryCache()
    const chat3 = fakeChat(modelReply([REC_A]))
    await runAiDiscovery(
      { query: "a different question here", conversation: newConversation(), availableOnly: false, count: 3 },
      { chat: chat3, catalogue: CATALOGUE }
    )
    const sent3 = chat3.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join("\n")
    expect(sent3).toContain("exactly 3 titles")
  })

  it("works without a catalogue — availability is unknown, not 'not in library'", async () => {
    const chat = fakeChat(modelReply([REC_A]))
    const result = await runAiDiscovery(
      { query: "something dark tonight", conversation: newConversation(), availableOnly: false },
      { chat }
    )
    expect(verifyMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ catalogue: undefined })
    )
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.match).toBeNull()
    expect(result.receipt.phase).toBe("ready")
  })

  it("passes the caller's AbortSignal to the model call", async () => {
    const controller = new AbortController()
    const { chat } = await runOnce({ signal: controller.signal })
    expect(chat.mock.calls[0][0].signal).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("discovery cache", () => {
  it("repeats an identical query from cache with ZERO model calls", async () => {
    const conversation = newConversation()
    const chat = fakeChat(modelReply([REC_A, REC_B]))
    const first = await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(first.receipt.phase).toBe("ready")
    const second = await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(chat).toHaveBeenCalledTimes(1)
    expect(verifyMock).toHaveBeenCalledTimes(1)
    expect(second.receipt.phase).toBe("cached")
    expect(second.receipt.engine).toBe("cached-ai")
    expect(second.receipt.cacheHit).toBe(true)
    expect(second.receipt.answeredAt).toBeNull()
    expect(second.results).toHaveLength(2)
    expect(second.diagnostics.cacheHit).toBe(true)
    // A cache hit still records the turn (the user saw the suggestions).
    expect(second.conversation.turns).toHaveLength(1)
  })

  it("treats availableOnly as NOT a cache dimension", async () => {
    const conversation = newConversation()
    const chat = fakeChat(modelReply([REC_A]))
    await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    const second = await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: true },
      { chat, catalogue: CATALOGUE }
    )
    expect(chat).toHaveBeenCalledTimes(1)
    expect(second.receipt.phase).toBe("cached")
  })

  it("a refinement (new turn) is a fresh request, not a cache hit", async () => {
    const chat = fakeChat(modelReply([REC_A]))
    const first = await runAiDiscovery(
      { query: "something dark", conversation: newConversation(), availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    const second = await runAiDiscovery(
      { query: "give me others", conversation: first.conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(chat).toHaveBeenCalledTimes(2)
    expect(second.receipt.phase).toBe("ready")
    // The refinement prompt carries the prior turn's context.
    const sent = chat.mock.calls[1][0].messages.map((m: { content: string }) => m.content).join("\n")
    expect(sent).toContain("Synthetic Film One")
  })

  it("a model, endpoint, profile or taste change is a cache miss", async () => {
    const conversation = newConversation()
    const chat = fakeChat(modelReply([REC_A]))
    const args = { query: "something dark tonight", conversation, availableOnly: false }
    await runAiDiscovery(args, { chat, catalogue: CATALOGUE, profileId: "p1" })
    provider.model = "gpt-4o"
    await runAiDiscovery(args, { chat, catalogue: CATALOGUE, profileId: "p1" })
    expect(chat).toHaveBeenCalledTimes(2)
    provider.model = "gpt-4o-mini"
    provider.endpoint = "https://other.example.invalid/v1"
    await runAiDiscovery(args, { chat, catalogue: CATALOGUE, profileId: "p1" })
    expect(chat).toHaveBeenCalledTimes(3)
    provider.endpoint = "https://api.example.invalid/v1"
    await runAiDiscovery(args, { chat, catalogue: CATALOGUE, profileId: "p2" })
    expect(chat).toHaveBeenCalledTimes(4)
  })

  it("a taste-summary change (when sharing is on) is a cache miss", async () => {
    shareTaste.value = true
    const conversation = newConversation()
    const chat = fakeChat(modelReply([REC_A]))
    await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false, tasteSummary: "Likes: horror" },
      { chat, catalogue: CATALOGUE }
    )
    await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false, tasteSummary: "Likes: comedy" },
      { chat, catalogue: CATALOGUE }
    )
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it("a changed catalogue is a cache miss (matches must not go stale)", async () => {
    const conversation = newConversation()
    const chat = fakeChat(modelReply([REC_A]))
    const args = { query: "something dark tonight", conversation, availableOnly: false }
    await runAiDiscovery(args, { chat, catalogue: CATALOGUE })
    const changed = [...CATALOGUE, catalogueCandidate({ id: "303", title: "Extra Title" })]
    await runAiDiscovery(args, { chat, catalogue: changed })
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it("normalises the query for the cache key (case + whitespace)", async () => {
    const conversation = newConversation()
    const chat = fakeChat(modelReply([REC_A]))
    await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    const second = await runAiDiscovery(
      { query: "  Something   DARK tonight ", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(chat).toHaveBeenCalledTimes(1)
    expect(second.receipt.phase).toBe("cached")
  })
})

// ---------------------------------------------------------------------------
// Failure behaviour
// ---------------------------------------------------------------------------

describe("failure behaviour", () => {
  it("generation failure -> unavailable phase, honest message, no turn, nothing cached", async () => {
    const failure = new Error("The provider rejected the API key.")
    ;(failure as Error & { kind: string }).kind = "invalid_key"
    const chat = vi.fn().mockRejectedValue(failure)
    const conversation = newConversation()
    const result = await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(result.results).toEqual([])
    expect(result.receipt.phase).toBe("unavailable")
    expect(result.receipt.fallbackReason).toContain("rejected the saved key")
    expect(result.diagnostics.providerError).toBeTruthy()
    expect(result.conversation.turns).toHaveLength(0)
    expect(verifyMock).not.toHaveBeenCalled()
    // Nothing cached: a retry after fixing the key sends a fresh request.
    chat.mockResolvedValue({ text: modelReply([REC_A]), model: "gpt-4o-mini" })
    const retry = await runAiDiscovery(
      { query: "something dark tonight", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(retry.receipt.phase).toBe("ready")
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it("an unusable reply -> unavailable with providerError, never fabricated fillers", async () => {
    const chat = fakeChat("definitely not json")
    const result = await runAiDiscovery(
      { query: "something dark tonight", conversation: newConversation(), availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(result.results).toEqual([])
    expect(result.receipt.phase).toBe("unavailable")
    expect(result.diagnostics.providerError).toContain("no usable recommendations")
  })

  it("an empty query never calls the model", async () => {
    const chat = fakeChat(modelReply([REC_A]))
    const result = await runAiDiscovery(
      { query: "   ", conversation: newConversation(), availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(chat).not.toHaveBeenCalled()
    expect(result.receipt.phase).toBe("unavailable")
    expect(result.results).toEqual([])
  })

  it("a wholesale verifier throw -> results unverified with an honest note, never claimed verified", async () => {
    verifyMock.mockRejectedValue(new Error("TMDB is down"))
    const chat = fakeChat(modelReply([REC_A, REC_B]))
    const result = await runAiDiscovery(
      { query: "something dark tonight", conversation: newConversation(), availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(result.results).toHaveLength(2)
    expect(result.results.every((r) => r.verified === false)).toBe(true)
    expect(result.results[0]?.verificationNote).toContain("verification failed")
    expect(result.results[0]?.tmdbId).toBeNull()
    expect(result.diagnostics.verifiedCount).toBe(0)
    expect(result.diagnostics.verificationFailures).toBe(2)
    expect(result.receipt.phase).toBe("ready")
  })

  it("partial verification is counted honestly", async () => {
    verifyMock.mockImplementation((recs: Array<{ title: string }>) =>
      fakeVerify(
        recs as never,
        { catalogue: CATALOGUE }
      ).map((entry, index) =>
        index === 0
          ? { ...entry, verified: false, tmdbId: null, verificationNote: "No TMDB match found." }
          : entry
      )
    )
    const chat = fakeChat(modelReply([REC_A, REC_B]))
    const result = await runAiDiscovery(
      { query: "something dark tonight", conversation: newConversation(), availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(result.diagnostics.generatedCount).toBe(2)
    expect(result.diagnostics.verifiedCount).toBe(1)
    expect(result.diagnostics.verificationFailures).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("an already-aborted signal rejects without calling the model", async () => {
    const controller = new AbortController()
    controller.abort()
    const chat = fakeChat(modelReply([REC_A]))
    await expect(
      runAiDiscovery(
        { query: "something dark", conversation: newConversation(), availableOnly: false, signal: controller.signal },
        { chat, catalogue: CATALOGUE }
      )
    ).rejects.toMatchObject({ kind: "aborted" })
    expect(chat).not.toHaveBeenCalled()
  })

  it("an abort during generation propagates and is never cached as unavailable", async () => {
    const failure = new Error("The AI request was cancelled.")
    ;(failure as Error & { kind: string }).kind = "aborted"
    const chat = vi.fn().mockRejectedValue(failure)
    const conversation = newConversation()
    await expect(
      runAiDiscovery(
        { query: "something dark", conversation, availableOnly: false },
        { chat, catalogue: CATALOGUE }
      )
    ).rejects.toBe(failure)
    chat.mockResolvedValue({ text: modelReply([REC_A]), model: "gpt-4o-mini" })
    const retry = await runAiDiscovery(
      { query: "something dark", conversation, availableOnly: false },
      { chat, catalogue: CATALOGUE }
    )
    expect(retry.receipt.phase).toBe("ready")
  })
})
