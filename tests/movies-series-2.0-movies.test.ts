/**
 * @vitest-environment jsdom
 */
// Movies & Series 2.0 (0.11.8, W5) acceptance tests 1–10: MOVIES.
//
// Deterministic, hermetic: seeded fixtures + the contract stubs in
// tests/movies-series-2.0-stubs.ts (deleted at integration; these
// tests then run against the real W1/W2/W3 modules). No network, no
// provider calls, no real catalogue. Every assertion is written
// against the frozen contract — see tests/movies-series-2.0-contract-map.md.

import { describe, it, expect, beforeEach } from "vitest"
import { parseRuntimeMinutes } from "@/scripts/lib/browse-filters.ts"
import {
  applyFilters,
  activeFilterSummary,
  createBrowseState,
  deriveBrowsePage,
  genresForEntry,
  getCatalogIndex,
  groupEntries,
  mountHomeShelves,
  normaliseRating,
  searchCatalogIndex,
  selectFeaturedFilm,
  selectRecentlyAdded,
  selectContinueWatching,
  selectHomeShelves,
  selectWorthWatching,
  type CatalogEntry,
  type CatalogIndex,
  type EntryProgress,
} from "./movies-series-2.0-stubs.ts"
import {
  adversarialFixture,
  generateCatalogue,
  generateEntryProgress,
} from "./fixtures-0118-catalogue.ts"

let revisionCounter = 1000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex(kind, entries, revisionCounter)
}

beforeEach(() => {
  document.body.innerHTML = ""
})

const ADV = adversarialFixture()
const ADV_IDS = (entries: CatalogEntry[]): number[] => entries.map((e) => e.id)

describe("0.11.8 movies acceptance (tests 1–10)", { timeout: 120000 }, () => {
  it("1. Home never mounts the full catalogue grid", () => {
    const catalogue = generateCatalogue({ seed: 0x1001, movieCount: 5000, seriesCount: 0 })
    expect(catalogue.movies.length).toBeGreaterThan(5000) // variants on top
    const index = freshIndex("vod", catalogue.movies)
    const shelves = selectHomeShelves(index, {
      progress: generateEntryProgress(catalogue.movies),
    })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const home = mountHomeShelves(container, shelves)
    // Bounded: shelves + genre tiles only — orders of magnitude below
    // the catalogue, and no browse grid element exists anywhere.
    expect(home.getMountedCardCount()).toBe(
      shelves.totalCards - shelves.genreTiles.length
    )
    expect(home.getMountedCardCount()).toBeLessThan(100)
    expect(home.getMountedCardCount()).toBeLessThan(catalogue.movies.length)
    expect(container.querySelector("[data-browse-grid]")).toBeNull()
    expect(container.querySelectorAll("[data-browse-card]").length).toBe(0)
    // The shelf bound is structural, not coincidental: the count is
    // exactly the composed shelf sizes.
    const counts = home.getShelfCounts()
    const shelfTotal =
      (counts["featured"] ?? 0) +
      (counts["continue-watching"] ?? 0) +
      (counts["worth-watching"] ?? 0) +
      (counts["recently-added"] ?? 0) +
      (counts["hidden-gems"] ?? 0)
    expect(shelfTotal).toBe(home.getMountedCardCount())
    home.unmount()
  })

  it("2. Continue Watching excludes completed and untouched films", () => {
    const index = freshIndex("vod", ADV.movies)
    const progress = new Map<number, EntryProgress>([
      [7001, { position: 1800, duration: 5400, completed: false, updatedAt: 100 }],
      [7002, { position: 5400, duration: 5400, completed: true, updatedAt: 200 }],
      [7003, { position: 12, duration: 5400, completed: false, updatedAt: 300 }],
      [7004, { position: 5400, duration: 5400, completed: false, updatedAt: 400 }],
      [7005, { position: 900, duration: 5400, completed: false, updatedAt: 500 }],
      // 7010: untouched — no progress row at all.
    ])
    const result = selectContinueWatching(index, { progress })
    expect(ADV_IDS(result)).toEqual([7005, 7001]) // most-recently-touched first
    expect(ADV_IDS(result)).not.toContain(7002) // completed
    expect(ADV_IDS(result)).not.toContain(7003) // barely started (<=30s)
    expect(ADV_IDS(result)).not.toContain(7004) // played to the end
    expect(ADV_IDS(result)).not.toContain(7010) // untouched
    // No progress at all → empty shelf, never the whole catalogue.
    expect(selectContinueWatching(index, {})).toEqual([])
    expect(selectContinueWatching(index)).toEqual([])
  })

  it("3. Worth Watching is not simply the first 12 rating-8 titles", () => {
    const index = freshIndex("vod", ADV.movies)
    const result = selectWorthWatching(index)
    // Every entry qualifies on evidence.
    for (const entry of result) {
      const rating = normaliseRating(entry)
      expect(rating.hasEvidence).toBe(true)
      expect(rating.value as number).toBeGreaterThanOrEqual(8)
    }
    // Highest-rated first: the 9.7 posterless film leads, not the
    // first 8.x title in catalogue order.
    expect(result[0].id).toBe(7060)
    expect(result[1].id).toBe(7070) // 5-based 4.5 → 9.0
    // Rating-descending throughout.
    const values = result.map((e) => normaliseRating(e).value as number)
    expect([...values].sort((a, b) => b - a)).toEqual(values)
    // And the order differs from the naive catalogue-order prefix.
    const naivePrefix = ADV.movies
      .filter((e) => {
        const r = normaliseRating(e)
        return r.hasEvidence && (r.value as number) >= 8
      })
      .slice(0, 12)
    expect(ADV_IDS(result)).not.toEqual(ADV_IDS(naivePrefix))

    // Same property on a generated 1k catalogue.
    const catalogue = generateCatalogue({ seed: 0x1003, movieCount: 1000, seriesCount: 0 })
    const big = freshIndex("vod", catalogue.movies)
    const bigResult = selectWorthWatching(big)
    expect(bigResult.length).toBeLessThanOrEqual(12)
    const bigNaive = catalogue.movies
      .filter((e) => {
        const r = normaliseRating(e)
        return r.hasEvidence && (r.value as number) >= 8
      })
      .slice(0, 12)
    expect(ADV_IDS(bigResult)).not.toEqual(ADV_IDS(bigNaive))
  })

  it("4. Recently Added uses the added timestamp, not the release year", () => {
    const index = freshIndex("vod", ADV.movies)
    const result = selectRecentlyAdded(index, { limit: 40 })
    const ids = ADV_IDS(result)
    // 1962 film added yesterday precedes the 2026 film added years ago.
    expect(ids.indexOf(7050)).toBeLessThan(ids.indexOf(7051))
    // Unknown `added` sorts last, never first.
    const unknownPos = ids.indexOf(7095)
    const knownPositions = ids.filter(
      (id) => id !== 7095 && (ADV.movies.find((e) => e.id === id)?.added ?? 0) > 0
    )
    expect(unknownPos).toBeGreaterThan(knownPositions.length - 1)
    // Added-descending for every known-added entry.
    const known = result.filter((e) => e.added > 0)
    const addedValues = known.map((e) => e.added)
    expect([...addedValues].sort((a, b) => b - a)).toEqual(addedValues)

    // Generated catalogue: same invariant, no year leakage.
    const catalogue = generateCatalogue({ seed: 0x1004, movieCount: 1000, seriesCount: 0 })
    const big = freshIndex("vod", catalogue.movies)
    const bigResult = selectRecentlyAdded(big, { limit: 50 })
    const bigKnown = bigResult.filter((e) => e.added > 0)
    const bigAdded = bigKnown.map((e) => e.added)
    expect([...bigAdded].sort((a, b) => b - a)).toEqual(bigAdded)
    const firstUnknown = bigResult.findIndex((e) => e.added <= 0)
    if (firstUnknown >= 0) {
      expect(bigResult.slice(firstUnknown).every((e) => e.added <= 0)).toBe(true)
    }
  })

  it("5. Genre tiles open Browse Everything", () => {
    const index = freshIndex("vod", ADV.movies)
    const shelves = selectHomeShelves(index)
    expect(shelves.genreTiles.map((t) => t.id)).toContain("horror")
    const opened: string[] = []
    const container = document.createElement("div")
    document.body.appendChild(container)
    const home = mountHomeShelves(container, shelves, {
      onGenreTile: (genreId) => opened.push(genreId),
    })
    const horrorTile = container.querySelector<HTMLElement>(
      '[data-genre-tile][data-genre-id="horror"]'
    )
    expect(horrorTile).not.toBeNull()
    horrorTile?.click()
    expect(opened).toEqual(["horror"])
    home.unmount()

    // The tile's destination is Browse Everything filtered to that
    // genre: every matched entry carries the genre, and the pure
    // Horror vehicle is in while the pure Comedy vehicle is out.
    const state = applyFilters(createBrowseState("vod"), { genre: "horror" })
    const derived = deriveBrowsePage(index, state)
    expect(derived.totalGroups).toBeGreaterThan(0)
    for (const group of derived.matchedGroups) {
      for (const variant of group.variants) {
        expect(genresForEntry(variant, index)).toContain("horror")
      }
    }
    const matchedIds = derived.matchedGroups.flatMap((g) =>
      g.variants.map((v) => v.id)
    )
    expect(matchedIds).toContain(7091)
    expect(matchedIds).not.toContain(7090)
  })

  it("6. Horror replaces Comedy on selection", () => {
    const index = freshIndex("vod", ADV.movies)
    const comedy = applyFilters(createBrowseState("vod"), { genre: "comedy" })
    const horror = applyFilters(comedy, { genre: "horror" })
    expect(horror.genre).toBe("horror")
    const summary = activeFilterSummary(horror).filter((s) => s.key === "genre")
    expect(summary).toHaveLength(1)
    expect(summary[0].label).toBe("Genre: horror")
    const derived = deriveBrowsePage(index, horror)
    const matchedIds = derived.matchedGroups.flatMap((g) =>
      g.variants.map((v) => v.id)
    )
    expect(matchedIds).toContain(7091) // pure Horror
    expect(matchedIds).not.toContain(7090) // pure Comedy: replaced, not ANDed
    // The input state was not mutated by the transition.
    expect(comedy.genre).toBe("comedy")
  })

  it("7. Rating 8+ with unknown rating does not falsely include titles", () => {
    // Evidence parsing itself: unknown stays unknown.
    expect(normaliseRating({ ratingRaw: "" }).hasEvidence).toBe(false)
    expect(normaliseRating({ ratingRaw: "0" }).hasEvidence).toBe(false)
    expect(normaliseRating({ ratingRaw: "N/A" }).hasEvidence).toBe(false)
    expect(normaliseRating({ ratingRaw: "4.5", ratingScale: 5 }).value).toBe(9)
    expect(normaliseRating({ ratingRaw: "8.5", ratingScale: 10 }).value).toBe(8.5)
    expect(normaliseRating({ ratingRaw: "11" }).hasEvidence).toBe(false)

    const index = freshIndex("vod", ADV.movies)
    const state = applyFilters(createBrowseState("vod"), { minRating: 8 })
    const derived = deriveBrowsePage(index, state)
    const matchedIds = derived.matchedGroups.flatMap((g) =>
      g.variants.map((v) => v.id)
    )
    expect(matchedIds).not.toContain(7030) // unrated
    expect(matchedIds).not.toContain(7031) // "0"
    expect(matchedIds).not.toContain(7032) // "N/A"
    expect(matchedIds).toContain(7003) // 8.9
    expect(matchedIds).toContain(7070) // 5-based 4.5 → 9.0
    for (const group of derived.matchedGroups) {
      for (const variant of group.variants) {
        const r = normaliseRating(variant)
        expect(r.hasEvidence).toBe(true)
        expect(r.value as number).toBeGreaterThanOrEqual(8)
      }
    }
  })

  it("8. Under 120 minutes excludes known longer films", () => {
    const index = freshIndex("vod", ADV.movies)
    const state = applyFilters(createBrowseState("vod"), { maxRuntime: 120 })
    const derived = deriveBrowsePage(index, state)
    const matchedIds = derived.matchedGroups.flatMap((g) =>
      g.variants.map((v) => v.id)
    )
    expect(matchedIds).toContain(7040) // 119 min
    expect(matchedIds).toContain(7041) // exactly 120 min ("02:00:00")
    expect(matchedIds).not.toContain(7042) // 121 min
    expect(matchedIds).not.toContain(7043) // unknown runtime: never assumed short
    for (const group of derived.matchedGroups) {
      for (const variant of group.variants) {
        const mins = parseRuntimeMinutes(variant.durationRaw)
        expect(mins).not.toBeNull()
        expect(mins as number).toBeLessThanOrEqual(120)
      }
    }
    // Boundary sanity on the real parser through the fixture formats.
    expect(parseRuntimeMinutes("119 min")).toBe(119)
    expect(parseRuntimeMinutes("02:00:00")).toBe(120)
    expect(parseRuntimeMinutes("121 min")).toBe(121)
    expect(parseRuntimeMinutes("")).toBeNull()
  })

  it("9. Provider variants group safely", () => {
    const groups = groupEntries(ADV.movies)
    const harbour2022 = groups.filter(
      (g) => g.baseTitle === "harbour lights" && g.year === 2022
    )
    expect(harbour2022).toHaveLength(1)
    expect(harbour2022[0].variants.map((v) => v.id).sort()).toEqual([
      7010, 7011, 7012, 7013, 7014,
    ])
    // The representative carries a poster (7010), not a posterless variant.
    expect(harbour2022[0].representative.poster).not.toBeNull()
    // Same base, different year: a separate group.
    const harbour1998 = groups.filter(
      (g) => g.baseTitle === "harbour lights" && g.year === 1998
    )
    expect(harbour1998).toHaveLength(1)
    expect(harbour1998[0].variants.map((v) => v.id)).toEqual([7015])
    // Same name, different years: never one group.
    const crossings = groups.filter((g) => g.baseTitle === "the crossing")
    expect(crossings).toHaveLength(2)
    // No entry lost, none duplicated.
    const groupedIds = groups.flatMap((g) => g.variants.map((v) => v.id)).sort()
    expect(groupedIds).toEqual(ADV.movies.map((e) => e.id).sort())
    // Movie + series title collision: grouping across kinds never merges.
    const mixed = groupEntries([...ADV.movies, ...ADV.series])
    const mixedCrossings = mixed.filter((g) => g.baseTitle === "the crossing")
    expect(mixedCrossings).toHaveLength(3) // 2 films + 1 series
    expect(new Set(mixedCrossings.map((g) => g.kind)).size).toBe(2)
    for (const group of mixedCrossings) {
      expect(new Set(group.variants.map((v) => v.kind)).size).toBe(1)
    }

    // Generated catalogue: grouping invariants hold at scale.
    const catalogue = generateCatalogue({ seed: 0x1009, movieCount: 2000, seriesCount: 0 })
    const bigGroups = groupEntries(catalogue.movies)
    const seen = new Set<number>()
    for (const group of bigGroups) {
      expect(new Set(group.variants.map((v) => v.kind)).size).toBe(1)
      expect(new Set(group.variants.map((v) => v.baseTitle)).size).toBe(1)
      const knownYears = new Set(
        group.variants.map((v) => v.yearNum).filter((y) => y != null)
      )
      expect(knownYears.size).toBeLessThanOrEqual(1)
      for (const variant of group.variants) {
        expect(seen.has(variant.id)).toBe(false)
        seen.add(variant.id)
      }
    }
    expect(seen.size).toBe(catalogue.movies.length)
  })

  it("10. Search finds an obscure title outside all curated shelves", () => {
    const index = freshIndex("vod", ADV.movies)
    const shelves = selectHomeShelves(index)
    const shelvedIds = new Set<number>([
      ...(shelves.featured ? [shelves.featured.id] : []),
      ...shelves.worthWatching.map((e) => e.id),
      ...shelves.recentlyAdded.map((e) => e.id),
      ...shelves.hiddenGems.map((e) => e.id),
    ])
    // The obscure title is on NO shelf (low rating, old, unremarkable).
    expect(shelvedIds.has(7061)).toBe(false)
    // ...but search finds it, case-insensitively, by partial tokens.
    expect(searchCatalogIndex(index, "quixotic zither", "all").map((e) => e.id)).toEqual([7061])
    expect(searchCatalogIndex(index, "ZITHER", "all").map((e) => e.id)).toEqual([7061])
    expect(searchCatalogIndex(index, "quixotic", "all").map((e) => e.id)).toEqual([7061])
    // Multi-token search: every token must match.
    expect(
      searchCatalogIndex(index, "harbour lights hindi", "all").map((e) => e.id)
    ).toEqual([7013])
    // A query matching nothing returns nothing — never filler.
    expect(searchCatalogIndex(index, "zzzqqq no such film", "all")).toEqual([])
    // Punctuation-prefixed titles are searchable.
    expect(searchCatalogIndex(index, "revolt silent", "all").map((e) => e.id)).toEqual([7001])

    // Featured-film fallback chain (supports test 1's shelf honesty):
    // with a poster + rating available, the featured pick has both.
    const featured = selectFeaturedFilm(index)
    expect(featured).not.toBeNull()
    expect(featured?.poster).not.toBeNull()
    expect(normaliseRating(featured as CatalogEntry).hasEvidence).toBe(true)
  })
})
