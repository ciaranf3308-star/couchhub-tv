/**
 * @vitest-environment jsdom
 */
// Movies & Series 2.0 (0.11.8) acceptance tests 1–10: MOVIES.
//
// Adapted at integration from the W5 stub contract to the REAL W1/W2/W3
// modules (see tests/movies-series-2.0-contract-map.md + the
// integration adaptations recorded in docs/validation-0118.md).
// Deterministic, hermetic: seeded fixtures, no network, no provider
// calls. Every adaptation is marked ADAPTED with the reason and the
// requirement it preserves.
//
// Key contract resolutions in this file:
// - Selectors return SelectorResult objects (ids via selectorIds),
//   resolved to rows through index.byId — never bare entry arrays.
// - Ratings: W1 normaliseRating returns RatingEvidence | null
//   (score10), never a {hasEvidence, value} pair; unknowns are null.
// - Recently Added EXCLUDES unknown-added titles (W1 strictness),
//   where the stub sorted them last.
// - Worth Watching has NO rating floor and NO rating-descending
//   order: brief §3.4 forbids the rating-8+ shortcut, so the stub's
//   ≥8/rating-order assertions were replaced with boundedness,
//   determinism, differs-from-naive-prefix, and diversity checks.
// - Runtime uses W2 buckets: "under-120" is strictly < 120, so the
//   exactly-120 film is excluded (honest "Under 120" reading).
// - Search is RANKED retrieval over display groups, not token-AND
//   filtering: assertions pin rank/presence, not exact result sets.
// - Grouping is W1 TitleGroup: variantIds are strings, primary first,
//   kind-partitioned; the representative is primaryId via byId.

import { describe, it, expect, beforeEach } from "vitest"
import { parseRuntimeMinutes } from "@/scripts/lib/browse-filters.ts"
import {
  getCatalogIndex,
  searchCatalogIndex,
  type CatalogIndex,
} from "@/scripts/lib/catalog-index.ts"
import {
  selectFeaturedFilm,
  selectRecentlyAdded,
  selectContinueWatching,
  selectWorthWatching,
  selectorIds,
} from "@/scripts/lib/collection-selectors.ts"
import { genresForEntry, genreLabelForId } from "@/scripts/lib/genres.ts"
import { groupEntries } from "@/scripts/lib/language-groups.ts"
import { normaliseRating } from "@/scripts/lib/rating-evidence.ts"
import { emptyTasteModel } from "@/scripts/lib/taste.ts"
import {
  applyFilters,
  activeFilterSummary,
  createBrowseState,
} from "@/scripts/lib/browse-state.ts"
import {
  deriveBrowseGroups,
  type BrowseDeriveContext,
} from "@/scripts/lib/browse-everything.ts"
import {
  buildMoviesHomeModel,
  selectContinueWatchingMovies,
} from "@/scripts/movies/movies-home.ts"
import { paintMoviesHome } from "@/scripts/movies/movies-home-mount.ts"
import {
  adversarialFixture,
  generateCatalogue,
  generateEntryProgress,
  type CatalogEntry,
  type EntryProgress,
} from "./fixtures-0118-catalogue.ts"

const TASTE = emptyTasteModel("acceptance", "acceptance-playlist")

let revisionCounter = 1000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  // A fresh array identity per index: the W1 cache keys on array
  // identity + revision, and these tests must never share an index
  // across cases (D26/D36).
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

/** DOM mirroring the home root in src/pages/movies/index.astro. */
function buildHomeDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="movies-home-root">
      <header class="mh-header">
        <p class="rs-meta"><span id="movies-home-count">Loading…</span></p>
      </header>
      <div id="movies-home-skeleton"><div>loading</div></div>
      <div id="movies-home-nolist" hidden><h2>No playlist yet</h2></div>
      <div id="movies-home-empty" hidden><h2>No movies yet</h2></div>
      <div id="movies-home-error" hidden role="alert">
        <p id="movies-home-error-message"></p>
        <button id="movies-home-retry" type="button">Try again</button>
      </div>
      <div id="movies-home-featured"></div>
      <div id="movies-home-continue"></div>
      <div id="movies-home-worth"></div>
      <div id="movies-home-recent"></div>
      <div id="movies-home-genres"></div>
      <section id="movies-home-browse-entry" hidden>
        <a href="/movies?view=browse"><span>Browse Everything</span>
        <span id="movies-home-browse-count"></span></a>
      </section>
    </div>`
  return document.getElementById("movies-home-root") as HTMLElement
}

beforeEach(() => {
  document.body.innerHTML = ""
})

const ADV = adversarialFixture()

describe("0.11.8 movies acceptance (tests 1–10)", { timeout: 120000 }, () => {
  it("1. Home never mounts the full catalogue grid", () => {
    const catalogue = generateCatalogue({ seed: 0x1001, movieCount: 5000, seriesCount: 0 })
    expect(catalogue.movies.length).toBeGreaterThan(5000) // variants on top
    const model = buildMoviesHomeModel({
      rows: catalogue.movies,
      playlistId: "acceptance-playlist",
      taste: TASTE,
      progressById: generateEntryProgress(catalogue.movies),
    })
    const root = buildHomeDom()
    paintMoviesHome(root, model)
    // Bounded: shelves only — orders of magnitude below the
    // catalogue, and no Browse Everything mount exists anywhere.
    // ADAPTED: the stub's mountHomeShelves/getMountedCardCount API is
    // gone; the real paint emits .rs-card elements, counted in the
    // DOM. The hidden-gems shelf does not exist on Movies Home
    // (brief §3 has none — Hidden Gems is a §5.2 collection), so it
    // drops out of the shelf sum deliberately.
    const cards = root.querySelectorAll(".rs-card")
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.length).toBeLessThan(100)
    expect(cards.length).toBeLessThan(catalogue.movies.length)
    expect(root.querySelector("[data-browse-everything]")).toBeNull()
    expect(root.querySelectorAll("[data-browse-key]").length).toBe(0)
    // The bound is structural: every card lives in a shelf mount,
    // and the genre tiles are tiles, not cards.
    const shelfCards =
      root.querySelectorAll("#movies-home-featured .rs-card").length +
      root.querySelectorAll("#movies-home-continue .rs-card").length +
      root.querySelectorAll("#movies-home-worth .rs-card").length +
      root.querySelectorAll("#movies-home-recent .rs-card").length
    expect(shelfCards).toBe(cards.length)
    expect(root.querySelectorAll("#movies-home-genres .rs-card").length).toBe(0)
    expect(root.querySelectorAll(".mh-genre-tile").length).toBeGreaterThan(0)
  })

  it("2. Continue Watching excludes completed and untouched films", () => {
    // ADAPTED: the 30s resume rule lives in the Home composition
    // (selectContinueWatchingMovies), not in the raw W1 selector —
    // the requirement is preserved at the seam that owns it, and the
    // W1 selector's own contract (fraction in (0,1), no 30s rule)
    // is asserted separately below.
    const progress = new Map<number, EntryProgress>([
      [7001, { position: 1800, duration: 5400, completed: false, updatedAt: 100 }],
      [7002, { position: 5400, duration: 5400, completed: true, updatedAt: 200 }],
      [7003, { position: 12, duration: 5400, completed: false, updatedAt: 300 }],
      [7004, { position: 5400, duration: 5400, completed: false, updatedAt: 400 }],
      [7005, { position: 900, duration: 5400, completed: false, updatedAt: 500 }],
      // 7010: untouched — no progress row at all.
    ])
    const items = selectContinueWatchingMovies(ADV.movies, progress)
    expect(items.map((i) => i.row.id)).toEqual([7005, 7001]) // most-recently-touched first
    expect(items.map((i) => i.row.id)).not.toContain(7002) // completed
    expect(items.map((i) => i.row.id)).not.toContain(7003) // barely started (<=30s)
    expect(items.map((i) => i.row.id)).not.toContain(7004) // played to the end
    expect(items.map((i) => i.row.id)).not.toContain(7010) // untouched
    // No progress at all → empty shelf, never the whole catalogue.
    expect(selectContinueWatchingMovies(ADV.movies, new Map())).toEqual([])

    // W1 selector: excludes completed/untouched/finished, but has NO
    // 30s threshold — the barely-started row IS returned here (the
    // Home composition above is what filters it).
    const index = freshIndex("vod", ADV.movies)
    const inputs = [...progress.entries()].map(([id, p]) => ({
      kind: "vod" as const,
      id,
      position: p.position,
      duration: p.duration,
      completed: p.completed,
      updatedAt: p.updatedAt,
    }))
    const selected = selectorIds(
      selectContinueWatching(index, TASTE, 12, { progressEntries: inputs })
    )
    expect(selected).toContain("7005")
    expect(selected).toContain("7001")
    expect(selected).toContain("7003") // no 30s rule at this seam
    expect(selected).not.toContain("7002")
    expect(selected).not.toContain("7004")
    expect(selected).not.toContain("7010")
    expect(selectContinueWatching(index, TASTE, 12, {})).toEqual([])
  })

  it("3. Worth Watching is not simply the first 12 rating-8 titles", () => {
    // ADAPTED: the stub asserted a ≥8 floor + rating-descending
    // order, which IS the rating-8+ shortcut brief §3.4 forbids.
    // The real shelf is composite-scored (quality + taste +
    // diversity) with no rating floor. What is preserved: bounded,
    // deterministic, evidence-preferred, diverse, and different
    // from the naive prefix.
    const index = freshIndex("vod", ADV.movies)
    const result = selectWorthWatching(index, TASTE, 12)
    expect(result.length).toBeLessThanOrEqual(12)
    expect(result.length).toBeGreaterThan(0)
    // Deterministic: a fresh index over the same rows selects identically.
    const again = selectWorthWatching(freshIndex("vod", ADV.movies), TASTE, 12)
    expect(selectorIds(again)).toEqual(selectorIds(result))
    // Evidence-preferred: the shelf is not all-unknown, and the top
    // pick carries rating evidence.
    const evidences = selectorIds(result).map((id) =>
      normaliseRating(index.byId.get(id) as CatalogEntry)
    )
    expect(evidences.some((e) => e != null && e.score10 >= 8)).toBe(true)
    expect(evidences[0]).not.toBeNull()
    // Diverse: the shelf spans more than one genre family.
    const shelfGenres = new Set(
      selectorIds(result).flatMap((id) =>
        genresForEntry(index.byId.get(id) as CatalogEntry, "vod")
      )
    )
    expect(shelfGenres.size).toBeGreaterThan(1)
    // And the order differs from the naive catalogue-order prefix.
    const naivePrefix = ADV.movies
      .filter((e) => {
        const r = normaliseRating(e)
        return r != null && r.score10 >= 8
      })
      .slice(0, 12)
    expect(selectorIds(result)).not.toEqual(naivePrefix.map((e) => String(e.id)))
    // And from the naive rating-descending order.
    const ratingDesc = [...ADV.movies]
      .filter((e) => normaliseRating(e) != null)
      .sort((a, b) => (normaliseRating(b)?.score10 ?? 0) - (normaliseRating(a)?.score10 ?? 0))
      .slice(0, result.length)
    expect(selectorIds(result)).not.toEqual(ratingDesc.map((e) => String(e.id)))

    // Same property on a generated 1k catalogue.
    const catalogue = generateCatalogue({ seed: 0x1003, movieCount: 1000, seriesCount: 0 })
    const big = freshIndex("vod", catalogue.movies)
    const bigResult = selectWorthWatching(big, TASTE, 12)
    expect(bigResult.length).toBeLessThanOrEqual(12)
    const bigNaive = catalogue.movies
      .filter((e) => {
        const r = normaliseRating(e)
        return r != null && r.score10 >= 8
      })
      .slice(0, 12)
    expect(selectorIds(bigResult)).not.toEqual(bigNaive.map((e) => String(e.id)))
  })

  it("4. Recently Added uses the added timestamp, not the release year", () => {
    const index = freshIndex("vod", ADV.movies)
    // ADAPTED: W1 EXCLUDES unknown-added titles (strict), where the
    // stub sorted them last. The requirement — unknown-added never
    // presented as recent — is preserved more strongly.
    const result = selectRecentlyAdded(index, 40, null, { cacheKey: "t4" })
    const ids = selectorIds(result)
    // 1962 film added yesterday precedes the 2026 film added years ago.
    expect(ids.indexOf("7050")).toBeLessThan(ids.indexOf("7051"))
    // Unknown `added` is absent, never first.
    expect(ids).not.toContain("7095")
    // Added-descending for every returned entry (group aggregate =
    // max member added).
    const addedValues = ids.map((id) => index.meta.get(id)?.addedMs as number)
    expect(addedValues.every((v) => v != null && v > 0)).toBe(true)
    expect([...addedValues].sort((a, b) => b - a)).toEqual(addedValues)

    // Generated catalogue: same invariant, no year leakage.
    const catalogue = generateCatalogue({ seed: 0x1004, movieCount: 1000, seriesCount: 0 })
    const big = freshIndex("vod", catalogue.movies)
    const bigResult = selectRecentlyAdded(big, 50, null, { cacheKey: "t4-big" })
    const bigAdded = selectorIds(bigResult).map(
      (id) => big.meta.get(id)?.addedMs as number
    )
    expect(bigAdded.every((v) => v != null && v > 0)).toBe(true)
    expect([...bigAdded].sort((a, b) => b - a)).toEqual(bigAdded)
  })

  it("5. Genre tiles open Browse Everything", () => {
    const index = freshIndex("vod", ADV.movies)
    const model = buildMoviesHomeModel({
      rows: ADV.movies,
      playlistId: "acceptance-playlist",
      taste: TASTE,
      progressById: new Map(),
    })
    expect(model.genres.map((t) => t.id)).toContain("horror")
    const root = buildHomeDom()
    paintMoviesHome(root, model)
    // ADAPTED: tiles are real links to Browse Everything, not
    // callback stubs — assert the link target, not a click handler.
    const horrorTile = root.querySelector<HTMLAnchorElement>(
      '[data-couch-key="movies-genre-horror"]'
    )
    expect(horrorTile).not.toBeNull()
    const url = new URL(horrorTile?.href ?? "", "https://example.invalid")
    expect(url.pathname).toBe("/movies")
    expect(url.searchParams.get("view")).toBe("browse")
    expect(url.searchParams.get("category")).toBe("genre:horror")

    // The tile's destination is Browse Everything filtered to that
    // genre: every matched GROUP carries the genre, and the pure
    // Horror vehicle is in while the pure Comedy vehicle is out.
    // ADAPTED: group-level semantics — the aggregate's genre union,
    // not every variant, carries the genre.
    const state = applyFilters(createBrowseState("movie"), { genre: "horror" })
    const derived = deriveBrowseGroups(index, state, emptyCtx())
    expect(derived.totalGroups).toBeGreaterThan(0)
    for (const group of derived.groups) {
      expect(group.aggregate.genreIds).toContain("horror")
    }
    const matchedIds = derived.groups.map((g) => g.primaryId)
    expect(matchedIds).toContain("7091")
    expect(matchedIds).not.toContain("7090")
  })

  it("6. Horror replaces Comedy on selection", () => {
    const index = freshIndex("vod", ADV.movies)
    const comedy = applyFilters(createBrowseState("movie"), { genre: "comedy" })
    const horror = applyFilters(comedy, { genre: "horror" })
    expect(horror.filters.genre).toBe("horror")
    // ADAPTED: the summary is a STRING in W2, not FilterSummaryItem[];
    // the mount passes label resolvers, so the test does too.
    const summary = activeFilterSummary(horror, {
      genreLabel: (id) => genreLabelForId(id, "vod"),
    })
    expect(summary).toContain("Horror")
    expect(summary).not.toContain("Comedy")
    expect(summary.match(/Horror/g)?.length).toBe(1)
    const derived = deriveBrowseGroups(index, horror, emptyCtx())
    const matchedIds = derived.groups.map((g) => g.primaryId)
    expect(matchedIds).toContain("7091") // pure Horror
    expect(matchedIds).not.toContain("7090") // pure Comedy: replaced, not ANDed
    // The input state was not mutated by the transition.
    expect(comedy.filters.genre).toBe("comedy")
  })

  it("7. Rating 8+ with unknown rating does not falsely include titles", () => {
    // Evidence parsing itself: unknown stays unknown.
    // ADAPTED: W1 normaliseRating reads {rating, ratingScale, ...}
    // and returns RatingEvidence | null (score10), never
    // {hasEvidence, value}.
    expect(normaliseRating({ rating: "" })).toBeNull()
    expect(normaliseRating({ rating: "0" })).toBeNull()
    expect(normaliseRating({ rating: "N/A" })).toBeNull()
    expect(normaliseRating({ rating: "4.5", ratingScale: 5 })?.score10).toBe(9)
    expect(normaliseRating({ rating: "8.5", ratingScale: 10 })?.score10).toBe(8.5)
    expect(normaliseRating({ rating: "11" })).toBeNull()

    const index = freshIndex("vod", ADV.movies)
    const state = applyFilters(createBrowseState("movie"), { minRating: 8 })
    const derived = deriveBrowseGroups(index, state, emptyCtx())
    const matchedIds = derived.groups.map((g) => g.primaryId)
    expect(matchedIds).not.toContain("7030") // unrated
    expect(matchedIds).not.toContain("7031") // "0"
    expect(matchedIds).not.toContain("7032") // "N/A"
    expect(matchedIds).toContain("7003") // 8.9
    expect(matchedIds).toContain("7070") // 5-based 4.5 → 9.0
    // ADAPTED: group-level — the aggregate (best-member) evidence
    // passes the minimum; an unrated variant inside a passing group
    // (e.g. 7012 in the Harbour group) does not fail it.
    for (const group of derived.groups) {
      expect(group.aggregate.rating).not.toBeNull()
      expect(group.aggregate.rating?.score10 as number).toBeGreaterThanOrEqual(8)
    }
  })

  it("8. Under 120 minutes excludes known longer films", () => {
    const index = freshIndex("vod", ADV.movies)
    // ADAPTED: W2 buckets — "under-120" is strictly < 120, so the
    // exactly-120 film is EXCLUDED here (honest "Under 120"
    // reading), where the stub's <=120 included it. It appears
    // under "under-150" instead.
    const state = applyFilters(createBrowseState("movie"), { runtime: "under-120" })
    const derived = deriveBrowseGroups(index, state, emptyCtx())
    const matchedIds = derived.groups.map((g) => g.primaryId)
    expect(matchedIds).toContain("7040") // 119 min
    expect(matchedIds).not.toContain("7041") // exactly 120 min: not under 120
    expect(matchedIds).not.toContain("7042") // 121 min
    expect(matchedIds).not.toContain("7043") // unknown runtime: never assumed short
    for (const group of derived.groups) {
      expect(group.aggregate.runtimeMinutes).not.toBeNull()
      expect(group.aggregate.runtimeMinutes as number).toBeLessThan(120)
    }
    const wider = applyFilters(createBrowseState("movie"), { runtime: "under-150" })
    const widerDerived = deriveBrowseGroups(index, wider, emptyCtx())
    expect(widerDerived.groups.map((g) => g.primaryId)).toContain("7041")
    // Boundary sanity on the real parser through the fixture formats.
    expect(parseRuntimeMinutes("119 min")).toBe(119)
    expect(parseRuntimeMinutes("02:00:00")).toBe(120)
    expect(parseRuntimeMinutes("121 min")).toBe(121)
    expect(parseRuntimeMinutes("")).toBeNull()
  })

  it("9. Provider variants group safely", () => {
    // ADAPTED: W1 TitleGroup — variantIds are strings, primary
    // first; the representative is primaryId resolved through byId.
    const groups = groupEntries(ADV.movies)
    const byId = new Map(ADV.movies.map((e) => [String(e.id), e]))
    const harbour2022 = groups.filter((g) => g.variantIds.includes("7010"))
    expect(harbour2022).toHaveLength(1)
    expect([...harbour2022[0].variantIds].sort()).toEqual([
      "7010", "7011", "7012", "7013", "7014",
    ])
    // The representative carries a poster (7010), not a posterless variant.
    expect(byId.get(harbour2022[0].primaryId)?.poster).not.toBeNull()
    expect(harbour2022[0].year).toBe(2022)
    // Same base, different year: a separate group.
    const harbour1998 = groups.filter((g) => g.variantIds.includes("7015"))
    expect(harbour1998).toHaveLength(1)
    expect(harbour1998[0].variantIds).toEqual(["7015"])
    // Same name, different years: never one group.
    const crossings = groups.filter(
      (g) => g.variantIds.includes("7004") || g.variantIds.includes("7005")
    )
    expect(crossings).toHaveLength(2)
    // No entry lost, none duplicated.
    const groupedIds = groups.flatMap((g) => g.variantIds).sort()
    expect(groupedIds).toEqual(ADV.movies.map((e) => String(e.id)).sort())
    // Movie + series title collision: grouping across kinds never merges.
    const mixed = groupEntries([...ADV.movies, ...ADV.series])
    const mixedCrossings = mixed.filter(
      (g) =>
        g.variantIds.includes("7004") ||
        g.variantIds.includes("7005") ||
        g.variantIds.includes("7101")
    )
    expect(mixedCrossings).toHaveLength(3) // 2 films + 1 series
    expect(new Set(mixedCrossings.map((g) => g.kind)).size).toBe(2)
    for (const group of mixedCrossings) {
      expect(new Set(group.variantIds.map((id) => byId.get(id)?.kind ?? "series")).size).toBe(1)
    }

    // Generated catalogue: grouping invariants hold at scale.
    const catalogue = generateCatalogue({ seed: 0x1009, movieCount: 2000, seriesCount: 0 })
    const bigGroups = groupEntries(catalogue.movies)
    const bigById = new Map(catalogue.movies.map((e) => [String(e.id), e]))
    const seen = new Set<string>()
    for (const group of bigGroups) {
      expect(new Set(group.variantIds.map((id) => bigById.get(id)?.kind)).size).toBe(1)
      expect(new Set(group.variantIds.map((id) => bigById.get(id)?.baseTitle)).size).toBe(1)
      const knownYears = new Set(
        group.variantIds
          .map((id) => bigById.get(id)?.yearNum)
          .filter((y) => y != null)
      )
      expect(knownYears.size).toBeLessThanOrEqual(1)
      for (const id of group.variantIds) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
    expect(seen.size).toBe(catalogue.movies.length)
  })

  it("10. Search finds an obscure title outside all curated shelves", () => {
    const index = freshIndex("vod", ADV.movies)
    // ADAPTED: on the 30-title adversarial catalogue the real Home
    // legitimately extends Recently Added to fill the shelf (§3.5
    // extend behaviour), so "on no shelf" is asserted against a
    // 1k catalogue where curation is genuinely selective — with the
    // obscure title appended last, so it cannot win a score tie.
    const big = generateCatalogue({ seed: 0x100a, movieCount: 1000, seriesCount: 0 })
    const obscure = ADV.movies.find((e) => e.id === 7061) as CatalogEntry
    const model = buildMoviesHomeModel({
      rows: [...big.movies, obscure],
      playlistId: "acceptance-playlist",
      taste: TASTE,
      progressById: new Map(),
    })
    const shelvedIds = new Set<number>([
      ...(model.featured ? [model.featured.row.id] : []),
      ...model.worthWatching.items.map((r) => r.id),
      ...model.recentlyAdded.items.map((r) => r.id),
    ])
    // The obscure title is on NO shelf (low rating, old, unremarkable).
    expect(shelvedIds.has(7061)).toBe(false)
    // ...but search finds it, case-insensitively, by partial tokens.
    // ADAPTED: W1 search returns ranked group-primary ids (strings),
    // scope null = search all; partial-token matches score > 0, so
    // assertions pin rank/presence, not exact result sets.
    expect(searchCatalogIndex(index, "quixotic zither", null)).toEqual(["7061"])
    expect(searchCatalogIndex(index, "ZITHER", null)).toEqual(["7061"])
    expect(searchCatalogIndex(index, "quixotic", null)).toEqual(["7061"])
    // Multi-token search ranks the full-token group first (not sole
    // result: ranked retrieval, not token-AND filtering).
    const harbour = searchCatalogIndex(index, "harbour lights hindi", null)
    expect(harbour[0]).toBe("7010") // 7013's group, primary 7010
    // A token-disjoint query returns nothing — never filler. The
    // tokens must share NO substring with any fixture title: W1's
    // partial-token fallback legitimately matches shared substrings
    // ("no" matches Nowhere/Unknown/Not), so "zzz-no-such-qqq" is
    // NOT disjoint for this fixture.
    expect(searchCatalogIndex(index, "qxjkv wvbmz", null)).toEqual([])
    // Punctuation-prefixed titles are searchable.
    expect(searchCatalogIndex(index, "revolt silent", null)).toEqual(["7001"])

    // Featured-film fallback chain (supports test 1's shelf honesty):
    // with a poster + rating available, the featured pick has both.
    const featured = selectFeaturedFilm(index, TASTE)
    expect(featured).not.toBeNull()
    const featuredRow = index.byId.get(featured?.id as string) as CatalogEntry
    expect(featuredRow.logo).not.toBeNull()
    expect(normaliseRating(featuredRow)).not.toBeNull()
  })
})
