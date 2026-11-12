// AI visibility (0.11.5, W3) — the Discover receipt must tell the truth
// about what engine produced every rail.
//
// Rules under test (no key, no network, no live provider):
// - "AI answered just now" describes ONLY a real, recently completed
//   API call: a validated receipt inside the fresh window. Never a
//   cache hit, never a local result, never a stale answer.
// - A rail is never labelled "AI picks" for local results, and never
//   "Local recommendations" for an AI-produced rail (a cache hit is
//   "Cached AI picks").
// - rankDiscover reports the diagnostics it can prove (catalogue size,
//   accepted + rejected counts); W1/W2-owned fields stay undefined
//   until their layer reports them.
import { describe, it, expect, afterEach } from "vitest"
import {
  aiSearchRailTitle,
  aiSearchStateNote,
  isFreshAiAnswer,
  AI_SEARCH_PHASE_LABELS,
  AI_FRESH_ANSWER_WINDOW_MS,
  type AiSearchReceipt,
  type AiSearchDiagnostics,
} from "../src/scripts/lib/ai/status"
import {
  rankDiscover,
  registerAIRanker,
  type DiscoverCandidate,
  type RankedCandidate,
} from "../src/scripts/lib/discover"
import { emptyTasteModel } from "../src/scripts/lib/taste"

const NOW = 1_790_000_000_000

function diagnostics(
  partial: Partial<AiSearchDiagnostics> = {}
): AiSearchDiagnostics {
  return { queryType: "keyword", catalogueSize: 10, ...partial }
}

function receipt(partial: Partial<AiSearchReceipt> = {}): AiSearchReceipt {
  return {
    phase: "validated",
    engine: "ai",
    query: "COMEDY",
    model: "gpt-4o-mini",
    answeredAt: NOW,
    durationMs: 2300,
    cacheHit: false,
    diagnostics: diagnostics({ acceptedCount: 3 }),
    ...partial,
  }
}

describe("aiSearchRailTitle", () => {
  it("says 'AI picks' only for a validated live answer", () => {
    expect(aiSearchRailTitle(receipt())).toBe("AI picks for “COMEDY”")
  })

  it("says 'Cached AI picks' for a cache hit — never plain 'AI picks'", () => {
    const title = aiSearchRailTitle(
      receipt({ phase: "cached", engine: "cached-ai", cacheHit: true, answeredAt: null })
    )
    expect(title).toBe("Cached AI picks for “COMEDY”")
    expect(title).not.toBe("AI picks for “COMEDY”")
  })

  it("says 'Local recommendations' for a local result", () => {
    expect(
      aiSearchRailTitle(
        receipt({ phase: "local-search", engine: "local", model: undefined })
      )
    ).toBe("Local recommendations for “COMEDY”")
  })

  it("says 'Local recommendations' on fallback, even when AI was attempted", () => {
    expect(
      aiSearchRailTitle(
        receipt({
          phase: "fallback",
          engine: "local",
          fallbackReason: "AI couldn't answer just now, so these are local picks.",
        })
      )
    ).toBe("Local recommendations for “COMEDY”")
  })
})

describe("aiSearchStateNote / isFreshAiAnswer", () => {
  it("'AI answered just now' only for a real, recently completed API call", () => {
    const note = aiSearchStateNote(receipt(), NOW)
    expect(note).toContain("AI answered just now")
    expect(note).toContain("gpt-4o-mini")
    expect(isFreshAiAnswer(receipt(), NOW)).toBe(true)
  })

  it("a stale validated answer drops 'just now' but keeps the model", () => {
    const stale = receipt({ answeredAt: NOW - AI_FRESH_ANSWER_WINDOW_MS - 1000 })
    const note = aiSearchStateNote(stale, NOW)
    expect(note).toContain("AI answered")
    expect(note).not.toContain("just now")
    expect(note).toContain("gpt-4o-mini")
    expect(isFreshAiAnswer(stale, NOW)).toBe(false)
  })

  it("a cache hit must NOT render 'AI answered just now'", () => {
    const cached = receipt({
      phase: "cached",
      engine: "cached-ai",
      cacheHit: true,
      answeredAt: NOW,
    })
    const note = aiSearchStateNote(cached, NOW)
    expect(note).not.toContain("AI answered just now")
    expect(note).toMatch(/Cached/)
    expect(note).toMatch(/no new request was sent/)
    expect(isFreshAiAnswer(cached, NOW)).toBe(false)
  })

  it("a local result must NOT render 'AI answered just now' or 'AI picks'", () => {
    const local = receipt({ phase: "local-search", engine: "local", model: undefined })
    const note = aiSearchStateNote(local, NOW)
    expect(note).not.toContain("AI answered")
    expect(note).toMatch(/Local search/)
    expect(isFreshAiAnswer(local, NOW)).toBe(false)
    expect(aiSearchRailTitle(local)).not.toContain("AI picks")
  })

  it("a fallback repeats the ranker's own reason and never says 'AI picks'", () => {
    const reason = "The AI provider is rate-limiting requests, so these are local picks for now."
    const fb = receipt({ phase: "fallback", engine: "local", fallbackReason: reason })
    expect(aiSearchStateNote(fb, NOW)).toBe(reason)
    expect(aiSearchRailTitle(fb)).not.toContain("AI picks")
    expect(isFreshAiAnswer(fb, NOW)).toBe(false)
  })

  it("sending names the active model", () => {
    const note = aiSearchStateNote(
      receipt({ phase: "sending", answeredAt: undefined }),
      NOW
    )
    expect(note).toContain("Sending one request to gpt-4o-mini")
  })

  it("sending without a model still says a request is being sent", () => {
    const note = aiSearchStateNote(
      receipt({ phase: "sending", model: undefined, answeredAt: undefined }),
      NOW
    )
    expect(note).toMatch(/Sending one request/)
    expect(note).not.toContain("gpt-4o-mini")
  })

  it("received and rejected never claim a fresh answer", () => {
    for (const phase of ["received", "rejected"] as const) {
      const r = receipt({ phase, answeredAt: NOW })
      expect(aiSearchStateNote(r, NOW)).not.toContain("just now")
      expect(isFreshAiAnswer(r, NOW)).toBe(false)
    }
    expect(aiSearchStateNote(receipt({ phase: "rejected" }), NOW)).toMatch(
      /local picks/
    )
  })

  it("a validated receipt with no answeredAt is not fresh", () => {
    expect(isFreshAiAnswer(receipt({ answeredAt: undefined }), NOW)).toBe(false)
    expect(isFreshAiAnswer(receipt({ answeredAt: null }), NOW)).toBe(false)
  })

  it("every phase has a label", () => {
    const phases = [
      "idle",
      "local-search",
      "sending",
      "received",
      "validated",
      "rejected",
      "cached",
      "fallback",
    ] as const
    expect(Object.keys(AI_SEARCH_PHASE_LABELS).sort()).toEqual([...phases].sort())
    for (const phase of phases) {
      expect(AI_SEARCH_PHASE_LABELS[phase]).toBeTruthy()
    }
    expect(AI_SEARCH_PHASE_LABELS.cached).toMatch(/Cached/)
    expect(AI_SEARCH_PHASE_LABELS.fallback).toMatch(/fallback/)
  })
})

// --- rankDiscover diagnostics (additive reporting; ranking untouched) ---

function candidate(
  partial: Partial<DiscoverCandidate> & { id: string; title: string }
): DiscoverCandidate {
  return { kind: "movie", genres: [], cast: [], source: "catalog", ...partial }
}

const CATALOG: DiscoverCandidate[] = [
  candidate({ id: "10", title: "Star Voyage", genres: ["Sci-Fi"], rating: 7.2, year: 2024 }),
  candidate({ id: "11", title: "Galaxy Run", genres: ["Sci-Fi", "Action"], rating: 6.5, year: 2023 }),
  candidate({ id: "14", title: "Slapstick Comedy", genres: ["Comedy"], rating: 5.0, year: 2021 }),
  candidate({ id: "17", title: "Cosy Romance", genres: ["Romance"], rating: 7.9, year: 2024 }),
]

afterEach(() => {
  registerAIRanker(null)
})

describe("rankDiscover diagnostics", () => {
  it("reports catalogue size + accepted count on the local path", async () => {
    const out = await rankDiscover("COMEDY", CATALOG, emptyTasteModel("shared", "pl1"))
    expect(out.source).toBe("local")
    expect(out.diagnostics?.catalogueSize).toBe(CATALOG.length)
    expect(out.diagnostics?.acceptedCount).toBe(out.results.length)
    expect(out.diagnostics?.rejectedCount).toBe(0)
    expect(out.fallbackReason).toBeUndefined()
  })

  it("counts model-ranked ids dropped by validation as rejected", async () => {
    registerAIRanker({
      // The shortlist is retrieval-ordered, so the valid entry must
      // be picked by id, not by position: for this cosy query the
      // shortlist head is Cosy Romance, not CATALOG[0]. The test's
      // point is the drop count (1 valid + 1 invented -> rejected 1),
      // not which valid title the mock returns.
      rank: async (_q, candidates): Promise<RankedCandidate[]> => [
        {
          candidate:
            candidates.find((c) => c.id === CATALOG[0].id) ?? candidates[0],
          score: 1,
          reason: "Cosy and funny.",
        },
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
    const out = await rankDiscover(
      "something cosy for tonight please",
      CATALOG,
      emptyTasteModel("shared", "pl1")
    )
    expect(out.source).toBe("ai")
    expect(out.results.map((r) => r.candidate.id)).toEqual([CATALOG[0].id])
    expect(out.diagnostics?.catalogueSize).toBe(CATALOG.length)
    expect(out.diagnostics?.acceptedCount).toBe(1)
    expect(out.diagnostics?.rejectedCount).toBe(1)
  })

  it("reports the empty-ranking fallback with diagnostics intact", async () => {
    registerAIRanker({ rank: async () => [] })
    const out = await rankDiscover(
      "something cosy for tonight please",
      CATALOG,
      emptyTasteModel("shared", "pl1")
    )
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toMatch(/didn't rank/)
    expect(out.diagnostics?.catalogueSize).toBe(CATALOG.length)
    expect(out.diagnostics?.acceptedCount).toBe(out.results.length)
  })

  it("reports the error fallback with diagnostics intact", async () => {
    registerAIRanker({
      rank: async () => {
        throw Object.assign(new Error("provider down"), { kind: "unavailable" })
      },
    })
    const out = await rankDiscover(
      "something cosy for tonight please",
      CATALOG,
      emptyTasteModel("shared", "pl1")
    )
    expect(out.source).toBe("local")
    expect(out.fallbackReason).toMatch(/couldn't answer/)
    expect(out.diagnostics?.catalogueSize).toBe(CATALOG.length)
    expect(out.diagnostics?.rejectedCount).toBe(0)
  })

  it("leaves W1/W2-owned counts undefined until their layer reports them", async () => {
    const out = await rankDiscover("COMEDY", CATALOG, emptyTasteModel("shared", "pl1"))
    expect(out.diagnostics?.retrievedCount).toBeUndefined()
    expect(out.diagnostics?.sentToModelCount).toBeUndefined()
    expect(out.diagnostics?.cacheHit).toBeUndefined()
  })
})
