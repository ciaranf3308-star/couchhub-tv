// Movies & Series 2.0 (0.11.8, W5) acceptance tests 21–30:
// CATEGORIES / FILTERS. Pure state + derivation tests (node env).
// Hermetic: seeded fixtures + contract stubs only.

import { describe, it, expect } from "vitest"
import {
  ALL_CATEGORIES_ID,
  CANONICAL_MOVIE_GENRES,
  UNCATEGORISED_ID,
  activeFilterSummary,
  applyFilters,
  catalogIndexBuildCount,
  createBrowseState,
  deriveBrowsePage,
  genresForEntry,
  getCatalogIndex,
  isDefaultBrowseState,
  normaliseRating,
  resetAllFilters,
  resetCatalogIndexCache,
  runtimeMinutesOf,
  searchCatalogIndex,
  selectCategory,
  setPage,
  setSearch,
  setSort,
  type BrowseState,
  type CatalogEntry,
  type CatalogIndex,
} from "./movies-series-2.0-stubs.ts"
import {
  adversarialFixture,
  generateCatalogue,
  reviseCatalogue,
} from "./fixtures-0118-catalogue.ts"

let revisionCounter = 3000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex(kind, entries, revisionCounter)
}

const ADV = adversarialFixture()

function matchedIds(index: CatalogIndex, state: BrowseState): number[] {
  return deriveBrowsePage(index, state).matchedGroups.flatMap((g) =>
    g.variants.map((v) => v.id)
  )
}

function flattenedEntries(index: CatalogIndex, state: BrowseState): CatalogEntry[] {
  return deriveBrowsePage(index, state).matchedGroups.flatMap((g) => g.variants)
}

describe("0.11.8 categories/filters acceptance (tests 21–30)", { timeout: 120000 }, () => {
  it("21. All populated canonical categories are reachable", () => {
    const catalogue = generateCatalogue({ seed: 0x1021, movieCount: 2000, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    // Every populated canonical genre: selectable, non-empty, and
    // every matched entry genuinely carries the genre.
    for (const genre of CANONICAL_MOVIE_GENRES) {
      const count = index.genreMembers.get(genre)?.length ?? 0
      if (count === 0) continue
      const state = applyFilters(createBrowseState("vod"), { genre })
      const derived = deriveBrowsePage(index, state)
      expect(derived.totalEntries).toBe(count)
      expect(derived.totalGroups).toBeGreaterThan(0)
      for (const entry of flattenedEntries(index, state)) {
        expect(genresForEntry(entry, index)).toContain(genre)
      }
    }
    // Every provider category: selectable, with exact member counts.
    let categoryTotal = 0
    for (const category of index.categories) {
      const state = selectCategory(createBrowseState("vod"), category.id)
      const derived = deriveBrowsePage(index, state)
      expect(derived.totalEntries).toBe(category.count)
      categoryTotal += category.count
    }
    expect(categoryTotal).toBe(index.entries.length)
    // Index caching: same revision → same object; new revision → rebuild.
    resetCatalogIndexCache()
    const before = catalogIndexBuildCount()
    const first = getCatalogIndex("vod", catalogue.movies, 4242)
    const second = getCatalogIndex("vod", catalogue.movies, 4242)
    expect(second).toBe(first)
    expect(catalogIndexBuildCount()).toBe(before + 1)
    const rebuilt = getCatalogIndex("vod", catalogue.movies, 4243)
    expect(rebuilt).not.toBe(first)
    expect(catalogIndexBuildCount()).toBe(before + 2)
    // A provider revision that renames a category: the new name is
    // reachable, the old name is gone (no stale phantom category).
    const revised = reviseCatalogue(catalogue)
    const revisedIndex = getCatalogIndex("vod", revised.movies, 4244)
    expect(
      revisedIndex.categories.some((c) => c.rawName === "Movies | Action & Adventure")
    ).toBe(true)
    expect(
      revisedIndex.categories.some((c) => c.rawName === "Movies | Action")
    ).toBe(false)
  })

  it("22. Provider categories are accessible", () => {
    const index = freshIndex("vod", ADV.movies)
    // Duplicate display labels stay DISTINCT categories.
    const actionCats = index.categories.filter((c) =>
      c.rawName.toLowerCase().replace(/[^a-z]/g, "") === "moviesaction"
    )
    expect(actionCats.length).toBeGreaterThanOrEqual(2)
    const ids = new Set(actionCats.map((c) => c.id))
    expect(ids.size).toBe(actionCats.length)
    // Each duplicate-label category has its own members; selecting one
    // never leaks the other's titles.
    const seen = new Map<string, number[]>()
    for (const category of actionCats) {
      const idsForCat = matchedIds(index, selectCategory(createBrowseState("vod"), category.id))
      expect(idsForCat.length).toBe(category.count)
      seen.set(category.id, idsForCat)
    }
    const allMembers = [...seen.values()].flat()
    expect(new Set(allMembers).size).toBe(allMembers.length)
    // The "Movies|Action" member (7081) is reachable only via its own category.
    const pipeCat = index.categories.find((c) => c.rawName === "Movies|Action")
    expect(pipeCat).toBeDefined()
    expect(matchedIds(index, selectCategory(createBrowseState("vod"), pipeCat?.id as string))).toContain(7081)
    const spacedCat = index.categories.find((c) => c.rawName === "Movies | Action")
    expect(
      matchedIds(index, selectCategory(createBrowseState("vod"), spacedCat?.id as string))
    ).not.toContain(7081)
    // "All" reaches everything, including uncategorised titles.
    const all = matchedIds(index, createBrowseState("vod"))
    expect(all.length).toBe(ADV.movies.length)
    expect(all).toContain(7080)
  })

  it("23. Uncategorised titles are reachable", () => {
    const index = freshIndex("vod", ADV.movies)
    const unc = index.categories.find((c) => c.id === UNCATEGORISED_ID)
    expect(unc).toBeDefined()
    expect(unc?.label).toBe("Uncategorised")
    const state = selectCategory(createBrowseState("vod"), UNCATEGORISED_ID)
    const derived = deriveBrowsePage(index, state)
    expect(derived.totalEntries).toBeGreaterThan(0)
    for (const entry of flattenedEntries(index, state)) {
      expect(entry.categoryName).toBe("")
    }
    expect(matchedIds(index, state)).toContain(7080)
    // Search scoped to Uncategorised works too.
    expect(
      searchCatalogIndex(index, "nowhere", { categoryId: UNCATEGORISED_ID }).map((e) => e.id)
    ).toEqual([7080])
    // With no uncategorised entries, no phantom category appears.
    const categorisedOnly = ADV.movies.filter((e) => e.categoryName !== "")
    const clean = freshIndex("vod", categorisedOnly)
    expect(clean.categories.some((c) => c.id === UNCATEGORISED_ID)).toBe(false)
    expect(
      deriveBrowsePage(clean, selectCategory(createBrowseState("vod"), UNCATEGORISED_ID)).totalEntries
    ).toBe(0)
  })

  it("24. Genre replace semantics", () => {
    const index = freshIndex("vod", ADV.movies)
    const base = createBrowseState("vod")
    // History independence: A→B→C equals a fresh state with C.
    const viaHistory = applyFilters(
      applyFilters(applyFilters(base, { genre: "comedy" }), { genre: "horror" }),
      { genre: "drama" }
    )
    const direct = applyFilters(base, { genre: "drama" })
    expect(viaHistory).toEqual(direct)
    expect(viaHistory.genre).toBe("drama")
    // Exactly one genre constraint is ever visible.
    expect(activeFilterSummary(viaHistory).filter((s) => s.key === "genre")).toHaveLength(1)
    // Derivation equality: history leaves no residue.
    expect(matchedIds(index, viaHistory)).toEqual(matchedIds(index, direct))
    // Clearing with "" removes the constraint entirely.
    const cleared = applyFilters(viaHistory, { genre: "" })
    expect(cleared.genre).toBe("")
    expect(activeFilterSummary(cleared).some((s) => s.key === "genre")).toBe(false)
    expect(matchedIds(index, cleared).length).toBe(ADV.movies.length)
    // Re-applying the same genre is idempotent.
    const twice = applyFilters(applyFilters(base, { genre: "horror" }), { genre: "horror" })
    expect(twice).toEqual(applyFilters(base, { genre: "horror" }))
  })

  it("25. Multi-filter intersections are visible and intentional", () => {
    const index = freshIndex("vod", ADV.movies)
    const comedyCat = index.categories.find((c) => c.rawName === "Movies | Comedy")
    expect(comedyCat).toBeDefined()
    let state = selectCategory(createBrowseState("vod"), comedyCat?.id as string)
    state = applyFilters(state, {
      genre: "comedy",
      minRating: 7,
      maxRuntime: 120,
      decade: "2020s",
    })
    const summary = activeFilterSummary(state)
    expect(summary.map((s) => s.key).sort()).toEqual([
      "category",
      "decade",
      "genre",
      "maxRuntime",
      "minRating",
    ])
    const entries = flattenedEntries(index, state)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.categoryName).toBe("Movies | Comedy")
      expect(genresForEntry(entry, index)).toContain("comedy")
      expect(normaliseRating(entry).value as number).toBeGreaterThanOrEqual(7)
      expect(runtimeMinutesOf(entry) as number).toBeLessThanOrEqual(120)
      expect(entry.yearNum as number).toBeGreaterThanOrEqual(2020)
    }
    expect(matchedIds(index, state)).toContain(7040)
    expect(matchedIds(index, state)).toContain(7090)
    expect(matchedIds(index, state)).not.toContain(7042) // 121 min
    // Removing ONE constraint widens exactly along that axis.
    const withoutRuntime = applyFilters(state, { maxRuntime: 0 })
    expect(matchedIds(index, withoutRuntime)).toContain(7042)
    expect(activeFilterSummary(withoutRuntime).some((s) => s.key === "maxRuntime")).toBe(false)
    expect(activeFilterSummary(withoutRuntime).some((s) => s.key === "minRating")).toBe(true)
  })

  it("26. Reset All removes hidden constraints", () => {
    const index = freshIndex("vod", ADV.movies)
    let state = selectCategory(createBrowseState("vod"), UNCATEGORISED_ID)
    state = applyFilters(state, {
      genre: "horror",
      minRating: 8,
      maxRuntime: 90,
      decade: "2010s",
      hideWatched: true,
      sort: "rating",
      query: "zzz",
      searchScope: "category",
    })
    state = setPage(state, 3, 1000)
    expect(isDefaultBrowseState(state)).toBe(false)
    expect(activeFilterSummary(state).length).toBeGreaterThan(0)
    const reset = resetAllFilters(state)
    expect(isDefaultBrowseState(reset)).toBe(true)
    expect(reset.page).toBe(0)
    expect(activeFilterSummary(reset)).toEqual([])
    expect(reset.categoryId).toBe(ALL_CATEGORIES_ID)
    expect(reset.query).toBe("")
    expect(reset.searchScope).toBe("all")
    expect(reset.sort).toBe("default")
    const derived = deriveBrowsePage(index, reset)
    expect(derived.totalEntries).toBe(ADV.movies.length)
    expect(derived.page).toBe(0)
    // The pre-reset state object is untouched (pure transition).
    expect(state.genre).toBe("horror")
    expect(state.query).toBe("zzz")
  })

  it("27. Category change resets pagination", () => {
    const index = freshIndex("vod", ADV.movies)
    const total = deriveBrowsePage(index, createBrowseState("vod")).totalGroups
    const onPage3 = setPage(createBrowseState("vod", { pageSize: 5 }), 3, total)
    expect(onPage3.page).toBe(3)
    const switched = selectCategory(onPage3, UNCATEGORISED_ID)
    expect(switched.page).toBe(0)
    // Filter/search/sort changes reset pagination too.
    expect(applyFilters(onPage3, { genre: "drama" }).page).toBe(0)
    expect(setSearch(onPage3, "harbour").page).toBe(0)
    expect(setSort(onPage3, "rating").page).toBe(0)
    // But a category change preserves the OTHER visible filters.
    const filtered = applyFilters(onPage3, { genre: "comedy", minRating: 7 })
    const reswitched = selectCategory(filtered, UNCATEGORISED_ID)
    expect(reswitched.genre).toBe("comedy")
    expect(reswitched.minRating).toBe(7)
    expect(reswitched.page).toBe(0)
  })

  it("28. Search All vs Search Current Category is explicit", () => {
    const index = freshIndex("vod", ADV.movies)
    const comedyCat = index.categories.find((c) => c.rawName === "Movies | Comedy")
    const base = selectCategory(createBrowseState("vod"), comedyCat?.id as string)
    // "harbour" titles live in Action, not Comedy.
    const scoped = setSearch(base, "harbour", "category")
    expect(deriveBrowsePage(index, scoped).totalEntries).toBe(0)
    const all = setSearch(base, "harbour", "all")
    const allIds = matchedIds(index, all)
    expect(allIds.length).toBeGreaterThan(0)
    expect(allIds).toContain(7010)
    // The summary names the scope: the user can SEE which search ran.
    expect(activeFilterSummary(scoped).find((s) => s.key === "query")?.label).toBe(
      'Search in current category: "harbour"'
    )
    expect(activeFilterSummary(all).find((s) => s.key === "query")?.label).toBe(
      'Search all: "harbour"'
    )
    // The index-level search honours scope identically.
    expect(
      searchCatalogIndex(index, "harbour", { categoryId: comedyCat?.id as string })
    ).toEqual([])
    expect(searchCatalogIndex(index, "harbour", "all").length).toBeGreaterThan(0)
    // A query inside the current category still finds its own titles.
    const own = setSearch(base, "comedy vehicle", "category")
    expect(matchedIds(index, own)).toContain(7090)
  })

  it("29. Sort order is correct", () => {
    const catalogue = generateCatalogue({ seed: 0x1029, movieCount: 1500, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    const base = createBrowseState("vod")
    // Browse pages over GROUPS, so sort order is asserted over group
    // order: the first variant of each group is the group's
    // highest-ranked member in the sort, and the first-variant
    // sequence must satisfy the sort invariant. (Flattened variants
    // need not: variants of one title legitimately carry different
    // added timestamps, and grouping pulls them together.)
    const check = (sort: BrowseState["sort"], invariant: (firsts: CatalogEntry[]) => void) => {
      const derived = deriveBrowsePage(index, setSort(base, sort))
      expect(derived.totalEntries).toBe(catalogue.movies.length)
      const firsts = derived.matchedGroups.map((g) => g.variants[0])
      invariant(firsts)
      // Deterministic: deriving twice yields the identical group order.
      const again = deriveBrowsePage(index, setSort(base, sort))
      expect(again.matchedGroups.map((g) => g.key)).toEqual(
        derived.matchedGroups.map((g) => g.key)
      )
    }
    check("added", (entries) => {
      const known = entries.filter((e) => e.added > 0)
      const added = known.map((e) => e.added)
      expect([...added].sort((a, b) => b - a)).toEqual(added)
      const firstUnknown = entries.findIndex((e) => e.added <= 0)
      if (firstUnknown >= 0) {
        expect(entries.slice(firstUnknown).every((e) => e.added <= 0)).toBe(true)
      }
    })
    check("rating", (entries) => {
      const rated = entries.filter((e) => normaliseRating(e).hasEvidence)
      const values = rated.map((e) => normaliseRating(e).value as number)
      expect([...values].sort((a, b) => b - a)).toEqual(values)
      const firstUnrated = entries.findIndex((e) => !normaliseRating(e).hasEvidence)
      if (firstUnrated >= 0) {
        expect(entries.slice(firstUnrated).every((e) => !normaliseRating(e).hasEvidence)).toBe(true)
      }
    })
    check("year-desc", (entries) => {
      const known = entries.filter((e) => e.yearNum != null)
      const years = known.map((e) => e.yearNum as number)
      expect([...years].sort((a, b) => b - a)).toEqual(years)
      const firstUnknown = entries.findIndex((e) => e.yearNum == null)
      if (firstUnknown >= 0) {
        expect(entries.slice(firstUnknown).every((e) => e.yearNum == null)).toBe(true)
      }
    })
    check("year-asc", (entries) => {
      const known = entries.filter((e) => e.yearNum != null)
      const years = known.map((e) => e.yearNum as number)
      expect([...years].sort((a, b) => a - b)).toEqual(years)
    })
    check("az", (entries) => {
      const titles = entries.map((e) => e.displayTitle)
      const sorted = [...titles].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
      expect(titles).toEqual(sorted)
    })
    check("runtime-asc", (entries) => {
      const known = entries.filter((e) => runtimeMinutesOf(e) != null)
      const runtimes = known.map((e) => runtimeMinutesOf(e) as number)
      expect([...runtimes].sort((a, b) => a - b)).toEqual(runtimes)
      const firstUnknown = entries.findIndex((e) => runtimeMinutesOf(e) == null)
      if (firstUnknown >= 0) {
        expect(entries.slice(firstUnknown).every((e) => runtimeMinutesOf(e) == null)).toBe(true)
      }
    })
    check("runtime-desc", (entries) => {
      const known = entries.filter((e) => runtimeMinutesOf(e) != null)
      const runtimes = known.map((e) => runtimeMinutesOf(e) as number)
      expect([...runtimes].sort((a, b) => b - a)).toEqual(runtimes)
    })
    check("default", (entries) => {
      // Catalogue order preserved: first variants appear in catalogue
      // position order.
      const positions = entries.map((e) =>
        catalogue.movies.findIndex((m) => m.id === e.id)
      )
      const sorted = [...positions].sort((a, b) => a - b)
      expect(positions).toEqual(sorted)
    })
  })

  it("30. Missing metadata produces no fictional filter results", () => {
    // A genre-less entry: no TMDb ids, no genre string, no category.
    const template = ADV.movies.find((e) => e.id === 7080) as CatalogEntry
    const genreLess: CatalogEntry = {
      ...template,
      id: 7999,
      name: "Genreless Drifter",
      displayTitle: "Genreless Drifter",
      baseTitle: "genreless drifter",
      categoryId: null,
      categoryName: "",
      tmdbGenreIds: [],
      genreString: "",
      year: "",
      yearNum: null,
      ratingRaw: "",
      durationRaw: "",
      added: 0,
    }
    expect(genresForEntry(genreLess)).toEqual([])
    const index = freshIndex("vod", [...ADV.movies, genreLess])
    // No genre filter may claim it.
    for (const genre of CANONICAL_MOVIE_GENRES) {
      const state = applyFilters(createBrowseState("vod"), { genre })
      expect(matchedIds(index, state)).not.toContain(7999)
    }
    // No rating/runtime/decade filter may claim it.
    expect(
      matchedIds(index, applyFilters(createBrowseState("vod"), { minRating: 6 }))
    ).not.toContain(7999)
    expect(
      matchedIds(index, applyFilters(createBrowseState("vod"), { maxRuntime: 180 }))
    ).not.toContain(7999)
    expect(
      matchedIds(index, applyFilters(createBrowseState("vod"), { decade: "2020s" }))
    ).not.toContain(7999)
    // But it is NOT hidden from browsing: All + Uncategorised reach it.
    expect(matchedIds(index, createBrowseState("vod"))).toContain(7999)
    expect(
      matchedIds(index, selectCategory(createBrowseState("vod"), UNCATEGORISED_ID))
    ).toContain(7999)
    // An unknown category id matches nothing — never a silent fallback to All.
    expect(
      deriveBrowsePage(index, selectCategory(createBrowseState("vod"), "cat:no-such-category")).totalEntries
    ).toBe(0)
    // An empty query restricts nothing.
    expect(matchedIds(index, setSearch(createBrowseState("vod"), "")).length).toBe(
      ADV.movies.length + 1
    )
  })
})
