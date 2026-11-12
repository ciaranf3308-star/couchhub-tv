# bench-0118 baseline — PRODUCTION NUMBERS (real merged 0.11.8 modules)

Measured 2026-11-12 on the integration branch against the REAL modules
(W1 `getCatalogIndex`, W3 `buildMoviesHomeModel`, W2
`mountBrowseEverything` + `deriveBrowseGroups`, D1 instrumentation),
headless jsdom on a throttled shared VM (1.5 shared CPUs). These numbers
describe the real code running headless on this VM — NOT the UM790 Pro.
No millisecond threshold is asserted anywhere; the deterministic
assertions (bounded DOM, zero derives/sorts/grouping on focus/scroll/
page-turn, one index build per revision) are in
`tests/bench-0118-performance.test.ts` and held at every size.

Re-run command (from the repo root):

```sh
pnpm vitest run tests/bench-0118-performance.test.ts
```

## Results (one run, 2026-11-12 evening)

| Size | Rows | Generate | Index build | First shelf | Enter Browse | Filter apply | Page switches | Focus ×50 | Cards | Posters | Heap Δ | Builds | Derives | Sorts | Groups | Scroll rebuilds |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,134 | 51 ms | 82 ms | 17.8 ms | 163 ms | 251 ms | 1 page, 126 ms | 6 ms | 24/24 | 21 | −21.6 MB | 2 | 3 | 0 | 2 | 0 |
| 5,000 | 5,600 | 69 ms | 253 ms | 68.6 ms | 401 ms | 249 ms | 7 pages, 498 ms | 8 ms | 24/24 | 21 | −0.1 MB | 2 | 3 | 0 | 2 | 0 |
| 10,000 | 11,281 | 145 ms | 406 ms | 22.7 ms | 493 ms | 249 ms | 10 pages, 624 ms | 7 ms | 24/24 | 16 | +29.2 MB | 2 | 3 | 0 | 2 | 0 |
| 25,000 | 28,272 | 483 ms | 1,302 ms | 64.6 ms | 1,162 ms | 254 ms | 10 pages, 623 ms | 4 ms | 24/24 | 24 | −136.0 MB | 2 | 3 | 0 | 2 | 0 |
| 50,000 | 56,699 | 712 ms | 2,653 ms | 142.6 ms | 3,090 ms | 263 ms | 10 pages, 628 ms | 7 ms | 24/24 | 24 | −180.6 MB | 2 | 3 | 0 | 2 | 0 |

Reading notes:

- **Rows exceed size**: the generator emits language/quality variants
  on top of the base counts (~13% extra rows).
- **Mounted cards stay 24** (one viewport-derived page in jsdom) at
  every size, including 50k; posters never exceed cards. DOM
  boundedness is size-independent.
- **Builds = 2** in every harness run: the harness's explicit build
  (shared with the Home model via the index cache) + the mount's
  build over its own mapped-entries array (new identity by
  construction). Filter/page/focus phases add zero builds.
- **Derives = 3** in every harness run: mount + two filter changes.
  Page turns, focus moves and scrolling add zero derives, zero
  decorated sorts, zero grouping runs (asserted, not just observed).
- **Index build scales ~linearly** (82 ms at 1k → 2,653 ms at 50k on
  this throttled VM) thanks to keyed grouping — the naive linear scan
  W5 measured at 74 s for 50k is not present in the real modules.
  First Browse entry pays one index build; later entries hit the
  cache. No UM790 Pro timing is claimed.
- **Heap Δ is noisy** (GC timing on a shared VM; negative deltas are
  collections, not leaks). Reported only; never asserted.
- **Millisecond figures are noisy** under VM throttling. Do not
  compare runs millisecond-to-millisecond; compare the deterministic
  invariants.
- **Pages(1) at 1k**: after the genre+rating filter the 1k catalogue
  fits on ~2 pages, so only one further page turn was available.
- **Network/image requests**: zero. The harness counts poster `<img>`
  elements (≤ page size); jsdom fetches nothing, and the mount never
  calls the provider loader (acceptance test 20 pins one loader call
  across mount/page/scroll/filter/search).

## Fixture determinism (same run)

Same seed → byte-identical catalogue (SHA-256 of the stable
serialisation, `tests/fixtures-0118-determinism.test.ts` — green):

| Size | Rows | SHA-256 (first 16 hex) |
|---:|---:|---|
| 1,000 | 1,134 | `1456bb491137bf14…` |
| 5,000 | 5,600 | `2e138e5b086e2ad1…` |
| 10,000 | 11,281 | `410ac4820cdc336a…` |
| 25,000 | 28,272 | `bc7aca131965e9b3…` |
| 50,000 | 56,699 | `32eaad8a9de9547f…` |

(Hashes differ from the W5 stub-baseline run: the fixtures were
re-pointed at integration to emit real mapped rows with W1-visible
fields. Same-seed determinism still holds — the hashes above are
stable across runs.)

## Derivation-work session (10k catalogue, asserted)

A realistic session — open, 2 filter changes, 2 sorts, 1 search —
costs 6 derives, 1 grouping run, 0 decorated sorts, 1 index build
and 6 cache hits on repeated reads. Page turns never re-derive
(the mount's `gotoPage` path; asserted mount-level).
