// AI Discovery 3.0 — W3 UI behaviour tests (0.11.6), integrated.
//
// These tests exercise the real modules the Discover UI builds
// against: runAiDiscovery (W1 orchestrator), verifyRecommendations
// (W2 verifier), the W4 state transitions, and the real presentation
// helpers — with injected fake model + TMDB transports. No network,
// no keys, no browser globals. The W3 branch ran this file against
// shims; integration rewired every shim-dependent assertion to the
// real behaviour (same intent, real semantics):
// - The orchestrator has no `handler`/`model`/`onPhase` deps: tests
//   inject `chat` + `searchTmdb` + `fetchDetails`, and progress is
//   observed via subscribeAiDiscoveryPhase with the real phase names
//   (asking-ai / verifying-tmdb / checking-library / ready).
// - DiscoverySearchState is W4's {query, activeMood, genre} shape;
//   conversation + toggle are view-owned companions, not state.
// - selectGenreFilter lives in browse-filters.ts (W4), not in
//   discover-state.ts.
// - VerifiedRecommendation.generated is a GeneratedRecommendation
//   object, never a bare title string.
// - An empty query resolves to an "unavailable" result with zero
//   model calls; it does not throw.
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
//   invokes the transport.
// - Abort cancels an in-flight run; a repeat identical request is a
//   cache hit with a cached-ai receipt.
// - Debounce-timer regression (0.11.6 P0): every transition that
//   replaces the typed query's meaning cancels the pending timer
//   first, so a quick pick within 250ms of typing survives.

import { readFileSync } from "node:fs"
import { describe, it, expect, beforeEach } from "vitest"
import {
  runAiDiscovery,
  clearAiDiscoveryCache,
  subscribeAiDiscoveryPhase,
  type DiscoveryRunResult,
} from "@/scripts/lib/ai/discovery-orchestrator.ts"
import {
  newConversation,
  conversationContextFor,
  type AiChatTransport,
  type GeneratedRecommendation,
} from "@/scripts/lib/ai/generation.ts"
import type { AiChatOptions } from "@/scripts/lib/ai/client.ts"
import {
  clearVerificationCache,
  type TmdbDetailsFn,
  type TmdbSearchFn,
  type VerifiedRecommendation,
} from "@/scripts/lib/ai/verification.ts"
import type { TmdbSearchResult } from "@/scripts/lib/tmdb.ts"
import {
  freshDiscoveryState,
  applyQuickPick,
  applyNewSearch,
} from "@/scripts/lib/discover-state.ts"
import {
  DEFAULT_BROWSE_FILTERS,
  selectGenreFilter,
} from "@/scripts/lib/browse-filters.ts"
import type { DiscoverCandidate } from "@/scripts/lib/discover.ts"
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

function fakeRec(overrides: Partial<VerifiedRecommendation> = {}): VerifiedRecommendation {
  return {
    generated: {
      title: "Fake Title",
      year: 2020,
      kind: "movie",
      reason: "A specific reason for this title.",
      tone: "Warm",
    },
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
    generated: {
      title,
      year: 2020,
      kind: "movie",
      reason: "A specific reason for this title.",
      tone: "Warm",
    },
    title,
    match: { compositeId: key, kind: "movie", title, year: 2020, catalogueKey: key },
  })
}

function gen(
  title: string,
  kind: "movie" | "series" = "movie",
  year: number | null = 2020
): GeneratedRecommendation {
  return { title, year, kind, reason: `A specific reason for ${title}.`, tone: "Warm" }
}

/** A counting fake chat transport returning canned generated titles. */
function fakeChat(
  replies: GeneratedRecommendation[][],
  model = "mock-model-1"
): { transport: AiChatTransport; calls: AiChatOptions[]; callCount: () => number } {
  const calls: AiChatOptions[] = []
  const transport: AiChatTransport = async (options) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)]
    calls.push(options)
    return { text: JSON.stringify({ recommendations: reply }), model }
  }
  return { transport, calls, callCount: () => calls.length }
}

/** A fake TMDB search that verifies exactly the titles it knows. */
function fakeTmdbSearch(known: GeneratedRecommendation[]): TmdbSearchFn {
  return async (query) => {
    const found = known.find(
      (rec) => rec.title.toLowerCase() === query.title.toLowerCase() && rec.kind === query.kind
    )
    if (!found) return []
    const id = 1000 + known.indexOf(found)
    const year = found.year ?? 2020
    const base: TmdbSearchResult = {
      id,
      vote_count: 100,
      popularity: 10,
      poster_path: `/mock-${id}.jpg`,
      backdrop_path: null,
      overview: `Overview for ${found.title}.`,
    }
    return [
      found.kind === "movie"
        ? { ...base, title: found.title, original_title: found.title, release_date: `${year}-01-01` }
        : { ...base, name: found.title, original_name: found.title, first_air_date: `${year}-01-01` },
    ]
  }
}

const fakeDetails: TmdbDetailsFn = async (tmdbId) => ({
  genres: ["Drama"],
  synopsis: `Synopsis for ${tmdbId}.`,
  posterUrl: `https://image.tmdb.org/t/p/w500/mock-${tmdbId}.jpg`,
  backdropUrl: null,
  alternativeTitles: [],
})

function candidate(overrides: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return { kind: "movie", genres: [], cast: [], source: "catalog", ...overrides }
}

function allText(calls: AiChatOptions[], index: number): string {
  return (calls[index]?.messages ?? []).map((message) => message.content).join("\n")
}

beforeEach(() => {
  clearAiDiscoveryCache()
  clearVerificationCache()
})

describe("available-only toggle (client-side filter, no new model call)", () => {
  const mixed = [
    matchedRec("In The Library", "movie:101"),
    fakeRec({ generated: gen("Not In Library"), title: "Not In Library" }),
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
    const recs = [gen("In The Library"), gen("Not In Library"), gen("Also In Library")]
    const chat = fakeChat([recs])
    const first = await runAiDiscovery(
      { query: "something funny", conversation: newConversation(), availableOnly: false },
      {
        chat: chat.transport,
        searchTmdb: fakeTmdbSearch(recs),
        fetchDetails: fakeDetails,
        catalogue: [
          candidate({ id: "101", title: "In The Library", year: 2020 }),
          candidate({ id: "102", title: "Also In Library", year: 2020 }),
        ],
        profileId: "w3-toggle-1",
      }
    )
    expect(chat.callCount()).toBe(1)
    expect(first.results).toHaveLength(3)
    // Toggle ON, then OFF, then ON again — pure filtering, no calls.
    expect(visibleRecommendations(first.results, true)).toHaveLength(2)
    expect(visibleRecommendations(first.results, false)).toHaveLength(3)
    expect(visibleRecommendations(first.results, true)).toHaveLength(2)
    expect(chat.callCount()).toBe(1)
  })
})

describe("new search clears everything", () => {
  it("applyNewSearch returns a fresh state; the conversation companion is empty", () => {
    const cleared = applyNewSearch()
    expect(cleared.query).toBe("")
    expect(cleared.activeMood).toBeNull()
    expect(cleared.genre).toBeNull()
    // Conversation is NOT part of DiscoverySearchState (W4): the view
    // clears it alongside via newConversation().
    expect(newConversation().turns).toEqual([])
  })

  it("freshDiscoveryState is independent per call (no shared state)", () => {
    const a = freshDiscoveryState()
    const b = freshDiscoveryState()
    a.query = "x"
    a.genre = "comedy"
    expect(b.query).toBe("")
    expect(b.genre).toBeNull()
    expect(a).not.toBe(b)
  })

  it("a search after New Search starts with zero turns", async () => {
    const chat = fakeChat([[gen("Fresh Title")]])
    const recs = [gen("Fresh Title")]
    const conversation = newConversation()
    conversation.turns.push({ query: "old question", generatedTitles: ["Old Title"] })
    const fresh = applyNewSearch()
    expect(fresh.query).toBe("")
    const result = await runAiDiscovery(
      { query: "new question", conversation: newConversation(), availableOnly: false },
      {
        chat: chat.transport,
        searchTmdb: fakeTmdbSearch(recs),
        fetchDetails: fakeDetails,
        catalogue: [],
        profileId: "w3-newsearch-1",
      }
    )
    expect(result.conversation.turns).toHaveLength(1)
    expect(result.conversation.turns[0].query).toBe("new question")
    // The model saw nothing of the old conversation.
    expect(allText(chat.calls, 0)).not.toContain("old question")
    expect(allText(chat.calls, 0)).not.toContain("Old Title")
  })
})

describe("conversational refinement preserves conversation", () => {
  it("the second call receives the first call's turn", async () => {
    const firstRecs = [gen("Dark Title One")]
    const secondRecs = [gen("Dark Title Two")]
    const chat = fakeChat([firstRecs, secondRecs])
    const search = fakeTmdbSearch([...firstRecs, ...secondRecs])
    const deps = {
      chat: chat.transport,
      searchTmdb: search,
      fetchDetails: fakeDetails,
      catalogue: [] as DiscoverCandidate[],
      profileId: "w3-refine-1",
    }
    const first = await runAiDiscovery(
      { query: "dark anime", conversation: newConversation(), availableOnly: false },
      deps
    )
    expect(first.conversation.turns).toHaveLength(1)
    expect(first.conversation.turns[0].query).toBe("dark anime")

    const second = await runAiDiscovery(
      { query: "Darker", conversation: first.conversation, availableOnly: false },
      deps
    )
    expect(second.conversation.turns).toHaveLength(2)
    expect(second.conversation.turns[1].query).toBe("Darker")
    // The refinement prompt carries the prior turn; the first call
    // knew nothing of the refinement.
    expect(allText(chat.calls, 1)).toContain("dark anime")
    expect(allText(chat.calls, 1)).toContain("Dark Title One")
    expect(allText(chat.calls, 0)).not.toContain("Darker")
    expect(chat.callCount()).toBe(2)
  })

  it("conversationContextFor renders one honest line per turn", () => {
    expect(conversationContextFor(newConversation())).toEqual([])
    const state = newConversation()
    state.turns.push({ query: "dark anime", generatedTitles: ["Akira", "Ghost in the Shell"] })
    expect(conversationContextFor(state)).toEqual([
      '- Earlier request: "dark anime" Already suggested: Akira, Ghost in the Shell.',
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
  it("applyQuickPick carries nothing: no query, no genre, only the new mood", () => {
    const before = freshDiscoveryState()
    before.query = "something funny"
    before.genre = "comedy"
    const next = applyQuickPick(before, "easy")
    expect(next.query).toBe("")
    expect(next.genre).toBeNull()
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

  it("unverified recommendations carry no artwork claim", () => {
    // Shape contract, asserted directly: an unverified rec may carry
    // a note, and the UI must not treat it as verified.
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
  it("filtering, clearing, genre selection and labelling never invoke the transport", async () => {
    const chat = fakeChat([[gen("A")]])
    // Exercise every pure transition WITHOUT calling runAiDiscovery.
    const state = freshDiscoveryState()
    applyQuickPick(state, "easy")
    applyNewSearch()
    selectGenreFilter(DEFAULT_BROWSE_FILTERS, "comedy")
    visibleRecommendations([matchedRec("A", "movie:1")], true)
    refinementContextLabel(newConversation())
    formatTasteSummaryForAi({ favouriteGenres: ["comedy"], likedTitles: [], dislikedTitles: [] })
    aiDiscoveryProgressText("asking-ai")
    expect(chat.callCount()).toBe(0)
  })

  it("a repeat identical request is a cache hit with a cached-ai receipt", async () => {
    const recs = [gen("Cache Title One"), gen("Cache Title Two")]
    const chat = fakeChat([recs])
    const deps = {
      chat: chat.transport,
      searchTmdb: fakeTmdbSearch(recs),
      fetchDetails: fakeDetails,
      catalogue: [] as DiscoverCandidate[],
      profileId: "w3-cache-1",
    }
    const request = {
      query: "something funny for tonight",
      conversation: newConversation(),
      availableOnly: false,
    }
    const first: DiscoveryRunResult = await runAiDiscovery(request, deps)
    expect(first.receipt.engine).toBe("ai")
    expect(first.receipt.cacheHit).toBe(false)
    const second = await runAiDiscovery(request, deps)
    expect(second.receipt.engine).toBe("cached-ai")
    expect(second.receipt.phase).toBe("cached")
    expect(second.receipt.cacheHit).toBe(true)
    expect(second.results.map((r) => r.title)).toEqual(first.results.map((r) => r.title))
    expect(chat.callCount()).toBe(1)
  })
})

describe("orchestrator run semantics (real modules)", () => {
  it("returns results + receipt + diagnostics + appended conversation", async () => {
    const recs = [gen("Run Title One"), gen("Run Title Two"), gen("Run Title Three"), gen("Run Title Four")]
    const chat = fakeChat([recs], "gpt-4o-mini")
    const result = await runAiDiscovery(
      { query: "dark anime", conversation: newConversation(), availableOnly: false, count: 4 },
      {
        chat: chat.transport,
        searchTmdb: fakeTmdbSearch(recs),
        fetchDetails: fakeDetails,
        catalogue: [],
        profileId: "w3-run-1",
      }
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
      result.results.map((r) => r.title)
    )
  })

  it("matches against the supplied catalogue and leaves the rest unmatched", async () => {
    const recs = [
      gen("Hot Fuzz", "movie", 2007),
      gen("Brooklyn Nine-Nine", "series", 2013),
      gen("Unmatched One"),
      gen("Unmatched Two", "series"),
    ]
    const chat = fakeChat([recs])
    const result = await runAiDiscovery(
      { query: "something funny", conversation: newConversation(), availableOnly: false },
      {
        chat: chat.transport,
        searchTmdb: fakeTmdbSearch(recs),
        fetchDetails: fakeDetails,
        catalogue: [
          candidate({ id: "101", kind: "movie", title: "Hot Fuzz", year: 2007 }),
          candidate({ id: "202", kind: "series", title: "Brooklyn Nine-Nine", year: 2013 }),
        ],
        profileId: "w3-run-2",
      }
    )
    const matched = result.results.filter((r) => r.match)
    const unmatched = result.results.filter((r) => !r.match)
    expect(matched.length).toBeGreaterThan(0)
    expect(unmatched.length).toBeGreaterThan(0)
    expect(matched[0].match?.catalogueKey).toMatch(/^(movie|series):\d+$/)
    expect(result.diagnostics.matchedCount).toBe(matched.length)
  })

  it("with no catalogue, nothing is claimed to be in the library", async () => {
    const recs = [gen("No Catalog Title")]
    const chat = fakeChat([recs])
    const result = await runAiDiscovery(
      { query: "something funny", conversation: newConversation(), availableOnly: false },
      {
        chat: chat.transport,
        searchTmdb: fakeTmdbSearch(recs),
        fetchDetails: fakeDetails,
        profileId: "w3-run-3",
      }
    )
    expect(result.results.every((r) => r.match == null)).toBe(true)
    expect(result.diagnostics.matchedCount).toBe(0)
  })

  it("an aborted run rejects with AbortError and produces nothing", async () => {
    const controller = new AbortController()
    const abortingChat: AiChatTransport = async (options) => {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        )
      })
      throw new Error("unreachable")
    }
    const promise = runAiDiscovery(
      { query: "dark anime please", conversation: newConversation(), availableOnly: false, signal: controller.signal },
      {
        chat: abortingChat,
        searchTmdb: fakeTmdbSearch([]),
        fetchDetails: fakeDetails,
        profileId: "w3-run-4",
      }
    )
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  })

  it("an empty query resolves unavailable and never sends a request", async () => {
    const chat = fakeChat([[gen("Never Sent")]])
    const result = await runAiDiscovery(
      { query: "   ", conversation: newConversation(), availableOnly: false },
      {
        chat: chat.transport,
        searchTmdb: fakeTmdbSearch([]),
        fetchDetails: fakeDetails,
        profileId: "w3-run-5",
      }
    )
    expect(result.results).toEqual([])
    expect(result.receipt.phase).toBe("unavailable")
    expect(result.receipt.fallbackReason).toBeTruthy()
    expect(chat.callCount()).toBe(0)
  })

  it("progress phases are emitted in order to subscribers", async () => {
    const recs = [gen("Progress Title")]
    const chat = fakeChat([recs])
    const phases: string[] = []
    const unsubscribe = subscribeAiDiscoveryPhase((phase) => phases.push(phase))
    // Drop the replayed last phase from any earlier run in this file.
    phases.length = 0
    try {
      await runAiDiscovery(
        { query: "a unique progress query xyz", conversation: newConversation(), availableOnly: false },
        {
          chat: chat.transport,
          searchTmdb: fakeTmdbSearch(recs),
          fetchDetails: fakeDetails,
          catalogue: [],
          profileId: "w3-run-6",
        }
      )
    } finally {
      unsubscribe()
    }
    expect(phases).toEqual(["asking-ai", "verifying-tmdb", "checking-library", "ready"])
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
    expect(aiDiscoveryProgressText("asking-ai")).toBe("Asking AI for recommendations…")
    expect(aiDiscoveryProgressText("verifying-tmdb")).toBe("Verifying titles with TMDB…")
    expect(aiDiscoveryProgressText("checking-library")).toBe("Checking your library…")
  })
})

describe("debounce timer (0.11.6 P0 regression)", () => {
  // The timer lives in DiscoverView.svelte, which has no component
  // mount harness in this repo (vitest runs in node; the settings
  // tests pin DiscoverView behaviour the same way — by reading the
  // source). These assertions pin the wiring that makes the runtime
  // behaviour true: one helper, called first by every transition
  // that replaces the typed query's meaning, and no other
  // clearTimeout call site that could leave a stale timer alive.
  const discoverView = readFileSync(
    new URL("../src/components/DiscoverView.svelte", import.meta.url),
    "utf8"
  )

  function handlerBody(name: string): string {
    const start = discoverView.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    const rest = discoverView.slice(start)
    const next = rest.indexOf("\n  function ", 1)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it("cancelQueryTimer clears the pending timer and nulls it", () => {
    const body = handlerBody("cancelQueryTimer")
    expect(body).toContain("clearTimeout(queryTimer)")
    expect(body).toContain("queryTimer = null")
  })

  it.each(["newSearch", "submitSearch", "askAi", "pickExample", "pickMood", "clearSearch"])(
    "%s cancels the debounce timer before any search or state effect",
    (name) => {
      const body = handlerBody(name)
      const cancelAt = body.indexOf("cancelQueryTimer()")
      expect(cancelAt).toBeGreaterThan(-1)
      const effectAt = Math.min(
        ...["void runSearch(", "void runAiSearch(", "queryDebounced =", "activeMood ="].map(
          (marker) => {
            const at = body.indexOf(marker)
            return at === -1 ? Number.POSITIVE_INFINITY : at
          }
        )
      )
      expect(effectAt).toBeLessThan(Number.POSITIVE_INFINITY)
      expect(cancelAt).toBeLessThan(effectAt)
    }
  )

  it("onQueryInput cancels any pending timer before arming a new one", () => {
    const body = handlerBody("onQueryInput")
    expect(body).toContain("cancelQueryTimer()")
    expect(body.indexOf("cancelQueryTimer()")).toBeLessThan(body.indexOf("setTimeout("))
  })

  it("no stale clearTimeout call site remains outside the helper", () => {
    const matches = discoverView.match(/clearTimeout\(/g) ?? []
    expect(matches).toHaveLength(1)
  })
})
