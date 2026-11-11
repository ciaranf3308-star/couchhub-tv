/**
 * @vitest-environment jsdom
 */
// AI usage controls (AI07) + taste-sharing gate (AI05) — no key, no
// network, no live provider. The model client is mocked.
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
  getAiEndpoint: () => "https://api.openai.com/v1",
  getAiModel: () => "gpt-4o-mini",
}))

import {
  aiRanker,
  clearAiRankCache,
  clearAiUsageState,
  subscribeAiActivity,
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
  localStorage.clear()
  sessionStorage.clear()
  clearAiRankCache()
  clearAiUsageState()
  chatMock.mockResolvedValue({
    text: modelReply([
      { id: "c1", reason: "Cosy and funny." },
      { id: "c2", reason: "Gentle drama." },
    ]),
    model: "gpt-4o-mini",
  })
})

const two = [candidate({ id: "c1" }), candidate({ id: "c2", title: "Second Film" })]

describe("AI07 usage controls", () => {
  it("answers an identical query from the session cache without a second request", async () => {
    const first = await aiRanker.rank("something cosy tonight please", two, taste)
    expect(chatMock).toHaveBeenCalledTimes(1)
    clearAiRankCache() // drop the in-memory cache; session cache must cover it
    const second = await aiRanker.rank("something cosy tonight please", two, taste)
    expect(chatMock).toHaveBeenCalledTimes(1)
    expect(second.map((r) => r.candidate.id)).toEqual(first.map((r) => r.candidate.id))
  })

  it("never sends a second request for the same query within 60s (falls back via error)", async () => {
    await aiRanker.rank("something cosy tonight please", two, taste)
    expect(chatMock).toHaveBeenCalledTimes(1)
    clearAiRankCache()
    // Different candidates: the session cache cannot answer, so the
    // 60s guard must stop a second paid request.
    const other = [candidate({ id: "c9", title: "Other Film" })]
    await expect(
      aiRanker.rank("something cosy tonight please", other, taste)
    ).rejects.toMatchObject({ kind: "rate_limited" })
    expect(chatMock).toHaveBeenCalledTimes(1)
  })

  it("emits start/done activity so the UI can show a request left the device", async () => {
    const events: Array<{ type: string }> = []
    const unsubscribe = subscribeAiActivity((event) => events.push(event))
    try {
      await aiRanker.rank("something cosy tonight please", two, taste)
    } finally {
      unsubscribe()
    }
    expect(events.map((e) => e.type)).toEqual(["start", "done"])
  })
})

describe("AI05 taste-sharing gate", () => {
  it("sends no taste summary without an explicit opt-in", async () => {
    await aiRanker.rank("something cosy tonight please", two, taste)
    const messages = chatMock.mock.calls[0][0].messages as Array<{ content: string }>
    const user = messages.find((m) => m.content.includes("Search:"))?.content ?? ""
    expect(user).toContain("Favourite genres: none stated")
    expect(user).not.toContain("The Office")
    expect(user).not.toContain("Saw")
  })

  it("includes the taste summary once the user opts in", async () => {
    localStorage.setItem("xt_ai_share_taste", "1")
    await aiRanker.rank("something cosy tonight please", two, taste)
    const messages = chatMock.mock.calls[0][0].messages as Array<{ content: string }>
    const user = messages.find((m) => m.content.includes("Search:"))?.content ?? ""
    expect(user).toContain("Comedy")
    expect(user).toContain("The Office")
  })
})
