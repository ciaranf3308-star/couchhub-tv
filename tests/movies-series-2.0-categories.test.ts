// Movies & Series 2.0 (0.11.8) acceptance tests 21–30:
// CATEGORIES / FILTERS. Pure state + derivation tests (node env).
// Adapted at integration from the W5 stub contract to the REAL W1/W2
// modules (see tests/movies-series-2.0-contract-map.md + the
// integration adaptations recorded in docs/validation-0118.md).
// Hermetic: seeded fixtures only.
//
// Key contract resolutions in this file:
// - The index exposes idsByGenre / idsByProviderCategory /
//   allEntryIdsByProviderCategory + providerCategoryInfo — never a
//   `categories` list. Provider keys are `id:<rawId>` (D6) or
//   `label:<normalised>`; labels come from the registry, verbatim.
// - Uncategorised has DUAL semantics (D11): the CATEGORY is groups
//   with no provider-category key on any member; the genre-filter
//   value is "no genre evidence". This file pins the category.
// - Pagination is 1-based in W2 (page 1, not 0); sort ids are
//   `recommended` (not `default`) + `rating`/`added`/etc. Runtime
//   sorts do not exist (D14) and their checks were dropped.
// - The filter summary is a STRING ("Horror · 2010s · Under 2h"),
//   with label resolvers supplied by the caller (as the mount does).
// - W1 search scope is genre-only ({genreId}); category-scoped
//   search lives in derive (intersect with the base set).
// - Index caching is asserted by object identity, not build
//   counters (the stub's counters were stub instrumentation;
//   identity IS the contract; D1 counters cover builds elsewhere).

import { describe, it, expect } from "vitest"
import {
  CANONICAL_MOVIE_GENRES,
  UNCATEGORISED_ID,
  genreLabelForId,
  genresForEntry,
  providerCategoryInfo,
} from "@/scripts/lib/genres.ts"
import {
  getCatalogIndex,
  invalidateCatalogIndex,
  searchCatalogIndex,
  type CatalogIndex,
} from "@/scripts/lib/catalog-index.ts"
import { normaliseRating } from "@/scripts/lib/rating-evidence.ts"
import {
  activeFilterSummary,
  applyFilters,
  browseTotalPages,
  createBrowseState,
  hasActiveBrowseConstraints,
  resetAllFilters,
  selectCategory,
  setPage,
  setSearch,
  setSort,
  type BrowseCategorySelection,
  type BrowseState,
} from "@/scripts/lib/browse-state.ts"
import {
  deriveBrowseGroups,
  type BrowseDeriveContext,
  type BrowseGroup,
} from "@/scripts/lib/browse-everything.ts"
import {
  adversarialFixture,
  generateCatalogue,
  reviseCatalogue,
  type CatalogEntry,
} from "./fixtures-0118-catalogue.ts"

let revisionCounter = 3000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex(kind, [...entries], `acceptance:${revisionCounter}`, {
    playlistId: "acceptance-playlist",
  })
}

function emptyCtx(): BrowseDeriveContext {
  return {
    collection: {
      favouriteIds: new Set(),
      watchLaterIds: new Set(),
      inProgressIds: new Set(),
      watchedIds: new Set(),
      followedIds: new Set(),
      newEpisodeIds: new Set(),
    },
    seasonCounts: new Map(),
  }
}

const ADV = adversarialFixture()

function derive(index: CatalogIndex, state: BrowseState): BrowseGroup[] {
  return deriveBrowseGroups(index, state, emptyCtx()).groups
}

/** Display-level primary ids. */
function matchedIds(index: CatalogIndex, state: BrowseState): string[] {
  return derive(index, state).map((g) => g.primaryId)
}

/** Entry-level ids (every variant of every matched group). */
function flattenedIds(index: CatalogIndex, state: BrowseState): string[] {
  return derive(index, state).flatMap((g) => g.group.variantIds)
}

function allSelection(): BrowseCategorySelection {
  return { kind: "all", id: "all", label: "All Movies" }
}

function uncategorisedSelection(): BrowseCategorySelection {
  return { kind: "uncategorised", id: UNCATEGORISED_ID, label: "Uncategorised" }
}

function providerSelection(index: CatalogIndex, rawLabel: string): BrowseCategorySelection {
  for (const key of index.idsByProviderCategory.keys()) {
    if (providerCategoryInfo(key).rawLabel === rawLabel) {
      return { kind: "provider", id: key, label: rawLabel }
    }
  }
  throw new Error(`no provider category with label ${JSON.stringify(rawLabel)}`)
}

describe("0.11.8 categories/filters acceptance (tests 21–30)", { timeout: 120000 }, () => {
  it("21. All populated canonical categories are reachable", () => {
    const catalogue = generateCatalogue({ seed: 0x1021, movieCount: 2000, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    // Every populated canonical genre: selectable, non-empty, and
    // every matched GROUP genuinely carries the genre (aggregate
    // union — the same source idsByGenre is built from, so the
    // drawer count and the Browse count agree by construction).
    for (const genre of CANONICAL_MOVIE_GENRES) {
      const count = index.idsByGenre.get(genre.id)?.length ?? 0
      if (count === 0) continue
      const state = applyFilters(createBrowseState("movie"), { genre: genre.id })
      const derived = deriveBrowseGroups(index, state, emptyCtx())
      expect(derived.totalGroups).toBe(count)
      expect(derived.totalGroups).toBeGreaterThan(0)
      for (const group of derived.groups) {
        expect(group.aggregate.genreIds).toContain(genre.id)
      }
    }
    // Every provider category: selectable, with exact member counts
    // (entry-level: every variant of every matched group).
    let categoryTotal = 0
    for (const [key, members] of index.allEntryIdsByProviderCategory) {
      const label = providerCategoryInfo(key).rawLabel || key
      const state = selectCategory(createBrowseState("movie"), {
        kind: "provider",
        id: key,
        label,
      })
      const derived = deriveBrowseGroups(index, state, emptyCtx())
      expect(derived.totalEntries).toBe(members.length)
      categoryTotal += members.length
    }
    // Plus the entries with no provider category at all: together
    // they partition the whole catalogue (no entry lost, none double-counted).
    const uncategorisedEntries = catalogue.movies.filter(
      (e) => (index.meta.get(String(e.id))?.providerCategoryKey ?? "") === ""
    ).length
    expect(categoryTotal + uncategorisedEntries).toBe(index.totalEntries)
    // Index caching: same array + revision → same object; a new
    // revision → a rebuild. (Identity IS the contract.)
    invalidateCatalogIndex()
    const first = getCatalogIndex("vod", catalogue.movies, "cache:4242", {
      playlistId: "acceptance-playlist",
    })
    const second = getCatalogIndex("vod", catalogue.movies, "cache:4242", {
      playlistId: "acceptance-playlist",
    })
    expect(second).toBe(first)
    const rebuilt = getCatalogIndex("vod", catalogue.movies, "cache:4243", {
      playlistId: "acceptance-playlist",
    })
    expect(rebuilt).not.toBe(first)
    // A provider revision that renames a category: the new name is
    // reachable, the old name is gone (no stale phantom category).
    const revised = reviseCatalogue(catalogue)
    const revisedIndex = getCatalogIndex("vod", revised.movies, "cache:4244", {
      playlistId: "acceptance-playlist",
    })
    const revisedLabels = [...revisedIndex.idsByProviderCategory.keys()].map(
      (key) => providerCategoryInfo(key).rawLabel
    )
    expect(revisedLabels).toContain("Movies | Action & Adventure")
    expect(revisedLabels).not.toContain("Movies | Action")
  })

  it("22. Provider categories are accessible", () => {
    const index = freshIndex("vod", ADV.movies)
    // Duplicate display labels stay DISTINCT categories.
    const actionKeys = [...index.idsByProviderCategory.keys()].filter(
      (key) =>
        providerCategoryInfo(key).rawLabel.toLowerCase().replace(/[^a-z]/g, "") ===
        "moviesaction"
    )
    expect(actionKeys.length).toBeGreaterThanOrEqual(2)
    expect(new Set(actionKeys).size).toBe(actionKeys.length)
    // Each duplicate-label category has its own members; selecting one
    // never leaks the other's titles.
    const seen = new Map<string, string[]>()
    for (const key of actionKeys) {
      const label = providerCategoryInfo(key).rawLabel
      const idsForCat = flattenedIds(
        index,
        selectCategory(createBrowseState("movie"), { kind: "provider", id: key, label })
      )
      expect(idsForCat.length).toBe(
        index.allEntryIdsByProviderCategory.get(key)?.length
      )
      seen.set(key, idsForCat)
    }
    const allMembers = [...seen.values()].flat()
    expect(new Set(allMembers).size).toBe(allMembers.length)
    // The "Movies|Action" member (7081) is reachable only via its own category.
    const pipe = providerSelection(index, "Movies|Action")
    expect(
      flattenedIds(index, selectCategory(createBrowseState("movie"), pipe))
    ).toContain("7081")
    const spaced = providerSelection(index, "Movies | Action")
    expect(
      flattenedIds(index, selectCategory(createBrowseState("movie"), spaced))
    ).not.toContain("7081")
    // "All" reaches everything, including uncategorised titles.
    const all = flattenedIds(index, createBrowseState("movie"))
    expect(all.length).toBe(ADV.movies.length)
    expect(all).toContain("7080")
  })

  it("23. Uncategorised titles are reachable", () => {
    const index = freshIndex("vod", ADV.movies)
    const state = selectCategory(createBrowseState("movie"), uncategorisedSelection())
    const derived = deriveBrowseGroups(index, state, emptyCtx())
    expect(derived.totalEntries).toBeGreaterThan(0)
    for (const group of derived.groups) {
      for (const row of group.rows) {
        expect(row.category ?? "").toBe("")
      }
    }
    expect(flattenedIds(index, state)).toContain("7080")
    // Search scoped to Uncategorised works too (derive-level: W1
    // search scope is genre-only, category scoping is derive's job).
    const scoped = setSearch(state, "nowhere", "category")
    expect(matchedIds(index, scoped)).toEqual(["7080"])
    // With no uncategorised entries, the category matches nothing —
    // no phantom populated category.
    const categorisedOnly = ADV.movies.filter((e) => e.categoryName !== "")
    const clean = freshIndex("vod", categorisedOnly)
    expect(
      deriveBrowseGroups(
        clean,
        selectCategory(createBrowseState("movie"), uncategorisedSelection()),
        emptyCtx()
      ).totalEntries
    ).toBe(0)
  })

  it("24. Genre replace semantics", () => {
    const index = freshIndex("vod", ADV.movies)
    const base = createBrowseState("movie")
    // History independence: A→B→C equals a fresh state with C.
    const viaHistory = applyFilters(
      applyFilters(applyFilters(base, { genre: "comedy" }), { genre: "horror" }),
      { genre: "drama" }
    )
    const direct = applyFilters(base, { genre: "drama" })
    expect(viaHistory).toEqual(direct)
    expect(viaHistory.filters.genre).toBe("drama")
    // Exactly one genre constraint is ever visible.
    const summary = activeFilterSummary(viaHistory, {
      genreLabel: (id) => genreLabelForId(id, "vod"),
    })
    expect(summary).toBe("Drama")
    // Derivation equality: history leaves no residue.
    expect(matchedIds(index, viaHistory)).toEqual(matchedIds(index, direct))
    // Clearing with "" removes the constraint entirely.
    const cleared = applyFilters(viaHistory, { genre: "" })
    expect(cleared.filters.genre).toBe("")
    expect(activeFilterSummary(cleared)).toBe("")
    expect(flattenedIds(index, cleared).length).toBe(ADV.movies.length)
    // Re-applying the same genre is idempotent.
    const twice = applyFilters(applyFilters(base, { genre: "horror" }), { genre: "horror" })
    expect(twice).toEqual(applyFilters(base, { genre: "horror" }))
  })

  it("25. Multi-filter intersections are visible and intentional", () => {
    const index = freshIndex("vod", ADV.movies)
    const comedyCat = providerSelection(index, "Movies | Comedy")
    let state = selectCategory(createBrowseState("movie"), comedyCat)
    state = applyFilters(state, {
      genre: "comedy",
      minRating: 7,
      runtime: "under-120",
      year: "2020s",
    })
    // EVERY constraint is visible in the one summary string.
    const summary = activeFilterSummary(state, {
      genreLabel: (id) => genreLabelForId(id, "vod"),
    })
    expect(summary).toContain("Movies | Comedy")
    expect(summary).toContain("Comedy")
    expect(summary).toContain("7+ rated")
    expect(summary).toContain("Under 2 hours")
    expect(summary).toContain("2020s")
    const groups = derive(index, state)
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect(group.row.category).toBe("Movies | Comedy")
      expect(group.aggregate.genreIds).toContain("comedy")
      expect(group.aggregate.rating?.score10 as number).toBeGreaterThanOrEqual(7)
      expect(group.aggregate.runtimeMinutes as number).toBeLessThan(120)
      expect(group.aggregate.year as number).toBeGreaterThanOrEqual(2020)
      expect(group.aggregate.year as number).toBeLessThanOrEqual(2029)
    }
    expect(matchedIds(index, state)).toContain("7040")
    expect(matchedIds(index, state)).toContain("7090")
    expect(matchedIds(index, state)).not.toContain("7042") // 121 min
    // Removing ONE constraint widens exactly along that axis.
    const withoutRuntime = applyFilters(state, { runtime: "" })
    expect(matchedIds(index, withoutRuntime)).toContain("7042")
    expect(activeFilterSummary(withoutRuntime)).not.toContain("Under 2 hours")
    expect(activeFilterSummary(withoutRuntime)).toContain("7+ rated")
  })

  it("26. Reset All removes hidden constraints", () => {
    const index = freshIndex("vod", ADV.movies)
    let state = selectCategory(createBrowseState("movie"), uncategorisedSelection())
    state = applyFilters(state, {
      genre: "horror",
      minRating: 8,
      runtime: "under-90",
      year: "2010s",
      watchStatus: "unwatched",
    })
    state = setSort(state, "rating")
    state = setSearch(state, "zzz", "category")
    const totalPages = browseTotalPages(index.totalGroups, state.pageSize)
    state = setPage(state, 3, totalPages)
    expect(hasActiveBrowseConstraints(state)).toBe(true)
    expect(activeFilterSummary(state).length).toBeGreaterThan(0)
    const reset = resetAllFilters(state)
    expect(hasActiveBrowseConstraints(reset)).toBe(false)
    expect(reset.page).toBe(1)
    expect(activeFilterSummary(reset)).toBe("")
    expect(reset.category).toEqual(allSelection())
    expect(reset.search).toBe("")
    expect(reset.searchScope).toBe("all")
    expect(reset.sort).toBe("recommended")
    const derived = deriveBrowseGroups(index, reset, emptyCtx())
    expect(derived.totalEntries).toBe(ADV.movies.length)
    expect(derived.totalGroups).toBe(index.totalGroups)
    // The pre-reset state object is untouched (pure transition).
    expect(state.filters.genre).toBe("horror")
    expect(state.search).toBe("zzz")
  })

  it("27. Category change resets pagination", () => {
    const index = freshIndex("vod", ADV.movies)
    const total = deriveBrowseGroups(index, createBrowseState("movie"), emptyCtx()).totalGroups
    const onPage3 = setPage(
      createBrowseState("movie", { pageSize: 5 }),
      3,
      browseTotalPages(total, 5)
    )
    expect(onPage3.page).toBe(3)
    const switched = selectCategory(onPage3, uncategorisedSelection())
    expect(switched.page).toBe(1)
    // Filter/search/sort changes reset pagination too.
    expect(applyFilters(onPage3, { genre: "drama" }).page).toBe(1)
    expect(setSearch(onPage3, "harbour").page).toBe(1)
    expect(setSort(onPage3, "rating").page).toBe(1)
    // But a category change preserves the OTHER visible filters.
    const filtered = applyFilters(onPage3, { genre: "comedy", minRating: 7 })
    const reswitched = selectCategory(filtered, uncategorisedSelection())
    expect(reswitched.filters.genre).toBe("comedy")
    expect(reswitched.filters.minRating).toBe(7)
    expect(reswitched.page).toBe(1)
  })

  it("28. Search All vs Search Current Category is explicit", () => {
    const index = freshIndex("vod", ADV.movies)
    const comedyCat = providerSelection(index, "Movies | Comedy")
    const base = selectCategory(createBrowseState("movie"), comedyCat)
    // "harbour" titles live in Action, not Comedy.
    const scoped = setSearch(base, "harbour", "category")
    expect(deriveBrowseGroups(index, scoped, emptyCtx()).totalEntries).toBe(0)
    const all = setSearch(base, "harbour", "all")
    const allIds = matchedIds(index, all)
    expect(allIds.length).toBeGreaterThan(0)
    expect(allIds).toContain("7010")
    // The summary names the scope: the user can SEE which search ran.
    expect(activeFilterSummary(scoped)).toContain("“harbour” in this category")
    expect(activeFilterSummary(all)).toContain("“harbour”")
    expect(activeFilterSummary(all)).not.toContain("in this category")
    // The index-level search honours GENRE scope identically (W1
    // scope is genre-only; category scoping is derive's job, above).
    expect(searchCatalogIndex(index, "harbour", { genreId: "comedy" })).toEqual([])
    expect(searchCatalogIndex(index, "harbour", null).length).toBeGreaterThan(0)
    // A query inside the current category still finds its own titles.
    const own = setSearch(base, "comedy vehicle", "category")
    expect(matchedIds(index, own)).toContain("7090")
  })

  it("29. Sort order is correct", () => {
    const catalogue = generateCatalogue({ seed: 0x1029, movieCount: 1500, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    const base = createBrowseState("movie")
    // Browse pages over GROUPS, so sort order is asserted over group
    // order via the group aggregates (the sort keys themselves).
    const check = (
      sort: BrowseState["sort"],
      invariant: (groups: BrowseGroup[]) => void
    ) => {
      const derived = deriveBrowseGroups(index, setSort(base, sort), emptyCtx())
      expect(derived.totalEntries).toBe(catalogue.movies.length)
      invariant(derived.groups)
      // Deterministic: deriving twice yields the identical group order.
      const again = deriveBrowseGroups(index, setSort(base, sort), emptyCtx())
      expect(again.groups.map((g) => g.id)).toEqual(derived.groups.map((g) => g.id))
    }
    check("added", (groups) => {
      const added = groups.map((g) => g.aggregate.addedMs)
      const known = added.filter((v): v is number => v != null)
      expect([...known].sort((a, b) => b - a)).toEqual(known)
      const firstUnknown = added.findIndex((v) => v == null)
      if (firstUnknown >= 0) {
        expect(added.slice(firstUnknown).every((v) => v == null)).toBe(true)
      }
    })
    check("rating", (groups) => {
      // Documented rating order: unrated last; Bayesian desc; votes
      // desc; raw score desc. With no vote counts in fixtures, the
      // Bayesian ties collapse and raw score decides — assert the
      // (bayesian, score10) lexicographic order + nulls last.
      const rated = groups.filter((g) => g.aggregate.rating != null)
      const keys = rated.map(
        (g) => [g.aggregate.bayesian, g.aggregate.rating?.score10 ?? 0] as const
      )
      const sorted = [...keys].sort(
        (a, b) => b[0] - a[0] || b[1] - a[1]
      )
      expect(keys).toEqual(sorted)
      const firstUnrated = groups.findIndex((g) => g.aggregate.rating == null)
      if (firstUnrated >= 0) {
        expect(groups.slice(firstUnrated).every((g) => g.aggregate.rating == null)).toBe(true)
      }
    })
    check("year-desc", (groups) => {
      const years = groups.map((g) => g.aggregate.year)
      const known = years.filter((y): y is number => y != null)
      expect([...known].sort((a, b) => b - a)).toEqual(known)
      const firstUnknown = years.findIndex((y) => y == null)
      if (firstUnknown >= 0) {
        expect(years.slice(firstUnknown).every((y) => y == null)).toBe(true)
      }
    })
    check("year-asc", (groups) => {
      const years = groups.map((g) => g.aggregate.year)
      const known = years.filter((y): y is number => y != null)
      expect([...known].sort((a, b) => a - b)).toEqual(known)
    })
    check("az", (groups) => {
      // D13: code-point order on normalised titles (not localeCompare).
      const titles = groups.map((g) => g.aggregate.normalisedTitle)
      const sorted = [...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      expect(titles).toEqual(sorted)
    })
    check("za", (groups) => {
      const titles = groups.map((g) => g.aggregate.normalisedTitle)
      const sorted = [...titles].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      expect(titles).toEqual(sorted)
    })
    // Runtime sorts do not exist in W2's BrowseSortId and are not in
    // brief §11 — the stub's runtime-asc/runtime-desc checks were
    // dropped deliberately (D14). W1's runtime indexes remain.
    check("recommended", (groups) => {
      // Catalogue order preserved: groups appear in first-appearance
      // order of their members in the input array.
      const position = new Map(catalogue.movies.map((m, i) => [String(m.id), i]))
      const positions = groups.map((g) =>
        Math.min(...g.group.variantIds.map((id) => position.get(id) ?? Infinity))
      )
      const sorted = [...positions].sort((a, b) => a - b)
      expect(positions).toEqual(sorted)
    })
  })

  it("30. Missing metadata produces no fictional filter results", () => {
    // A genre-less entry: no TMDb ids, no genre string, no category,
    // no year, no rating, no runtime, no added date. EVERY W1-visible
    // field is cleared — the template (7080) carries genre + rating
    // evidence that must not leak through.
    const template = ADV.movies.find((e) => e.id === 7080) as CatalogEntry
    const genreLess: CatalogEntry = {
      ...template,
      id: 7999,
      name: "Genreless Drifter",
      displayTitle: "Genreless Drifter",
      baseTitle: "genreless drifter",
      category: "",
      category_id: null,
      categoryId: null,
      categoryName: "",
      tmdbGenreIds: [],
      genre: undefined,
      genreString: "",
      year: "",
      yearNum: null,
      rating: "",
      ratingRaw: "",
      rating_5based: null,
      duration: "",
      durationRaw: "",
      added: 0,
    }
    expect(genresForEntry(genreLess, "vod")).toEqual([])
    expect(normaliseRating(genreLess)).toBeNull()
    const index = freshIndex("vod", [...ADV.movies, genreLess])
    // No genre filter may claim it.
    for (const genre of CANONICAL_MOVIE_GENRES) {
      const state = applyFilters(createBrowseState("movie"), { genre: genre.id })
      expect(matchedIds(index, state)).not.toContain("7999")
    }
    // No rating/runtime/decade filter may claim it.
    expect(
      matchedIds(index, applyFilters(createBrowseState("movie"), { minRating: 6 }))
    ).not.toContain("7999")
    expect(
      matchedIds(index, applyFilters(createBrowseState("movie"), { runtime: "under-180" }))
    ).not.toContain("7999")
    expect(
      matchedIds(index, applyFilters(createBrowseState("movie"), { year: "2020s" }))
    ).not.toContain("7999")
    // But it is NOT hidden from browsing: All + Uncategorised reach it.
    expect(matchedIds(index, createBrowseState("movie"))).toContain("7999")
    expect(
      matchedIds(index, selectCategory(createBrowseState("movie"), uncategorisedSelection()))
    ).toContain("7999")
    // An unknown category id matches nothing — never a silent fallback to All.
    expect(
      deriveBrowseGroups(
        index,
        selectCategory(createBrowseState("movie"), {
          kind: "provider",
          id: "cat:no-such-category",
          label: "No such category",
        }),
        emptyCtx()
      ).totalEntries
    ).toBe(0)
    // An empty query restricts nothing.
    expect(flattenedIds(index, setSearch(createBrowseState("movie"), "")).length).toBe(
      ADV.movies.length + 1
    )
  })
})
