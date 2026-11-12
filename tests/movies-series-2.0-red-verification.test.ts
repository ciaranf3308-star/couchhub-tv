/**
 * @vitest-environment jsdom
 */
// RED VERIFICATION (0.11.8, W5): every test group below runs the same
// requirement predicate against a DELIBERATELY-BROKEN stub variant
// (tests/movies-series-2.0-broken.ts) and asserts the requirement is
// VIOLATED. If a green test passed against both the correct stub and
// its broken variant, the green test would be vacuous — this file is
// the proof that it is not. Each `it` names the green test(s) it
// guards. Deleted at integration along with the stubs.

import { describe, it, expect, beforeEach } from "vitest"
import {
  applyFilters,
  createBrowseState,
  deriveBrowsePage,
  getCatalogIndex,
  groupEntries,
  normaliseRating,
  selectContinueWatching,
  selectRecentlyAdded,
  selectWorthWatching,
  type CatalogEntry,
  type CatalogIndex,
  type EntryProgress,
} from "./movies-series-2.0-stubs.ts"
import {
  brokenActivationCountForKeyEvents,
  brokenCloseDrawer,
  brokenContinueWatchingEverything,
  brokenDeriveWithHiddenGenres,
  brokenGroupEntries,
  brokenHomeRendersFullCatalogue,
  brokenNaiveEpisodeDiff,
  brokenOpenDrawer,
  brokenPageCountFor,
  brokenPageSlice,
  brokenRatingPassesUnknown,
  brokenRatingSortUnratedFirst,
  brokenRecentlyAddedByYear,
  brokenResetAllFilters,
  brokenRuntimePassesUnknown,
  brokenSearchIgnoresScope,
  brokenSeasonCount,
  brokenSelectCategoryKeepsPage,
  brokenSelectGenreIntersect,
  brokenStalePaintSequence,
  brokenWorthWatchingFirstTwelve,
} from "./movies-series-2.0-broken.ts"
import {
  adversarialFixture,
  buildChurnScenario,
  generateCatalogue,
} from "./fixtures-0118-catalogue.ts"
import { normalizeSnapshot } from "@/scripts/lib/followed.ts"

const ADV = adversarialFixture()
let revisionCounter = 5000

beforeEach(() => {
  document.body.innerHTML = ""
})

function freshIndex(): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex("vod", ADV.movies, revisionCounter)
}

describe("red verification: broken variants must violate the requirements", { timeout: 120000 }, () => {
  it("RED (tests 6/24): genre-intersecting selection keeps Comedy hidden", () => {
    const index = freshIndex()
    const state = brokenSelectGenreIntersect(
      brokenSelectGenreIntersect(createBrowseState("vod"), "comedy"),
      "horror"
    )
    // The broken derivation ANDs both genres: the pure Horror vehicle
    // (no Comedy evidence) vanishes — the exact 0.11.5 bug.
    const matched = brokenDeriveWithHiddenGenres(index, state)
    expect(matched.map((e) => e.id)).not.toContain(7091)
    // The correct derivation keeps it.
    const correct = deriveBrowsePage(
      index,
      applyFilters(applyFilters(createBrowseState("vod"), { genre: "comedy" }), { genre: "horror" })
    )
    expect(
      correct.matchedGroups.flatMap((g) => g.variants.map((v) => v.id))
    ).toContain(7091)
  })

  it("RED (test 9): grouping that ignores year+kind merges distinct titles", () => {
    const groups = brokenGroupEntries([...ADV.movies, ...ADV.series])
    const crossings = groups.filter((g) => g.baseTitle === "the crossing")
    // Broken: all three Crossings (2 films + 1 series) in ONE group.
    expect(crossings).toHaveLength(1)
    expect(crossings[0].variants.map((v) => v.id).sort()).toEqual([7004, 7005, 7101])
    const harbour = groups.filter((g) => g.baseTitle === "harbour lights")
    expect(harbour).toHaveLength(1) // 1998 swallowed into the 2022 group
    expect(harbour[0].variants.map((v) => v.id)).toContain(7015)
    // Correct grouping keeps them apart (guarded by test 9).
    expect(groupEntries([...ADV.movies, ...ADV.series]).filter((g) => g.baseTitle === "the crossing")).toHaveLength(3)
  })

  it("RED (test 7): rating filter that passes unknowns includes unrated titles", () => {
    const matched = brokenRatingPassesUnknown(ADV.movies, 8)
    expect(matched.map((e) => e.id)).toContain(7030)
    expect(matched.map((e) => e.id)).toContain(7031)
    expect(matched.map((e) => e.id)).toContain(7032)
  })

  it("RED (tests 31/32): pagination that floors the page count drops the last page", () => {
    expect(brokenPageCountFor(121, 60)).toBe(2) // correct: 3
    expect(brokenPageCountFor(61, 60)).toBe(1) // correct: 2
    const items = Array.from({ length: 121 }, (_, i) => i)
    const seen = new Set<number>()
    for (let page = 0; page < brokenPageCountFor(121, 60); page++) {
      for (const item of brokenPageSlice(items, page, 60)) seen.add(item)
    }
    expect(seen.size).toBe(120) // item 120 unreachable
    expect(seen.has(120)).toBe(false)
  })

  it("RED (test 4): Recently Added by release year inverts the fixture", () => {
    const index = freshIndex()
    const broken = brokenRecentlyAddedByYear(index, { limit: 40 })
    const ids = broken.map((e) => e.id)
    // The 2026 film precedes the 1962 film: year order, not added order.
    expect(ids.indexOf(7051)).toBeLessThan(ids.indexOf(7050))
    const correct = selectRecentlyAdded(index, { limit: 40 }).map((e) => e.id)
    expect(correct.indexOf(7050)).toBeLessThan(correct.indexOf(7051))
  })

  it("RED (test 3): Worth Watching as first-12 catalogue order", () => {
    const index = freshIndex()
    const broken = brokenWorthWatchingFirstTwelve(index)
    // The 9.7 film is buried mid-list instead of leading it.
    expect(broken[0].id).toBe(7001)
    expect(broken.map((e) => e.id).indexOf(7060)).toBeGreaterThan(0)
    expect(selectWorthWatching(index)[0].id).toBe(7060)
  })

  it("RED (test 2): Continue Watching that includes completed + untouched", () => {
    const index = freshIndex()
    const progress = new Map<number, EntryProgress>([
      [7001, { position: 1800, duration: 5400, completed: false, updatedAt: 100 }],
      [7002, { position: 5400, duration: 5400, completed: true, updatedAt: 200 }],
      [7003, { position: 12, duration: 5400, completed: false, updatedAt: 300 }],
    ])
    const broken = brokenContinueWatchingEverything(index, { progress })
    expect(broken.map((e) => e.id)).toContain(7002) // completed
    expect(broken.map((e) => e.id)).toContain(7003) // barely started
    expect(broken.map((e) => e.id)).toContain(7010) // untouched filler
    expect(selectContinueWatching(index, { progress }).map((e) => e.id)).toEqual([7001])
  })

  it("RED (test 26): reset that leaves genre + query behind", () => {
    const state = applyFilters(createBrowseState("vod"), { genre: "horror" })
    const withQuery = { ...state, query: "zzz" }
    const reset = brokenResetAllFilters(withQuery)
    expect(reset.genre).toBe("horror")
    expect(reset.query).toBe("zzz")
    const index = freshIndex()
    expect(
      deriveBrowsePage(index, reset).totalEntries
    ).toBeLessThan(ADV.movies.length)
  })

  it("RED (test 27): category change that keeps the old page", () => {
    const state = { ...createBrowseState("vod"), page: 3 }
    expect(brokenSelectCategoryKeepsPage(state, "uncategorised").page).toBe(3)
  })

  it("RED (test 28): scoped search that searches everything", () => {
    const matched = brokenSearchIgnoresScope(ADV.movies, "harbour")
    expect(matched.map((e) => e.id)).toContain(7010)
    // The correct scoped search from Comedy finds nothing (test 28).
  })

  it("RED (test 8): runtime filter that passes unknown runtimes", () => {
    const matched = brokenRuntimePassesUnknown(ADV.movies, 120)
    expect(matched.map((e) => e.id)).toContain(7043)
  })

  it("RED (test 17): fabricated season counts", () => {
    const unknown = ADV.series.find((e) => e.id === 7103)
    expect(unknown?.seasonCount).toBeNull()
    expect(brokenSeasonCount(unknown as CatalogEntry)).toBe(1) // invented "1 season"
  })

  it("RED (test 29): rating sort with unrated titles first", () => {
    const sorted = brokenRatingSortUnratedFirst(ADV.movies)
    expect(normaliseRating(sorted[0]).hasEvidence).toBe(false)
  })

  it("RED (test 14): id-only episode diff flags a remap as new episodes", () => {
    const { baseline, remapped } = buildChurnScenario()
    const base = normalizeSnapshot(baseline)
    const snap = normalizeSnapshot(remapped)
    const naive = brokenNaiveEpisodeDiff(base, snap)
    expect(naive).toHaveLength(10) // ten false "new" episodes
  })

  it("RED (test 1): home mount that renders the full catalogue", () => {
    const catalogue = generateCatalogue({ seed: 0x1101, movieCount: 1000, seriesCount: 0 })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const count = brokenHomeRendersFullCatalogue(container, catalogue.movies)
    expect(count).toBe(catalogue.movies.length)
    expect(count).toBeGreaterThan(1000)
  })

  it("RED (tests 35/36): drawer with no trap and no focus restore", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const card = document.createElement("button")
    card.type = "button"
    card.textContent = "Card"
    container.appendChild(card)
    card.focus()
    const panel = brokenOpenDrawer(container)
    // No trap registered: the panel has no keydown trap behaviour to
    // assert directly, so assert the structural facts the trap
    // requires — the broken drawer records no invoker and restores
    // nothing on close.
    brokenCloseDrawer(panel)
    expect(document.activeElement).toBe(document.body)
    expect(document.activeElement).not.toBe(card)
  })

  it("RED (test 37): activation with no repeat guard re-fires on held keys", () => {
    let count = 0
    const total = brokenActivationCountForKeyEvents(
      [
        { key: "Enter", repeat: false },
        { key: "Enter", repeat: true },
        { key: "Enter", repeat: true },
      ],
      () => {
        count += 1
      }
    )
    expect(total).toBe(3)
    expect(count).toBe(3)
  })

  it("RED (test 39): paint pipeline with no generation guard shows stale results", async () => {
    let shown = ""
    const last = await brokenStalePaintSequence(
      [
        { label: "A-stale", delayMs: 30 },
        { label: "B-current", delayMs: 5 },
      ],
      (label) => {
        shown = label
      }
    )
    // The slow stale paint lands last: the screen shows A, not B.
    expect(shown).toBe("A-stale")
    expect(last).toBe("A-stale")
  })
})
