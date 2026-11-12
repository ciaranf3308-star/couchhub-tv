// Mocked-TMDB helper (0.11.6, W5).
//
// A deterministic stand-in for the TmdbSearchFn seam
// ({title, kind, year} -> TmdbSearchResult[]) plus the fetchDetails seam.
// It NEVER touches the network: it answers from the canned tables in
// tests/fixtures/ai-discovery-3.0-tmdb.ts, captures every query, and can
// be configured to throw — globally, or for one title — for the failure
// tests (Test L).
//
// Lookup ignores the requested year on purpose: the mock returns the
// full candidate set for a (kind, normalised title) key, and picking the
// right year / refusing a bad year is production logic under test.

import { normalize } from "../../src/scripts/lib/text"
import type { TmdbSearchResult } from "../../src/scripts/lib/tmdb"
import type {
  TmdbDetailsFn,
  TmdbSearchFn,
  TmdbSearchQuery,
} from "../../src/scripts/lib/ai/verification"
import {
  TMDB_DETAILS_TABLE,
  TMDB_SEARCH_TABLE,
  type MockTmdbDetails,
} from "../fixtures/ai-discovery-3.0-tmdb"

export interface MockTmdbOptions {
  searchTable?: Record<string, TmdbSearchResult[]>
  detailsTable?: Record<number, MockTmdbDetails>
  /** Throw for every search (TMDB outage, Test L). */
  throwAll?: Error
  /** Normalised titles whose search throws (per-title failure). */
  throwForTitles?: string[]
  /** Throw for every details fetch. */
  throwDetails?: Error
}

export interface MockTmdb {
  search: TmdbSearchFn
  fetchDetails: TmdbDetailsFn
  /** Every search query received, in call order. */
  searchCalls: TmdbSearchQuery[]
  /** Every tmdbId passed to fetchDetails, in call order. */
  detailsCalls: number[]
}

export function createMockTmdb(options: MockTmdbOptions = {}): MockTmdb {
  const searchTable = options.searchTable ?? TMDB_SEARCH_TABLE
  const detailsTable = options.detailsTable ?? TMDB_DETAILS_TABLE
  const throwTitles = new Set((options.throwForTitles ?? []).map((title) => normalize(title)))
  const searchCalls: TmdbSearchQuery[] = []
  const detailsCalls: number[] = []

  const search: TmdbSearchFn = async (query) => {
    searchCalls.push(query)
    if (options.throwAll) throw options.throwAll
    if (throwTitles.has(normalize(query.title))) {
      throw new Error(`Mock TMDB failure for "${query.title}"`)
    }
    const key = `${query.kind}:${normalize(query.title)}`
    return [...(searchTable[key] ?? [])]
  }

  const fetchDetails: TmdbDetailsFn = async (tmdbId) => {
    detailsCalls.push(tmdbId)
    if (options.throwDetails) throw options.throwDetails
    return detailsTable[tmdbId] ?? null
  }

  return { search, fetchDetails, searchCalls, detailsCalls }
}
