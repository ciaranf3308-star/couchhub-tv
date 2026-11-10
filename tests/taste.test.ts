// Discover CORE — taste model tests (W1).
// Pure functions only; no live catalogue, no AI key, no browser globals.
import { describe, it, expect } from "vitest"
import {
  buildTasteModel,
  dedupeTitleRefs,
  emptyTasteModel,
  recordFeedback,
  summarizeTaste,
  preferredRuntimeMax,
  ABANDONED_FRACTION,
  type TasteModel,
  type TasteTitleRef,
} from "../src/scripts/lib/taste"

const NOW = Date.parse("2026-11-10T12:00:00Z")
const WEEK = 7 * 24 * 60 * 60 * 1000

describe("buildTasteModel", () => {
  it("treats completions as likes, never bare opens", () => {
    const model = buildTasteModel({
      profileId: "shared",
      playlistId: "pl1",
      nowMs: NOW,
      signals: [
        { kind: "vod", id: 1, name: "Finished Film", updatedAt: NOW - 1000, completed: true, progressFraction: 1 },
        // Opened and stopped at 5% yesterday: too recent to call abandoned,
        // and definitely not a like.
        { kind: "vod", id: 2, name: "Just Opened", updatedAt: NOW - 1000, completed: false, progressFraction: 0.05 },
        // Never even started: no progress at all.
        { kind: "vod", id: 3, name: "Never Started", updatedAt: NOW - 1000, completed: false, progressFraction: 0 },
      ],
      favourites: [],
    })
    expect(model.likedTitles.map((t) => t.id)).toEqual(["1"])
    expect(model.dislikedTitles).toEqual([])
  })

  it("infers abandonment only for old early stops below 20%", () => {
    const model = buildTasteModel({
      profileId: "shared",
      playlistId: "pl1",
      nowMs: NOW,
      signals: [
        { kind: "vod", id: 1, name: "Bailed Early", updatedAt: NOW - 2 * WEEK, completed: false, progressFraction: 0.1 },
        // Stopped at 50%: watched half of it — not abandonment.
        { kind: "vod", id: 2, name: "Half Watched", updatedAt: NOW - 2 * WEEK, completed: false, progressFraction: 0.5 },
        // Stopped at 10% yesterday: may come back, not a signal yet.
        { kind: "vod", id: 3, name: "Paused Yesterday", updatedAt: NOW - 1000, completed: false, progressFraction: 0.1 },
      ],
      favourites: [],
    })
    expect(model.dislikedTitles.map((t) => t.id)).toEqual(["1"])
    expect(model.dislikedTitles[0].weight).toBeLessThan(1)
    expect(ABANDONED_FRACTION).toBe(0.2)
  })

  it("builds genre/cast/director affinities from liked titles only", () => {
    const model = buildTasteModel({
      profileId: "shared",
      playlistId: "pl1",
      nowMs: NOW,
      signals: [
        { kind: "vod", id: 1, name: "Space Heist", updatedAt: NOW - 1000, completed: true, progressFraction: 1 },
      ],
      favourites: [{ kind: "movie", id: 2, title: "Quiet Drama", addedAt: NOW - 2000 }],
      resolveMeta: (kind, id) =>
        id === "1"
          ? { genres: ["Sci-Fi", "Action"], cast: ["Ada Star"], director: "Jane Doe", runtimeMinutes: 120 }
          : { genres: ["Drama"], cast: [], director: null, runtimeMinutes: 95 },
    })
    expect(model.genreWeights["sci-fi"]).toBeGreaterThan(0)
    expect(model.genreWeights["drama"]).toBeGreaterThan(0)
    expect(model.castWeights["ada star"]).toBeGreaterThan(0)
    expect(model.directorWeights["jane doe"]).toBeGreaterThan(0)
    expect(model.likedRuntimes).toEqual([95, 120])
  })

  it("is idempotent: rebuilding over the same inputs never duplicates records", () => {
    const input = {
      profileId: "shared",
      playlistId: "pl1",
      nowMs: NOW,
      signals: [
        { kind: "vod" as const, id: 1, name: "Same Film", updatedAt: NOW - 1000, completed: true, progressFraction: 1 },
        { kind: "vod" as const, id: 1, name: "Same Film", updatedAt: NOW - 1000, completed: true, progressFraction: 1 },
      ],
      favourites: [],
    }
    const first = buildTasteModel(input)
    const second = buildTasteModel(input)
    expect(first.likedTitles).toEqual(second.likedTitles)
    expect(first.likedTitles).toHaveLength(1)
  })
})

describe("dedupeTitleRefs", () => {
  it("keeps the newest record per kind:id", () => {
    const refs: TasteTitleRef[] = [
      { kind: "movie", id: "1", title: "Old", weight: 1, updatedAt: 100 },
      { kind: "movie", id: "1", title: "New", weight: 1, updatedAt: 300 },
      { kind: "series", id: "1", title: "Different kind", weight: 1, updatedAt: 200 },
    ]
    const out = dedupeTitleRefs(refs)
    expect(out).toHaveLength(2)
    expect(out.find((r) => r.kind === "movie")?.title).toBe("New")
  })
})

describe("recordFeedback", () => {
  it("dedupes repeated feedback on the same title", () => {
    let model = emptyTasteModel("shared", "pl1")
    model = recordFeedback(model, { kind: "movie", id: 7, title: "Liked It", action: "like" })
    model = recordFeedback(model, { kind: "movie", id: 7, title: "Liked It", action: "like" })
    expect(model.likedTitles.filter((t) => t.id === "7")).toHaveLength(1)
  })

  it("a dislike removes the like, and not-interested excludes the title", () => {
    let model = emptyTasteModel("shared", "pl1")
    model = recordFeedback(model, { kind: "movie", id: 7, title: "Changed Mind", action: "like" })
    model = recordFeedback(model, { kind: "movie", id: 7, title: "Changed Mind", action: "dislike" })
    expect(model.likedTitles.find((t) => t.id === "7")).toBeUndefined()
    expect(model.dislikedTitles.find((t) => t.id === "7")).toBeDefined()
    model = recordFeedback(model, { kind: "movie", id: 7, title: "Changed Mind", action: "not-interested" })
    expect(model.notInterestedKeys).toContain("movie:7")
    model = recordFeedback(model, { kind: "movie", id: 7, title: "Changed Mind", action: "not-interested" })
    expect(model.notInterestedKeys.filter((k) => k === "movie:7")).toHaveLength(1)
  })

  it("more-like-this counts selections without creating a like", () => {
    let model = emptyTasteModel("shared", "pl1")
    model = recordFeedback(model, { kind: "movie", id: 9, title: "Picked", action: "more-like-this" })
    model = recordFeedback(model, { kind: "movie", id: 9, title: "Picked", action: "more-like-this" })
    expect(model.selectedRecommendations["movie:9"]).toBe(2)
    expect(model.likedTitles).toEqual([])
  })

  it("does not mutate the input model", () => {
    const model = emptyTasteModel("shared", "pl1")
    const next = recordFeedback(model, { kind: "movie", id: 1, title: "X", action: "like" })
    expect(model.likedTitles).toEqual([])
    expect(next.likedTitles).toHaveLength(1)
  })
})

describe("summarizeTaste", () => {
  it("summarises genres, liked/disliked titles, runtime and pace", () => {
    const model: TasteModel = {
      ...emptyTasteModel("shared", "pl1"),
      likedTitles: [
        { kind: "movie", id: "1", title: "Action One", weight: 1, updatedAt: 1 },
        { kind: "movie", id: "2", title: "Action Two", weight: 1, updatedAt: 2 },
      ],
      dislikedTitles: [{ kind: "movie", id: "9", title: "Nope", weight: 1, updatedAt: 3 }],
      genreWeights: { action: 5, thriller: 3, comedy: 0.5 },
      likedRuntimes: [90, 100, 110, 120],
    }
    const summary = summarizeTaste(model)
    expect(summary.favouriteGenres[0]).toBe("action")
    expect(summary.likedTitles).toContain("Action One")
    expect(summary.dislikedTitles).toEqual(["Nope"])
    expect(summary.preferredRuntimeMax).toBe(110)
    expect(summary.pace).toBe("intense")
  })

  it("returns no runtime max with fewer than 3 samples", () => {
    const model = emptyTasteModel("shared", "pl1")
    model.likedRuntimes = [90, 100]
    expect(preferredRuntimeMax(model)).toBeUndefined()
    expect(summarizeTaste(model).preferredRuntimeMax).toBeUndefined()
  })

  it("cold start summarises to empty lists", () => {
    const summary = summarizeTaste(emptyTasteModel("shared", "pl1"))
    expect(summary).toEqual({ favouriteGenres: [], likedTitles: [], dislikedTitles: [] })
  })
})
