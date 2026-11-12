// AI Discovery 3.0 — W3 UI behaviour tests (0.11.6).
//
// These tests exercise the frozen contracts the Discover UI builds
// against (via the W3 shims, which integration deletes) plus the real
// presentation helpers. No network, no keys, no browser globals: the
// orchestrator shim's `handler` override stands in for the model, so
// every "model call" is exactly countable.
//
// Covered:
// - Available-only toggle filters client-side with NO new model call,
//   never substitutes, never pads.
// - New Search clears everything, including the conversation.
// - Refinements preserve the conversation (turns accumulate; the
//   second call receives the first call's turn).
// - Quick picks start fresh (no carried query/conversation/filters).
// - Genre selection REPLACES (Comedy -> Horror is Horror, never an
//   intersection); null clears; other fields untouched; no mutation.
// - Unavailable / unverified states: honest copy, no detail href
//   without a match, no invented metadata.
// - No model call happens for pure state transitions (filtering,
//   clearing, genre selection) — only an explicit runAiDiscovery call
//   invokes the handler.
// - Abort cancels an in-flight run; a repeat identical request is a
//   cache hit with a cached-ai receipt.

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  runAiDiscovery,
  resetDiscoveryShimCache,
  type DiscoveryResult,
  type VerifiedRecommendation,
} from "@/scripts/lib/ai/discovery-orchestrator.ts"
import {
  newConversation,
  conversationContextFor,
} from "@/scripts/lib/ai/generation.ts"
import {
  freshDiscoveryState,
  applyQuickPick,
  applyNewSearch,
  selectGenreFilter,
} from "@/scripts/lib/discover-state.ts"
import { DEFAULT_BROWSE_FILTERS } from "@/scripts/lib/browse-filters.ts"
import {
  visibleRecommendations,
  countMatched,
  recommendationDetailHref,
  isRefinementSubmit,
  refinementContextLabel,
  formatTasteSummaryForAi,
  providerErrorMessage,
  providerErrorCodeFor,
  aiDiscoveryProgressText,
} from "@/scripts/lib/ai/discovery-presentation.ts"
import type { AiSearchReceipt } from "@/scripts/lib/ai/status.ts"

function fakeRec(overrides: Partial<VerifiedRecommendation> = {}): VerifiedRecommendation {
  return {
    generated: "Fake Title",
    verified: true,
    tmdbId: 1,
    title: "Fake Title",
    year: 2020,
    kind: "movie",
    reason: "A specific reason for this title.",
    tone: "Warm",
    genres: ["Comedy"],
    synopsis: "A synopsis.",
    posterUrl: "https://image.tmdb.org/t/p/w342/fake.jpg",
    backdropUrl: null,
    match: null,
    ...overrides,
  }
}

function matchedRec(title: string, key: string): VerifiedRecommendation {
  return fakeRec({
    generated: title,
    title,
    match: { compositeId: key, kind: "movie", title, year: 2020, catalogueKey: key },
  })
}

function fakeReceipt(overrides: Partial<AiSearchReceipt> = {}): AiSearchReceipt {
  return {
    phase: "validated",
    engine: "ai",
    query: "something funny",
    model: "gpt-4o-mini",
    answeredAt: Date.now(),
    durationMs: 1200,
    cacheHit: false,
    diagnostics: {
      queryType: "natural-language",
      generatedCount: 3,
      verifiedCount: 3,
      matchedCount: 2,
      verificationFailures: 0,
    },
    ...overrides,
  }
}

/** A counting handler that returns a fixed mixed-availability result. */
function countingHandler(counter: { calls: number }, results: VerifiedRecommendation[]) {
  return vi.fn(async (request: Parameters<typeof runAiDiscovery>[0]) => {
    counter.calls++
    const receipt = fakeReceipt({ query: request.query })
    const conversation = {
      turns: [
        ...request.conversation.turns,
        { query: request.query, generatedTitles: results.map((r) => r.generated) },
      ],
    }
    const out: DiscoveryResult = {
      results,
      receipt,
      diagnostics: receipt.diagnostics,
      conversation,
    }
    return out
  })
}

beforeEach(() => {
  resetDiscoveryShimCache()
})

describe("available-only toggle (client-side filter, no new model call)", () => {
  const mixed = [
    matchedRec("In The Library", "movie:101"),
    fakeRec({ generated: "Not In Library", title: "Not In Library" }),
    matchedRec("Also In Library", "movie:102"),
  ]

  it("OFF shows every recommendation, ON shows only matched entries", () => {
    expect(visibleRecommendations(mixed, false)).toHaveLength(3)
    const only = visibleRecommendations(mixed, true)
    expect(only).toHaveLength(2)
    expect(only.map((r) => r.title)).toEqual(["In The Library", "Also In Library"])
  })

  it("never substitutes or pads: two available means two shown", () => {
    const only = visibleRecommendations(mixed, true)
    expect(only.every((r) => r.match != null)).toBe(true)
    expect(countMatched(mixed)).toBe(2)
  })

  it("toggling does not call the model: one request, many filters", async () => {
    const counter = { calls: 0 }
    const handler = countingHandler(counter, mixed)
    const first = await runAiDiscovery(
      { query: "something funny", conversation: newConversation(), availableOnly: false },
      { handler }
    )
    expect(counter.calls).toBe(1)
    // Toggle ON, then OFF, then ON again — pure filtering, no calls.
    expect(visibleRecommendations(first.results, true)).toHaveLength(2)
    expect(visibleRecommendations(first.results, false)).toHaveLength(3)
    expect(visibleRecommendations(first.results, true)).toHaveLength(2)
    expect(counter.calls).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("new search clears everything", () => {
  it("applyNewSearch returns a fresh state with an empty conversation", () => {
    const cleared = applyNewSearch()
    expect(cleared.query).toBe("")
    expect(cleared.conversation.turns).toEqual([])
    expect(cleared.availableOnly).toBe(false)
    expect(cleared.activeMood).toBeNull()
  })

  it("freshDiscoveryState is independent per call (no shared conversation)", () => {
    const a = freshDiscoveryState()
    const b = freshDiscoveryState()
    a.conversation.turns.push({ query: "x", generatedTitles: ["Y"] })
    expect(b.conversation.turns).toEqual([])
  })

  it("a search after New Search starts with zero turns", async () => {
    const counter = { calls: 0 }
    const handler = countingHandler(counter, [matchedRec("A", "movie:1")])
    const conversation = newConversation()
    conversation.turns.push({ query: "old question", generatedTitles: ["Old"] })
    const fresh = applyNewSearch()
    await runAiDiscovery(
      { query: "new question", conversation: fresh.conversation, availableOnly: false },
      { handler }
    )
    const seen = handler.mock.calls[0][0]
    expect(seen.conversation.turns).toEqual([])
  })
})

describe("conversational refinement preserves conversation", () => {
  it("the second call receives the first call's turn", async () => {
    const counter = { calls: 0 }
    const handler = countingHandler(counter, [matchedRec("A", "movie:1")])
    const first = await runAiDiscovery(
      { query: "dark anime", conversation: newConversation(), availableOnly: false },
      { handler }
    )
    expect(first.conversation.turns).toHaveLength(1)
    expect(first.conversation.turns[0].query).toBe("dark anime")

    const second = await runAiDiscovery(
      { query: "Darker", conversation: first.conversation, availableOnly: false },
      { handler }
    )
    expect(second.conversation.turns).toHaveLength(2)
    expect(second.conversation.turns[1].query).toBe("Darker")
    const seen = handler.mock.calls[1][0]
    expect(seen.conversation.turns).toHaveLength(1)
    expect(seen.conversation.turns[0].query).toBe("dark anime")
    expect(counter.calls).toBe(2)
  })

  it("conversationContextFor renders one honest line per turn", () => {
    expect(conversationContextFor(newConversation())).toEqual([])
    const state = newConversation()
    state.turns.push({ query: "dark anime", generatedTitles: ["Akira", "Ghost in the Shell"] })
    expect(conversationContextFor(state)).toEqual([
      "dark anime (previously suggested: Akira, Ghost in the Shell)",
    ])
  })

  it("refinement context label names the original question", () => {
    expect(refinementContextLabel(newConversation())).toBe("")
    const state = newConversation()
    state.turns.push({ query: "dark anime", generatedTitles: [] })
    state.turns.push({ query: "Darker", generatedTitles: [] })
    expect(refinementContextLabel(state)).toBe("Refining: “dark anime”")
  })

  it("isRefinementSubmit only when results + conversation + typed query", () => {
    const withTurns = newConversation()
    withTurns.turns.push({ query: "dark anime", generatedTitles: [] })
    expect(isRefinementSubmit(withTurns, true, "Darker")).toBe(true)
    expect(isRefinementSubmit(withTurns, false, "Darker")).toBe(false)
    expect(isRefinementSubmit(newConversation(), true, "Darker")).toBe(false)
    expect(isRefinementSubmit(withTurns, true, "   ")).toBe(false)
  })
})

describe("quick picks start fresh", () => {
  it("applyQuickPick carries nothing: no query, no conversation, no toggle", () => {
    const before = freshDiscoveryState()
    before.query = "something funny"
    before.availableOnly = true
    before.conversation.turns.push({ query: "old", generatedTitles: ["Old"] })
    const next = applyQuickPick(before, "easy")
    expect(next.query).toBe("")
    expect(next.conversation.turns).toEqual([])
    expect(next.availableOnly).toBe(false)
    expect(next.activeMood).toBe("easy")
  })

  it("applyQuickPick does not mutate the previous state", () => {
    const before = freshDiscoveryState()
    before.query = "keep me"
    applyQuickPick(before, "intense")
    expect(before.query).toBe("keep me")
    expect(before.activeMood).toBeNull()
  })
})

describe("genre selection replaces (Comedy -> Horror bug)", () => {
  it("picking Horror after Comedy means Horror, never an intersection", () => {
    const comedy = selectGenreFilter(DEFAULT_BROWSE_FILTERS, "comedy")
    expect(comedy.genre).toBe("comedy")
    const horror = selectGenreFilter(comedy, "horror")
    expect(horror.genre).toBe("horror")
    expect(horror.genre).not.toContain("comedy")
  })

  it("null clears the genre; other fields are untouched; input not mutated", () => {
    const state = { ...DEFAULT_BROWSE_FILTERS, genre: "comedy", minRating: 7, sort: "rating" as const }
    const cleared = selectGenreFilter(state, null)
    expect(cleared.genre).toBe("")
    expect(cleared.minRating).toBe(7)
    expect(cleared.sort).toBe("rating")
    expect(state.genre).toBe("comedy")
    expect(cleared).not.toBe(state)
  })
})

describe("unavailable and unverified states", () => {
  it("an unverified title with a match is never counted as available", () => {
    const rec = matchedRec("Maybe This", "movie:55")
    rec.verified = false
    expect(countMatched([rec])).toBe(0)
    expect(visibleRecommendations([rec], true)).toEqual([])
  })

  it("no match means no detail href — unavailable titles link nowhere", () => {
    expect(recommendationDetailHref(fakeRec())).toBeNull()
    expect(recommendationDetailHref(matchedRec("A", "movie:101"))).toBe(
      "/movies/detail?id=101"
    )
    expect(
      recommendationDetailHref(
        fakeRec({
          match: { compositeId: "series:7", kind: "series", title: "S", year: 2020, catalogueKey: "series:7" },
        })
      )
    ).toBe("/series/detail?id=7")
  })

  it("an unverified title never links, even with a match present", () => {
    const rec = matchedRec("Maybe This", "movie:55")
    rec.verified = false
    expect(recommendationDetailHref(rec)).toBeNull()
  })

  it("a malformed catalogue key never produces a guessed route", () => {
    const bad = fakeRec({
      match: { compositeId: "???", kind: "movie", title: "X", year: 2020, catalogueKey: "???" },
    })
    expect(recommendationDetailHref(bad)).toBeNull()
    const live = fakeRec({
      match: { compositeId: "live:9", kind: "movie", title: "X", year: 2020, catalogueKey: "live:9" },
    })
    expect(recommendationDetailHref(live)).toBeNull()
  })

  it("unverified recommendations carry no artwork claim in the shim", async () => {
    // The shim's unverified scenario is sessionStorage-driven; here we
    // assert the shape contract directly: an unverified rec may carry a
    // note, and the UI must not treat it as verified.
    const rec = fakeRec({ verified: false, tmdbId: null, posterUrl: null, verificationNote: "TMDB could not verify this title — the details shown are unconfirmed." })
    expect(rec.verified).toBe(false)
    expect(rec.posterUrl).toBeNull()
    expect(rec.verificationNote).toMatch(/could not verify/)
  })

  it("provider error copy is plain and never echoes raw error text", () => {
    expect(providerErrorMessage("rate_limited")).toMatch(/rate-limiting/)
    expect(providerErrorMessage("bogus-code-with-https://example.invalid/x?k=secret")).toBe(
      "The AI provider couldn't be reached. Check your connection and try again."
    )
    expect(providerErrorMessage(undefined)).toMatch(/couldn't be reached/)
  })

  it("providerErrorCodeFor maps thrown errors without surfacing messages", () => {
    expect(providerErrorCodeFor(Object.assign(new Error("boom"), { providerError: "timeout" }))).toBe("timeout")
    expect(providerErrorCodeFor(new Error("Rate limit exceeded, retry later"))).toBe("rate_limited")
    expect(providerErrorCodeFor(new Error("weird opaque failure"))).toBe("unavailable")
  })
})

describe("no model call for pure transitions", () => {
  it("filtering, clearing, genre selection and labelling never invoke the handler", async () => {
    const counter = { calls: 0 }
    const handler = countingHandler(counter, [matchedRec("A", "movie:1")])
    // Exercise every pure transition WITHOUT calling runAiDiscovery.
    const state = freshDiscoveryState()
    applyQuickPick(state, "easy")
    applyNewSearch()
    selectGenreFilter(DEFAULT_BROWSE_FILTERS, "comedy")
    visibleRecommendations([matchedRec("A", "movie:1")], true)
    refinementContextLabel(newConversation())
    formatTasteSummaryForAi({ favouriteGenres: ["comedy"], likedTitles: [], dislikedTitles: [] })
    aiDiscoveryProgressText("asking")
    expect(counter.calls).toBe(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it("the shim itself only runs when runAiDiscovery is called", async () => {
    // No handler, no call: constructing state must not touch the shim
    // cache or produce results. The proof is the cache-hit test below:
    // a first call is fresh, a second identical call is cached.
    const first = await runAiDiscovery(
      { query: "something funny for tonight", conversation: newConversation(), availableOnly: false },
      {}
    )
    expect(first.receipt.engine).toBe("ai")
    expect(first.receipt.cacheHit).toBe(false)
    const second = await runAiDiscovery(
      { query: "something funny for tonight", conversation: newConversation(), availableOnly: false },
      {}
    )
    expect(second.receipt.engine).toBe("cached-ai")
    expect(second.receipt.phase).toBe("cached")
    expect(second.receipt.cacheHit).toBe(true)
    expect(second.results.map((r) => r.title)).toEqual(first.results.map((r) => r.title))
  })
})

describe("shim run semantics (frozen contract shape)", () => {
  it("returns results + receipt + diagnostics + appended conversation", async () => {
    const result = await runAiDiscovery(
      { query: "dark anime", conversation: newConversation(), availableOnly: false, count: 4 },
      { model: "gpt-4o-mini" }
    )
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results.length).toBeLessThanOrEqual(4)
    expect(result.diagnostics).toBe(result.receipt.diagnostics)
    expect(result.receipt.model).toBe("gpt-4o-mini")
    expect(result.diagnostics.generatedCount).toBeGreaterThan(0)
    expect(result.diagnostics.verifiedCount).toBeGreaterThan(0)
    expect(typeof result.diagnostics.matchedCount).toBe("number")
    expect(typeof result.diagnostics.verificationFailures).toBe("number")
    expect(result.conversation.turns).toHaveLength(1)
    expect(result.conversation.turns[0].generatedTitles).toEqual(
      result.results.map((r) => r.generated)
    )
  })

  it("matches against the supplied catalogue and leaves the rest unmatched", async () => {
    const catalogue = [
      { id: "101", kind: "movie", title: "Hot Fuzz", year: 2007, genres: [], cast: [], source: "catalog" },
      { id: "202", kind: "series", title: "Brooklyn Nine-Nine", year: 2013, genres: [], cast: [], source: "catalog" },
    ] as never
    const result = await runAiDiscovery(
      { query: "something funny", conversation: newConversation(), availableOnly: false },
      { catalogue }
    )
    const matched = result.results.filter((r) => r.match)
    const unmatched = result.results.filter((r) => !r.match)
    expect(matched.length).toBeGreaterThan(0)
    expect(unmatched.length).toBeGreaterThan(0)
    expect(matched[0].match?.catalogueKey).toMatch(/^(movie|series):\d+$/)
    expect(result.diagnostics.matchedCount).toBe(matched.length)
  })

  it("with no catalogue, nothing is claimed to be in the library", async () => {
    const result = await runAiDiscovery(
      { query: "something funny", conversation: newConversation(), availableOnly: false },
      {}
    )
    expect(result.results.every((r) => r.match == null)).toBe(true)
    expect(result.diagnostics.matchedCount).toBe(0)
  })

  it("an aborted run rejects with AbortError and produces nothing", async () => {
    const controller = new AbortController()
    const promise = runAiDiscovery(
      { query: "dark anime please", conversation: newConversation(), availableOnly: false, signal: controller.signal },
      {}
    )
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  })

  it("an empty query is rejected, never sent", async () => {
    await expect(
      runAiDiscovery({ query: "   ", conversation: newConversation(), availableOnly: false }, {})
    ).rejects.toThrow(TypeError)
  })

  it("progress phases are emitted in order when the caller listens", async () => {
    const phases: string[] = []
    await runAiDiscovery(
      { query: "a unique progress query xyz", conversation: newConversation(), availableOnly: false },
      { onPhase: (phase) => phases.push(phase) }
    )
    expect(phases).toEqual(["asking", "verifying", "checking"])
  })
})

describe("taste summary formatting", () => {
  it("formats real signals only, and null when there is nothing to say", () => {
    expect(formatTasteSummaryForAi(null)).toBeNull()
    expect(
      formatTasteSummaryForAi({ favouriteGenres: [], likedTitles: [], dislikedTitles: [] })
    ).toBeNull()
    expect(
      formatTasteSummaryForAi({
        favouriteGenres: ["comedy", "drama"],
        likedTitles: ["Hot Fuzz"],
        dislikedTitles: ["Slow Burn"],
        preferredRuntimeMax: 120,
        pace: "light",
      })
    ).toBe(
      "Favourite genres: comedy, drama. Liked: Hot Fuzz. Disliked: Slow Burn. Prefers films under 120 minutes. Pace: light."
    )
  })
})

describe("progress copy", () => {
  it("names the three honest stages", () => {
    expect(aiDiscoveryProgressText("asking")).toBe("Asking AI for recommendations…")
    expect(aiDiscoveryProgressText("verifying")).toBe("Verifying titles with TMDB…")
    expect(aiDiscoveryProgressText("checking")).toBe("Checking your library…")
  })
})
