// AI ranking tests. The model client is mocked — no key, no network.
// Fixtures are synthetic; the "provider" here is a canned JSON reply.
import { describe, it, expect, beforeEach, vi } from "vitest"

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

import {
  aiRanker,
  applyRerankCap,
  buildAiPrompt,
  parseAiRankResponse,
  fallbackRank,
  clearAiRankCache,
  type DiscoverCandidate,
  type TasteSummary,
} from "@/scripts/lib/ai/ranking"

const taste: TasteSummary = {
  favouriteGenres: ["Comedy", "Drama"],
  likedTitles: ["The Office"],
  dislikedTitles: ["Saw"],
  preferredRuntimeMax: 120,
  pace: "gentle",
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

beforeEach(() => {
  vi.resetAllMocks()
  aiEnabled.value = true
  clearAiRankCache()
  chatMock.mockResolvedValue({
    text: modelReply([
      { id: "c1", reason: "Cosy and funny." },
      { id: "c2", reason: "Gentle drama." },
    ]),
    model: "gpt-4o-mini",
  })
})

describe("aiRanker.rank", () => {
  it("returns model order with position-derived scores and validated IDs", async () => {
    const candidates = [candidate({ id: "c1" }), candidate({ id: "c2", title: "Second" })]
    const ranked = await aiRanker.rank("something cosy", candidates, taste)
    expect(ranked.map((entry) => entry.candidate.id)).toEqual(["c1", "c2"])
    expect(ranked[0].score).toBe(1)
    expect(ranked[1].score).toBe(0.5)
    expect(ranked[0].reason).toBe("Cosy and funny.")
  })

  it("drops unknown/invented IDs and collapses duplicates", async () => {
    chatMock.mockResolvedValueOnce({
      text: modelReply([
        { id: "c1", reason: "Real." },
        { id: "invented-999", reason: "Not in the catalogue." },
        { id: "c1", reason: "Duplicate." },
      ]),
      model: "gpt-4o-mini",
    })
    const ranked = await aiRanker.rank("x", [candidate({ id: "c1" })], taste)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].candidate.id).toBe("c1")
    expect(ranked[0].candidate.title).toBe("Test Film")
  })

  it("never returns a title that is not in the candidates", async () => {
    chatMock.mockResolvedValueOnce({
      text: modelReply([{ id: "ghost", reason: "Trust me." }]),
      model: "gpt-4o-mini",
    })
    await expect(aiRanker.rank("x", [candidate({ id: "c1" })], taste)).rejects.toMatchObject({
      kind: "bad_output",
    })
  })

  it("falls back cleanly: malformed output rejects with bad_output", async () => {
    chatMock.mockResolvedValueOnce({ text: "not json at all", model: "gpt-4o-mini" })
    await expect(
      aiRanker.rank("x", [candidate({ id: "c1" })], taste)
    ).rejects.toMatchObject({ kind: "bad_output" })
  })

  it("falls back cleanly: empty model output rejects with bad_output", async () => {
    chatMock.mockResolvedValueOnce({ text: "   ", model: "gpt-4o-mini" })
    await expect(
      aiRanker.rank("x", [candidate({ id: "c1" })], taste)
    ).rejects.toMatchObject({ kind: "bad_output" })
  })

  it("propagates rate-limit errors with their kind for the fallback path", async () => {
    chatMock.mockRejectedValueOnce(new MockAiError("rate_limited", "slow down"))
    await expect(
      aiRanker.rank("x", [candidate({ id: "c1" })], taste)
    ).rejects.toMatchObject({ kind: "rate_limited" })
    // The coordinator's catch path: local order, honest reason.
    const fallback = fallbackRank([candidate({ id: "c1" }), candidate({ id: "c2" })])
    expect(fallback.map((entry) => entry.candidate.id)).toEqual(["c1", "c2"])
    expect(fallback[0].reason).toContain("unavailable")
  })

  it("does not call the model when AI is off, and returns [] for no candidates", async () => {
    aiEnabled.value = false
    await expect(
      aiRanker.rank("x", [candidate({ id: "c1" })], taste)
    ).rejects.toMatchObject({ kind: "not_configured" })
    expect(chatMock).not.toHaveBeenCalled()

    aiEnabled.value = true
    await expect(aiRanker.rank("x", [], taste)).resolves.toEqual([])
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("caches results per query for the session and re-requests after a clear", async () => {
    const candidates = [candidate({ id: "c1" })]
    await aiRanker.rank("cosy", candidates, taste)
    await aiRanker.rank("cosy", candidates, taste)
    expect(chatMock).toHaveBeenCalledTimes(1)
    clearAiRankCache()
    await aiRanker.rank("cosy", candidates, taste)
    expect(chatMock).toHaveBeenCalledTimes(2)
  })

  it("cancels the obsolete request when a new search begins", async () => {
    const signals: AbortSignal[] = []
    chatMock.mockImplementationOnce((options: { signal?: AbortSignal }) => {
      signals.push(options.signal!)
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new MockAiError("aborted", "cancelled"))
        )
      })
    })
    const first = aiRanker.rank("first", [candidate({ id: "c1" }), candidate({ id: "c2", title: "Second" })], taste)
    const firstSettled = first.then(
      () => "resolved",
      (error: Error) => (error as MockAiError).kind
    )
    const second = await aiRanker.rank("second", [candidate({ id: "c1" }), candidate({ id: "c2", title: "Second" })], taste)
    expect(second).toHaveLength(2)
    expect(await firstSettled).toBe("aborted")
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe("buildAiPrompt", () => {
  it("sends only query + compact candidates + taste — no URLs, keys or history", () => {
    const sneaky = candidate({
      id: "c9",
      overview: "Watch it at http://provider.example/stream.m3u8 right now",
      posterUrl: "https://image.tmdb.org/t/p/w500/secret.jpg",
      cast: ["Leaked Person"],
      director: "Leaked Director",
    })
    const { system, user } = buildAiPrompt("something cosy please", [sneaky], taste)
    const payload = `${system}\n${user}`
    expect(payload).not.toContain("http")
    expect(payload).not.toContain("provider.example")
    expect(payload).not.toContain("image.tmdb.org")
    expect(payload).not.toContain("secret.jpg")
    expect(payload).not.toContain("Leaked Person")
    expect(payload).not.toContain("Leaked Director")
    expect(payload).not.toContain("stream.m3u8")
    expect(user).toContain("something cosy please")
    expect(user).toContain("Test Film")
    expect(user).toContain("Comedy")
    expect(user).toContain("The Office")
    expect(user).toContain("Saw")
  })

  // 0.11.5 (W4): the old test here asserted the production bug —
  // that buildAiPrompt sends the FIRST 20 catalogue entries and
  // drops the rest. That slice-before-relevance is what returned
  // 'G' Men et al. for "some fucked up dark anime". The 20-cap is
  // still real, but it is a PAYLOAD cap on the shortlist the caller
  // hands over (already retrieved for relevance), never a licence
  // to take the first 20 catalogue entries — and it lives in the
  // caller (applyRerankCap, applied by runRerank before the prompt
  // is built), NOT in the renderer: buildAiPrompt renders exactly
  // what it is handed (see the "renders the whole relevance-ranked
  // shortlist" test in ai-rerank-w2.test.ts), so asserting the cap
  // on the renderer would contradict that contract. This test
  // asserts the cap at its enforcement point and that the cap
  // keeps the HEAD of the relevance-ranked shortlist (best first),
  // and the retrieval behaviour itself is covered at the
  // rankDiscover level in tests/ai-discovery-regression.test.ts
  // (T1/T2).
  it("caps the model payload at 20 candidates by count, never by catalogue position", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      candidate({ id: `c${index}`, title: `Film ${index}` })
    )
    const capped = applyRerankCap(many)
    expect(capped).toHaveLength(20)
    const { user } = buildAiPrompt("x", capped, taste)
    const lines = user.split("\n").filter((line) => /^\d+\. \[/.test(line))
    expect(lines).toHaveLength(20)
    expect(user).toContain("Film 0")
    expect(user).toContain("Film 19")
    expect(user).not.toContain("Film 20")
    expect(user).not.toContain("Film 24")
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("ranks the shortlist it is handed in full — including titles a raw catalogue would bury", async () => {
    // Seam contract: rank() trusts the caller's retrieval. A
    // caller that retrieved relevant anime from beyond catalogue
    // position 20 must see all of them ranked — rank() never
    // re-slices by catalogue position.
    const shortlist = [
      candidate({ id: "a0", title: "Crimson Ronin", genres: ["Animation", "Horror"] }),
      candidate({ id: "a1", title: "Black Sakura", genres: ["Animation", "Horror"] }),
      candidate({ id: "a2", title: "The Hollow School", genres: ["Animation", "Thriller"] }),
    ]
    chatMock.mockResolvedValueOnce({
      text: modelReply([
        { id: "a2", reason: "Dark anime." },
        { id: "a0", reason: "Dark anime." },
        { id: "a1", reason: "Dark anime." },
      ]),
      model: "gpt-4o-mini",
    })
    const ranked = await aiRanker.rank("some fucked up dark anime", shortlist, taste)
    expect(ranked.map((entry) => entry.candidate.id)).toEqual(["a2", "a0", "a1"])
  })
})

describe("parseAiRankResponse", () => {
  it("reads a fenced JSON block and the intent alongside the ranking", () => {
    const text = [
      "Here are my picks:",
      "```json",
      JSON.stringify({
        intent: { genres: ["Comedy"], mood: "cosy", pace: "gentle", maxRuntimeMinutes: 120 },
        rankings: [{ id: "c1", reason: "Cosy." }],
      }),
      "```",
    ].join("\n")
    const parsed = parseAiRankResponse(text, [candidate({ id: "c1" })])
    expect(parsed.rankings).toHaveLength(1)
    expect(parsed.intent?.mood).toBe("cosy")
    expect(parsed.intent?.maxRuntimeMinutes).toBe(120)
  })

  it("throws bad_output when the reply has no rankings list", () => {
    expect(() => parseAiRankResponse('{"intent": {}}', [candidate({ id: "c1" })])).toThrow()
  })
})

describe("fallbackRank", () => {
  it("keeps input order with descending scores", () => {
    const ranked = fallbackRank([
      candidate({ id: "a" }),
      candidate({ id: "b" }),
      candidate({ id: "c" }),
    ])
    expect(ranked.map((entry) => entry.candidate.id)).toEqual(["a", "b", "c"])
    expect(ranked.map((entry) => entry.score)).toEqual([1, 0.67, 0.33])
    expect(ranked[0].reason).toBeTruthy()
  })

  it("returns [] for no candidates", () => {
    expect(fallbackRank([])).toEqual([])
  })
})
