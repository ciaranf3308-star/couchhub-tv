// TMDB verification + catalogue matching (AI Discovery 3.0, 0.11.6).
//
// *** W2-OWNED SEAM STUB — PLACED BY W1 SO THIS BRANCH COMPILES ***
//
// W2 builds the real implementation of this module in parallel. This
// file exists in the W1 branch ONLY so that discovery-orchestrator.ts
// can import the frozen shapes and function names and the branch
// stays green (tsc + vitest + Astro build) before integration.
//
// INTEGRATION MUST REPLACE THIS FILE WHOLESALE WITH W2's
// implementation. Nothing here verifies anything: verifyRecommendations
// returns every recommendation as verified=false with an honest note,
// and defaultTmdbSearch throws. That is deliberate — a stub that
// claimed verification would fabricate verified results. If this stub
// ever shipped, every AI result would honestly say it was unverified.
//
// Frozen shapes (do not drift — W1's orchestrator and W3's UI build
// against these exact field names):
//   VerifiedRecommendation, CatalogueMatch, TmdbSearchFn,
//   verifyRecommendations(recs, { searchTmdb, catalogue, concurrency? }),
//   defaultTmdbSearch.

import type { GeneratedRecommendation } from "./generation.js"
import type { DiscoverCandidate } from "../discover.js"

export interface CatalogueMatch {
  compositeId: string
  kind: "movie" | "series"
  title: string
  year: number | null
  catalogueKey: string
}

export interface VerifiedRecommendation {
  generated: GeneratedRecommendation
  verified: boolean
  tmdbId: number | null
  title: string
  year: number | null
  kind: "movie" | "series"
  reason: string
  tone: string
  genres: string[]
  synopsis: string | null
  posterUrl: string | null
  backdropUrl: string | null
  match: CatalogueMatch | null
  verificationNote?: string
}

/** One TMDB search outcome, as W2's verifier consumes it. */
export interface TmdbSearchOutcome {
  tmdbId: number
  title: string
  year: number | null
  kind: "movie" | "series"
  genres: string[]
  synopsis: string | null
  posterUrl: string | null
  backdropUrl: string | null
}

export type TmdbSearchFn = (
  rec: GeneratedRecommendation,
  opts?: { signal?: AbortSignal }
) => Promise<TmdbSearchOutcome | null>

export interface VerifyRecommendationsOptions {
  searchTmdb?: TmdbSearchFn
  catalogue?: DiscoverCandidate[]
  concurrency?: number
  signal?: AbortSignal
}

/**
 * STUB — replaced by W2. Returns every recommendation unverified, with
 * an honest note, and no catalogue match. Never claims verification.
 */
export async function verifyRecommendations(
  recs: GeneratedRecommendation[],
  _opts: VerifyRecommendationsOptions = {}
): Promise<VerifiedRecommendation[]> {
  return recs.map((generated) => ({
    generated,
    verified: false,
    tmdbId: null,
    title: generated.title,
    year: generated.year,
    kind: generated.kind,
    reason: generated.reason,
    tone: generated.tone,
    genres: [],
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    match: null,
    verificationNote: "TMDB verification is not available in this build.",
  }))
}

/**
 * STUB — replaced by W2. The real defaultTmdbSearch queries TMDB with
 * the stored TMDB key; this stub throws so a missing W2 implementation
 * fails loudly instead of silently returning no results.
 */
export async function defaultTmdbSearch(
  _rec: GeneratedRecommendation,
  _opts?: { signal?: AbortSignal }
): Promise<TmdbSearchOutcome | null> {
  throw new Error(
    "defaultTmdbSearch is provided by the W2 verification module, which is not present in this branch."
  )
}
