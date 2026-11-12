// Rating evidence (0.11.8 W1, brief §8.3 / §14.5).
//
// One honest answer to "how good is this title, and how do we know?"
// Catalogue rows carry ratings from mixed origins on mixed scales, and
// the Xtream mappers fold `rating`, `rating_5based` and `vote_average`
// into a single `rating` string — so a bare row rating can never be
// presented as an authoritative TMDb score. This module is the only
// place that turns a raw rating field into a normalised 10-point
// value, and it carries the provenance with it:
//
//   - 5-point values are converted (x2) ONLY when the source field is
//     explicitly 5-based (`rating_5based`, or an explicit
//     `ratingScale` of 5). A bare `rating` is read as 10-point, matching
//     the long-standing `ratingSortValue` reading — never silently
//     rescaled, never mixed with 5-point values without conversion.
//   - `source: "tmdb"` requires corroboration: a vote count, an
//     explicit `ratingSource: "tmdb"` marker, or `ratingVerified`.
//     TMDb-shaped fields without corroboration are `"enrichment"`,
//     never `"tmdb"`. Provider rows are `"provider"`.
//   - `confidence` follows the vote count (see rating-confidence.ts).
//     A provider 10 with no credible source is confidence "low" and
//     its Bayesian score collapses to the prior mean, so it can never
//     outrank an established film in evidence-weighted comparisons.
//   - No rating, or an invalid one (<= 0, > 10, unparseable), is null:
//     unrated titles are identifiable so minimum-rating filters can
//     exclude them instead of silently passing them.
//
// Pure and deterministic: no storage, no network, no DOM.

import {
  bayesianRating,
  confidenceTier,
  type ConfidenceTier,
} from "@/scripts/lib/rating-confidence.ts"

/** Where a normalised rating came from. Never upgrade a source without evidence. */
export type RatingSource = "tmdb" | "enrichment" | "provider"

/** Confidence follows the vote count; provider ratings without votes are always "low". */
export type RatingConfidence = ConfidenceTier

export interface RatingEvidence {
  /** Normalised score on the documented 10-point scale, in (0, 10]. */
  score10: number
  source: RatingSource
  confidence: RatingConfidence
  /** Known vote count, or null when the catalogue carries no vote support. Never fabricated. */
  voteCount: number | null
  /** The raw numeric value before scale conversion. */
  rawValue: number
  /** The scale the raw value was read on. 5-point values are doubled into score10. */
  rawScale: 5 | 10
}

/** Everything normaliseRating reads. Extra provider/enrichment fields are ignored. */
export interface RatableEntry {
  rating?: unknown
  rating_5based?: unknown
  ratingScale?: unknown
  ratingSource?: unknown
  ratingVerified?: unknown
  vote_average?: unknown
  voteAverage?: unknown
  vote_count?: unknown
  voteCount?: unknown
  tmdb?: unknown
  [key: string]: unknown
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = parseFloat(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toVoteCount(value: unknown): number | null {
  const parsed = toFiniteNumber(value)
  if (parsed == null || parsed < 0) return null
  return Math.floor(parsed)
}

function readScale(entry: RatableEntry): 5 | 10 | null {
  const raw = entry.ratingScale
  if (raw === 5 || raw === "5" || raw === "5-point" || raw === "5based") return 5
  if (raw === 10 || raw === "10" || raw === "10-point" || raw === "10based") return 10
  return null
}

function isTmdbMarked(entry: RatableEntry): boolean {
  if (entry.ratingVerified === true) return true
  const source = String(entry.ratingSource ?? "").trim().toLowerCase()
  return source === "tmdb" || source === "themoviedb" || source === "tmdb_verified"
}

/**
 * Normalise one entry's rating onto the documented 10-point scale.
 * Returns null when the entry carries no usable rating — never a
 * guessed score, never 0 (0 would read as "rated terribly" instead
 * of "unrated").
 */
export function normaliseRating(entry: RatableEntry | null | undefined): RatingEvidence | null {
  if (!entry || typeof entry !== "object") return null

  const voteAverage = toFiniteNumber(entry.vote_average ?? entry.voteAverage)
  const voteCount = toVoteCount(entry.vote_count ?? entry.voteCount)
  const tmdbMarked = isTmdbMarked(entry)

  // TMDb-shaped fields: corroborated -> "tmdb"; uncorroborated ->
  // "enrichment" (TMDb vocabulary, unverified vote support). The
  // distinction is the honesty rule in §14.5: never present an
  // unverified value as an authoritative TMDb score.
  if (voteAverage != null && voteAverage > 0 && voteAverage <= 10) {
    const corroborated = voteCount != null || tmdbMarked
    return {
      score10: voteAverage,
      source: corroborated ? "tmdb" : "enrichment",
      confidence: confidenceTier(voteCount),
      voteCount,
      rawValue: voteAverage,
      rawScale: 10,
    }
  }

  // Explicitly 5-based provider field: convert (x2) into the 10-point scale.
  const fiveBased = toFiniteNumber(entry.rating_5based)
  if (fiveBased != null && fiveBased > 0 && fiveBased <= 5) {
    return {
      score10: Math.min(10, fiveBased * 2),
      source: "provider",
      confidence: "low",
      voteCount,
      rawValue: fiveBased,
      rawScale: 5,
    }
  }

  const rating = toFiniteNumber(entry.rating)
  if (rating == null || rating <= 0 || rating > 10) return null

  const scale = readScale(entry)
  if (scale === 5) {
    return {
      score10: Math.min(10, rating * 2),
      source: tmdbMarked ? "tmdb" : "provider",
      confidence: confidenceTier(voteCount),
      voteCount,
      rawValue: rating,
      rawScale: 5,
    }
  }

  // Bare `rating`: 10-point, provider origin unless explicitly marked.
  // Confidence stays "low" without vote support, so a provider 10 can
  // never outrank an established film in evidence-weighted order.
  return {
    score10: rating,
    source: tmdbMarked ? "tmdb" : "provider",
    confidence: tmdbMarked ? confidenceTier(voteCount) : "low",
    voteCount,
    rawValue: rating,
    rawScale: 10,
  }
}

/**
 * Evidence-weighted score for ranking: the Bayesian weighted rating
 * (see rating-confidence.ts). Unrated titles score exactly the prior
 * mean — "average until proven otherwise" — which is the right value
 * for shelf scoring, but NOT for sort order: see
 * compareByRatingEvidence, which keeps unrated titles last.
 */
export function evidenceWeightedScore(
  evidence: RatingEvidence | RatableEntry | null | undefined,
): number {
  const resolved = isRatingEvidence(evidence) ? evidence : normaliseRating(evidence)
  if (!resolved) return bayesianRating(null, null)
  return bayesianRating(resolved.score10, resolved.voteCount)
}

export function isRatingEvidence(value: unknown): value is RatingEvidence {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<RatingEvidence>
  return (
    typeof candidate.score10 === "number" &&
    typeof candidate.source === "string" &&
    typeof candidate.confidence === "string" &&
    "voteCount" in candidate &&
    "rawValue" in candidate &&
    "rawScale" in candidate
  )
}

function evidenceOf(value: RatingEvidence | RatableEntry | null | undefined): RatingEvidence | null {
  if (value == null) return null
  return isRatingEvidence(value) ? value : normaliseRating(value)
}

/**
 * Evidence-weighted comparison for sort order (negative = `a` first).
 * Rated titles always sort before unrated ones; among rated titles
 * the Bayesian score decides, so a provider 10 with no votes loses
 * to a well-supported 8. Ties break on vote count, then raw score.
 * Deterministic; callers add their own final tie-break (title, id).
 */
export function compareByRatingEvidence(
  a: RatingEvidence | RatableEntry | null | undefined,
  b: RatingEvidence | RatableEntry | null | undefined,
): number {
  const evidenceA = evidenceOf(a)
  const evidenceB = evidenceOf(b)
  if (!evidenceA && !evidenceB) return 0
  if (!evidenceA) return 1
  if (!evidenceB) return -1
  const bayesianDelta =
    evidenceWeightedScore(evidenceA) - evidenceWeightedScore(evidenceB)
  if (bayesianDelta !== 0) return -bayesianDelta
  const votesDelta = (evidenceA.voteCount ?? 0) - (evidenceB.voteCount ?? 0)
  if (votesDelta !== 0) return -votesDelta
  return evidenceB.score10 - evidenceA.score10
}

/**
 * True only when a title has enough real votes to support a quality
 * claim. Provider ratings never qualify (they carry no vote counts),
 * and an unknown vote count is zero evidence, never an average.
 */
export function hasReliableRating(
  entry: RatingEvidence | RatableEntry | null | undefined,
  minVotes = 100,
): boolean {
  const evidence = evidenceOf(entry)
  if (!evidence || evidence.voteCount == null) return false
  return evidence.voteCount >= Math.max(0, minVotes)
}

/**
 * Minimum-rating filter predicate. A minimum of 0 (or less) passes
 * everything; any positive minimum EXCLUDES unrated titles — they
 * must never silently pass a rating filter.
 */
export function ratingPassesMinimum(
  entry: RatingEvidence | RatableEntry | null | undefined,
  minRating: number,
): boolean {
  if (!minRating || minRating <= 0) return true
  const evidence = evidenceOf(entry)
  if (!evidence) return false
  return evidence.score10 >= minRating
}
