// Discover seam integration tests (coordinator).
// Verifies the W1 engine reads the W3 followed-series provider through the
// registry — the exact path DiscoverView wires at mount — without importing
// the followed module itself. Synthetic fixtures only.
import { describe, it, expect, afterEach } from "vitest"
import {
  getDiscoverRows,
  registerFollowedProvider,
  type DiscoverCandidate,
} from "../src/scripts/lib/discover"
import { emptyTasteModel } from "../src/scripts/lib/taste"

afterEach(() => {
  registerFollowedProvider(null)
})

function candidate(partial: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

const base = {
  candidates: [
    candidate({ id: "1", title: "Space Heist", genres: ["Sci-Fi"], cast: ["Ada Star"], rating: 8.5, year: 2024 }),
    candidate({ id: "2", title: "Quiet Drama", genres: ["Drama"], cast: [], rating: 7.9, year: 2023 }),
  ],
  taste: emptyTasteModel("shared", "pl1"),
  continueWatching: [],
  recentlyAdded: [],
  nowPlaying: [],
  watchedKeys: new Set<string>(),
  excludeWatched: true,
}

const PROVIDER_EPISODES = [
  { seriesId: "19", seriesTitle: "Epic Binge", season: 2, episode: 3, episodeTitle: "The Return", detectedAt: new Date().toISOString(), watched: false },
  { seriesId: "19", seriesTitle: "Epic Binge", season: 2, episode: 2, detectedAt: new Date().toISOString(), watched: true },
]

describe("followed-provider seam", () => {
  it("renders the New Episodes row from the registered provider", () => {
    registerFollowedProvider({ getNewEpisodes: () => [...PROVIDER_EPISODES] })
    const rows = getDiscoverRows(base)
    const row = rows.find((r) => r.id === "new-episodes")
    expect(row).toBeDefined()
    // Only the unwatched episode surfaces.
    expect(row?.items).toHaveLength(1)
    expect(row?.items[0].reason).toMatch(/S2 E3/)
    expect(row?.items[0].candidate.title).toBe("Epic Binge")
  })

  it("hides the New Episodes row when the provider is unregistered", () => {
    registerFollowedProvider({ getNewEpisodes: () => [...PROVIDER_EPISODES] })
    registerFollowedProvider(null)
    const rows = getDiscoverRows(base)
    expect(rows.map((r) => r.id)).not.toContain("new-episodes")
  })

  it("explicit followedEpisodes input takes precedence over the provider", () => {
    registerFollowedProvider({ getNewEpisodes: () => [...PROVIDER_EPISODES] })
    const rows = getDiscoverRows({
      ...base,
      followedEpisodes: [
        { seriesId: "7", seriesTitle: "Other Show", season: 1, episode: 1, detectedAt: new Date().toISOString(), watched: false },
      ],
    })
    const row = rows.find((r) => r.id === "new-episodes")
    expect(row?.items).toHaveLength(1)
    expect(row?.items[0].candidate.title).toBe("Other Show")
  })
})
