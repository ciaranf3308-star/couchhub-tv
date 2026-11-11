// C2 recommendation engine tests (0.10.0, W4).
// Pure functions only; no live catalogue, no AI key. localStorage is
// stubbed in-memory for the trackExposure tests only.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  confidenceScore,
  isHeadlineEligible,
  filterHeadlineEligible,
  sortByConfidence,
  explain,
  neutralLabel,
  trackExposure,
  readExposure,
  exposureCount,
  diversify,
  EXPOSURE_STORAGE_KEY,
  type TasteSignals,
} from "../src/scripts/lib/recommendations"
import { explainBecause } from "../src/scripts/lib/because-watched"
import { tasteSignalsFromModel, emptyTasteModel } from "../src/scripts/lib/taste"

function signalsWithGenre(genre: string, weight: number): TasteSignals {
  return {
    likedTitles: [],
    favouriteTitles: [],
    dislikedTitles: [],
    notInterestedKeys: [],
    genreWeights: { [genre]: weight },
    castWeights: {},
    directorWeights: {},
  }
}

describe("confidenceScore", () => {
  it("returns -Infinity for a null/unknown rating — never a headline", () => {
    expect(confidenceScore(null, 5000)).toBe(-Infinity)
    expect(confidenceScore(null, null)).toBe(-Infinity)
    expect(confidenceScore(0, 5000)).toBe(-Infinity)
    expect(confidenceScore(NaN, 5000)).toBe(-Infinity)
  })

  it("shrinks a 10.0 with no votes to the prior mean 6.5", () => {
    expect(confidenceScore(10, 0)).toBe(6.5)
    expect(confidenceScore(10, null)).toBe(6.5)
    expect(confidenceScore(10, 1)).toBeLessThan(6.6)
  })

  it("scores a well-supported 8.0 above a no-vote 10.0", () => {
    expect(confidenceScore(8, 5000)).toBeGreaterThan(confidenceScore(10, 0))
    expect(confidenceScore(8, 5000)).toBeCloseTo(8, 1)
  })

  it("converges on the title's own rating with many votes", () => {
    expect(confidenceScore(7.2, 100000)).toBeCloseTo(7.2, 2)
  })
})

describe("isHeadlineEligible", () => {
  it("rejects a 10.0 with no votes — always", () => {
    expect(isHeadlineEligible({ rating: 10 })).toBe(false)
    expect(isHeadlineEligible({ rating: 10, voteCount: 0 })).toBe(false)
    expect(isHeadlineEligible({ rating: 10, voteCount: 99 })).toBe(false)
    // Even a TMDb match without a surfaced count is not evidence.
    expect(isHeadlineEligible({ rating: 10, tmdbId: 123 })).toBe(false)
  })

  it("rejects unrated titles whatever their votes", () => {
    expect(isHeadlineEligible({ rating: null, voteCount: 5000 })).toBe(false)
    expect(isHeadlineEligible({ voteCount: 5000 })).toBe(false)
  })

  it("accepts real-vote titles at/above the floor", () => {
    expect(isHeadlineEligible({ rating: 8.1, voteCount: 100 })).toBe(true)
    expect(isHeadlineEligible({ rating: 7.5, voteCount: 5000 })).toBe(true)
    expect(isHeadlineEligible({ rating: 9.9, votes: 250 })).toBe(true)
    expect(isHeadlineEligible({ rating: 9.9, vote_count: 250 })).toBe(true)
  })

  it("respects a caller-supplied minVotes floor", () => {
    expect(isHeadlineEligible({ rating: 8.0, voteCount: 500 }, 1000)).toBe(false)
    expect(isHeadlineEligible({ rating: 8.0, voteCount: 1500 }, 1000)).toBe(true)
  })

  it("filterHeadlineEligible keeps only eligible items, in order", () => {
    const items = [
      { rating: 10, voteCount: 0 },
      { rating: 8.2, voteCount: 400 },
      { rating: null, voteCount: 9000 },
      { rating: 7.0, voteCount: 100 },
    ]
    expect(filterHeadlineEligible(items).map((i) => i.rating)).toEqual([8.2, 7.0])
  })

  it("sortByConfidence ranks by Bayesian score, unrated last", () => {
    const items = [
      { id: "a", rating: 10, voteCount: 0 },
      { id: "b", rating: 8.0, voteCount: 5000 },
      { id: "c", rating: null, voteCount: 9000 },
    ]
    expect(sortByConfidence(items).map((i) => i.id)).toEqual(["b", "a", "c"])
  })
})

describe("explain", () => {
  it("returns null with no signals at all", () => {
    expect(explain({ title: "Film", genres: ["Crime"] }, null)).toBeNull()
    expect(explain({ title: "Film", genres: ["Crime"] }, undefined)).toBeNull()
    expect(explain({ title: "Film", genres: ["Crime"] }, signalsWithGenre("crime", 0))).toBeNull()
  })

  it("returns null when the genre affinity is weak (below one liked title)", () => {
    expect(explain({ title: "Film", genres: ["Crime"] }, signalsWithGenre("crime", 0.5))).toBeNull()
  })

  it("cites a real genre affinity", () => {
    expect(explain({ title: "Film", genres: ["Crime"] }, signalsWithGenre("crime", 2))).toBe(
      "Because you liked Crime",
    )
  })

  it("does not cite a genre the household has no affinity for", () => {
    expect(explain({ title: "Film", genres: ["Horror"] }, signalsWithGenre("crime", 2))).toBeNull()
  })

  it("cites cast affinity using the candidate's own name spelling", () => {
    const signals: TasteSignals = {
      ...signalsWithGenre("crime", 0),
      castWeights: { "tom hanks": 1.6 },
    }
    expect(
      explain({ title: "Film", genres: ["Drama"], cast: ["Tom Hanks"] }, signals),
    ).toBe("Starring Tom Hanks")
  })

  it("cites director affinity", () => {
    const signals: TasteSignals = {
      ...signalsWithGenre("crime", 0),
      directorWeights: { "denis villeneuve": 1 },
    }
    expect(
      explain({ title: "Film", genres: ["Sci-Fi"], director: "Denis Villeneuve" }, signals),
    ).toBe("Directed by Denis Villeneuve")
  })

  it("cites the because-watched seed when genres overlap", () => {
    const signals: TasteSignals = {
      ...signalsWithGenre("crime", 0),
      seedTitle: { title: "Breaking Bad", genres: ["Crime", "Drama"] },
    }
    expect(explain({ title: "Show", genres: ["Drama"] }, signals)).toBe(
      "Because you watched Breaking Bad",
    )
  })

  it("does not cite a seed with no genre overlap", () => {
    const signals: TasteSignals = {
      ...signalsWithGenre("crime", 0),
      seedTitle: { title: "Breaking Bad", genres: ["Crime"] },
    }
    expect(explain({ title: "Show", genres: ["Comedy"] }, signals)).toBeNull()
  })

  it("returns null for an already-liked title (no discovery reason)", () => {
    const signals: TasteSignals = {
      ...signalsWithGenre("crime", 3),
      likedTitles: [{ kind: "movie", id: "7", title: "Film", weight: 1, updatedAt: 1 }],
    }
    expect(explain({ id: 7, kind: "movie", title: "Film", genres: ["Crime"] }, signals)).toBeNull()
  })

  it("returns null for a not-interested title", () => {
    const signals: TasteSignals = {
      ...signalsWithGenre("crime", 3),
      notInterestedKeys: ["movie:7"],
    }
    expect(explain({ id: 7, kind: "movie", title: "Film", genres: ["Crime"] }, signals)).toBeNull()
  })

  it("tasteSignalsFromModel projects a real model into citable signals", () => {
    const model = emptyTasteModel("shared", "pl1")
    model.genreWeights = { crime: 2 }
    model.likedTitles = [{ kind: "movie", id: "1", title: "Liked", weight: 1, updatedAt: 1 }]
    const signals = tasteSignalsFromModel(model)
    expect(explain({ title: "Film", genres: ["Crime"] }, signals)).toBe(
      "Because you liked Crime",
    )
  })

  it("neutralLabel never claims a reason", () => {
    expect(neutralLabel({ title: "Film", kind: "series", genres: ["Crime"] })).toBe(
      "Featured Crime Series",
    )
    expect(neutralLabel({ title: "Film", kind: "movie" })).toBe("Featured Movie")
  })

  it("explainBecause cites only a real watched seed", () => {
    expect(explainBecause({ kind: "vod", id: 5, name: "Breaking Bad", updatedAt: 1 })).toBe(
      "Because you watched Breaking Bad",
    )
    expect(explainBecause(null)).toBeNull()
    expect(explainBecause({ kind: "vod", id: 5, name: "  ", updatedAt: 1 })).toBeNull()
  })
})

describe("trackExposure / readExposure", () => {
  let store: Record<string, string>
  let previous: unknown

  beforeEach(() => {
    store = {}
    previous = (globalThis as Record<string, unknown>).localStorage
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
    }
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).localStorage = previous
  })

  it("counts exposures under the contract key and reads them back", () => {
    trackExposure(["a", "b", "a"])
    expect(readExposure()).toEqual({ a: 2, b: 1 })
    expect(exposureCount("a")).toBe(2)
    expect(exposureCount("never-shown")).toBe(0)
    expect(Object.keys(store)).toEqual([EXPOSURE_STORAGE_KEY])
    trackExposure(["a"])
    expect(exposureCount("a")).toBe(3)
  })

  it("ignores corrupt stored data instead of throwing", () => {
    store[EXPOSURE_STORAGE_KEY] = "not json{"
    expect(readExposure()).toEqual({})
    expect(() => trackExposure(["x"])).not.toThrow()
    expect(exposureCount("x")).toBe(1)
  })

  it("no-ops with no localStorage (node without a stub)", () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(() => trackExposure(["x"])).not.toThrow()
    expect(readExposure()).toEqual({})
  })
})

describe("diversify", () => {
  const rails = [
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ id: 1 }, { id: 4 }, { id: 2 }],
    [{ id: 1 }, { id: 5 }],
    [{ id: 1 }, { id: 6 }],
  ]

  it("caps a title at 2 rails by default", () => {
    const out = diversify(rails)
    const appearances = out.flat().filter((i) => i.id === 1).length
    expect(appearances).toBe(2)
  })

  it("never places a title in adjacent rails", () => {
    const out = diversify(rails)
    // id 1 kept in rail 0, dropped from rail 1 (adjacent), kept in rail 2.
    expect(out[0].map((i) => i.id)).toContain(1)
    expect(out[1].map((i) => i.id)).not.toContain(1)
    expect(out[2].map((i) => i.id)).toContain(1)
    // id 2: rail 0 then rail 1 is adjacent, so it is dropped from rail 1.
    expect(out[1].map((i) => i.id)).not.toContain(2)
  })

  it("respects a caller-supplied maxPerTitle", () => {
    const out = diversify(rails, 1)
    expect(out.flat().filter((i) => i.id === 1).length).toBe(1)
    const out3 = diversify(
      [[{ id: 1 }], [{ id: 2 }], [{ id: 1 }], [{ id: 3 }], [{ id: 1 }]],
      3,
    )
    expect(out3.flat().filter((i) => i.id === 1).length).toBe(3)
  })

  it("preserves rail positions and order, including emptied rails", () => {
    const out = diversify([[{ id: 1 }], [{ id: 1 }], [{ id: 1 }]], 1)
    expect(out).toEqual([[{ id: 1 }], [], []])
  })

  it("keeps unkeyable items (they cannot be recognised as repeats)", () => {
    const out = diversify([[{}], [{}]])
    expect(out).toEqual([[{}], [{}]])
  })

  it("handles string ids and empty input", () => {
    expect(diversify([["a", "b"], ["a", "c"]])).toEqual([["a", "b"], ["c"]])
    expect(diversify([])).toEqual([])
  })
})
