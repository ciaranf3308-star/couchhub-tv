import { describe, it, expect } from "vitest"
import {
  normaliseRating,
  compareByRatingEvidence,
  evidenceWeightedScore,
  hasReliableRating,
  ratingPassesMinimum,
} from "@/scripts/lib/rating-evidence.ts"

describe("normaliseRating", () => {
  it("reads a bare provider rating as 10-point with low confidence", () => {
    const evidence = normaliseRating({ rating: "8.4" })
    expect(evidence).toEqual({
      score10: 8.4,
      source: "provider",
      confidence: "low",
      voteCount: null,
      rawValue: 8.4,
      rawScale: 10,
    })
  })

  it("converts an explicitly 5-based rating (x2) without mixing scales", () => {
    const evidence = normaliseRating({ rating_5based: 4 })
    expect(evidence?.score10).toBe(8)
    expect(evidence?.rawScale).toBe(5)
    expect(evidence?.source).toBe("provider")
  })

  it("converts a rating with an explicit 5-point scale marker", () => {
    expect(normaliseRating({ rating: "4", ratingScale: 5 })?.score10).toBe(8)
    expect(normaliseRating({ rating: "4", ratingScale: "5" })?.rawScale).toBe(5)
  })

  it("does not rescale a bare rating of 4 (10-point reading, matching ratingSortValue)", () => {
    expect(normaliseRating({ rating: "4" })?.score10).toBe(4)
  })

  it("marks corroborated TMDb fields as tmdb with vote-based confidence", () => {
    const evidence = normaliseRating({ vote_average: 7.5, vote_count: 1200 })
    expect(evidence?.source).toBe("tmdb")
    expect(evidence?.confidence).toBe("high")
    expect(evidence?.voteCount).toBe(1200)
  })

  it("marks uncorroborated TMDb-shaped fields as enrichment, never tmdb", () => {
    const evidence = normaliseRating({ vote_average: 7.5 })
    expect(evidence?.source).toBe("enrichment")
    expect(evidence?.confidence).toBe("low")
  })

  it("trusts an explicit tmdb marker on a bare rating", () => {
    const evidence = normaliseRating({ rating: "8.1", ratingSource: "tmdb", vote_count: 50 })
    expect(evidence?.source).toBe("tmdb")
    expect(evidence?.confidence).toBe("low")
  })

  it("returns null for missing, zero, negative, oversized or unparseable ratings", () => {
    expect(normaliseRating({})).toBeNull()
    expect(normaliseRating({ rating: "0" })).toBeNull()
    expect(normaliseRating({ rating: "-1" })).toBeNull()
    expect(normaliseRating({ rating: "11" })).toBeNull()
    expect(normaliseRating({ rating: "" })).toBeNull()
    expect(normaliseRating({ rating: "abc" })).toBeNull()
    expect(normaliseRating(null)).toBeNull()
    expect(normaliseRating(undefined)).toBeNull()
  })

  it("clamps a 5-based 5 to 10", () => {
    expect(normaliseRating({ rating_5based: 5 })?.score10).toBe(10)
  })
})

describe("compareByRatingEvidence", () => {
  it("ranks a well-supported 8 above a provider 10 with no votes", () => {
    const providerTen = { rating: "10" }
    const established = { vote_average: 8.0, vote_count: 5000 }
    expect(compareByRatingEvidence(providerTen, established)).toBeGreaterThan(0)
    expect(compareByRatingEvidence(established, providerTen)).toBeLessThan(0)
  })

  it("sorts unrated titles last, and two unrated titles equal", () => {
    expect(compareByRatingEvidence({}, { rating: "2" })).toBeGreaterThan(0)
    expect(compareByRatingEvidence({ rating: "2" }, {})).toBeLessThan(0)
    expect(compareByRatingEvidence({}, {})).toBe(0)
    expect(compareByRatingEvidence(null, null)).toBe(0)
  })

  it("accepts pre-normalised evidence objects", () => {
    const a = normaliseRating({ vote_average: 9, vote_count: 2000 })!
    const b = normaliseRating({ vote_average: 7, vote_count: 2000 })!
    expect(compareByRatingEvidence(a, b)).toBeLessThan(0)
  })
})

describe("evidenceWeightedScore", () => {
  it("scores unrated titles at the prior mean", () => {
    expect(evidenceWeightedScore(null)).toBe(6.5)
    expect(evidenceWeightedScore({})).toBe(6.5)
  })

  it("collapses a voteless 10 to the prior mean", () => {
    expect(evidenceWeightedScore({ rating: "10" })).toBe(6.5)
  })
})

describe("hasReliableRating / ratingPassesMinimum", () => {
  it("requires real votes for reliability", () => {
    expect(hasReliableRating({ vote_average: 8, vote_count: 100 })).toBe(true)
    expect(hasReliableRating({ vote_average: 8, vote_count: 99 })).toBe(false)
    expect(hasReliableRating({ rating: "9.9" })).toBe(false)
    expect(hasReliableRating({}, 0)).toBe(false)
  })

  it("never lets an unrated title pass a positive minimum", () => {
    expect(ratingPassesMinimum({}, 7)).toBe(false)
    expect(ratingPassesMinimum(null, 7)).toBe(false)
    expect(ratingPassesMinimum({ rating: "6.9" }, 7)).toBe(false)
    expect(ratingPassesMinimum({ rating: "7" }, 7)).toBe(true)
    expect(ratingPassesMinimum({}, 0)).toBe(true)
  })
})
