// Discover redesign (0.11.18) — flow state machine, library-match
// rule, no-repeat-in-session, refine-retains-state, honest no-key
// state. Pure module: no browser globals, no model calls.
import { describe, it, expect } from "vitest"
import {
  freshDiscoverFlow,
  selectDiscoverKind,
  toggleDiscoverCategory,
  surpriseDiscoverCategories,
  continueToBrief,
  setDiscoverBrief,
  refineFlowState,
  stepBackFlow,
  choicesSummary,
  selectedSummary,
  buildDiscoveryQuery,
  playableRecommendations,
  recommendationSessionId,
  pickNextRecommendation,
  shownTitles,
  isAiReadyMode,
  aiNotReadyMessage,
  GENRE_CATEGORIES,
  KIND_CARDS,
  type DiscoverFlowState,
  type VerifiedRecommendation,
} from "../src/scripts/lib/discover-redesign"

function flowWith(overrides: Partial<DiscoverFlowState> = {}): DiscoverFlowState {
  return {
    step: "brief",
    kind: "either",
    categories: ["anime", "thriller", "horror"],
    brief: "Fucked-up anime. Psychological, unsettling, no comedy.",
    ...overrides,
  }
}

function rec(overrides: Partial<VerifiedRecommendation> = {}): VerifiedRecommendation {
  return {
    generated: { title: "Test Title", year: 2020, kind: "movie", reason: "Fits.", tone: "dark" },
    verified: true,
    tmdbId: 1,
    title: "Test Title",
    year: 2020,
    kind: "movie",
    reason: "Fits.",
    tone: "dark",
    genres: [],
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    match: { catalogueKey: "movie:1", title: "Test Title", kind: "movie", id: "1" },
    ...overrides,
  } as VerifiedRecommendation
}

describe("flow state machine", () => {
  it("starts fresh on step 1 with nothing chosen", () => {
    expect(freshDiscoverFlow()).toEqual({ step: "kind", kind: null, categories: [], brief: "" })
  })

  it("step 1: picking a kind moves to step 2 and keeps the draws", () => {
    const next = selectDiscoverKind(freshDiscoverFlow(), "movie")
    expect(next.step).toBe("categories")
    expect(next.kind).toBe("movie")
    expect(next.categories).toEqual([])
  })

  it("step 1 offers exactly Movie / Series / Either", () => {
    expect(KIND_CARDS.map((c) => c.id)).toEqual(["movie", "series", "either"])
    expect(KIND_CARDS.map((c) => c.label)).toEqual(["Movie", "Series", "Either"])
  })

  it("step 2 offers the eight genre draws", () => {
    expect(GENRE_CATEGORIES.map((g) => g.id)).toEqual([
      "anime", "thriller", "horror", "scifi", "crime", "comedy", "drama", "documentary",
    ])
  })

  it("step 2: toggling selects and deselects, multi-select never clears another tile", () => {
    let state = freshDiscoverFlow()
    state = selectDiscoverKind(state, "either")
    state = toggleDiscoverCategory(state, "anime")
    state = toggleDiscoverCategory(state, "thriller")
    expect(state.categories).toEqual(["anime", "thriller"])
    state = toggleDiscoverCategory(state, "anime")
    expect(state.categories).toEqual(["thriller"])
    expect(state.step).toBe("categories")
  })

  it("step 2: unknown genre ids are ignored", () => {
    const state = toggleDiscoverCategory(freshDiscoverFlow(), "no-such-genre")
    expect(state.categories).toEqual([])
  })

  it("step 2: Surprise me clears the draws and moves to step 3", () => {
    const state = surpriseDiscoverCategories(flowWith({ step: "categories" }))
    expect(state.categories).toEqual([])
    expect(state.step).toBe("brief")
    expect(state.kind).toBe("either")
  })

  it("step 2: Continue moves to step 3 with the draws intact", () => {
    const state = continueToBrief(flowWith({ step: "categories" }))
    expect(state.step).toBe("brief")
    expect(state.categories).toEqual(["anime", "thriller", "horror"])
  })

  it("step 3: the brief is stored exactly as typed", () => {
    const state = setDiscoverBrief(freshDiscoverFlow(), "  darker, no comedy  ")
    expect(state.brief).toBe("  darker, no comedy  ")
  })

  it("Back steps one screen at a time and never leaves step 1", () => {
    expect(stepBackFlow(flowWith({ step: "reveal" })).step).toBe("brief")
    expect(stepBackFlow(flowWith({ step: "loading" })).step).toBe("brief")
    expect(stepBackFlow(flowWith({ step: "brief" })).step).toBe("categories")
    expect(stepBackFlow(flowWith({ step: "categories" })).step).toBe("kind")
    expect(stepBackFlow(freshDiscoverFlow()).step).toBe("kind")
  })

  it("transitions never mutate the input state", () => {
    const before = flowWith({ step: "categories" })
    const snapshot = JSON.stringify(before)
    toggleDiscoverCategory(before, "comedy")
    selectDiscoverKind(before, "series")
    setDiscoverBrief(before, "x")
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it("choices summary joins kind + draws for the step-3 line", () => {
    expect(choicesSummary(flowWith())).toBe("Either · Anime · Thriller · Horror")
    expect(choicesSummary(freshDiscoverFlow())).toBe("")
    expect(choicesSummary(flowWith({ kind: "movie", categories: [] }))).toBe("Movie")
  })

  it("selected summary names the draws on step 2", () => {
    expect(selectedSummary(flowWith({ step: "categories" }))).toBe(
      "Selected: Anime · Thriller · Horror",
    )
    expect(selectedSummary(freshDiscoverFlow())).toContain("nothing yet")
  })
})

describe("the request sent to the model", () => {
  it("carries kind, draws and brief as one natural-language request", () => {
    const q = buildDiscoveryQuery(flowWith())
    expect(q).toContain("film or a TV series")
    expect(q).toContain("Anime, Thriller, Horror")
    expect(q).toContain("Fucked-up anime. Psychological, unsettling, no comedy.")
  })

  it("constrains kind when Movie or Series is picked, and does not when Either is picked", () => {
    expect(buildDiscoveryQuery(flowWith({ kind: "movie" }))).toContain("Recommend a film")
    expect(buildDiscoveryQuery(flowWith({ kind: "series" }))).toContain("Recommend a TV series")
    const either = buildDiscoveryQuery(flowWith({ kind: "either" }))
    expect(either).not.toContain("Only recommend films")
    expect(either).not.toContain("Only recommend series")
  })

  it("states the session request takes priority over usual viewing habits", () => {
    const q = buildDiscoveryQuery(flowWith())
    expect(q).toContain("takes priority over my usual viewing habits")
  })

  it("asks for interpretation by meaning, not literal keyword matching", () => {
    const q = buildDiscoveryQuery(flowWith())
    expect(q).toContain("Interpret the brief and the combination of draws by meaning")
    expect(q).toContain("not by literal keyword matching")
  })

  it("names already-shown titles as do-not-repeat, and omits the line when none were shown", () => {
    expect(buildDiscoveryQuery(flowWith(), { shownTitles: ["Perfect Blue"] })).toContain(
      "Do not suggest any of these again",
    )
    expect(buildDiscoveryQuery(flowWith(), { shownTitles: ["Perfect Blue"] })).toContain("Perfect Blue")
    expect(buildDiscoveryQuery(flowWith())).not.toContain("Do not suggest")
  })

  it("works with no draws and no brief — an open 'surprise me' ask", () => {
    const q = buildDiscoveryQuery({ step: "brief", kind: "either", categories: [], brief: "" })
    expect(q).toContain("Recommend something to watch tonight")
    expect(q).toContain("takes priority over my usual viewing habits")
  })
})

describe("library-match rule: unplayable titles never surface", () => {
  it("keeps only verified recommendations with a catalogue match", () => {
    const results = [
      rec({ title: "In Library" }),
      rec({ title: "Verified But Absent", match: null }),
      rec({ title: "Unverified", verified: false, match: null }),
      rec({ title: "Unverified Match", verified: false, match: { catalogueKey: "movie:9", title: "x", kind: "movie", id: "9" } }),
    ]
    expect(playableRecommendations(results).map((r) => r.title)).toEqual(["In Library"])
  })

  it("returns an empty queue when nothing is playable — never filler", () => {
    expect(playableRecommendations([rec({ match: null })])).toEqual([])
    expect(playableRecommendations([])).toEqual([])
  })
})

describe("no-repeat-in-session", () => {
  const queue = [
    rec({ title: "One", match: { catalogueKey: "movie:1", title: "One", kind: "movie", id: "1" } }),
    rec({ title: "Two", match: { catalogueKey: "movie:2", title: "Two", kind: "movie", id: "2" } }),
    rec({ title: "Three", match: { catalogueKey: "series:3", title: "Three", kind: "series", id: "3" } }),
  ]

  it("walks the queue in order and never repeats a shown title", () => {
    let shown = new Set<string>()
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const { rec: next, shownIds } = pickNextRecommendation(queue, shown)
      expect(next).not.toBeNull()
      seen.push(next!.title)
      shown = shownIds
    }
    expect(seen).toEqual(["One", "Two", "Three"])
    const exhausted = pickNextRecommendation(queue, shown)
    expect(exhausted.rec).toBeNull()
    expect(exhausted.shownIds).toEqual(shown)
  })

  it("skips titles already shown before this session's queue was built", () => {
    const { rec: next } = pickNextRecommendation(queue, new Set(["movie:1", "movie:2"]))
    expect(next?.title).toBe("Three")
  })

  it("session ids are stable per catalogue key, and distinct per title", () => {
    expect(recommendationSessionId(queue[0])).toBe("movie:1")
    expect(recommendationSessionId(queue[1])).toBe("movie:2")
    expect(recommendationSessionId(queue[2])).toBe("series:3")
  })

  it("shownTitles names the shown titles for the refetch exclusion line", () => {
    expect(shownTitles(queue, new Set(["movie:1", "series:3"])) ).toEqual(["One", "Three"])
  })

  it("skipping records no dislike anywhere — the shown set is the only session memory", () => {
    // There is no dislike/skipped store in this module: the only
    // session state pickNextRecommendation touches is the shown set.
    const { shownIds } = pickNextRecommendation(queue, new Set())
    expect([...shownIds]).toEqual(["movie:1"])
  })
})

describe("refine keeps the original choices and brief", () => {
  it("returns to step 3 with kind, categories and brief intact", () => {
    const state = refineFlowState(flowWith({ step: "reveal" }))
    expect(state.step).toBe("brief")
    expect(state.kind).toBe("either")
    expect(state.categories).toEqual(["anime", "thriller", "horror"])
    expect(state.brief).toBe("Fucked-up anime. Psychological, unsettling, no comedy.")
  })

  it("refining twice still keeps everything", () => {
    const state = refineFlowState(refineFlowState(flowWith({ step: "reveal" })))
    expect(state).toEqual({ ...flowWith(), step: "brief" })
  })
})

describe("honest no-key state", () => {
  it("only the connected mode may call the model", () => {
    expect(isAiReadyMode("connected")).toBe(true)
    expect(isAiReadyMode("not-configured")).toBe(false)
    expect(isAiReadyMode("local")).toBe(false)
    expect(isAiReadyMode("unavailable")).toBe(false)
    expect(isAiReadyMode(null)).toBe(false)
    expect(isAiReadyMode(undefined)).toBe(false)
  })

  it("names the real reason for each non-ready mode", () => {
    expect(aiNotReadyMessage("not-configured", false)).toContain("No API key saved")
    expect(aiNotReadyMessage("not-configured", true)).toContain("Finish AI setup")
    expect(aiNotReadyMessage("local", true)).toContain("AI is off")
    expect(aiNotReadyMessage("local", false)).toContain("AI Discovery is off")
    expect(aiNotReadyMessage("unavailable", false)).toContain("isn't available")
  })
})
