# Live TV 2.0 (0.11.7) — W5 tests: integration notes

Branch: `livetv-0117-w5-tests` (from `origin/main @ c905982`, 0.11.5).
This directory holds the fourteen mandatory tests (user brief §9),
the deterministic fixtures, the performance instrumentation, and
MINIMAL stubs for the W1–W4 modules that did not exist yet when
these tests were written. **All stubs live under `tests/` only —
no production code was modified and no version file was bumped.**

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
`livetv0117-red-verification.test.ts` (red-verification, see below),
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

## Stubs — DELETE ON INTEGRATION

Every stub file is headed `STUB-FOR-INTEGRATION`. Integration
deletes the whole `stubs/` directory and re-points the test imports
at the real merged modules, adapting ONLY names/wiring — never
weakening an assertion. If a real module's semantics differ from a
stub's in any way a test asserts, that is an integration defect to
resolve with W1–W4, not a reason to edit the test.

| Stub | Real module | Contract / adaptation |
|------|-------------|-----------------------|
| `stubs/category-index.stub.ts` | `src/scripts/lib/livetv-category-index.ts` (W1) | `buildCategoryIndex(channels, revision)`, `getCategoryIndex(channels, revision)`, `getDerivedChannels(index, opts)`. Identity = verbatim raw category string; subcategories are raw categories, never merged across regions. `CategoryIndex.buildCount` = module-wide build sequence number (see stub header); `recomputeCount` = per-index derived-cache misses. If W1 names the counters differently, adapt the accessor, not the assertion. `splitProviderCategory` is stub-only: W1's parser is authoritative; fixture raw categories use only ` \| ` separators so both must agree. `DerivedChannelsOptions` = `{ groupId?, subcategoryId?, query?, sort?, favouritesOnly? }`; group ids are slugs of group labels (`sports`, `news`, …). `sliceDerivedWindow` is a test helper, not part of the contract — drop it if W1/W2 expose their own windowing. `__resetCategoryIndexCacheForTests` / `getCategoryIndexBuildCount` are test-only accessors; W1 must expose an equivalent way to observe the counters (or integration wires the tests to W1's counters directly). |
| `stubs/virtual-list.stub.ts` | W2's virtualised browser list | `mountVirtualList` / `VirtualListHandle`. Window math reuses the REAL `computeVisibleWindow`. Adaptation: mount W2's real list in the harness, map `getMountedRowCount` → mounted `[data-browser-row]` (or W2's row selector) count, `moveFocus` → W2's focus movement, `applyEpgUpdate` → W2's EPG-refresh path, `captureContext`/`restoreContext` → the real browser-context snapshot. Keep the bounds: mounted ≤ `ceil(viewport/rowHeight) + 2*overscan + 1`. |
| `stubs/guide.stub.ts` | W3's virtualised Guide lists | `mountGuideList` with modes `now` / `channel`. Rows come from the REAL `nowNextRows` — keep that. Adaptation: mount W3's real On Now / By Channel lists, map the handle methods to W3's selectors/movement. |
| `stubs/nav.stub.ts` | `src/scripts/lib/livetv-nav.ts` (W4) | `LivetvNavStack` (push/pop/back/top/depth/snapshot), `LivetvInputGate` (active mode + overlay gating, `deliverInput`), `attachNavEventWiring` (`livetv:close-overlay` → pop one overlay layer). Adaptation: import W4's real stack/gate; if W4 splits the gate differently, wire the same assertions to W4's visibility API. `back()` MUST pop exactly one layer and never pop the root. |
| `stubs/input-dedupe.stub.ts` | `gamepad.ts` edge handling + `livetv-keys` mapping | `ButtonEdgeTracker.feed(sample)` → action on rising edge only, across `xinput` + `gamepad` sources; full release required before a second action. Action resolution delegates to the REAL `livetvGamepadActionForButton`. Adaptation: drive the real gamepad edge path with the same sample sequences (or keep the tracker semantics in the real layer and assert through it). Do NOT delete the cross-source duplicate assertion. |
| `stubs/events.stub.ts` | W2/W4 overlay event surface | Literal event names `livetv:open-search`, `livetv:search-submit`, `livetv:open-sort`, `livetv:sort-submit`, `livetv:close-overlay`; detail shapes `{ query: string }` / `{ sort: string }`. Adaptation: import the real constants from W2/W4 (or keep asserting the literal names — they ARE the contract) and dispatch through the real overlays. |
| `stubs/broken/*.stub.ts` | — (red-verification only) | Deliberately broken variants. Delete with the stubs. The red-verification file is deleted too once the green tests run against real modules — UNLESS integration keeps broken-variant checks against the real modules' failure modes, in which case rewrite them against real fault injection, never against these files. |

## Red verification (mandatory, done)

`livetv0117-red-verification.test.ts` runs each guarded invariant
against a deliberately broken variant and asserts it FAILS there:

- R1 (guards test 3): broken index rebuilds/recomputes on every access.
- R2 (guards test 4): broken list mounts all 2,000 rows.
- R3 (guards test 11): broken nav pops two layers per B, through the root.
- R4 (guards test 10): broken tracker emits once per poll sample (30×).
- R5 (guards test 14): broken list resets focus/scroll on EPG update.

All red tests pass (i.e. the broken variants are correctly detected
as broken). If integration changes a green test, re-check that its
red counterpart still fails against the broken variant first.

## Real seams already exercised (no stubs)

These assertions run against production code on the 0.11.5 base and
must keep passing unchanged after integration:

- `mountChannelBrowser` virtualisation, highlight walk, no-tune on
  category change / row click, search scoping/clearing, B one-level,
  hidden-root gating, refresh focus/scroll survival
  (`livetv-browser.ts`).
- `livetvGamepadActionForButton` LB/RB/LT/RT mapping (`livetv-keys.ts`).
- `createLivetvState` / `enterBrowser` / `tuneTo` / `enterPlayback` /
  `exitPlaybackToLanding` (`livetv-state.ts`).
- `stableGuideSelection`, `nowNextRows` (`livetv-guide.ts`).
- `computeVisibleWindow` (`couch-grid.ts`, via the virtual-list stub).
- `dispatchLivetvTune` / `livetv:tune` (`livetv-data.ts`).

## Instrumentation

`livetv0117-benchmark.test.ts` measures (performance.now):
index build at 4 sizes, cache hit, category switch (first derivation
per group), derived cache hit, scroll window slices, virtual-list
scroll re-render, controller-move→focus latency (incl. DOM focus),
`nowNextRows` at 2,500, Guide scroll steps. It asserts NO millisecond
thresholds. Numbers are sandbox measurements on fixtures/stubs and
are NEVER a claim about the user's PC. Re-run after integration
against the real modules and record the new numbers.

## What was NOT touched

No production code (`src/`, `src-tauri/`), no version files
(`package.json`, `tauri.conf.json`, `Cargo.toml`), no Discover AI /
Movies / Series / launcher files, no merges, no PR. Only
`tests/livetv0117/` was added.
