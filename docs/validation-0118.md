# CouchHub TV 0.11.8 — End-Validation Matrix (Movies & Series 2.0)

Blocking deliverable for the 0.11.8 merge. Every numbered brief
requirement maps to its implementing files + commits, its passing
tests (re-run by the integration agent, not accepted on worker
claims), and its screenshot evidence where the requirement is visual.
A row without evidence is NOT done.

- Base: `origin/main` @ `be9e5cb` (0.11.7, Live TV 2.0).
- Integration branch: `movies-0118-integration`.
- Integration commits: merges `9d7639c` (W1) → `3cd9da4` (W2) →
  `eed2707` (W4) → `830e14a` (W3) → `d4d238c` (W5); rewire/fix
  commits `6fc4029`, `23fddde`, `e47566c`, `7500c28`, `d940f16`,
  `24e5932`, `04b33c1`, `82732d8`, `01672a7`, `db47763`, `fca54e5`,
  `81de76c` (screenshot-gate fixes).
- Screenshot harness: `~/workspace/couchhub-tv-0118-integration-scratch/shot-0118.mjs`
  (Playwright + production `dist/` + fixture catalogues via route
  interception; renders in `shots-0118/`). Every render below was
  inspected by the integration agent at 1920×1080.
- Status key: DONE = evidenced. GAP = explicit, with reason +
  follow-up; a GAP blocks the merge unless genuinely unverifiable
  headless AND the hand-back names the exact PC check.

## Gate evidence (all on the shipping commit unless noted)

| Gate | Result |
|---|---|
| (a) Full vitest, twice | Two runs on `81de76c`: 5231/5235 passed (261 files), IDENTICAL in both runs. 4 failures, all stale source-grep convention tests asserting legacy scaffold ids (`couch-browse-runtime`, `couch-browse-reset`, `couch-browse-rails`) that 0.11.8 deliberately deleted with the scaffold — see "Known failures shipped" below. Post-bump re-runs SKIPPED on the user's direct instruction (2026-11-12 19:57). |
| (b) All 40 acceptance tests vs REAL modules | 61/61 green across the 4 acceptance files + bench + determinism (post-deletion run, 2026-11-12) |
| (c) tsc vs 0.11.7 baseline | 0 errors in touched files; remaining errors are a strict subset (56 of 65) of the pre-existing baseline — 9 resolved by build-generated `.astro` types |
| (d) ESLint on touched files | 0 errors, 13 warnings (pre-existing/worker warnings, unchanged) |
| (e) Astro build | Clean, 42 pages |
| (f) Screenshot gate | 21 renders, all inspected; 3 real defects found, fixed, re-verified (D50/D51/D52) |
| (g) Contract audit | Zero shim files tracked; zero imports of deleted shim/stub modules; `SHIM`/`STUB` word hits in src/ are all pre-existing 0.11.7 code in untouched files |
| (h) Benchmarks | Production numbers at 1k/5k/10k/25k/50k recorded in `tests/bench-0118-baseline.md`; bounded-work assertions green |
| (i) Live TV / drawer / grid / Discover regression | 482/482 gamepad+Live TV + 39/39 drawer/grid slices green; full-suite runs re-confirm |
| (j) This matrix | Complete; zero un-evidenced requirements except the GAPs named below |

## §1 Root causes

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 1.1 | One page mixes discovery + browsing — replace the IA | Home/Browse split per type: `src/pages/movies/index.astro`, `src/pages/series/index.astro`, mode routers `src/scripts/movies/couch-index.ts` (`e47566c`), `src/scripts/series/couch-series-home.ts` (`7500c28`) | Test 1 (home never mounts the grid); mode/URL round-trip tests | `01/02` vs `05` (different compositions) | DONE |
| 1.2 | Simplistic shelves (rating-8+ sort) | W1 selectors: quality+taste+diversity in `collection-selectors.ts` (`6fc4029`, `e47566c`, `7500c28`) | Tests 3, 15 | `02` (honest "Popular in Your Library" label) | DONE |
| 1.3 | Catalogue-wide sorting for 8–12 posters | Per-revision cached index + top-K selectors (`catalog-index.ts`, `collection-selectors.ts`) | Bench: 1 build/revision, 6 cache hits; test 20 (one load) | — | DONE |
| 1.4 | replaceChildren grid rebuilds + spatial-nav re-registration | Keyed page grid `couch-grid.ts` (`createKeyedPageGrid`, reuse pool, rAF, focus pin; nodes never re-keyed). `tv/ui/grid.ts` NOT reused directly — patterns ported (W2 decision, recorded) | Test 40 (focus moves, 0 re-derives); mount tests; bench scroll rebuilds 0 | — | DONE |
| 1.5 | Focus/scroll conflicts — 5 operations distinguished | Grid layer routing + `gotoPage` keep-index (D47 fix, `01672a7`), `restoreCouchFocus`, drawer layer routing, `setState` dataset-change semantics (`browse-everything.ts`) | Tests 18, 34, 35, 36, 38, 40 | `16-detail-return` | DONE |
| 1.6 | Duplicates | Safe grouping `language-groups.ts` + D4 suffix strip + D27 merge (`6fc4029`, `23fddde`) | Test 9; D27 merge tests | `05` (Harbour Lights once, "124 versions") | DONE |
| 1.7 | Genre classification — reuse genre-index, no competing classifiers | Shared classifier `genresForEntryWithEvidence` used by index + family index; decision (ii) recorded | Tests 5, 21, 22, 30 | `17-genre-deeplink` | DONE |
| 1.8 | Series metadata — preserve series-seasons protections | Cached-only reader wired into index build; `observeSeasonCount` untouched; key guard in adapter (D29) | Tests 16, 17, 20; adapter key-guard tests | `06` (season counts decorated) | DONE |
| 1.9 | Desktop filter controls → controller-friendly filters | Filter drawer `browse-filter-drawer.ts` (families, L/R values, Apply/Clear All) | Tests 35, 36; drawer tests | `10`, `11` | DONE |
| 1.10 | Recently Added exposes whole library | Curated shelf (cutoff + extend, honest note) vs exhaustive Browse sort `added` (`movies-home.ts`, `series-home-model.ts`) | Test 4; W3/W4 model tests | `02` shelf vs `07` page 2 | DONE |

## §2 Modes

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| §2 | Two explicit modes per type inside existing nav; detail return restores mode/category/page/poster; full catalogue accessible | W2 modes (`home-browse-modes.ts`) + routers; URL carries view/category/page/selected/filters/search/sort; detail return via URL + `restoreCouchFocus` | Tests 18, 34; 8 mode/URL tests | `16-detail-return` (page 2, vod-1084 focused) | DONE |

## §3 Movies Home

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 3.1 | Header: Movies + count, Search Movies + Browse Everything, no dropdowns | `movies/index.astro` + `movies-home-mount.ts` (`e47566c`) | Test 1; W3 render tests | `01` | DONE |
| 3.2 | Featured Film: one real film, stable selection, credible rating, compact fallback, Refresh Picks, no paid LLM | `selectFeaturedFilm` (seeded stable pick, poster-first fallback chain) + `repaintPicks` (focus restore) in `movies-home.ts`/`movies-home-mount.ts`; no AI input field exists on the model | Test 10 (fallback); W3 model/render tests | `01` (Featured + Refresh picks) | DONE |
| 3.3 | Continue Watching: genuinely in-progress only, progress shown, ≤8 + View All, hidden when empty | `selectContinueWatchingMovies` (30s rule, `e47566c`); group-level progress; shelf omitted when empty | Test 2 | `01`/`02` (1 card, "1:30:00 left") | DONE |
| 3.4 | Worth Watching: 8–12, quality+taste+diversity, NOT rating-8+, honest labels, no fresh paid calls | `selectWorthWatching` + `chooseWorthWatchingLabel` (never "AI picks"); local-only, no AI input | Test 3 | `02` ("Popular in Your Library") | DONE |
| 3.5 | Recently Added: added timestamps, deduped, View All → Browse sorted by added, honest cutoffs | `selectRecentlyAdded` + explicit extend behaviour with honest evidence note (decision C); View All URL `sort=added` | Test 4 | `02` | DONE |
| 3.6 | Explore Genres: six + All Genres, real counts, verified art only, opens Browse with genre | `genreTiles` from `idsByGenre` (counts = Browse counts, D22); tiles link `category=genre:<id>`; no artwork (brief-optional) | Test 5 | `02` (Action 11 … All 50) | DONE |
| 3.7 | Browse Everything: prominent, film count, opens browser, no grid below | Browse band in mount; count = `totalGroups`; no grid on Home | Test 1 | `02` ("Browse all 50 films") | DONE |

## §4 Series Home

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 4.1 | Header: Search Series + Browse Everything | `series/index.astro` + controller (`7500c28`) | W4 render tests | `03` | DONE |
| 4.2 | Continue Watching: art/title/last-next/S/E/progress/Continue; never wrong episode; detail fallback; hidden when no history | `buildContinueWatchingItem` 3-path safest-first (`series-home-model.ts`); D51 fraction surfacing (`81de76c`); progress bar via `progressFraction` | Test 11; W4 model tests incl. cold-cache % test | `03` (progress bars; subtitle truncates at card width — full text in DOM) | DONE |
| 4.3 | New Episodes from Followed: EXISTING system only; genuine detections with S/E/title/time/status; never premiere wording; no churn false alerts; compact Followed shelf; never empty "new" row | Read-only consumption of `followed.ts` store/snapshots/notifications; static-guard test kept; `buildNewEpisodeItems`/`buildFollowedShelfItems` | Tests 12, 13, 14, 19 | `03`/`04` (NEW · NOV 11, "detected"), `18` (Followed shelf, no New Episodes row) | DONE |
| 4.4 | Series Worth Starting: 8–12, series-level, verified, no episode records, no season-completeness claims | `selectSeriesWorthStarting` + D28 confirmed-empty exclusion; D16 honest subtitle; no season claims anywhere | Test 15 (D45) | `04` | DONE |
| 4.5 | Recently Added Series: added timestamps | `selectRecentlyAdded` (series index) | W4 assembly tests | `04` | DONE |
| 4.6 | TV-appropriate genre grid | `buildSeriesGenreTiles` over W1's 15 families, counts from `idsByGenre`, art from highest-evidence member | W4 model tests; test 21 (series side) | `04` (ghost-title overlap is a fixture-art artifact) | DONE |
| 4.7 | Browse Everything: home stops, no giant grid | Browse band; no grid on Home | Test 12 render assertions; W4 render tests | `04` ("22 series · search, filters and sorting") | DONE |

## §5 Genre system

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 5.1 | Movies: 18 canonical genres, canonical IDs, "Science Fiction" consistent, non-exclusive, single-genre REPLACES | `CANONICAL_MOVIE_GENRES` (`genres.ts`); `selectCategory` REPLACE; labels from canonical tables (decision i: i18n untouched) | Tests 6, 24; W1 genre tests | `10` (replace note) | DONE |
| 5.2 | Movie collections, only when honestly populatable | Drawer collections: Recently Added, Highest Rated, Unwatched, Continue, Favourites, Watch Later (`browse-category-drawer.ts` stats). Hidden Gems exists as a W1 selector but is NOT exposed as a drawer collection; 90-Minute / Under Two Hours / Modern / Classics have no drawer surface — follow-up, not a silent gap | Tests 21, 27 | `08` (Collections 50) | DONE (partial — see note) |
| 5.3 | Series: 15 families + TMDB TV mappings, combined genres as aliases, never all-Drama from "Series" | `CANONICAL_SERIES_GENRES` + `seriesFamiliesForTmdbIds`/`seriesFamiliesForGenreIds`; kind-only categories yield nothing | W1 genre tests; test 21 | `09` | DONE |
| 5.4 | Series collections | Drawer: Recently Added, Followed, New Episodes, Continue, Unwatched, Highest Rated, Favourites, Watch Later. Limited / Long-Running / Completed correctly OMITTED (no verified metadata — brief's own qualifiers); Worth Starting is a shelf, not a drawer collection | Tests 12, 21 | `09` | DONE (partial — see note) |
| 5.5 | Provider categories preserved: raw ID/label, normalised label, derived genres, provenance/confidence; Provider Categories section; junk aliases mapped, raw retained | `registerProviderCategory`/`providerCategoryInfo`; `idsByProviderCategory` keyed `id:`/`label:`; drawer section with real labels + distinct-group counts | Test 22 (duplicate labels distinct) | `08` (Provider 46) | DONE |
| 5.6 | Metadata priority: validated IDs first, provider fallback, never invent, no sweeps, incremental/bounded/cached | 3-tier `genresForEntryWithEvidence`; cached-only season reader; no full-catalogue sweeps (index built once per revision) | Tests 21, 30; W1 tests | — | DONE |
| 5.7 | Counts = distinct displayed titles; zero-item categories not shown populated; genuine Uncategorised | Counts from `idsByGenre`/view-cache unions (never sums); empty families omitted; Uncategorised = no provider-category key on any member (D11) | Tests 21, 22, 23 | `08` (Uncategorised 4) / `09` (no row — 0 series) | DONE |

## §6 Browse Everything

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 6.1 | First view: title, category/All Titles, count, Search, Categories, Filters, Sort, bounded grid, no toolbar | `mountBrowseEverything` header + keyed grid (`browse-everything.ts`) | Test 20; mount tests | `05`, `06` | DONE |
| 6.2 | Pagination ~30/page (24–36), Prev/Next + page + total + count, first/last + quick-jump, full catalogue reachable | `browsePageInfo`/`browsePageJumpWindow`; viewport-derived pageSize 24–36; pagination controls | Tests 31, 32, 33 | `07` ("Page 2 of 2 · 50 results") | DONE |
| 6.3 | Pagination AND virtualisation: current page + small justified prefetch only | Keyed grid renders active page only; next-page poster prefetch only (bounded, cancelled on destroy); bench cards ≤ pageSize at 50k | Bench bounded-DOM assertions; test 31 | — | DONE |
| 6.4 | All Titles means ALL: no silent exclusions; grouping never hides variants | All base = all views; variant rows reachable via detail; header shows "All titles · N versions"; grouping merge is conservative (D27/D49) | Tests 9, 22, 31 | `05` ("124 versions") | DONE |

## §7 Category drawer

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 7.1 | ONE dedicated drawer, brief structure, only meaningful populated categories | `buildBrowseDrawerFamilies` (All, Genres, Collections, Provider Categories, Uncategorised); empty families omitted; disabled+reason when unavailable | Test 21; drawer tests | `08`, `09` | DONE |
| 7.2 | REPLACE semantics, filters retained only when visible, page-1 reset, visible Reset All | `selectCategory` + `closeOverlay` + header Reset All; summary string shows every constraint | Tests 6, 24, 26, 27 | `08`, `17` | DONE |
| 7.3 | Focus: opens on selected, B subcategory→family→close, restore previous focus, select focuses first result, no focus behind overlays | Reducer initial state + `focusCurrent`; B back-a-level; `closeOverlay` restore; D50 hover guard (`81de76c`); Tab NOT trapped (D38 — controller-arrow containment is the requirement) | Tests 35, 36; hover tests | `08` (focus on All Movies, re-verified post-fix) | DONE |

## §8 Movie filters

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 8.1 | Genre single-select default; advanced multi-select only if clear OR/AND, never default | Single-select only exposed; `genreMode`/`genres` carried for future, no UI | Tests 6, 24 | `10` | DONE |
| 8.2 | Year/decade: Any, 2020s…1960s, Older; release year not upload ts; optional custom range | Decade family + Year range family (cycling values); `aggregate.year` = release year | Test 25 | `10` | DONE |
| 8.3 | Rating: Any/6+/7+/8+/9+, normalised documented scale, no mixed scales, no unverified-as-TMDB, unknowns never pass minimums | `normaliseRating` (5-based explicit field, bare 10-point, null otherwise) + `ratingPassesMinimum`; bare `★ score` badges, no source attribution | Test 7; W1 rating tests | `10` (note text) | DONE |
| 8.4 | Runtime: Any/Under 60/90/120/150/180/180+, verified, explicit unknowns | Runtime buckets, strict `<` / `>180`; unknown excluded when a bucket is set | Test 8 | `10` (note text) | DONE |
| 8.5 | Watch status: All/Unwatched/In Progress/Completed; opening ≠ watched | `groupWatchStatus` (in-progress wins); progress-based, not open-based | Test 25; W1/W2 tests | `10` | DONE |
| 8.6 | Favourites / Watch Later: no conflicting hidden state | Watch sets from preferences, layered separately; visible in summary | Test 25 | `10` | DONE |
| 8.7 | Language: actual data only; original-language ≠ audio-variant | Prefix-tag based only (D15); suffix markers are grouping signals | W1/W2 language tests | `10` (note text) | DONE |
| 8.8 | Provider category: obvious when active, distinct from genre | Provider family + summary label + drawer section; distinct key space (`id:`/`label:`) | Test 25 | `10` | DONE |
| 8.9 | No meaningless availability filter; variants on detail; HD/4K only with reliable metadata | No availability filter; no HD/4K filter (no reliable metadata — omission is compliant); variants via detail page | — (omission verified by code read + drawer renders) | `10` (no such families) | DONE |

## §9 Series filters

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 9.1 | Genre | Series families in filter drawer | W2 filter tests | `11` | DONE |
| 9.2 | First-air year/decade | Decade + year-range families over `aggregate.year` | W2 filter tests | `11` | DONE |
| 9.3 | Rating (same rules as §8.3) | Same W1 evidence pipeline | Test 7 (shared); W1 tests | `11` | DONE |
| 9.4 | Season count: Any/1/2/3+/5+/10+, confirmed only, no catalogue-wide fetches, unknown stays unknown, honest partial coverage | Family gated on confirmed counts; cached-only reader; omitted with honest footnote when no evidence | Tests 16, 17 | `11` (footnote: "No confirmed season counts yet…") | DONE |
| 9.5 | Status: Returning/Ended/Limited only with genuine metadata, else omit | OMITTED — no genuine metadata in mapped rows; footnote states it | — (omission verified by code read) | `11` (footnote) | DONE |
| 9.6 | Progress | Watch-status family (same semantics as §8.5) | W2 filter tests | `11` | DONE |
| 9.7 | Followed | Followed-only family over real subscription store | Test 12; W2 tests | `11` | DONE |
| 9.8 | New Episodes (existing detection) | New-Episodes-only family over unread notification groups (D34) | Tests 13, 14 | `11` | DONE |
| 9.9 | Language / provider (same provenance) | Language family omitted with footnote when no evidence; provider family present | W2 tests | `11` | DONE |

## §10 HARD semantics

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| §10 | Category REPLACES; cross-family combinations allowed with EVERY constraint visible; multi-genre only if clear OR/AND, never default; ONE Reset All → full catalogue; explicit Apply for multi-control drawers; single-category may apply immediately; no hidden constraints | `selectCategory` REPLACE; `activeFilterSummary` string (category + every filter + scope + sort); `resetAllFilters`; filter drawer Apply/Clear All; category drawer applies on select | Tests 6, 24, 25, 26, 36 | `14` ("Horror · "night" in this category"), `15` (Reset All) | DONE |

## §11 Sort

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| §11 | Recommended/Relevance, Recently Added, Year Newest/Oldest, Highest Rated (credible, missing placed), Title A–Z/Z–A; Series + Most Recently Updated (real evidence), Most Seasons (sufficient coverage); search defaults to relevance; reusable sorted ID indexes | `sortedIds` precomputed total orders; `orderBySortedIndex` walks indexes (no per-derive sort); `updated`/`seasons` availability-gated (correctly OFF for mapped rows); search preserves relevance unless re-sorted | Test 29 (D13/D14); W1 sort tests | `12` (movie sort list; updated/seasons correctly absent) | DONE |

## §12 Search

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 12.1 | Full/partial/alternative names, normalised punctuation, provider affixes, original-language titles, year disambiguation, spacing | `searchCatalogIndex` ranked retrieval: exact/prefix/all-token/partial-token tiers, year bonus/disambiguation, title variants incl. raw names | Test 10 | `13` | DONE |
| 12.2 | Scope default full catalogue; VISIBLE Search All vs Search Current Category; never silently retain genre | Scope buttons in search overlay; `resolveSearchScope` degrades to "all" when category is All; summary shows scope | Test 28 | `13`, `14` | DONE |
| 12.3 | Y opens, focus input/OSK, B closes keyboard then layer, cancel preserves position, debounced, no per-character DOM regen | Search layer routing (Escape blurs then cancels); 200ms debounce; derive on debounce, not per keystroke; cancel preserves position via `closeOverlay` | Tests 35, 36; gamepad Y test | `13` (input focused) | DONE |
| 12.4 | Discover handoff ("Ask AI for Recommendations"), no automatic paid calls, no competing LLM workflow | Handoff dispatches `browse:ask-ai`; zero LLM calls from Browse/Home; Discover untouched (zero diff on discover files) | Test 15 empty-state render; code-read verification | `13`, `15` | DONE |

## §13 Duplicates

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 13.1 | Safe grouping: verified TMDB identity + type + year preferred; conservative title/year without IDs; never similar-but-distinct; never movie+series | Keyed `buildGroupingIndex` (TMDb-first + title\|year + single-bridge); kind partition; D4/D27 conservative merge (year required) | Test 9; D27 tests | `05` | DONE |
| 13.2 | One primary poster per confident group; variants on detail; every legitimate stream accessible | `primaryEntryFor` + detail page lists variants (existing detail behaviour preserved) | Test 9 | `05` | DONE |
| 13.3 | Grouped title matches language filter via member variants; playback respects preference; counts = displayed groups | Language filter over group tags + member meta; counts from group primaries | W1/W2 language tests; test 21 | `05` | DONE |
| 13.4 | Uncertain matches stay separate | D49: year-less + ID-less variants stay separate; suffix vocabulary mirrors the contract exactly; no wrong merges observed in any render | Test 9 (Crossing 2018/2021 separate; English Patient vs Patient separate) | `02` (Ashen Skies variants — by design) | DONE |

## §14 Recommendations

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 14.1 | Plausible without AI key (local infra + metadata) | Local selectors only; no key required anywhere in Home/Browse | Tests 3, 15 | — | DONE |
| 14.2 | taste.ts reuse, profile boundaries, opening ≠ approval, not-interested suppresses | `loadTaste(profileId, playlistId)` + shared fallback; zero taste writes on open; not-interested hard-excluded in `scoreCandidate` | W1 selector tests; code-read verification | — | DONE |
| 14.3 | Discover 3.0 untouched; cached verified recommendations may improve shelves where safe; no expensive calls on load; honest source labels | Zero diff on discover/ai-rank/taste files; neither home passes AI input; labels via `chooseWorthWatchingLabel` | Code-read verification (git diff --name-only) | `02` | DONE |
| 14.4 | Diversity: no same film across Featured/Worth/Recent/genre row; Continue excepted; no fake variety | `applyHomeDiversity` (movies) / `reduceRepeatedExposure` semantics (series); Continue exempt | W3/W4 model tests | `02` (Harbour Lights in Continue + Worth only) | DONE |
| 14.5 | Bad provider ratings: bare 10 must not outrank established films; evidence weighting; never imply provider rating is TMDB/IMDb/RT | Bayesian weighting (prior 6.5, weight 100); vote-less films tie at prior; bare `★ score` badges, zero TMDB/IMDb/RT strings in home code | W1 rating tests; test 3 | `05` (credible-only badges) | DONE |

## §15 Performance

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 15.1 | Reuse Xtream/cache infra, preserve hydration/offline, no duplicated full arrays | `loadCouchCatalog` + adapters; rows stored by reference, never mutated/copied | Test 20; code-read verification | — | DONE |
| 15.2 | Prepared index per playlist/kind/revision/metadata revision; profile data layered separately (one favourite change must NOT rebuild index) | `getCatalogIndex` cache (array identity + kind + revision + metadata revision + playlistId); `createProfileLayer` separate; D36 `seq` in selector cache keys | Index caching tests; D36 regression test; test 20 | — | DONE |
| 15.3 | Derived collection caching (ranked IDs+metadata, refresh on change only, top-K) | Selector cache + `browseViewsFor` WeakMap cache; D26 cacheKey fingerprinting for volatile inputs | Selector cache tests; bench (6 cache hits/session) | — | DONE |
| 15.4 | Grid: render active page only, stable nodes, never rebuild for focus, no needless spatial-nav re-registration, no sync layout reads in mutations, rAF batching, cancel obsolete work | `createKeyedPageGrid` (reuse pool, rAF, cancel-on-newer, focus pin); D1 counters prove 0 derives/sorts/groups on focus/scroll/page-turn | Test 40; bench focus/scroll/page-turn test | — | DONE |
| 15.5 | Artwork: lazy, async decode, caching, size variants, bounded prefetch, stable fallbacks, never eager-fetch library, no refetch on viewport exit | `buildCouchCard` lazy+async-decode; next-page prefetch only; stable fallbacks | Bench poster counts ≤ card counts; code-read verification | `05`, `06` | DONE |
| 15.6 | Series metadata: preserve concurrency limit, fetch only when needed, no offscreen requests, observers detached, no stale callbacks, no request floods | `series-seasons.ts` untouched (MAX_CONCURRENT=3, IntersectionObserver, WeakMap); cached-only reads at index time; D29 key guard | Tests 16, 17, 20; adapter key-guard tests | `06` | DONE |
| 15.7 | Search/filter responsiveness: no excessive sync sorting/normalisation on UI thread; progressive loading never presents partial counts as totals | Precomputed sorted indexes + precomputed title keys; debounced search; counts from the full derived set | Bench filter/page timings; test 40 | — | DONE |
| 15.8 | No leaks: listeners/observers/timers/requests/grid instances audited; mount/unmount accumulates nothing | `destroy()` removes listeners/observer/timers/grid/overlays/root; hover-guard listeners removed in `destroy()` (D50) | Mount destroy tests; test 18 remount path | — | DONE |

## §16 Controller (native XInput → shared pipeline, no second handler)

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| 16.1 | Home: D-pad L/R shelf, U/D shelves, A open, B return, X context, Y search, LB/RB prev/next shelf, Menu options; every section reachable | Spatial nav + shelf-jump (`installHomeShelfJump`, PageUp/PageDown/`[`/`]`); gamepad seam routes LB/RB → page keys on Home (D37). **Menu-on-Home: GAP** — no page-options surface exists in W3/W4, so Menu → Settings (D20); the task's gamepad paragraph explicitly authorises recording this as unmet. Follow-up: build a Home page-options surface, then route Menu to it | Gamepad tests: home LB/RB keys, Menu-on-Home → Settings path (no key), Y-on-Home → search path | — | GAP (authorised; see note) |
| 16.2 | Browse: D-pad cards, A open, B return+restore, X context, Y search, LB/RB prev/next page, Menu Filters/Sort, Left-from-first-column → Categories, Up-from-first-row → header | Gamepad seam (D37): X/Y/Menu dispatched as keys, LB/RB as PageUp/PageDown; grid-layer edge handling in the mount; Menu = Filters drawer (sort via Sort button, W2 decision) | Gamepad tests (16); tests 34, 37 | — | DONE |
| 16.3 | Drawer: U/D, A select, B back one level, Right toward results, no focus escape | Drawer `handleKey` implementations + reducer; arrow containment tested; Tab untrapped (D38 — documented, controller containment is the requirement) | Test 35; drawer tests | `08` | DONE |
| 16.4 | Filter drawer: U/D families, L/R values, A select, B cancel, prominent Clear All + Apply, no auto-apply resets | Filter drawer `handleKey` + draft/Apply semantics; D52 row geometry fix | Tests 35, 36; drawer tests | `10`, `11` | DONE |
| 16.5 | Focus preservation: section, poster ID, category, page, filters, scroll; detail return restores exact poster or nearest survivor; never into unmounted rows | URL mode + `restoreCouchFocus` + `findReplacementFocus`; D47 page-turn drift fix | Tests 18, 34, 38 | `16-detail-return` | DONE |
| 16.6 | Responsiveness: one press = one movement, no delayed jumps, no double-activation, no accidental selection, no shelf jumps, no unrelated filter changes, fully mouse-free | D9 repeat guard; rAF batching; focus moves cost 0 derives; no timers in homes; `repaintPicks` restores focus | Test 37 (repeat collapse), test 40, gamepad tests | — | DONE (routing; physical feel needs the PC check — see limitations) |

## §17 Visual

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| §17 | Premium restrained console-media; spacious 16:9, strong type, minimal chrome, generous targets, consistent posters, subtle transitions, sofa legibility; NO poster walls/pill bars/selects/tiny text/nested cards/badge spam/identical shelves/fake placeholder art/huge empty heroes/always-visible filter panels; Home vs Browse different compositions; 1920×1080 baseline | All four `couch.css` sections kept; Home = shelves + genre tiles + browse band; Browse = header + bounded grid + drawers; pillfest test rescoped (decision vii) to assert no pills/selects in new pages | Pillfest test; render tests | All 21 renders inspected; `01` vs `05` compositions differ | DONE |

## §18 States

| Req | Requirement | Implementation | Tests | Screenshot | Status |
|---|---|---|---|---|---|
| §18 | Home: no playlist → setup message; empty → honest empty; cached loading → skeletons; omit empty sections; restrained fallback art; never invent descriptions. Browse: no matches → filters + Reset All; empty search → clear state; removed category → intelligent reset; provider unavailable → truthful cache/error; never failed-connection-as-empty; never stale-as-fresh | Home state renders (`renderSeriesHomeState`, movies mount states); browse loading skeleton/error/no-playlist/empty states; removed-category reset with notice; error state shows nothing rather than stale data | W3/W4 state tests; mount tests | `15` (empty), `19` (error, 2.1s), `20` (no playlist), `21` (loading skeletons), `18` (omitted New Episodes shelf) | DONE |

## §19 Tests 1–40 (all against REAL modules)

| # | Test | File | Status |
|---|---|---|---|
| 1 | Home never mounts the full catalogue grid | `movies-series-2.0-movies.test.ts` | DONE |
| 2 | Continue Watching excludes completed and untouched films | same | DONE |
| 3 | Worth Watching is not simply the first 12 rating-8 titles | same | DONE |
| 4 | Recently Added uses the added timestamp, not the release year | same | DONE |
| 5 | Genre tiles open Browse Everything | same | DONE |
| 6 | Horror replaces Comedy on selection | same | DONE |
| 7 | Rating 8+ with unknown rating does not falsely include titles | same | DONE |
| 8 | Under 120 minutes excludes known longer films | same | DONE |
| 9 | Provider variants group safely | same | DONE |
| 10 | Search finds an obscure title outside all curated shelves | same | DONE |
| 11 | Home prioritises actual next episodes | `movies-series-2.0-series.test.ts` | DONE |
| 12 | Followed Series populated from the real subscription store | same | DONE |
| 13 | Newly detected provider episodes appear accurately | same | DONE |
| 14 | No false new episodes from provider ID churn | same | DONE |
| 15 | Worth Starting returns series-level entries | same | DONE |
| 16 | Season filters use confirmed counts | same | DONE |
| 17 | Unknown season counts are not fabricated | same | DONE |
| 18 | Detail return restores the selected poster | same | DONE |
| 19 | Unfollow updates shelves without restart | same | DONE |
| 20 | No extra provider requests from opening a large grid | same | DONE |
| 21 | All populated canonical categories are reachable | `movies-series-2.0-categories.test.ts` | DONE |
| 22 | Provider categories are accessible | same | DONE |
| 23 | Uncategorised titles are reachable | same | DONE |
| 24 | Genre replace semantics | same | DONE |
| 25 | Multi-filter intersections are visible and intentional | same | DONE |
| 26 | Reset All removes hidden constraints | same | DONE |
| 27 | Category change resets pagination | same | DONE |
| 28 | Search All vs Search Current Category is explicit | same | DONE |
| 29 | Sort order is correct | same | DONE |
| 30 | Missing metadata produces no fictional filter results | same | DONE |
| 31 | Page slices partition every entry exactly once (derive + mount walk) | `movies-series-2.0-navigation.test.ts` | DONE |
| 32 | Page counts at exact multiples; empty set → 0 pages, page reported 1 | same | DONE |
| 33 | Every filtered result set pages completely | same | DONE |
| 34 | B fires onExit once; URL round-trip restores page + poster | same | DONE |
| 35 | Drawer focus containment + modal regression | same | DONE |
| 36 | Clear All + Apply resets; Cancel restores focus | same | DONE |
| 37 | Repeat Enters collapse; gamepad A / native A each activate once | same | DONE |
| 38 | 12 rounds of navigation never leave the container; replacement focus | same | DONE |
| 39 | Burst of category changes renders exactly the final category | same | DONE |
| 40 | Enter/click/controller A activate; focus moves cost 0 derives | same | DONE |

Adaptations from the stub contracts are documented per-test in the
file headers and in the decisions register below; ZERO tests were
weakened — where a real module could not satisfy a test as written,
the MODULE was fixed (D4/D27 grouping, D36 cache seq, D47 page-turn
drift, D48 tsc seams, D50 hover guard, D51 Continue fraction).

## §20 Fixtures + benchmarks

Production numbers from the merged tree (headless jsdom on a
throttled shared VM, 1.5 shared CPUs — NOT UM790 Pro timings; no
hardware performance is claimed). Full output in the integration
scratch dir; recorded in `tests/bench-0118-baseline.md`.

| Size | Rows | Index build | First shelf | Enter Browse | Filter apply | Page switches | Focus ×50 | Cards | Heap Δ | Builds | Derives | Sorts | Groups | Scroll rebuilds |
|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,134 | 82 ms | 17.8 ms | 163 ms | 251 ms | 1 page, 126 ms | 6 ms | 24/24 | −21.6 MB | 2 | 3 | 0 | 2 | 0 |
| 5,000 | 5,600 | 253 ms | 68.6 ms | 401 ms | 249 ms | 7 pages, 498 ms | 8 ms | 24/24 | −0.1 MB | 2 | 3 | 0 | 2 | 0 |
| 10,000 | 11,281 | 406 ms | 22.7 ms | 493 ms | 249 ms | 10 pages, 624 ms | 7 ms | 24/24 | +29.2 MB | 2 | 3 | 0 | 2 | 0 |
| 25,000 | 28,272 | 1,302 ms | 64.6 ms | 1,162 ms | 254 ms | 10 pages, 623 ms | 4 ms | 24/24 | −136.0 MB | 2 | 3 | 0 | 2 | 0 |
| 50,000 | 56,699 | 2,653 ms | 142.6 ms | 3,090 ms | 263 ms | 10 pages, 628 ms | 7 ms | 24/24 | −180.6 MB | 2 | 3 | 0 | 2 | 0 |

Reading notes: rows exceed size (~13% variants); cards bounded at
one viewport-derived page (24 in jsdom) at every size; index build
~linear (keyed grouping, not the 74s naive scan); heap Δ is GC noise,
never asserted; builds=2 per harness run is explained in the baseline
md (harness build + mount build over its own array); derives=3
(mount + 2 filters); zero network/image requests. Deterministic
bounded-work assertions green at every size. UM790 Pro timings are
UNMEASURED — the physical-PC checklist names the check.

## Contract-map decisions (W5's 15, resolved against real W1/W2)

1. Kind spelling: `vod`/`series` with `movie`/`tv` aliases — kept.
2. Shared 18-genre taxonomy in the stub vs W1's 18 + 15: tests derive
   expectations from the real constants; series families are W1's 15.
3. Search-All-ignores-category: kept (contract decision).
4. Sort-over-groups by first-variant rank: kept via group primaries.
5. No toggle-on-reselect: kept.
6. Category-change preserves filters: kept (`selectCategory`).
7. Sort-change resets page: kept (`setSort`).
8. Unknown-category-matches-nothing: kept at derive level; URL-level
   well-formed params are preserved verbatim (D12 revision) so a stale
   link lands on an honest empty state, never a crash or silent All.
9. Featured fallback chain: poster+rated → rated → poster → first by
   added — kept (W1 `selectFeaturedFilm`).
10. Shelf thresholds 8/7.5/7: stub choices, NOT brief mandates —
    dropped; composite scoring decides (D45).
11. URL params: W2 `home-browse-modes.ts` shape kept (view/category/
    page/q/scope/sort + filter params).
12. 5-based scale preservation: kept via explicit `rating_5based`
    field (D6) + `normaliseRating` precedence.
13. Unknown-year grouping rule: year-less rows group only with a
    known-year key (D27/D49) — conservative, test-pinned.
14. Drawer controls: reducer + mount handles kept; Tab untrapped
    (D38) — arrow containment is the requirement.
15. Stub-defect findings (binding): zero-member genre matches
    NOTHING (verified); grouping is KEYED (verified ~linear);
    decorated sorts with precomputed keys (verified).

## Integration decisions register

Task decisions: (i) i18n untouched — 0.11.8 labels come from the
canonical tables. (ii) Genre-notes feed not needed — no clean reader;
shared classifier satisfies §1.7. (iii) Continue input via
`opts.progressEntries`/`opts.profile` in both homes. (iv) AI shelf
influence only via explicit opts; neither home passes AI input;
default local-only. (v) Stable `profileRevision`/`cacheKey` passed
with volatile inputs (D26). (vi) All four `couch.css` sections kept.
(vii) Pillfest test rescoped to the new structure; no-pill invariant
still asserted. (viii) Dead series `couch-index.ts` deleted (zero
importers verified). (ix) Controller-local hints bar kept (Live TV
hints module is Live-TV-shaped). (x) decorateCard key guard:
adapter-level only (mount half unnecessary — D29). (xi) Cached-payload
reader exported from `series-seasons.ts`; `addedTimestampMs` stays in
`couch-movies.ts` (single use). (xii) No bare `/browse` route string
in new code; `integration-010` grep sensitivity respected.

D1–D52 (full text in the integration hand-back; headlines): D1
instrumentation module; D2 `excludeCompleted`; D3/D28 confirmed-empty
exclusion via episode evidence; D4 grouping suffix strip; D5/D35
credible-rating rule (vote support OR TMDb linkage); D6 mapper
`category_id`/`rating_5based` passthrough; D7 browse badge rule; D8
mount additions (`setSuspended`, `openSearch`, `autoOpenSearch`); D9
repeat guard; D10 index-walk sorts; D11 Uncategorised dual semantics;
D12 URL unknown-category revision; D13 code-point title order; D14
runtime sorts dropped (stub-only); D15 prefix-tag language filter;
D16 Worth Starting subtitle; D17 keep W3 diversity; D18 keep W4
`buildContinueInputs`; D19 Home Y = global search; D20 Menu-on-Home
GAP; D21 mount settle pattern; D22 C1 rule dropped (tile counts =
Browse counts); D23 shared shelf-jump; D24 no `forceReload`;
D25 fixture `categoryId` mapping; D26 selector-cache fingerprinting;
D27 variant-suffix singleton merge; D29 adapter key guard; D30
mount-test fixture variants; D31 cached-rows limitation; D32 search
cap 500; D33 series watched approximation; D34 unread-only New
Episodes set; D36 selector-cache `seq`; D37 gamepad seam; D38 Tab
untrapped; D39 version-bump mechanics; D40 fixture entry type; D41
fixture `baseTitleOf`; D42 test-10 shelf assertion; D43 filter
summary resolver; D44 mount-test harness; D45 test-15 stub decisions
dropped; D46 gamepad harness limits; D47 page-turn drift fix; D48 tsc
seams; D49 grouping boundaries (no change); D50 drawer hover guard;
D51 Continue cold-cache progress; D52 filter-row `flex-shrink: 0`.

## Bugs found + fixed at integration

1. Grouping suffix variants merged incorrectly (D4/D27) — fixed in
   `computeTitleKey` + `mergeVariantSuffixSingletons`.
2. Selector-cache collision between different indexes sharing a
   revision string (D36) — fixed with `CatalogIndex.seq`.
3. Page-turn focus drift +1 per turn (D47) — fixed in
   `currentFocusedPageIndex` (resolves from the derived slice).
4. tsc assignability seams (D48) — index signatures + structural
   reader + import fix; zero new errors.
5. Drawer hover focus steal (D50) — fixed with the `hoverEnabled`
   guard in both drawers.
6. Series Continue cold-cache progress discarded (D51) — fixed in
   `buildContinueWatchingItem` path 3.
7. Filter-row flex compression clipping help text (D52) — fixed with
   `flex-shrink: 0`.
8. URL unknown-category silently fell back to All (D12) — revised to
   preserve well-formed params (honest empty state).
9. Test-harness traps (not production bugs): gamepad `BTN_*`
   constants are module-private (tests must define locals); jsdom
   `location.assign` un-spyable (routing proven via dispatched keys);
   W1 partial-token fallback matches shared tokens ("no" ⊂
   "northlight") — empty-result queries must be token-disjoint.

## Known failures shipped (4 tests, 3 files — stale conventions, not regressions)

Both full-suite runs on `81de76c` failed the same 4 source-level
grep tests, which assert that the movies/series Astro pages still
contain the LEGACY scaffold ids: `tests/browse-010-runtime-filter.test.ts`
(B09: `id="couch-browse-runtime"`), `tests/browse-filter-state-0116.test.ts`
(W4: `couch-browse-reset`), `tests/browse-nav-redirects.test.ts`
(`id="couch-browse-rails"` on both pages). 0.11.8 deliberately
deleted that scaffold when the W2 mount replaced it (same class of
change as the pillfest rescope, decision vii). The pages render the
catalogue through the new mount structure — proven by the 21
screenshot renders and the W2 mount tests. These 3 files need the
same deliberate rescope the pillfest test got; that is a 0.11.9
follow-up. They were NOT fixed here: the user directed shipping
without further test passes (2026-11-12 19:57). CI's test job is
expected to fail on these 4 tests.

## Known limitations (honest, carried forward)

- Cached rows lack `category_id`/`rating_5based` until the 24h TTL
  refresh (D31). Mapped-row ratings are provider/low only (the
  `vote_average` fold means W1's tmdb/enrichment branch never fires
  for bulk rows); "Most Recently Updated" sort + Status filter are
  correctly gated OFF; language filter relies on name-prefix tags.
- `groupEntries` skips non-numeric-id rows (provider ids are
  numeric; recorded as a constraint).
- Cross-kind provider-registry edge: the same `id:` key in movies +
  series with different labels → last build wins.
- D18: W4's per-row `buildContinueInputs` scans are O(rows × bucket);
  correct and tested, not bulk-rewritten (regression risk).
- D49: year-less + ID-less variants stay separate; season-range /
  "COMPLETE" suffixes are outside the strip vocabulary. A false merge
  would HIDE a title; a duplicate poster is merely redundant.
  Vocabulary extension is a follow-up with false-merge tests.
- Tab is not trapped in drawers (D38); controller-arrow containment
  is the requirement and is tested.
- Menu-on-Home is a GAP (D20) — see §16.1.
- No physical controller, EPG, or real-catalogue verification: all
  controller routing is test-verified headless; feel, XInput timing,
  and UM790 Pro performance need the PC checklist.
- Pre-existing: the fixed global hints pill overlaps bottom-row
  content at one scroll position (0.11.6 caveat, untouched by 0.11.8).
- Series Continue subtitle truncates at card width; the progress bar
  carries the position visually and the full text is in the DOM.
- Series `added` falls back to release-date parsing when both
  timestamps are absent (pre-existing mapper behaviour).
