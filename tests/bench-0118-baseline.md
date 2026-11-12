# bench-0118 baseline — STUB-BASELINE NUMBERS (not production measurements)

Measured 2026-11-12 in the W5 worktree against the CONTRACT STUBS
(`tests/movies-series-2.0-stubs.ts`), headless jsdom on a throttled
shared VM (1.5 shared CPUs). These numbers describe the stubs + the
harness, NOT the real 0.11.8 modules and NOT the UM790 Pro. No
millisecond threshold is asserted anywhere; the deterministic
assertions (bounded DOM, zero passes/sorts/grouping on focus/scroll/
page-turn) are in `tests/bench-0118-performance.test.ts` and held at
every size.

Integration MUST re-run the harness against the real merged tree and
replace this file with production numbers:

```sh
pnpm vitest run tests/bench-0118-performance.test.ts
```

## Results (one run, 2026-11-12)

| Size | Rows | Generate | Index build | First shelf | Enter Browse | Filter apply | Page switches | Focus ×50 | Cards | Posters | Heap Δ | Passes | Sorts | Groups | Scroll rebuilds |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,134 | 321 ms | 172 ms | 206 ms | 828 ms | 1,084 ms | 0 pages, 0 ms | 2,394 ms | 60 | 55 | +23.3 MB | 3 | 0 | 3 | 0 |
| 5,000 | 5,600 | 2,411 ms | 902 ms | 624 ms | 893 ms | 482 ms | 3 pages, 503 ms | 192 ms | 60 | 55 | +5.9 MB | 3 | 0 | 3 | 0 |
| 10,000 | 11,281 | 2,622 ms | 1,069 ms | 725 ms | 991 ms | 406 ms | 6 pages, 1,199 ms | 692 ms | 60 | 55 | +34.0 MB | 3 | 0 | 3 | 0 |
| 25,000 | 28,272 | 6,402 ms | 1,996 ms | 1,792 ms | 1,579 ms | 423 ms | 10 pages, 989 ms | 790 ms | 60 | 55 | +46.3 MB | 3 | 0 | 3 | 0 |
| 50,000 | 56,699 | 10,409 ms | 4,078 ms | 3,706 ms | 2,298 ms | 1,609 ms | 10 pages, 1,087 ms | 2,693 ms | 60 | 55 | −86.3 MB | 3 | 0 | 3 | 0 |

Reading notes:

- **Rows exceed size**: the generator emits language/quality variants
  on top of the base counts (~13% extra rows).
- **Mounted cards stay 60** (one page) at every size, including 50k;
  posters (55) never exceed cards. DOM boundedness is size-independent.
- **Passes = 3** in every harness run: mount + two filter changes.
  Page turns, focus moves and scrolling add zero passes, zero sorts,
  zero grouping runs (asserted, not just observed).
- **Heap Δ is noisy** (GC timing on a shared VM; negative deltas are
  collections, not leaks). Reported only; never asserted.
- **Millisecond figures are noisy** under VM throttling (e.g. focus
  ×50 varies 192–2,693 ms run to run). Do not compare runs
  millisecond-to-millisecond; compare the deterministic invariants.
- **Pages(0) at 1k**: after the genre+rating filter the 1k catalogue
  fits on one page, so there were no further pages to switch to.
- **Network/image requests**: zero. The harness counts poster `<img>`
  elements (≤ page size); jsdom fetches nothing, and the mount never
  calls the provider loader (acceptance test 20 pins zero loader
  calls across mount/page/scroll/filter/search).

## Fixture determinism (same run)

Same seed → byte-identical catalogue (SHA-256 of the stable
serialisation, `tests/fixtures-0118-determinism.test.ts`):

| Size | Rows | SHA-256 (first 16 hex) |
|---:|---:|---|
| 1,000 | 1,134 | `92cec6bf73b9de66…` |
| 5,000 | 5,600 | `de350e3040156091…` |
| 10,000 | 11,281 | `0a702bd52bfc951e…` |
| 25,000 | 28,272 | `830840c24b9bd327…` |
| 50,000 | 56,699 | `bbb7b0f54cb9d3d3…` |

## Derivation-work session (10k catalogue, asserted)

A realistic session — open, 5 page turns, 2 filter changes, 2 sorts,
1 search — costs 6 full passes, 6 grouping runs, 2 sorts and 6 cache
hits (5 page turns + 1 repeat). Page turns never re-derive.
