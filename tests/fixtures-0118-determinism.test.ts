// Fixture determinism proof (0.11.8, W5 — brief §20).
//
// The same seed + counts must produce a byte-identical catalogue:
// generate twice, compare SHA-256 hashes of the stable serialisation
// AND deep-compare. A different seed must produce a different
// catalogue. Generation time is REPORTED (console) but never asserted
// against a millisecond threshold.

import { describe, it, expect } from "vitest"
import {
  generateCatalogue,
  generateCatalogueOfSize,
  hashCatalogue,
} from "./fixtures-0118-catalogue.ts"

describe("fixtures-0118 determinism", { timeout: 300000 }, () => {
  it("same seed produces a byte-identical catalogue", () => {
    const first = generateCatalogue({ seed: 0x0118, movieCount: 1000, seriesCount: 200 })
    const second = generateCatalogue({ seed: 0x0118, movieCount: 1000, seriesCount: 200 })
    const hashFirst = hashCatalogue({ movies: first.movies, series: first.series })
    const hashSecond = hashCatalogue({ movies: second.movies, series: second.series })
    expect(hashSecond).toBe(hashFirst)
    expect(second.movies).toEqual(first.movies)
    expect(second.series).toEqual(first.series)
    expect(hashCatalogue(first.rawMovies)).toBe(hashCatalogue(second.rawMovies))
    expect(hashCatalogue(first.rawSeries)).toBe(hashCatalogue(second.rawSeries))
  })

  it("different seeds produce different catalogues", () => {
    const a = generateCatalogue({ seed: 1, movieCount: 500, seriesCount: 100 })
    const b = generateCatalogue({ seed: 2, movieCount: 500, seriesCount: 100 })
    expect(hashCatalogue(a.movies)).not.toBe(hashCatalogue(b.movies))
    expect(hashCatalogue(a.series)).not.toBe(hashCatalogue(b.series))
  })

  it("fixture sizes 1k/5k/10k/25k/50k generate and hash deterministically", () => {
    for (const total of [1000, 5000, 10000, 25000, 50000]) {
      const started = performance.now()
      const first = generateCatalogueOfSize(total)
      const hashFirst = hashCatalogue({ movies: first.movies, series: first.series })
      const second = generateCatalogueOfSize(total)
      const hashSecond = hashCatalogue({ movies: second.movies, series: second.series })
      const elapsed = performance.now() - started
      // Variants add rows on top of the base counts: the total is
      // always >= the requested size, and identical across runs.
      expect(first.movies.length + first.series.length).toBeGreaterThanOrEqual(total)
      expect(second.movies.length).toBe(first.movies.length)
      expect(second.series.length).toBe(first.series.length)
      expect(hashSecond).toBe(hashFirst)
      console.log(
        `fixtures-0118: size=${total} rows=${first.movies.length + first.series.length} ` +
          `generate+hash x2 in ${elapsed.toFixed(0)}ms sha256=${hashFirst.slice(0, 16)}…`
      )
    }
  }, 300000)
})
