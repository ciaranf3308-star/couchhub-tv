// AI generation tests (AI Discovery 3.0, 0.11.6). The model client is
// mocked — no key, no network. Fixtures are synthetic canned replies.
import { describe, it, expect, beforeEach, vi } from "vitest"

const { chatMock, shareTaste } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  shareTaste: { value: false },
}))

vi.mock("@/scripts/lib/ai/client.js", () => ({
  chatCompletions: chatMock,
}))

vi.mock("@/scripts/lib/ai/status.js", () => ({
  getAiShareTaste: () => shareTaste.value,
}))

import {
  buildGenerationPrompt,
  parseGeneratedRecommendations,
  generateRecommendations,
  gateTasteSummary,
  generationTokenBudget,
  clampCount,
  newConversation,
  conversationContextFor,
  intentToGenerationConstraints,
  mergeGenerationConstraints,
  constraintsForConversation,
  AI_GENERATION_MAX_OUTPUT_TOKENS,
} from "@/scripts/lib/ai/generation"
import { parseIntent } from "@/scripts/lib/retrieval"

function modelReply(recs: Array<unknown>): string {
  return JSON.stringify({ recommendations: recs })
}

const REC_A = {
  title: "Synthetic Film One",
  year: 2019,
  kind: "movie",
  reason: "A dark, specific reason tied to the request.",
  tone: "dark thriller",
}
const REC_B = {
  title: "Synthetic Series Two",
  year: 2021,
  kind: "series",
  reason: "A second specific reason tied to the request.",
  tone: "slow mystery",
}

beforeEach(() => {
  vi.resetAllMocks()
  shareTaste.value = false
  chatMock.mockResolvedValue({ text: modelReply([REC_A, REC_B]), model: "gpt-4o-mini" })
})

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe("buildGenerationPrompt", () => {
  it("includes the user's request, the count and the JSON contract", () => {
    const { system, user } = buildGenerationPrompt({
      query: "something dark and unsettling",
      count: 8,
    })
    expect(system).toContain("JSON only")
    expect(system).toContain("exactly 8 titles")
    expect(system).toContain("never invent a title")
    expect(user).toContain("something dark and unsettling")
    expect(user).toContain("Recommend 8 titles as JSON.")
  })

  it("never includes a candidate list as the answer space", () => {
    const { system, user } = buildGenerationPrompt({
      query: "something funny",
      count: 10,
    })
    const combined = `${system}\n${user}`
    expect(combined).not.toContain("Candidates:")
    expect(combined).not.toContain("candidate list")
    expect(combined).not.toContain("Rank ONLY")
  })

  it("states explicit constraints as requirements", () => {
    const { user } = buildGenerationPrompt({
      query: "a film",
      count: 5,
      constraints: {
        kind: "movie",
        yearMin: 2016,
        yearMax: 2024,
        maxRuntimeMinutes: 120,
        excludeTitles: ["Already Seen One", "Already Seen Two"],
      },
    })
    expect(user).toContain("Only films.")
    expect(user).toContain("2016 to 2024")
    expect(user).toContain("No film longer than 120 minutes.")
    expect(user).toContain("Already Seen One")
    expect(user).toContain("Already Seen Two")
  })

  it("includes conversation context when refining", () => {
    const { user } = buildGenerationPrompt({
      query: "give me others",
      count: 5,
      conversationContext: ['- Earlier request: "something dark" Already suggested: Synthetic Film One.'],
    })
    expect(user).toContain("Earlier in this conversation:")
    expect(user).toContain("Synthetic Film One")
  })

  it("withholds the taste summary when sharing is off (default)", () => {
    shareTaste.value = false
    const { user } = buildGenerationPrompt({
      query: "something funny",
      count: 5,
      tasteSummary: "Favourite genres: horror. Liked: Secret Taste Title.",
    })
    expect(user).not.toContain("Secret Taste Title")
    expect(user).not.toContain("Favourite genres")
  })

  it("includes the taste summary only when the user opted in", () => {
    shareTaste.value = true
    const { user } = buildGenerationPrompt({
      query: "something funny",
      count: 5,
      tasteSummary: "Favourite genres: horror. Liked: Shared Taste Title.",
    })
    expect(user).toContain("Shared Taste Title")
  })

  it("strips URLs from the query so no link can leak into the prompt", () => {
    const { user } = buildGenerationPrompt({
      query: "like https://example.invalid/stream/123 something dark",
      count: 5,
    })
    expect(user).not.toContain("example.invalid")
    expect(user).not.toContain("http")
  })
})

describe("gateTasteSummary", () => {
  it("returns null when sharing is off, even with a summary supplied", () => {
    shareTaste.value = false
    expect(gateTasteSummary("Favourite genres: horror")).toBeNull()
  })

  it("returns the summary when sharing is on", () => {
    shareTaste.value = true
    expect(gateTasteSummary("Favourite genres: horror")).toBe("Favourite genres: horror")
  })

  it("returns null for an empty summary even when sharing is on", () => {
    shareTaste.value = true
    expect(gateTasteSummary("  ")).toBeNull()
    expect(gateTasteSummary(null)).toBeNull()
    expect(gateTasteSummary(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Output budget
// ---------------------------------------------------------------------------

describe("generationTokenBudget", () => {
  it("gives the default 10 recommendations 1600 tokens, not the 800 rerank budget", () => {
    expect(AI_GENERATION_MAX_OUTPUT_TOKENS).toBe(1600)
    expect(generationTokenBudget(10)).toBe(1600)
  })

  it("floors small counts at 800 and ceilings large counts at 2000", () => {
    expect(generationTokenBudget(1)).toBe(800)
    expect(generationTokenBudget(12)).toBe(1920)
    expect(generationTokenBudget(100)).toBe(1920) // count clamps to 12
  })

  it("clamps counts to 1..12", () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(13)).toBe(12)
    expect(clampCount(Number.NaN)).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// JSON parsing robustness
// ---------------------------------------------------------------------------

describe("parseGeneratedRecommendations", () => {
  it("parses a plain recommendations object", () => {
    const recs = parseGeneratedRecommendations(modelReply([REC_A, REC_B]))
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ title: "Synthetic Film One", year: 2019, kind: "movie" })
    expect(recs[1]).toMatchObject({ title: "Synthetic Series Two", kind: "series" })
  })

  it("parses a bare top-level array", () => {
    const recs = parseGeneratedRecommendations(JSON.stringify([REC_A]))
    expect(recs).toHaveLength(1)
    expect(recs[0]?.title).toBe("Synthetic Film One")
  })

  it("strips markdown fences", () => {
    const fenced = "```json\n" + modelReply([REC_A]) + "\n```"
    expect(parseGeneratedRecommendations(fenced)).toHaveLength(1)
    const unfenced = "```\n" + modelReply([REC_A]) + "\n```"
    expect(parseGeneratedRecommendations(unfenced)).toHaveLength(1)
  })

  it("tolerates prose and trailing text around the JSON", () => {
    const text = `Here are my picks:\n${modelReply([REC_A])}\nHope you enjoy them!`
    expect(parseGeneratedRecommendations(text)).toHaveLength(1)
  })

  it("drops invalid items individually instead of failing the whole reply", () => {
    const recs = parseGeneratedRecommendations(
      modelReply([
        REC_A,
        { title: "", year: 2020, kind: "movie", reason: "No title." },
        { title: "No Kind Here", year: 2020, reason: "No kind." },
        { title: "Bad Kind Here", year: 2020, kind: "podcast", reason: "Bad kind." },
        "not an object",
        null,
        REC_B,
      ])
    )
    expect(recs.map((r) => r.title)).toEqual(["Synthetic Film One", "Synthetic Series Two"])
  })

  it("turns a bad or missing year into null, never a guessed year", () => {
    const recs = parseGeneratedRecommendations(
      modelReply([
        { ...REC_A, year: "not a year" },
        { ...REC_B, title: "Future Guessed", year: 2999 },
        { title: "No Year Given", kind: "movie", reason: "Fine without a year." },
        { title: "String Year", year: "1997", kind: "movie", reason: "Parses." },
      ])
    )
    expect(recs.map((r) => r.year)).toEqual([null, null, null, 1997])
  })

  it("maps kind synonyms and drops unknown kinds", () => {
    const recs = parseGeneratedRecommendations(
      modelReply([
        { title: "Film Synonym", year: 2000, kind: "film", reason: "x" },
        { title: "TV Synonym", year: 2000, kind: "tv", reason: "x" },
      ])
    )
    expect(recs.map((r) => r.kind)).toEqual(["movie", "series"])
  })

  it("keeps only a valid external id, and only when confidently structured", () => {
    const recs = parseGeneratedRecommendations(
      modelReply([
        { ...REC_A, externalId: { source: "tmdb", id: "12345" } },
        { ...REC_B, externalId: { source: "made-up", id: "999" } },
        { title: "Empty Id", kind: "movie", reason: "x", externalId: { source: "imdb", id: "" } },
      ])
    )
    expect(recs[0]?.externalId).toEqual({ source: "tmdb", id: "12345" })
    expect(recs[1]?.externalId).toBeUndefined()
    expect(recs[2]?.externalId).toBeUndefined()
  })

  it("collapses duplicate titles (same kind, case-insensitive) to the first mention", () => {
    const recs = parseGeneratedRecommendations(
      modelReply([REC_A, { ...REC_A, title: "  synthetic film ONE " }, REC_B])
    )
    expect(recs.map((r) => r.title)).toEqual(["Synthetic Film One", "Synthetic Series Two"])
  })

  it("falls back to a generic reason when the model gives none", () => {
    const recs = parseGeneratedRecommendations(
      modelReply([{ title: "No Reason", year: 2000, kind: "movie" }])
    )
    expect(recs[0]?.reason).toBeTruthy()
  })

  it("returns an empty list for garbage, empty JSON, or a missing list", () => {
    expect(parseGeneratedRecommendations("")).toEqual([])
    expect(parseGeneratedRecommendations("no json here at all")).toEqual([])
    expect(parseGeneratedRecommendations(JSON.stringify({ recommendations: [] }))).toEqual([])
    expect(parseGeneratedRecommendations(JSON.stringify({ somethingElse: 1 }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// generateRecommendations
// ---------------------------------------------------------------------------

describe("generateRecommendations", () => {
  it("calls the transport once with system+user messages and the generation budget", async () => {
    const result = await generateRecommendations({ query: "something dark", count: 10 })
    expect(chatMock).toHaveBeenCalledTimes(1)
    const options = chatMock.mock.calls[0][0]
    expect(options.messages).toHaveLength(2)
    expect(options.messages[0].role).toBe("system")
    expect(options.messages[1].role).toBe("user")
    expect(options.maxTokens).toBe(1600)
    expect(result.recommendations).toHaveLength(2)
    expect(result.model).toBe("gpt-4o-mini")
    expect(result.cached).toBe(false)
    expect(result.providerError).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("passes the caller's AbortSignal through untouched", async () => {
    const controller = new AbortController()
    await generateRecommendations({
      query: "something dark",
      count: 5,
      signal: controller.signal,
    })
    expect(chatMock.mock.calls[0][0].signal).toBe(controller.signal)
  })

  it("uses an injected transport instead of the default", async () => {
    const injected = vi.fn().mockResolvedValue({
      text: modelReply([REC_A]),
      model: "injected-model",
    })
    const result = await generateRecommendations(
      { query: "something dark", count: 5 },
      { chat: injected }
    )
    expect(injected).toHaveBeenCalledTimes(1)
    expect(chatMock).not.toHaveBeenCalled()
    expect(result.model).toBe("injected-model")
    expect(result.recommendations).toHaveLength(1)
  })

  it("returns an empty result with providerError when nothing parses, never fillers", async () => {
    chatMock.mockResolvedValue({ text: "I have no idea, sorry.", model: "gpt-4o-mini" })
    const result = await generateRecommendations({ query: "something dark", count: 5 })
    expect(result.recommendations).toEqual([])
    expect(result.providerError).toBeTruthy()
  })

  it("propagates transport errors instead of disguising them", async () => {
    const failure = new Error("The provider rejected the API key.")
    ;(failure as Error & { kind: string }).kind = "invalid_key"
    chatMock.mockRejectedValue(failure)
    await expect(generateRecommendations({ query: "something dark", count: 5 })).rejects.toBe(
      failure
    )
  })

  it("rejects an empty query without calling the transport", async () => {
    await expect(generateRecommendations({ query: "   ", count: 5 })).rejects.toThrow()
    expect(chatMock).not.toHaveBeenCalled()
  })

  it("never sends the taste summary when sharing is off, even when supplied", async () => {
    shareTaste.value = false
    await generateRecommendations({
      query: "something funny",
      count: 5,
      tasteSummary: "Liked: Secret Taste Title",
    })
    const sent = chatMock.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join("\n")
    expect(sent).not.toContain("Secret Taste Title")
  })

  it("sends the taste summary when sharing is on", async () => {
    shareTaste.value = true
    await generateRecommendations({
      query: "something funny",
      count: 5,
      tasteSummary: "Liked: Shared Taste Title",
    })
    const sent = chatMock.mock.calls[0][0].messages.map((m: { content: string }) => m.content).join("\n")
    expect(sent).toContain("Shared Taste Title")
  })
})

// ---------------------------------------------------------------------------
// Conversation state + constraint merging
// ---------------------------------------------------------------------------

describe("conversation state", () => {
  it("starts empty and renders prior turns as bounded context", () => {
    const state = newConversation()
    expect(state.turns).toEqual([])
    expect(conversationContextFor(state)).toEqual([])
    state.turns.push({
      query: "something dark",
      generatedTitles: ["Synthetic Film One", "Synthetic Series Two"],
    })
    const context = conversationContextFor(state)
    expect(context).toHaveLength(1)
    expect(context[0]).toContain("something dark")
    expect(context[0]).toContain("Synthetic Film One")
    expect(context[0]).toContain("Synthetic Series Two")
  })

  it("keeps only the most recent turns so context stays bounded", () => {
    const state = newConversation()
    for (let i = 0; i < 6; i++) {
      state.turns.push({ query: `request ${i}`, generatedTitles: [`Title ${i}`] })
    }
    const context = conversationContextFor(state)
    expect(context).toHaveLength(4)
    expect(context[0]).toContain("request 2")
    expect(context[3]).toContain("request 5")
  })
})

describe("intentToGenerationConstraints + mergeGenerationConstraints", () => {
  it("extracts explicit kind/year/runtime constraints from a query", () => {
    const constraints = intentToGenerationConstraints(
      parseIntent("a film after 2015 under two hours")
    )
    expect(constraints.kind).toBe("movie")
    expect(constraints.yearMin).toBe(2016)
    expect(constraints.maxRuntimeMinutes).toBe(120)
  })

  it("extracts a series kind and a year bound", () => {
    const constraints = intentToGenerationConstraints(parseIntent("a gripping series from the 90s"))
    expect(constraints.kind).toBe("series")
    expect(constraints.yearMin).toBe(1990)
    expect(constraints.yearMax).toBe(1999)
  })

  it("replace semantics: a fresh scalar replaces, an unmentioned field is kept", () => {
    const merged = mergeGenerationConstraints(
      { kind: "movie", yearMin: 2000, maxRuntimeMinutes: 90 },
      { kind: "series" }
    )
    expect(merged).toEqual({ kind: "series", yearMin: 2000, maxRuntimeMinutes: 90 })
  })

  it("union semantics: exclusions accumulate across turns", () => {
    const merged = mergeGenerationConstraints(
      { excludeTitles: ["Title A", "Title B"] },
      { excludeTitles: ["Title B", "Title C"] }
    )
    expect([...(merged.excludeTitles ?? [])].sort()).toEqual(["Title A", "Title B", "Title C"])
  })

  it("constraintsForConversation folds prior turns, excludes suggested titles, and lets the current query win", () => {
    const state = newConversation()
    state.turns.push(
      { query: "a film after 2010", generatedTitles: ["Suggested One"] },
      { query: "something darker", generatedTitles: ["Suggested Two"] }
    )
    const merged = constraintsForConversation(state, "make it a series")
    expect(merged.kind).toBe("series")
    expect(merged.yearMin).toBe(2011)
    expect(merged.excludeTitles).toContain("Suggested One")
    expect(merged.excludeTitles).toContain("Suggested Two")
  })

  it("constraintsForConversation keeps genre/tone in the query text, not as hard constraints", () => {
    // GenerationConstraints has no genre field: "horror" must reach
    // the model through the query itself, never as a filter.
    const merged = constraintsForConversation(newConversation(), "something horror")
    expect(merged).not.toHaveProperty("genres")
    expect(Object.keys(merged)).not.toContain("genres")
  })
})
