# Live TV 2.0 (0.11.7) — W5 tests: integration notes

Branch: `livetv-0117-w5-tests` (from `origin/main @ c905982`, 0.11.5),
integrated onto `livetv-0117-integration` against the REAL merged
modules. **All stubs are deleted** (`stubs/` + `stubs/broken/` +
`livetv0117-red-verification.test.ts` are gone); every test below
runs against production code. No production code was modified by
W5; integration adaptations are listed at the bottom.

## Running

```sh
pnpm vitest run tests/livetv0117/                                    # all W5 tests
pnpm vitest run tests/livetv0117/livetv0117-benchmark.test.ts       # benchmark (prints numbers)
```

## Test map (the fourteen)

| # | Requirement | File |
|---|-------------|------|
| 1 | Sports preserves provider subcategories | `livetv0117-category-index.test.ts` |
| 2 | Category counts and membership correct | `livetv0117-category-index.test.ts` |
| 3 | Scroll does not rerun grouping/filtering (counters) | `livetv0117-category-index.test.ts` |
| 4 | Virtual lists mount a bounded number of DOM rows | `livetv0117-browser-virtual.test.ts` |
| 5 | Fast controller movement maintains focus | `livetv0117-browser-virtual.test.ts` |
| 6 | Category changes do not trigger accidental playback | `livetv0117-browser-virtual.test.ts` |
| 7 | Guide On Now / By Channel bounded at 2,000+ entries | `livetv0117-guide-virtual.test.ts` |
| 8 | Category with no subcategories fully navigable | `livetv0117-category-index.test.ts` |
| 9 | Search correctly scoped and cleared | `livetv0117-browser-virtual.test.ts` |
| 10 | LB/RB and LT/RT without duplicate events | `livetv0117-nav-events.test.ts` |
| 11 | B closes precisely one navigation level | `livetv0117-nav-events.test.ts` |
| 12 | Hidden Live TV modes cannot steal input | `livetv0117-nav-events.test.ts` |
| 13 | Returning from playback restores browser context | `livetv0117-nav-events.test.ts` |
| 14 | EPG updates don't reset channel focus unnecessarily | `livetv0117-nav-events.test.ts` |

Supporting files: `livetv0117-fixtures.test.ts` (fixture self-checks),
`livetv0117-benchmark.test.ts` (instrumentation, reported numbers,
no ms thresholds).

## Fixtures (`fixtures.ts`)

Deterministic (fixed seed, no `Math.random`): `buildFixtureChannels`
at exactly 200 / 2,000 / 5,000 / 10,000 channels. Sports is 60% of
each catalogue across 30 distinct raw provider categories (3 regions
× 10 subcategories: Football, F1, Cricket, Rugby, Golf, Tennis, NFL,
NBA, Darts, Boxing). Same-label subcategories stay distinct across
regions (`UK | Sports | Football` ≠ `US | Sports | Football`).
Duplicate display names reuse 5 names across distinct provider ids.
EPG is sparse by default (~30% coverage, `buildFixtureProgrammes`);
`buildGuideFixture(2500)` gives full coverage for Guide-scale tests.
`buildEnormousCategoryFixture(3000)` is one raw category
(`UK | International`) with no subcategories;
`buildFlatCategoryFixture()` is bare single-segment categories.
Channels use the REAL `LivetvChannel` shape and the REAL
`normaliseCategoryLabel` / `normalize` helpers. Oracle helpers
(`rawCategoryCounts`, `channelsInRawCategory`,
`distinctRawCategories`, `sportsChannelsOracle`) count verbatim raw
categoryId strings with no grouping logic, so membership assertions
do not trust the index's parser.

## Real modules under test

| Area | Real module |
|------|-------------|
| Category index | `src/scripts/lib/livetv-category-index.ts` (W1): `buildCategoryIndex(channels, revision)`, `getCategoryIndex(channels, revision)`, `getDerivedChannels(index, opts)`; counters `categoryIndexBuildCount()` / `derivedListRecomputeCount()`, resets `resetCategoryIndexCache()` / `resetCategoryIndexCounters()`. Subcategory ids are `sub:<slug-of-raw-name>`; `rawName` is the verbatim provider string. |
| Browser list | `src/scripts/lib/livetv-browser.ts` (W2): `mountChannelBrowser`, keyed row pool (`[data-browser-row]`), rAF-coalesced scroll paints, drawer, `livetv:search-submit` / `livetv:sort-submit` event contract. |
| Guide lists | `src/scripts/lib/livetv-guide-virtual.ts` (W3): `createVirtualList` (spacer mode), `virtualListWindow`, `nowNextRows` (kept from `livetv-guide.ts`). |
| Nav / events | `src/scripts/lib/livetv-nav.ts` (W4): `LivetvNavController`, `installTopLayerBackGuard`, singleton `livetvNav`; `src/scripts/lib/livetv-search-sort.ts` (W4): dispatch helpers + literal event names (the contract). |
| Input dedupe | `src/scripts/lib/gamepad.ts`: the poll loop's rising-edge detection + native-path stand-down, driven with a mocked Gamepad API; `livetvGamepadActionForButton` (`livetv-keys.ts`) for the mapping. The native XInput path sends edges only (Rust) — cross-source dedupe is the loop standing down while native input is live. |

## Integration adaptations (names/wiring only — no weakened assertions)

- **Index shapes**: stub `index.subcategories` / `group.subcategoryIds`
  / `group.directChannelIds` / `group.count` / `index.totalChannels`
  / per-index `recomputeCount` → W1 nested `group.subcategories`
  (`id` / `rawName` / `channelCount` / `channelIds`),
  `group.channelCount`, `index.byId`, module counters. Subcategory
  ids resolve from the index by `rawName` lookup in-test.
- **Group-slice order**: W1 returns group slices in subcategory
  first-seen order with provider order inside each subcategory
  (the stub preserved global catalogue order). Test 2 asserts
  membership exactly plus per-subcategory provider order — the
  W1 contract — instead of global order.
- **Derived search option** is `search` (not the stub's `query`);
  **sort vocabulary**: the index spells catalogue order `provider`
  (the browser/W4 spell it `source`); the events harness maps.
- **Flat categories (test 8)**: W1 represents one raw category as
  one group with ONE subcategory (the verbatim raw name); the
  stub's "no subcategories" shape does not exist in W1. The
  navigability assertions (complete ordered list, windowed
  reachability, search/sort) are unchanged.
- **Browser UI**: pills and the inline search box are gone (drawer
  + overlay search). Test 6 drives drawer picks; test 9 drives
  the real `livetv:search-submit` event. A category-scoped search
  is CLEARED on any category change (W4 rule) — the old
  "query persists across a category change" expectation was
  replaced by the clearing assertion.
- **List wrap**: the real browser wraps highlight movement
  (pre-existing behaviour); the 1,000-move walk asserts the wrap
  explicitly instead of the stub's top clamp.
- **Nav/events**: the stub stack/gate/tracker are replaced by the
  real controller, guards, and poll loop (see table). The
  `livetv:close-overlay` direction is notification-only in W4
  (overlays dispatch it when closing; nothing pops on receipt) —
  the guard test asserts the real guard wiring instead.
- **Row bound**: `ceil(viewport/rowHeight) + 2·overscan + 1`
  (the +1 covers the Guide engine's one pinned focused node),
  computed through the real `virtualListWindow` math at a
  mid-list scroll position.
- **Red verification**: deleted with the stubs (brief default).
  The green tests' power is carried by the counter, bound, and
  exactness assertions against real modules.

## Instrumentation

`livetv0117-benchmark.test.ts` measures (performance.now):
index build at 4 sizes, cache hit, category switch (first derivation
per group), derived cache hit, scroll window slices, real-browser
scroll paints + controller moves, `nowNextRows` at 2,500, Guide
scroll steps. It asserts NO millisecond thresholds. Numbers are
sandbox measurements on fixtures and are NEVER a claim about the
user's PC. Scroll-step means include awaiting rAF frames in jsdom
(frame-wait, not paint cost); the controller-move mean is the
synchronous-paint number. Re-run after integration against the real
modules and record the new numbers.

## What was NOT touched

No production code (`src/`, `src-tauri/`) by W5, no version files
(`package.json`, `tauri.conf.json`, `Cargo.toml`), no Discover AI /
Movies / Series / launcher files, no merges, no PR. Only
`tests/livetv0117/` was added (integration later rewired the
production seams on the integration branch).
