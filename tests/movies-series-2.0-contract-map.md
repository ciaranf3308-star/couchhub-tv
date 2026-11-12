# Movies & Series 2.0 (0.11.8) — W5 Contract Map

> INTEGRATION NOTE (2026-11-12): the swap this map describes is DONE.
> The stub module, the broken-variants module, and the red-verification
> test file were deleted at integration; all 40 acceptance tests now
> run against the real W1/W2/W3/W4 modules. The 15 pinned contract
> decisions below were each resolved deliberately against the real
> modules — see `docs/validation-0118.md` for the resolution record.
> This map is kept as W5-branch provenance; its file references to the
> deleted stub modules are historical.

How integration swaps the W5 test stubs for the real W1–W4 modules and
re-runs the acceptance suite. Read this before touching any file in
this set.

## The deal

The acceptance tests import the contract APIs from exactly ONE place:

- `tests/movies-series-2.0-stubs.ts` — faithful contract implementations
  (W1 + W2 + home-mount surface). Every export is marked
  `// 0.11.8 TEST STUB` in the file header.
- `tests/movies-series-2.0-broken.ts` — deliberately-broken variants,
  imported ONLY by `tests/movies-series-2.0-red-verification.test.ts`.
- `tests/fixtures-0118-catalogue.ts` — seeded fixtures. KEPT at
  integration (fixtures are test infrastructure, not stubs). It imports
  only the `CatalogEntry`/`EpisodeRef`/`EntryProgress` TYPES plus
  `baseTitleOf` from the stubs file — see "Fixture coupling" below.

Integration steps:

1. Implement (or land) the real modules per the mapping below.
2. Change the imports in the five acceptance test files +
   `tests/bench-0118-harness.ts` from `./movies-series-2.0-stubs.ts`
   to the real modules. Where a real signature differs from the stub
   signature, adapt the CALL SITE in the test — never weaken the
   assertion. Each adaptation must be listed in the integration report
   (same discipline as 0.11.6).
3. Delete `tests/movies-series-2.0-stubs.ts`,
   `tests/movies-series-2.0-broken.ts`, and
   `tests/movies-series-2.0-red-verification.test.ts` (red verification
   is meaningless without the broken variants; the green tests are the
   acceptance proof).
4. Re-run: `pnpm vitest run tests/movies-series-2.0-*.test.ts
   tests/fixtures-0118-determinism.test.ts
   tests/bench-0118-performance.test.ts` — all green required.
5. Re-run the benchmark and REPLACE `tests/bench-0118-baseline.md`
   with production numbers (relabelled — the stub-baseline numbers
   must not survive as production evidence).

## Stub → real-module mapping

W1 (data architecture) — expected location
`src/scripts/movies-series/` (confirm against W1's actual layout;
export NAMES are the contract, paths are the suggestion):

| Stub export | Real owner / notes |
|---|---|
| `CatalogEntry`, `EpisodeRef`, `EntryProgress`, `ProgressMap`, `CatalogKind` | W1 entry model. W1's row type may be richer; tests only need the fields the stub defines. If W1 names the type differently, adapt the fixture builder (see below) — the tests reference the type only through fixtures + selectors. |
| `normaliseKind` | W1 helper (or fold into W1's index builder). Accepts `"movie"` as an alias for `"vod"`; the repo convention is `"vod" \| "series"`. |
| `CANONICAL_MOVIE_GENRES`, `CANONICAL_SERIES_GENRES` | W1 genre system, built on the real `CANONICAL_GENRES` (`src/scripts/lib/genres.ts`). Stub: both are the full 18-id taxonomy (kinds differ in TMDb mapping, not membership). If W1 narrows one list, the tests still hold — they derive expectations from the constants. |
| `UNCATEGORISED_ID` (`"uncategorised"`) | W1. Matches the Live TV `LIVETV_UNCATEGORISED_GROUP_ID` spelling. |
| `ALL_CATEGORIES_ID` (`"all"`), `DEFAULT_PAGE_SIZE` (60), `BROWSE_GRID_COLUMNS` (6) | W2 constants (page size / columns) + W1 category id. If W2 freezes a different page size, update the constant AND the bench bound — the tests read the constant, so only `bench-0118-baseline.md` numbers change. |
| `normaliseRating(entry)` → `{ value, hasEvidence, source }` | W1 rating evidence. Unknown stays unknown; 5-based doubles. |
| `runtimeMinutesOf(entry)` | Thin wrapper over the real `parseRuntimeMinutes` (`browse-filters.ts`). W1 may export its own name; adapt the import. |
| `compareByRatingEvidence(a, b)` | W1 comparator. Total order: rated first, value desc, title A–Z, id. |
| `genresForEntry(entry, index?)` | W1. Union of TMDb ids + genre string + category name, canonical order. The `index` parameter is accepted for signature compatibility and unused. |
| `CatalogCategory`, `CatalogIndex` | W1 index types. |
| `buildCatalogIndex(kind, catalogue, revision)` | W1. One full pass; uncached. |
| `getCatalogIndex(kind, catalogue, revision)` | W1. Cached per (kind, revision); same revision returns the SAME object. Counters: `catalogIndexBuildCount()`, `resetCatalogIndexCounters()`, `resetCatalogIndexCache()`. |
| `searchCatalogIndex(index, query, scope)` | W1. `scope: "all" \| { categoryId: string }`. All-tokens-must-match over the normalised haystack; catalogue order. |
| `stripVariantSuffix`, `baseTitleOf`, `differsOnlyByVariantSuffix` | W1 grouping helpers. The variant-token list is the conservative contract — W1 may extend it ONLY with tokens that can never be real title words (never "Part", never years). |
| `EntryGroup`, `groupEntries(entries, index?)` | W1 safe grouping. Rules in the stub header comment are the contract: same kind + same base title + year rule (both known → equal; either unknown → suffix-only difference). |
| `SelectorOptions`, `selectFeaturedFilm`, `selectWorthWatching`, `selectRecentlyAdded`, `selectHiddenGems`, `selectSeriesWorthStarting`, `selectContinueWatching` | W1 collection selectors. Signatures: `(index, opts?)`. `selectContinueWatching` needs `opts.progress`; `selectHomeShelves` needs `opts.followedIds` for the Followed shelf. Default limits: 12 (20 for Continue Watching). |
| `HomeShelves`, `selectHomeShelves(index, opts?)` | W1 composition consumed by W3/W4 home adapters. Includes `followedSeries` (from `opts.followedIds`) and `genreTiles`. |
| Instrumentation: `getBrowseInstrumentation()`, `resetBrowseInstrumentation()`, `BrowseInstrumentation` | W1/W2 shared counters (brief §15). The real modules must expose equivalent counters or the bench assertions cannot run — this is a HARD integration requirement, not a nice-to-have. Counter semantics: `fullPasses` = full-catalogue passes; `sorts` = full sorts; `groupRuns` = grouping runs; `cacheHits` = memoised derivations; `pageTurns`; `focusMoves` = key-driven focus moves. |

W2 (Browse Everything engine) — expected location
`src/scripts/movies-series/browse/` (confirm against W2's layout):

| Stub export | Real owner / notes |
|---|---|
| `BrowseState`, `BrowseFilterPatch` | W2 state shape. Single `genre` string (replace semantics); `searchScope: "all" \| "category"`. |
| `createBrowseState(kind, opts?)` | W2. |
| `isDefaultBrowseState(state)` | W2 helper. |
| `selectCategory(state, categoryId)` | W2. Replaces category, resets page, preserves other filters. |
| `applyFilters(state, patch)` | W2. Every field REPLACES; resets page. No toggle-on-reselect (explicit `""` clears; the drawer control may toggle at the UI layer). |
| `resetAllFilters(state)` | W2. Fresh default, same pageSize. |
| `activeFilterSummary(state)` | W2. Every active constraint visible; empty ⟺ default. Label strings are the stub's; W2 may reword labels, but the KEYS (`category`, `genre`, `query`, `minRating`, `maxRuntime`, `decade`, `hideWatched`, `sort`) and the empty⟺default invariant are the contract. Tests assert on keys + two query-scope labels — adapt label assertions if W2 rewords, and record it. |
| `pageCountFor(total, pageSize)`, `setPage(state, page, total)` | W2. Ceil division; clamping, never phantom pages. |
| `setSearch(state, query, scope?)`, `setSort(state, sort)` | W2. Unknown sort ids fall back to `"default"`. |
| `BrowseDerivation`, `deriveBrowsePage(index, state, ctx?)` | W2 engine. Memoised per constraint signature (page excluded); one full pass + one grouping run per NEW constraint set; sort only when `sort !== "default"`. Search scope `"all"` ignores the category constraint for the query; `"category"` honours it. Unknown metadata never matches a filter. Groups ordered by first-variant rank. |
| `BrowseMountOptions`, `BrowseMountHandle`, `mountBrowseEverything(container, opts)` | W2 mount. Renders ONLY the current page; roving tabindex; arrow/Home/End/PageUp/PageDown; ONE activation funnel (keyboard Enter/Space → click, like gamepad A); generation-guarded paints; focus-trapped filter drawer with focus restore; detail open/return with page+card restore; `loader` option must NEVER be called. The handle's method names are the contract for tests 31–40; W2's real mount is a Svelte/Astro component, so integration adapts these tests to drive the real component through an equivalent harness — the ASSERTIONS (card bounds, focus behaviour, no-stale-results, no-double-activation) must survive verbatim. |
| `DrawerHandle` | W2 drawer handle (`element`, `close()`). |
| `HomeMountOptions`, `HomeMountHandle`, `mountHomeShelves(container, shelves, opts?)` | W3/W4 home surface. Renders shelves + genre tiles ONLY. Same adaptation note as the browse mount: W3/W4's real home components need a test harness exposing `getMountedCardCount()`, `getShelfCounts()`, `reRender()`. |
| `BrowseMode`, `ParsedModeUrl`, `parseModeFromUrl(url)`, `setModeInUrl(url, mode, extra?)` | W2 mode/URL contract. Path names the kind; `mode` param names home/browse; mode switches reset the page and preserve category/query. If W2 freezes different param names, adapt the tests + record it — the ROUND-TRIP and preservation invariants are the contract. |

## Real seams already used (no stub — keep as-is)

These tests import production code directly and must keep doing so
after integration:

- `src/scripts/lib/followed.ts` — `createMemoryFollowedStore`,
  `followSeries`, `unfollowSeries`, `listSubscriptions`,
  `normalizeSnapshot`, `diffSnapshots`, `isSaneSnapshot`,
  `FOLLOWED_CHANGED_EVENT` (tests 12–14, 19).
- `src/scripts/series/couch-series.ts` — `groupEpisodesBySeason`,
  `nextEpisode`, `resumeEpisode`, `resumeOrNextEpisode`,
  `selectSeason`, `seriesDetailViewModel`, `seriesDetailMetaLine`
  (tests 11, 16, 17).
- `src/scripts/movies/couch-movies.ts` — `mapMovieRow` (fixtures),
  `RESUME_MIN_SECONDS` (stub, via import).
- `src/scripts/series/couch-series.ts` — `mapSeriesRow` (fixtures).
- `src/scripts/lib/genres.ts` — taxonomy (stub, via import).
- `src/scripts/lib/browse-filters.ts` — `parseYear`,
  `parseRuntimeMinutes`, `decadeKeyForYear` (stub + fixtures + tests).
- `src/scripts/lib/text.ts` — `normalize` (stub, via import).
- `src/scripts/lib/gamepad.ts` — `handleGamepadButtonPress`,
  `dispatchNativeButton` (tests 34, 37, 40).
- `src/scripts/lib/dialog-spatial-nav.ts` — `findOpenModal`,
  `firstFocusableInModal` (test 35).
- `src/scripts/lib/couch-focus.ts` — `recordCouchFocus`,
  `readCouchFocusMemory`, `clearCouchFocusMemory`,
  `restoreCouchFocus`, `findReplacementFocus` (tests 18, 38).

## Fixture coupling

`tests/fixtures-0118-catalogue.ts` builds `CatalogEntry` objects from
the REAL `mapMovieRow`/`mapSeriesRow` output plus contract
enrichments (`baseTitle`, `tmdbGenreIds`, `genreString`, seasons,
episodes, variant signals, `ratingScale`). At integration, EITHER:

- (a) keep the stub's `CatalogEntry` shape as W1's entry type (then
  fixtures are untouched except for the import path), OR
- (b) re-point the fixture builder at W1's real mapping and adapt
  the enrichment fields.

Option (a) is strongly preferred: the fixture builder is the only
place that constructs entries by hand, and the tests never construct
entries except through it (plus one hand-built genre-less entry in
test 30, which spreads a fixture entry).

The `baseTitleOf` import in fixtures is the grouping helper — if W1
puts it elsewhere, update the one import.

## Contract decisions the stub made (W1/W2 to confirm)

Decisions the brief's contract list left silent, resolved in the stub
and pinned by tests. If W1/W2 choose differently, the AFFECTED tests
must be updated deliberately and the change recorded — never silently:

1. **Kind spelling**: `"vod" | "series"` with `"movie"` accepted as an
   alias. Tests use `"vod"`/`"series"`.
2. **Genre taxonomy**: both kinds share the 18-id list; kinds differ
   in TMDb mapping only.
3. **Search scope `"all"` ignores the category constraint** for the
   query (other filters still apply). Test 28 pins this.
4. **Sort is over groups**, ordered by first-variant (highest-ranked
   member) rank. Test 29 pins group-level invariants.
5. **Genre re-selection does NOT toggle off** at the state layer
   (explicit `""` clears). The 0.11.6 `selectGenreFilter` toggles;
   the browse state layer deliberately does not — the drawer offers
   "All genres". Test 24 pins idempotent re-application.
6. **Category change preserves other filters** (genre/rating/etc.)
   and resets only the page. Test 27 pins this.
7. **Sort change resets the page.** Test 27 pins this.
8. **Unknown category id matches nothing** (no silent fallback to
   All). Test 30 pins this.
9. **Featured fallback chain**: poster+rated → rated → poster →
   first-by-added. Test 10 pins the first link only (poster + rated
   when available).
10. **Hidden Gems**: rated 7.5+, rating desc then OLDEST added first,
    featured excluded. Threshold 7.5 / Worth Watching 8 / Worth
    Starting 7 are stub choices — W1 may tune the thresholds, but the
    "rated-only, deterministic, not-the-same-list" invariants stand.
11. **Continue Watching limit 20**, other shelves 12. Limits are stub
    choices; the boundedness invariant (test 1) stands regardless.
12. **URL params**: `mode`, `category`, `page`, `q`; kind from path
    (`/movies`, `/series`) or `?kind=` on `/browse`. Mode switch
    resets the page.
13. **5-based ratings**: `ratingScale` preserved from the provider
    field (`rating_5based`). The base mappers conflate the scale into
    one string — W1 must preserve scale evidence or 5-based 4.5s will
    read as 4.5/10. Test 7 pins the doubling.
14. **Grouping unknown-year rule**: either year unknown → merge only
    on suffix-only name difference. Test 9 pins this.
15. **Drawer controls**: genre/rating/runtime selects + Reset + Done.
    The trap/restore behaviour is the contract; control widgets may
    differ in the real drawer.

## Flags for integration / PC checks (not hermetically testable)

- **Real provider catalogue**: all tests run on fixtures. The PC
  check must open Browse Everything against the real Xtream catalogue
  and confirm: every provider category reachable, uncategorised
  present when applicable, no title missing vs the provider list
  count, and grouping does not merge visibly distinct titles.
- **Physical controller**: tests 34/37/40 drive the real gamepad
  pipeline synthetically in jsdom. The PC check must confirm with a
  real Xbox controller: A activates once, B backs out of detail to
  the same card, D-pad moves never lose focus, drawer trap holds.
- **Real XInput**: `dispatchNativeButton` is exercised with synthetic
  calls; the native Rust → JS path needs the PC.
- **EPG / Live TV**: untouched by this work; no regressions expected,
  but the full suite (`pnpm vitest run`) must stay green at
  integration — these files add no production code, so any failure
  is an integration issue, not a W5 one.
- **Performance on the UM790 Pro**: stub-baseline numbers are
  headless jsdom on a VM. The PC check is the only performance
  evidence that counts; re-run the bench harness on the merged tree
  and record production numbers before claiming anything.
- **TMDB enrichment**: the stub treats `tmdbGenreIds` as fixture
  input. Whether W1 populates them from TMDB detail fetches (and the
  request discipline for that) is W1's call — the genre tests only
  require that SOME evidence source feeds `genresForEntry`.
- **Image requests**: the bench counts poster `<img>` elements, not
  network requests. The PC/network check must confirm no poster
  fetching happens for unmounted cards (virtualisation) and no
  duplicate fetches per card.
