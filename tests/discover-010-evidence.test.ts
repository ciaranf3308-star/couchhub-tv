// B10 confidence-aware ratings on Discover (0.10.1 fix).
//
// 0.10.0 applied the confidence fix across Home, Movies and Series but
// NOT to Discover's local ranking: scoreOne() used the raw provider
// rating and "New and Worth Watching" sorted by raw rating, so the
// fixture's two deliberate no-vote 10.0 traps led the "Highly Rated in
// Your Library" rail in the 0.10.0 integration render. These tests pin
// the fix: a rating with no votes behind it earns no rating points
// and no "Highly rated" reason, and a no-vote 10.0 never leads a
// rating-ranked Discover rail.
//
// Fixture mirrors fixtures-010.mjs: every vote-backed title carries a
// TMDb id and a real vote count; the traps carry neither.
import { describe, it, expect } from "vitest"
import {
  rankCandidates,
  searchDiscover,
  getDiscoverRows,
  catalogRowToCandidate,
  type DiscoverCandidate,
} from "../src/scripts/lib/discover"
import { emptyTasteModel } from "../src/scripts/lib/taste"
import { confidenceScore } from "../src/scripts/lib/recommendations"
import { BAYESIAN_PRIOR_MEAN } from "../src/scripts/lib/rating-confidence"

function candidate(partial: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

// Mirror of the 0.10.0 integration fixture (fixtures-010.mjs).
const CATALOG: DiscoverCandidate[] = [
  candidate({ id: "111", title: "The Cartographer", genres: ["Drama", "Mystery"], cast: [], rating: 8.8, voteCount: 15000, tmdbId: 1111, year: 2021 }),
  candidate({ id: "201", title: "Harbour Town", kind: "series", genres: ["Crime", "Drama"], cast: [], rating: 8.9, voteCount: 20000, tmdbId: 2222, year: 2023 }),
  candidate({ id: "112", title: "Linked Eight", genres: ["Action"], cast: [], rating: 8.0, voteCount: 800, tmdbId: 333, year: 2022 }),
  candidate({ id: "113", title: "Proven Six", genres: ["Comedy"], cast: [], rating: 6.0, voteCount: 5000, tmdbId: 555, year: 2020 }),
  // TRAPS: 10.0, no TMDb match, no votes.
  candidate({ id: "120", title: "Unproven Ten", genres: ["Crime", "Mystery"], cast: [], rating: 10.0, year: 2024 }),
  candidate({ id: "211", title: "Unproven Series Ten", kind: "series", genres: ["Crime", "Mystery"], cast: [], rating: 10.0, year: 2024 }),
  // TMDb-matched but no surfaced vote count: the match alone is not
  // evidence for the rating term (recommendations.ts rule).
  candidate({ id: "114", title: "Matched No Count", genres: ["Drama"], cast: [], rating: 9.5, tmdbId: 444, year: 2023 }),
]

const TRAP_TITLES = ["Unproven Ten", "Unproven Series Ten"]

function coldStart() {
  return emptyTasteModel("shared", "pl1")
}

describe("B10 — no-vote 10.0 scores at the prior mean, never 10", () => {
  it("the shared engine shrinks a no-vote 10.0 to the prior mean", () => {
    expect(confidenceScore(10.0, null)).toBe(BAYESIAN_PRIOR_MEAN)
    expect(confidenceScore(10.0, 0)).toBe(BAYESIAN_PRIOR_MEAN)
    expect(confidenceScore(null, null)).toBe(-Infinity)
    expect(confidenceScore(8.8, 15000)).toBeGreaterThan(8.5)
  })
})

describe("B10 — Picked for You / Highly Rated in Your Library", () => {
  it("cold start leads with a vote-backed title, never a trap", () => {
    const ranked = rankCandidates(CATALOG, coldStart())
    expect(ranked[0].candidate.title).toBe("Harbour Town")
    // Every vote-backed title outranks both traps.
    for (const trap of TRAP_TITLES) {
      const trapRank = ranked.findIndex((r) => r.candidate.title === trap)
      expect(trapRank).toBeGreaterThan(-1)
      for (const proven of ["Harbour Town", "The Cartographer", "Linked Eight", "Proven Six"]) {
        expect(trapRank).toBeGreaterThan(ranked.findIndex((r) => r.candidate.title === proven))
      }
    }
  })

  it("a no-vote 10.0 earns no rating points and no rating-based reason", () => {
    const ranked = rankCandidates(CATALOG, coldStart())
    for (const trap of TRAP_TITLES) {
      const item = ranked.find((r) => r.candidate.title === trap)!
      expect(item.reason).not.toMatch(/Highly rated/)
      // Only recency + novelty remain: a 2024 unwatched trap scores 5.
      expect(item.score).toBe(5)
    }
    // A vote-backed title keeps the "Highly rated" reason.
    const linked = ranked.find((r) => r.candidate.title === "Linked Eight")!
    expect(linked.reason).toMatch(/Highly rated action \(8\.0\/10\)/)
  })

  it("a TMDb match with no surfaced vote count earns no rating points either", () => {
    const ranked = rankCandidates(CATALOG, coldStart())
    const matched = ranked.find((r) => r.candidate.title === "Matched No Count")!
    expect(matched.reason).not.toMatch(/Highly rated/)
    expect(matched.score).toBe(2) // novelty only: 2023, no rating term
    expect(ranked[0].candidate.title).not.toBe("Matched No Count")
  })

  it("getDiscoverRows cold start labels honestly and never leads with a trap", () => {
    const rows = getDiscoverRows({
      candidates: CATALOG,
      taste: coldStart(),
      continueWatching: [],
      recentlyAdded: [],
      nowPlaying: [],
      watchedKeys: new Set(),
    })
    expect(rows[0].id).toBe("picked-for-you")
    expect(rows[0].title).toBe("Highly Rated in Your Library")
    expect(rows[0].items[0].candidate.title).toBe("Harbour Town")
    expect(TRAP_TITLES).not.toContain(rows[0].items[0].candidate.title)
  })
})

describe("B10 — New and Worth Watching", () => {
  // recentlyAdded arrives newest-first: the trap is deliberately the
  // NEWEST item, so recency alone must not let it lead.
  const recentlyAdded = [
    CATALOG.find((c) => c.title === "Unproven Ten")!,
    CATALOG.find((c) => c.title === "Unproven Series Ten")!,
    CATALOG.find((c) => c.title === "Harbour Town")!,
    CATALOG.find((c) => c.title === "The Cartographer")!,
    CATALOG.find((c) => c.title === "Proven Six")!,
    CATALOG.find((c) => c.title === "Matched No Count")!,
  ]

  it("never leads with a trap even when the trap is the newest addition", () => {
    const rows = getDiscoverRows({
      candidates: CATALOG,
      taste: coldStart(),
      continueWatching: [],
      recentlyAdded,
      nowPlaying: [],
      watchedKeys: new Set(),
    })
    const row = rows.find((r) => r.id === "new-and-worth-watching")!
    expect(row).toBeDefined()
    expect(row.items[0].candidate.title).toBe("Harbour Town")
    expect(TRAP_TITLES).not.toContain(row.items[0].candidate.title)
  })

  it("evidence sorts before no evidence: a proven 6.0 beats a no-vote 10.0", () => {
    const rows = getDiscoverRows({
      candidates: CATALOG,
      taste: coldStart(),
      continueWatching: [],
      recentlyAdded,
      nowPlaying: [],
      watchedKeys: new Set(),
    })
    const row = rows.find((r) => r.id === "new-and-worth-watching")!
    const titles = row.items.map((i) => i.candidate.title)
    // Proven Six (confidence ~6.0) sits above both traps (prior mean
    // 6.5 in the engine) because it has evidence and they do not.
    expect(titles.indexOf("Proven Six")).toBeLessThan(titles.indexOf("Unproven Ten"))
    expect(titles.indexOf("Proven Six")).toBeLessThan(titles.indexOf("Unproven Series Ten"))
    expect(titles).toEqual([
      "Harbour Town",
      "The Cartographer",
      "Proven Six",
      "Unproven Ten",
      "Unproven Series Ten",
      "Matched No Count",
    ])
  })
})

describe("B10 — mood / Quick Pick presets flow through the fixed ranking", () => {
  it("Hidden Gems never leads with a trap (the 7.5 filter passes it, the ranking must not)", () => {
    const ranked = searchDiscover("", CATALOG, coldStart(), { moodId: "hidden-gems" })
    expect(ranked[0].candidate.title).toBe("Harbour Town")
    expect(TRAP_TITLES).not.toContain(ranked[0].candidate.title)
  })

  it("Binge-worthy Series never leads with a trap", () => {
    const ranked = searchDiscover("", CATALOG, coldStart(), { moodId: "binge" })
    expect(ranked.map((r) => r.candidate.title)).toEqual(["Harbour Town", "Unproven Series Ten"])
  })
})

describe("B10 — catalogue mapping carries the evidence the ranking needs", () => {
  it("maps a fixture trap row to no vote count and no TMDb id", () => {
    const trap = catalogRowToCandidate("movie", {
      id: 120,
      name: "Unproven Ten",
      category: "Crime / Mystery",
      rating: "10.0",
      year: "2024",
      tmdb: 0,
      vote_count: 0,
    })
    expect(trap.rating).toBe(10.0)
    expect(trap.voteCount).toBeUndefined()
    expect(trap.tmdbId).toBeUndefined()
  })

  it("maps a vote-backed row with its count and TMDb id intact", () => {
    const proven = catalogRowToCandidate("movie", {
      id: 111,
      name: "The Cartographer",
      category: "Drama / Mystery",
      rating: "8.8",
      year: "2021",
      tmdb: 1111,
      vote_count: 15000,
    })
    expect(proven.voteCount).toBe(15000)
    expect(proven.tmdbId).toBe(1111)
  })
})
