// AI Discovery 3.0 acceptance tests (0.11.6, W5 — brief §11, Tests A–L).
//
// Deterministic, hermetic tests against the REAL integration seams:
// runAiDiscovery (orchestrator), generateRecommendations (generation),
// verifyRecommendations (verification), selectGenreFilter (browse
// state), and the Discover state helpers — with a mocked model transport
// (tests/helpers/mocked-model.ts) and a mocked TMDB search
// (tests/helpers/mocked-tmdb.ts). No real network, no real API calls,
// no real keys. Mock data MAY contain real film/series titles: mocks are
// not production recommendations.
//
// READ BEFORE TOUCHING:
//   - In the W5 worktree these tests run against MINIMAL STUB modules
//     with the exact frozen signatures (marked STUB, deleted at
//     integration). The stubs call through to the injected fakes and
//     apply only the contract's stated semantics literally. Integration
//     deletes the stubs and runs THIS file against the real merged tree
//     — that run is the acceptance proof. A test that passes against a
//     stub but encodes a stub-only behaviour is a bug in the test: every
//     assertion below is written against the frozen contract, and every
//     place the contract was silent is called out in the W5 report.
//   - Cache isolation: the orchestrator cache is keyed (in part) by
//     profileId, so EVERY test uses its own profileId. Reusing one
//     across tests would turn a fresh call into a cache hit.
//   - Red/green evidence: each group was verified to FAIL against a
//     deliberately-broken stub variant and/or red-on-base (no stubs).
//     See the W5 report for the per-group table.
//   - Test K pins the ORCHESTRATION half of cost discipline only.
//     Typing/scrolling/controller-nav trigger discipline is UI-level
//     (W3); these tests pin that repeated identical searches cost one
//     call, refinements cost a fresh call, and the availableOnly toggle
//     costs nothing.
//   - Test E's state layer (selectGenreFilter / discover-state) does
//     NOT exist at the 0.11.5 base: red-on-base is a collection error
//     (missing module/function), verified by running this file with the
//     stubs removed. The replace-not-intersect assertions below are the
//     regression net for the user-reported Comedy→Horror bug.

import { describe, it, expect } from "vitest"
import {
  generateRecommendations,
  newConversation,
  conversationContextFor,
  type ConversationState,
} from "@/scripts/lib/ai/generation"
import {
  verifyRecommendations,
  type VerifiedRecommendation,
} from "@/scripts/lib/ai/verification"
import { runAiDiscovery } from "@/scripts/lib/ai/discovery-orchestrator"
import {
  applyNewSearch,
  applyQuickPick,
  freshDiscoveryState,
} from "@/scripts/lib/discover-state"
import {
  applyBrowseFilters,
  DEFAULT_BROWSE_FILTERS,
  selectGenreFilter,
  type BrowseFilterState,
} from "@/scripts/lib/browse-filters"
import {
  candidateKey,
  moodMatches,
  moodPreset,
  type DiscoverCandidate,
} from "@/scripts/lib/discover"
import {
  cleanProviderTitle,
  matchRecommendationsToCatalog,
  pickTmdbMatch,
} from "@/scripts/lib/tmdb-match"
import { aiSearchStateNote, isFreshAiAnswer } from "@/scripts/lib/ai/status"
import {
  AI30_CATALOGUE,
  NO_ANIME_CATALOGUE,
  GENRE_FILTER_CATALOGUE,
  PUNCTUATION_TITLES_30,
  WESTERN_ANIMATION_TITLES,
  ATTACK_ON_TITAN,
  DEATH_NOTE,
  PERFECT_BLUE,
  IT_SERIES_1990,
  IT_MOVIE_2017,
  SUPERBAD,
  HEREDITARY_A,
  DUNE_1984,
  DUNE_2021,
  THING_1982,
  THING_2011,
} from "./fixtures/ai-discovery-3.0-catalogue"
import {
  TMDB_ATTACK_ON_TITAN,
  TMDB_BLADE_RUNNER_2049,
  TMDB_DUNE_1984,
  TMDB_DUNE_2021,
  TMDB_IT_MOVIE_2017,
  TMDB_IT_SERIES_1990,
  TMDB_THING_1982,
} from "./fixtures/ai-discovery-3.0-tmdb"
import {
  ALIAS_TITLE_SET,
  COMEDY_SET,
  DARK_ANIME_MOVIES_POST_2010_SET,
  DARK_ANIME_QUERY_30,
  DARK_ANIME_SET,
  HORROR_SET,
  INVENTED_TITLE_SET,
  MIXED_AVAILABILITY_SET,
  NO_DETAILS_SET,
  STRONG_ABSENT_SET,
  UNMATCHABLE_YEAR_SET,
  WRONG_EXTERNAL_ID_SET,
  WRONG_YEAR_SET,
} from "./fixtures/ai-discovery-3.0-model"
import {
  INVALID_ITEMS_REPLY,
  MALFORMED_MODEL_REPLY,
  MOCK_MODEL_ID,
  allMessageText,
  createMockChat,
  failingMock,
  fixedReplyMock,
  modelReply,
  scriptedMock,
  systemMessageText,
  userMessageText,
  type MockChat,
} from "./helpers/mocked-model"
import { createMockTmdb } from "./helpers/mocked-tmdb"

const CATALOGUE_TITLES = new Set(AI30_CATALOGUE.map((entry) => entry.title))
const NO_ANIME_TITLES = new Set(NO_ANIME_CATALOGUE.map((entry) => entry.title))
const PUNCTUATION_SET = new Set<string>(PUNCTUATION_TITLES_30)
const WESTERN_ANIMATION_SET = new Set<string>(WESTERN_ANIMATION_TITLES)

function titlesOf(results: VerifiedRecommendation[]): string[] {
  return results.map((result) => result.title)
}

function freshFilters(): BrowseFilterState {
  return { ...DEFAULT_BROWSE_FILTERS }
}

/** Catalogue entries a title-group must never contain (substitution guards). */
function assertNoFillerTitles(results: VerifiedRecommendation[]): void {
  for (const result of results) {
    expect(PUNCTUATION_SET.has(result.title)).toBe(false)
  }
}

// ── Test A: AI independence ──────────────────────────────────────
// The model generates from its own knowledge. Titles ABSENT from the
// catalogue must still be presented as verified recommendations after
// TMDB resolution — the catalogue gates playability, never generation.

describe("Test A — AI independence", () => {
  it("presents generated titles absent from the catalogue as verified recommendations", async () => {
    const mock = fixedReplyMock(modelReply(DARK_ANIME_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: DARK_ANIME_QUERY_30,
        conversation: newConversation(),
        availableOnly: false,
        count: 5,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: NO_ANIME_CATALOGUE,
        profileId: "w5-a-1",
      },
    )

    expect(titlesOf(outcome.results)).toEqual(DARK_ANIME_SET.map((rec) => rec.title))
    for (const result of outcome.results) {
      expect(result.verified).toBe(true)
      expect(result.tmdbId).not.toBeNull()
      // Honest unavailability: none of them is in this catalogue.
      expect(result.match).toBeNull()
      expect(NO_ANIME_TITLES.has(result.title)).toBe(false)
    }
    expect(outcome.receipt.phase).toBe("validated")
    expect(outcome.receipt.engine).toBe("ai")
    expect(outcome.receipt.model).toBe(MOCK_MODEL_ID)
    expect(outcome.diagnostics.catalogueSize).toBe(NO_ANIME_CATALOGUE.length)
    expect(isFreshAiAnswer(outcome.receipt)).toBe(true)
  })

  it("asks TMDB about every generated title, not only catalogue titles", async () => {
    const mock = fixedReplyMock(modelReply(DARK_ANIME_SET))
    const tmdb = createMockTmdb()
    await runAiDiscovery(
      {
        query: DARK_ANIME_QUERY_30,
        conversation: newConversation(),
        availableOnly: false,
        count: 5,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: NO_ANIME_CATALOGUE,
        profileId: "w5-a-2",
      },
    )
    expect(tmdb.searchCalls.map((call) => call.title)).toEqual(
      DARK_ANIME_SET.map((rec) => rec.title),
    )
  })
})

// ── Test B: availability matching ────────────────────────────────
// Some titles in the catalogue, others not. Matches link Play to the
// RIGHT catalogue entry; the rest are honestly unavailable.

describe("Test B — availability matching", () => {
  it("links matches to the right catalogue entry and marks the rest unavailable", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something great for tonight",
        conversation: newConversation(),
        availableOnly: false,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-b-1",
      },
    )

    expect(titlesOf(outcome.results)).toEqual([
      "Hereditary",
      "The Shawshank Redemption",
      "Superbad",
      "Parasite",
    ])
    const [hereditary, shawshank, superbad, parasite] = outcome.results
    expect(hereditary.verified).toBe(true)
    expect(hereditary.match?.catalogueKey).toBe(candidateKey(HEREDITARY_A))
    expect(hereditary.match?.compositeId).toBe(candidateKey(HEREDITARY_A))
    expect(hereditary.match?.kind).toBe("movie")
    expect(hereditary.match?.year).toBe(2018)
    expect(shawshank.verified).toBe(true)
    expect(shawshank.match).toBeNull()
    expect(superbad.verified).toBe(true)
    expect(superbad.match?.catalogueKey).toBe(candidateKey(SUPERBAD))
    expect(parasite.verified).toBe(true)
    expect(parasite.match).toBeNull()
  })

  it("availableOnly returns only the playable subset, in generation order", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something great for tonight",
        conversation: newConversation(),
        availableOnly: true,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-b-2",
      },
    )
    expect(titlesOf(outcome.results)).toEqual(["Hereditary", "Superbad"])
    for (const result of outcome.results) {
      expect(result.match).not.toBeNull()
    }
    expect(outcome.diagnostics.acceptedCount).toBe(2)
  })
})

// ── Test C: no substitution ──────────────────────────────────────
// A strong title absent from the catalogue is presented as unavailable,
// NEVER replaced by an unrelated title. Results contain exactly the
// generated titles — no filler, ever.

describe("Test C — no substitution", () => {
  it("presents absent titles as unavailable without replacing them", async () => {
    const mock = fixedReplyMock(modelReply(STRONG_ABSENT_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "The best films ever made",
        conversation: newConversation(),
        availableOnly: false,
        count: 2,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-c-1",
      },
    )

    expect(titlesOf(outcome.results)).toEqual(["The Shawshank Redemption", "Parasite"])
    for (const result of outcome.results) {
      expect(result.verified).toBe(true)
      expect(result.match).toBeNull()
    }
    assertNoFillerTitles(outcome.results)
  })

  it("never fills the rail with catalogue titles the model did not generate", async () => {
    const mock = fixedReplyMock(modelReply(STRONG_ABSENT_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "The best films ever made",
        conversation: newConversation(),
        availableOnly: false,
        count: 10,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-c-2",
      },
    )
    // The model generated 2 titles; asking for 10 must not invent 8 more.
    expect(outcome.results).toHaveLength(2)
    for (const result of outcome.results) {
      expect(CATALOGUE_TITLES.has(result.title)).toBe(false)
    }
  })
})

// ── Test D: correct anime ────────────────────────────────────────
// The user's own query. Genuine dark anime in, genuine dark anime out —
// kind/genre/tone from the TMDB + model seams, no Western-animation
// filler, no punctuation-block filler.

describe("Test D — correct anime", () => {
  it("returns genuine dark anime with anime kind/genre/tone, no western-animation filler", async () => {
    const mock = fixedReplyMock(modelReply(DARK_ANIME_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: DARK_ANIME_QUERY_30,
        conversation: newConversation(),
        availableOnly: false,
        count: 5,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-d-1",
      },
    )

    expect(titlesOf(outcome.results)).toEqual(DARK_ANIME_SET.map((rec) => rec.title))
    for (const [index, result] of outcome.results.entries()) {
      const generated = DARK_ANIME_SET[index]
      expect(result.verified).toBe(true)
      expect(result.kind).toBe(generated.kind)
      // Genre comes from the TMDB details seam, tone from the model.
      expect(result.genres).toContain("Animation")
      expect(result.tone).toMatch(/dark|disturbing|bleak/)
      expect(WESTERN_ANIMATION_SET.has(result.title)).toBe(false)
    }
    assertNoFillerTitles(outcome.results)
    // The catalogue entries the results link to are the anime entries.
    expect(outcome.results[0].match?.catalogueKey).toBe(candidateKey(ATTACK_ON_TITAN))
  })
})

// ── Test E: genre replacement ────────────────────────────────────
// Comedy then Horror = Horror only. Genre selection REPLACES, never
// intersects or accumulates — the user-reported progressive sub-filter
// bug. Asserted at three levels: the state helper itself, the real
// adapter-level filter application (applyBrowseFilters / moodMatches),
// and the Discover quick-pick state. The state helpers do not exist at
// the 0.11.5 base (red-on-base = missing module/function); the adapter
// helpers are real base code and these assertions run against them
// genuinely in every worktree.

describe("Test E — genre replacement", () => {
  it("selectGenreFilter replaces the genre: Comedy then Horror is Horror only", () => {
    const start = freshFilters()
    const comedy = selectGenreFilter(start, "comedy")
    expect(comedy.genre).toBe("comedy")
    const horror = selectGenreFilter(comedy, "horror")
    expect(horror.genre).toBe("horror")
    // The previous selection leaves no trace, and inputs are untouched.
    expect(comedy.genre).toBe("comedy")
    expect(start.genre).toBe("")
  })

  it("selectGenreFilter preserves every other field and null clears", () => {
    const start: BrowseFilterState = {
      ...freshFilters(),
      contentType: "movie",
      year: "2010s",
      minRating: 7,
      maxRuntime: 120,
      sort: "rating",
    }
    const picked = selectGenreFilter(start, "horror")
    expect(picked).toEqual({ ...start, genre: "horror" })
    expect(selectGenreFilter(picked, null)).toEqual({ ...start, genre: "" })
    expect(selectGenreFilter(picked, "")).toEqual({ ...start, genre: "" })
  })

  it("adapter-level: Comedy then Horror filters Horror only (Discover scope)", () => {
    let state = freshFilters()
    state = selectGenreFilter(state, "comedy")
    const comedyResults = applyBrowseFilters(GENRE_FILTER_CATALOGUE, state)
    expect(comedyResults.map((entry) => entry.title).sort()).toEqual([
      "Bridesmaids",
      "Hot Fuzz",
      "Step Brothers",
      "Superbad",
      "The Grand Budapest Hotel",
    ])
    state = selectGenreFilter(state, "horror")
    const horrorResults = applyBrowseFilters(GENRE_FILTER_CATALOGUE, state)
    expect(horrorResults).toHaveLength(7)
    for (const entry of horrorResults) {
      expect(entry.genres.map((genre) => genre.toLowerCase())).toContain("horror")
    }
    // No comedy survives the switch, and no title is dropped by an
    // intersected comedy+horror filter (no entry carries both).
    expect(horrorResults.map((entry) => entry.title)).not.toContain("Superbad")
  })

  it("adapter-level: the replace pattern holds for the Movies scope", () => {
    const entries = [SUPERBAD, IT_SERIES_1990, IT_MOVIE_2017]
    let state: BrowseFilterState = { ...freshFilters(), contentType: "movie" }
    state = selectGenreFilter(state, "comedy")
    expect(applyBrowseFilters(entries, state).map((entry) => entry.title)).toEqual(["Superbad"])
    state = selectGenreFilter(state, "horror")
    const horrorMovies = applyBrowseFilters(entries, state)
    expect(horrorMovies.map((entry) => entry.title)).toEqual(["It"])
    expect(horrorMovies[0].kind).toBe("movie")
  })

  it("adapter-level: the replace pattern holds for the Series scope", () => {
    const entries = [SUPERBAD, IT_SERIES_1990, IT_MOVIE_2017]
    let state: BrowseFilterState = { ...freshFilters(), contentType: "series" }
    state = selectGenreFilter(state, "comedy")
    expect(applyBrowseFilters(entries, state)).toHaveLength(0)
    state = selectGenreFilter(state, "horror")
    const horrorSeries = applyBrowseFilters(entries, state)
    expect(horrorSeries.map((entry) => entry.title)).toEqual(["It"])
    expect(horrorSeries[0].kind).toBe("series")
  })

  it("Discover quick picks replace: each pick filters by the latest preset only", () => {
    const shortFilm: DiscoverCandidate = {
      id: "e-short-film",
      kind: "movie",
      title: "Short Comedy Film",
      year: 2020,
      rating: 7.4,
      runtimeMinutes: 45,
      genres: ["Comedy"],
      cast: [],
      source: "catalog",
    }
    const longFilm: DiscoverCandidate = {
      ...PERFECT_BLUE,
      id: "e-long-film",
      runtimeMinutes: 81,
    }
    const entries = [shortFilm, longFilm, ATTACK_ON_TITAN, DEATH_NOTE, IT_SERIES_1990]
    const filteredBy = (presetId: string | null): string[] => {
      const preset = presetId ? moodPreset(presetId) : null
      if (!preset) return []
      return entries.filter((entry) => moodMatches(entry, preset)).map((entry) => entry.title)
    }

    let state = freshDiscoveryState()
    state = applyQuickPick(state, "short")
    expect(state.activeQuickPick).toBe("short")
    expect(state.query).toBe("")
    expect(filteredBy(state.activeQuickPick)).toEqual(["Short Comedy Film"])

    state = applyQuickPick(state, "binge")
    expect(state.activeQuickPick).toBe("binge")
    // Series rated 7.0+: the 6.8-rated series and both movies are out,
    // and the 60-minute cap from "short" leaves no trace.
    expect(filteredBy(state.activeQuickPick).sort()).toEqual([
      "Attack on Titan",
      "Death Note",
    ])

    state = applyQuickPick(state, "easy")
    expect(state.activeQuickPick).toBe("easy")
    // Easy Watching genres only — the series/rating constraints of
    // "binge" are gone, so the comedy short and the anime film return.
    expect(filteredBy(state.activeQuickPick).sort()).toEqual([
      "Attack on Titan",
      "Death Note",
      "Perfect Blue",
      "Short Comedy Film",
    ])
  })

  it("applyQuickPick is pure and applyNewSearch returns a fresh state", () => {
    const start = freshDiscoveryState()
    const picked = applyQuickPick(start, "intense")
    expect(picked.activeQuickPick).toBe("intense")
    expect(start.activeQuickPick).toBeNull()
    expect(applyNewSearch()).toEqual(freshDiscoveryState())
    expect(applyNewSearch()).toEqual({ activeQuickPick: null, query: "" })
  })
})

// ── Test F: conversational refinement ────────────────────────────
// "Dark anime" then "Only movies made after 2010", with the carried
// ConversationState. The second request's context preserves anime+dark,
// the mock receives the refinement (asserted on captured messages), and
// the revised recommendations conform (movies, post-2010).
//
// Scope note: no frozen contract parses natural language into
// GenerationConstraints, so these tests do NOT assert NL→constraint
// parsing. They pin context-carrying + conforming output at the
// orchestration seam, plus explicit-constraints-in-prompt at the
// generation seam.

describe("Test F — conversational refinement", () => {
  it("carries conversation context into the refinement and returns revised recommendations", async () => {
    const mock = scriptedMock([
      modelReply(DARK_ANIME_SET),
      modelReply(DARK_ANIME_MOVIES_POST_2010_SET),
    ])
    const tmdb = createMockTmdb()
    const deps = {
      chat: mock.transport,
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
      profileId: "w5-f-1",
    }
    const first = await runAiDiscovery(
      {
        query: "Dark anime",
        conversation: newConversation(),
        availableOnly: false,
        count: 5,
      },
      deps,
    )
    expect(first.conversation.turns).toHaveLength(1)
    expect(first.conversation.turns[0].query).toBe("Dark anime")
    expect(first.conversation.turns[0].generatedTitles).toEqual(
      DARK_ANIME_SET.map((rec) => rec.title),
    )

    const second = await runAiDiscovery(
      {
        query: "Only movies made after 2010",
        conversation: first.conversation,
        availableOnly: false,
        count: 3,
      },
      deps,
    )
    expect(mock.callCount).toBe(2)
    const secondPrompt = allMessageText(mock, 1)
    expect(secondPrompt).toContain("Dark anime")
    expect(secondPrompt).toContain("Attack on Titan")
    expect(secondPrompt).toContain("Only movies made after 2010")
    // The first request knew nothing of the refinement.
    expect(allMessageText(mock, 0)).not.toContain("Only movies made after 2010")

    expect(titlesOf(second.results)).toEqual(
      DARK_ANIME_MOVIES_POST_2010_SET.map((rec) => rec.title),
    )
    for (const result of second.results) {
      expect(result.kind).toBe("movie")
      expect(result.year).not.toBeNull()
      expect(result.year as number).toBeGreaterThan(2010)
    }
    expect(second.conversation.turns).toHaveLength(2)
    expect(second.conversation.turns[1].query).toBe("Only movies made after 2010")
    // The input conversation is never mutated.
    expect(first.conversation.turns).toHaveLength(1)
  })

  it("conversationContextFor renders each turn's query and titles", () => {
    const state: ConversationState = {
      turns: [
        { query: "Dark anime", generatedTitles: ["Attack on Titan", "Death Note"] },
        { query: "Only movies", generatedTitles: [] },
      ],
    }
    const context = conversationContextFor(state)
    expect(context).toHaveLength(2)
    expect(context[0]).toContain("Dark anime")
    expect(context[0]).toContain("Attack on Titan")
    expect(context[0]).toContain("Death Note")
    expect(context[1]).toContain("Only movies")
    expect(conversationContextFor(newConversation())).toEqual([])
  })

  it("explicit generation constraints reach the model's prompt", async () => {
    const mock = fixedReplyMock(modelReply(DARK_ANIME_MOVIES_POST_2010_SET))
    const result = await generateRecommendations(
      {
        query: "Dark anime",
        conversationContext: ["Previous request 1: \"Dark anime\" — suggested: Attack on Titan"],
        constraints: { kind: "movie", yearMin: 2010, excludeTitles: ["Perfect Blue"] },
        count: 3,
      },
      { chat: mock.transport },
    )
    expect(result.recommendations).toHaveLength(3)
    expect(result.model).toBe(MOCK_MODEL_ID)
    expect(result.cached).toBe(false)
    const prompt = allMessageText(mock, 0)
    expect(prompt).toContain("Dark anime")
    expect(prompt).toContain("Attack on Titan")
    expect(systemMessageText(mock, 0)).toContain("movie")
    expect(systemMessageText(mock, 0)).toContain("2010")
    expect(systemMessageText(mock, 0)).toContain("Perfect Blue")
  })
})

// ── Test G: New Search ───────────────────────────────────────────
// After a horror conversation, New Search + a fresh conversation must
// leave NO horror behind: no horror constraint, title, or context in
// the new request's captured messages.

describe("Test G — New Search", () => {
  it("a new search after a horror conversation carries no horror context", async () => {
    const horrorConversation: ConversationState = {
      turns: [{ query: "Something scary", generatedTitles: ["Hereditary", "Get Out"] }],
    }
    expect(conversationContextFor(horrorConversation)[0]).toContain("Hereditary")

    const freshState = applyNewSearch()
    expect(freshState).toEqual(freshDiscoveryState())
    const freshConversation = newConversation()
    expect(conversationContextFor(freshConversation)).toEqual([])

    const mock = fixedReplyMock(modelReply(COMEDY_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something funny",
        conversation: freshConversation,
        availableOnly: false,
        count: 3,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-g-1",
      },
    )
    const prompt = allMessageText(mock, 0)
    expect(prompt).toContain("Something funny")
    expect(prompt.toLowerCase()).not.toContain("horror")
    expect(prompt).not.toContain("Hereditary")
    expect(prompt).not.toContain("Get Out")
    expect(prompt).not.toContain("Something scary")
    expect(titlesOf(outcome.results)).toEqual(COMEDY_SET.map((rec) => rec.title))
    expect(outcome.conversation.turns).toHaveLength(1)
  })
})

// ── Test H: title verification ───────────────────────────────────
// The model supplies a wrong year / an uncertain external id; TMDB
// resolves the correct identity. Displayed title/year/id come from
// TMDB — or the item is unverified with NO invented details.

describe("Test H — title verification", () => {
  it("corrects a wrong model year from TMDB and links the right catalogue entry", async () => {
    const tmdb = createMockTmdb()
    const results = await verifyRecommendations(WRONG_YEAR_SET, {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(results).toHaveLength(2)
    const [dune, bladeRunner] = results
    expect(dune.verified).toBe(true)
    expect(dune.title).toBe("Dune")
    expect(dune.year).toBe(2021)
    expect(dune.tmdbId).toBe(TMDB_DUNE_2021.id)
    expect(dune.match?.catalogueKey).toBe(candidateKey(DUNE_2021))
    expect(bladeRunner.verified).toBe(true)
    expect(bladeRunner.year).toBe(2017)
    expect(bladeRunner.tmdbId).toBe(TMDB_BLADE_RUNNER_2049.id)
  })

  it("never trusts the model's external id over TMDB's identity", async () => {
    const tmdb = createMockTmdb()
    const [result] = await verifyRecommendations(WRONG_EXTERNAL_ID_SET, {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(result.generated.externalId).toBe("tmdb:1")
    expect(result.tmdbId).toBe(TMDB_DUNE_2021.id)
    expect(result.tmdbId).not.toBe(1)
  })

  it("leaves an unmatchable year unverified instead of guessing a nearby film", async () => {
    const tmdb = createMockTmdb()
    const [result] = await verifyRecommendations(UNMATCHABLE_YEAR_SET, {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(result.verified).toBe(false)
    expect(result.tmdbId).toBeNull()
    expect(result.match).toBeNull()
    // The model's claim is shown as the model's claim — nothing invented.
    expect(result.title).toBe("Dune")
    expect(result.year).toBe(1995)
    expect(result.genres).toEqual([])
    expect(result.synopsis).toBe("")
    expect(result.posterUrl).toBeUndefined()
    expect(result.verificationNote).toBeTruthy()
  })

  it("leaves an invented title unverified with no invented details", async () => {
    const tmdb = createMockTmdb()
    const [result] = await verifyRecommendations(INVENTED_TITLE_SET, {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(result.verified).toBe(false)
    expect(result.tmdbId).toBeNull()
    expect(result.match).toBeNull()
    expect(result.genres).toEqual([])
    expect(result.synopsis).toBe("")
    expect(result.posterUrl).toBeUndefined()
    expect(result.backdropUrl).toBeUndefined()
    expect(result.verificationNote).toBeTruthy()
  })

  it("resolves an alternative title to the canonical TMDB identity", async () => {
    const tmdb = createMockTmdb()
    const [result] = await verifyRecommendations(ALIAS_TITLE_SET, {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(result.verified).toBe(true)
    expect(result.title).toBe("Attack on Titan")
    expect(result.tmdbId).toBe(TMDB_ATTACK_ON_TITAN.id)
    expect(result.year).toBe(2013)
    expect(result.match?.catalogueKey).toBe(candidateKey(ATTACK_ON_TITAN))
  })

  it("falls back to search-result fields when no details record exists", async () => {
    const tmdb = createMockTmdb()
    const [result] = await verifyRecommendations(NO_DETAILS_SET, {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(result.verified).toBe(true)
    expect(result.genres).toEqual([])
    expect(result.synopsis).toBe("Overview for Neon Genesis Evangelion (1995).")
    expect(result.posterUrl).toBe("https://image.tmdb.org/t/p/w500/mock-900006.jpg")
    expect(result.backdropUrl).toBeUndefined()
  })

  it("corrects years at the orchestration seam too", async () => {
    const mock = fixedReplyMock(modelReply(WRONG_YEAR_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Sci-fi epics",
        conversation: newConversation(),
        availableOnly: false,
        count: 2,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-h-1",
      },
    )
    expect(outcome.results.map((result) => result.year)).toEqual([2021, 2017])
  })
})

// ── Test I: provider matching ────────────────────────────────────
// Punctuation, alternative titles, quality suffixes, duplicate
// streams, same-named different-year films: correct identity + correct
// playback link, zero false matches. The cleanProviderTitle /
// pickTmdbMatch / matchRecommendationsToCatalog assertions run against
// the REAL base helpers; the verifyRecommendations assertions run the
// frozen verification seam against a crafted catalogue.

describe("Test I — provider matching", () => {
  it("cleanProviderTitle strips quality suffixes and recovers the year", () => {
    expect(cleanProviderTitle("Dune (2021) 1080p BluRay")).toEqual(
      expect.objectContaining({ year: 2021 }),
    )
    expect(cleanProviderTitle("Dune (2021) 1080p BluRay").variants[0]).toBe("Dune")
    expect(cleanProviderTitle("Hereditary (2018) 2160p WEB-DL").variants[0]).toBe("Hereditary")
    expect(cleanProviderTitle("Hereditary (2018) 2160p WEB-DL").year).toBe(2018)
    expect(cleanProviderTitle("The Thing [1982] 720p BluRay").variants[0]).toBe("The Thing")
    expect(cleanProviderTitle("The Thing [1982] 720p BluRay").year).toBe(1982)
    expect(cleanProviderTitle("Get Out (2017) 1080p WEBRip").variants[0]).toBe("Get Out")
    expect(cleanProviderTitle("Get Out (2017) 1080p WEBRip").year).toBe(2017)
    expect(cleanProviderTitle("Attack on Titan").variants[0]).toBe("Attack on Titan")
    expect(cleanProviderTitle("Attack on Titan").year).toBeNull()
  })

  it("pickTmdbMatch disambiguates same-named films by year and refuses ambiguity", () => {
    const dunes = [TMDB_DUNE_1984, TMDB_DUNE_2021]
    expect(
      pickTmdbMatch(dunes, { variants: ["Dune"], year: 2021, mediaType: "movie" }),
    ).toEqual({ id: TMDB_DUNE_2021.id, title: "Dune", year: 2021 })
    expect(
      pickTmdbMatch(dunes, { variants: ["Dune"], year: 1984, mediaType: "movie" }),
    ).toEqual({ id: TMDB_DUNE_1984.id, title: "Dune", year: 1984 })
    expect(
      pickTmdbMatch(dunes, { variants: ["Dune"], year: 1995, mediaType: "movie" }),
    ).toBeNull()
    expect(
      pickTmdbMatch(dunes, { variants: ["Dune"], year: null, mediaType: "movie" }),
    ).toBeNull()
    expect(
      pickTmdbMatch([TMDB_IT_SERIES_1990], { variants: ["It"], year: 1990, mediaType: "tv" }),
    ).toEqual({ id: TMDB_IT_SERIES_1990.id, title: "It", year: 1990 })
  })

  it("matchRecommendationsToCatalog resolves a quality-suffixed provider name", () => {
    const matched = matchRecommendationsToCatalog(
      [{ title: "Dune", year: 2021 }],
      [{ id: "prov-dune", name: "Dune (2021) 1080p BluRay", year: 2021 }],
      { mediaType: "movie" },
    )
    expect(matched.map((entry) => entry.id)).toEqual(["prov-dune"])
    const wrongYear = matchRecommendationsToCatalog(
      [{ title: "Dune", year: 1984 }],
      [{ id: "prov-dune", name: "Dune (2021) 1080p BluRay", year: 2021 }],
      { mediaType: "movie" },
    )
    expect(wrongYear).toEqual([])
  })

  it("verifyRecommendations matches suffixes, duplicates, and same-name pairs exactly", async () => {
    const tmdb = createMockTmdb()
    const generated = [
      { title: "Dune", year: 2021, kind: "movie", reason: "", tone: "" },
      { title: "The Thing", year: 1982, kind: "movie", reason: "", tone: "" },
      { title: "Hereditary", year: 2018, kind: "movie", reason: "", tone: "" },
      { title: "It", year: 2017, kind: "movie", reason: "", tone: "" },
      { title: "It", year: 1990, kind: "series", reason: "", tone: "" },
    ] as const
    const results = await verifyRecommendations([...generated], {
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
    })
    expect(results.map((result) => result.match?.catalogueKey)).toEqual([
      candidateKey(DUNE_2021),
      candidateKey(THING_1982),
      // Duplicate streams collapse to the FIRST catalogue entry.
      candidateKey(HEREDITARY_A),
      // Composite ids: same provider id "900", kinds distinguished.
      "movie:900",
      "series:900",
    ])
    expect(results[3].match?.catalogueKey).toBe(candidateKey(IT_MOVIE_2017))
    expect(results[4].match?.catalogueKey).toBe(candidateKey(IT_SERIES_1990))
    expect(results[3].tmdbId).toBe(TMDB_IT_MOVIE_2017.id)
    expect(results[4].tmdbId).toBe(TMDB_IT_SERIES_1990.id)
  })

  it("verifyRecommendations never false-matches across years or kinds", async () => {
    const tmdb = createMockTmdb()
    const [dune1984, thing2011] = await verifyRecommendations(
      [
        { title: "Dune", year: 1984, kind: "movie", reason: "", tone: "" },
        { title: "The Thing", year: 2011, kind: "movie", reason: "", tone: "" },
      ],
      {
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
      },
    )
    expect(dune1984.match?.catalogueKey).toBe(candidateKey(DUNE_1984))
    expect(dune1984.tmdbId).toBe(TMDB_DUNE_1984.id)
    expect(thing2011.match?.catalogueKey).toBe(candidateKey(THING_2011))
    expect(thing2011.tmdbId).not.toBe(TMDB_THING_1982.id)

    // Kind gate: a series-only catalogue never matches a movie request.
    const [movieAgainstSeriesOnly] = await verifyRecommendations(
      [{ title: "It", year: 2017, kind: "movie", reason: "", tone: "" }],
      {
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: [IT_SERIES_1990],
      },
    )
    expect(movieAgainstSeriesOnly.verified).toBe(true)
    expect(movieAgainstSeriesOnly.match).toBeNull()
  })
})

// ── Test J: empty catalogue ──────────────────────────────────────
// No catalogue at all: AI still produces useful verified
// recommendations, all clearly unavailable, no crash, no filler.

describe("Test J — empty catalogue", () => {
  it("produces verified, honestly-unavailable recommendations with catalogue = []", async () => {
    const mock = fixedReplyMock(modelReply(DARK_ANIME_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: DARK_ANIME_QUERY_30,
        conversation: newConversation(),
        availableOnly: false,
        count: 5,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: [],
        profileId: "w5-j-1",
      },
    )
    expect(titlesOf(outcome.results)).toEqual(DARK_ANIME_SET.map((rec) => rec.title))
    for (const result of outcome.results) {
      expect(result.verified).toBe(true)
      expect(result.match).toBeNull()
    }
    expect(outcome.diagnostics.catalogueSize).toBe(0)
    expect(outcome.receipt.phase).toBe("validated")
  })

  it("treats an absent catalogue the same as an empty one", async () => {
    const mock = fixedReplyMock(modelReply(HORROR_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something scary",
        conversation: newConversation(),
        availableOnly: false,
        count: 3,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        profileId: "w5-j-2",
      },
    )
    expect(outcome.results).toHaveLength(3)
    for (const result of outcome.results) {
      expect(result.match).toBeNull()
    }
  })

  it("availableOnly with an empty catalogue returns no results, honestly", async () => {
    const mock = fixedReplyMock(modelReply(DARK_ANIME_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: DARK_ANIME_QUERY_30,
        conversation: newConversation(),
        availableOnly: true,
        count: 5,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: [],
        profileId: "w5-j-3",
      },
    )
    expect(outcome.results).toEqual([])
    expect(outcome.diagnostics.acceptedCount).toBe(0)
  })
})

// ── Test K: cost / caching ───────────────────────────────────────
// Mocked-transport call counting at the ORCHESTRATION seam. Repeated
// identical searches cost ONE call and the receipt says cached; a
// refinement costs a fresh call; the availableOnly toggle costs nothing
// (filtering is not a cache dimension). UI trigger discipline —
// typing, scrolling, controller nav producing zero calls — is W3's
// half and is NOT asserted here; these tests pin the orchestration
// half so W3's UI can rely on it.

describe("Test K — cost and caching", () => {
  it("answers a repeated identical search from cache: 1 call, receipt says cached", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb()
    const conversation = newConversation()
    const base = {
      chat: mock.transport,
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
      profileId: "w5-k-1",
    }
    const first = await runAiDiscovery(
      { query: "Something great", conversation, availableOnly: false, count: 4 },
      base,
    )
    expect(mock.callCount).toBe(1)
    expect(first.receipt.cacheHit).toBe(false)
    expect(first.receipt.phase).toBe("validated")

    const second = await runAiDiscovery(
      { query: "Something great", conversation, availableOnly: false, count: 4 },
      base,
    )
    expect(mock.callCount).toBe(1)
    expect(second.receipt.cacheHit).toBe(true)
    expect(second.receipt.phase).toBe("cached")
    expect(second.receipt.engine).toBe("cached-ai")
    expect(aiSearchStateNote(second.receipt)).toBe("Cached AI answer — no new request was sent.")
    expect(isFreshAiAnswer(second.receipt)).toBe(false)
    expect(titlesOf(second.results)).toEqual(titlesOf(first.results))
  })

  it("the availableOnly toggle changes no call count", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb()
    const conversation = newConversation()
    const base = {
      chat: mock.transport,
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
      profileId: "w5-k-2",
    }
    const all = await runAiDiscovery(
      { query: "Something great", conversation, availableOnly: false, count: 4 },
      base,
    )
    expect(mock.callCount).toBe(1)
    expect(all.results).toHaveLength(4)

    const availableOnly = await runAiDiscovery(
      { query: "Something great", conversation, availableOnly: true, count: 4 },
      base,
    )
    expect(mock.callCount).toBe(1)
    expect(availableOnly.receipt.cacheHit).toBe(true)
    expect(titlesOf(availableOnly.results)).toEqual(["Hereditary", "Superbad"])

    const allAgain = await runAiDiscovery(
      { query: "Something great", conversation, availableOnly: false, count: 4 },
      base,
    )
    expect(mock.callCount).toBe(1)
    expect(allAgain.results).toHaveLength(4)
  })

  it("a refinement is a fresh call, and profile/taste identity dimensions miss the cache", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb()
    const base = {
      chat: mock.transport,
      searchTmdb: tmdb.search,
      fetchDetails: tmdb.fetchDetails,
      catalogue: AI30_CATALOGUE,
      profileId: "w5-k-3",
    }
    const first = await runAiDiscovery(
      { query: "Something great", conversation: newConversation(), availableOnly: false, count: 4 },
      base,
    )
    expect(mock.callCount).toBe(1)

    // Refinement with the carried conversation: fresh call.
    await runAiDiscovery(
      {
        query: "Something darker",
        conversation: first.conversation,
        availableOnly: false,
        count: 4,
      },
      base,
    )
    expect(mock.callCount).toBe(2)

    // Same query, different profile: fresh call.
    await runAiDiscovery(
      { query: "Something great", conversation: newConversation(), availableOnly: false, count: 4 },
      { ...base, profileId: "w5-k-3-other-profile" },
    )
    expect(mock.callCount).toBe(3)

    // Same query/profile, new taste revision: fresh call.
    await runAiDiscovery(
      { query: "Something great", conversation: newConversation(), availableOnly: false, count: 4 },
      { ...base, tasteRevision: "rev-2" },
    )
    expect(mock.callCount).toBe(4)
  })
})

// ── Test L: failure handling ─────────────────────────────────────
// OpenAI fails, TMDB fails, catalogue lookup fails: the app stays
// usable — honest phases/notes, no crash, no invented data, no partial
// silent success. Failures resolve at this seam; nothing here throws.

describe("Test L — failure handling", () => {
  it("a provider failure resolves with zero results and an honest fallback receipt", async () => {
    const mock = failingMock(new Error("mock provider outage"))
    const tmdb = createMockTmdb()
    const conversation = newConversation()
    const outcome = await runAiDiscovery(
      {
        query: "Something great",
        conversation,
        availableOnly: false,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-l-1",
      },
    )
    expect(outcome.results).toEqual([])
    expect(outcome.receipt.phase).toBe("fallback")
    expect(outcome.receipt.fallbackReason).toBeTruthy()
    expect(outcome.diagnostics.fallbackReason).toBeTruthy()
    expect(outcome.conversation).toEqual(conversation)
    // TMDB was never consulted: there was nothing to verify.
    expect(tmdb.searchCalls).toHaveLength(0)
  })

  it("a TMDB outage leaves every item unverified with notes, never invented", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb({ throwAll: new Error("mock TMDB outage") })
    const outcome = await runAiDiscovery(
      {
        query: "Something great",
        conversation: newConversation(),
        availableOnly: false,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-l-2",
      },
    )
    expect(outcome.results).toHaveLength(4)
    for (const result of outcome.results) {
      expect(result.verified).toBe(false)
      expect(result.tmdbId).toBeNull()
      expect(result.match).toBeNull()
      expect(result.genres).toEqual([])
      expect(result.synopsis).toBe("")
      expect(result.posterUrl).toBeUndefined()
      expect(result.verificationNote).toBeTruthy()
    }
    expect(outcome.receipt.phase).not.toBe("sending")
    expect(outcome.receipt.phase).not.toBe("idle")
  })

  it("a per-title TMDB failure is isolated to that title", async () => {
    const mock = fixedReplyMock(modelReply(MIXED_AVAILABILITY_SET))
    const tmdb = createMockTmdb({ throwForTitles: ["Parasite"] })
    const outcome = await runAiDiscovery(
      {
        query: "Something great",
        conversation: newConversation(),
        availableOnly: false,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-l-3",
      },
    )
    const byTitle = new Map(outcome.results.map((result) => [result.title, result]))
    expect(byTitle.get("Parasite")?.verified).toBe(false)
    expect(byTitle.get("Hereditary")?.verified).toBe(true)
    expect(byTitle.get("Superbad")?.verified).toBe(true)
    expect(byTitle.get("The Shawshank Redemption")?.verified).toBe(true)
  })

  it("a catalogue failure degrades to honestly-unavailable verified results", async () => {
    const mock = fixedReplyMock(modelReply(HORROR_SET))
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something scary",
        conversation: newConversation(),
        availableOnly: false,
        count: 3,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: () => {
          throw new Error("mock catalogue failure")
        },
        profileId: "w5-l-4",
      },
    )
    expect(outcome.results).toHaveLength(3)
    for (const result of outcome.results) {
      expect(result.verified).toBe(true)
      expect(result.match).toBeNull()
    }
    expect(outcome.diagnostics.catalogueSize).toBe(0)
  })

  it("a malformed model reply resolves with an honest fallback, no crash", async () => {
    const mock = fixedReplyMock(MALFORMED_MODEL_REPLY)
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something great",
        conversation: newConversation(),
        availableOnly: false,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-l-5",
      },
    )
    expect(outcome.results).toEqual([])
    expect(outcome.receipt.phase).toBe("fallback")
    expect(outcome.receipt.fallbackReason).toBeTruthy()
    expect(tmdb.searchCalls).toHaveLength(0)
  })

  it("a reply with no usable items resolves with an honest fallback, no crash", async () => {
    const mock = fixedReplyMock(INVALID_ITEMS_REPLY)
    const tmdb = createMockTmdb()
    const outcome = await runAiDiscovery(
      {
        query: "Something great",
        conversation: newConversation(),
        availableOnly: false,
        count: 4,
      },
      {
        chat: mock.transport,
        searchTmdb: tmdb.search,
        fetchDetails: tmdb.fetchDetails,
        catalogue: AI30_CATALOGUE,
        profileId: "w5-l-6",
      },
    )
    expect(outcome.results).toEqual([])
    expect(outcome.receipt.phase).toBe("fallback")
    expect(outcome.receipt.fallbackReason).toBeTruthy()
  })
})

// ── Fixture invariants (not acceptance tests — guardrails) ───────

describe("Fixture invariants", () => {
  it("the catalogue is punctuation-first and the absent titles are absent", () => {
    expect(AI30_CATALOGUE.slice(0, 10).map((entry) => entry.title)).toEqual([
      ...PUNCTUATION_TITLES_30,
    ])
    expect(CATALOGUE_TITLES.has("The Shawshank Redemption")).toBe(false)
    expect(CATALOGUE_TITLES.has("Parasite")).toBe(false)
    expect(CATALOGUE_TITLES.has("The Glimmering Void")).toBe(false)
    for (const entry of AI30_CATALOGUE.slice(0, 10)) {
      const genres = entry.genres.map((genre) => genre.toLowerCase())
      expect(genres).not.toContain("animation")
      expect(genres).not.toContain("comedy")
      expect(genres).not.toContain("horror")
    }
  })

  it("the no-anime catalogue contains no anime entry", () => {
    for (const entry of NO_ANIME_CATALOGUE) {
      expect(DARK_ANIME_SET.map((rec) => rec.title)).not.toContain(entry.title)
    }
    expect(NO_ANIME_CATALOGUE.length).toBeLessThan(AI30_CATALOGUE.length)
  })

  it("the mock chat captures messages and counts calls", async () => {
    const mock: MockChat = createMockChat(() => modelReply(COMEDY_SET))
    expect(mock.callCount).toBe(0)
    await generateRecommendations(
      { query: "Funny", count: 3 },
      { chat: mock.transport },
    )
    expect(mock.callCount).toBe(1)
    expect(userMessageText(mock, 0)).toContain("Funny")
  })
})
