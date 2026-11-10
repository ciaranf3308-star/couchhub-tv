// RedSilk Home — confidence-aware quality (W2, Home Production Pass).
//
// A catalogue rating on its own says nothing about how much evidence
// sits behind it: a 10.0 from nobody is not a better film than an 8.0
// from fifty thousand people. Every quality claim on Home (Hidden Gems,
// hero, Trending, Short & Sweet) goes through this module so a
// thinly-supported rating can never outrank a well-supported one.
//
// Method: Bayesian weighted rating (the IMDb-style shrinkage estimator):
//   bayesian = (PRIOR_MEAN * PRIOR_WEIGHT + rating * votes)
//              / (PRIOR_WEIGHT + votes)
// With no votes the estimate is exactly the prior mean — an unvoted
// title is "average until proven otherwise", never "perfect".
//
// Constants (documented, tunable in one place):
//   BAYESIAN_PRIOR_MEAN = 6.5 — the prior mean rating. Catalogue
//     ratings here are TMDB-style vote averages; across a broad
//     catalogue the mean sits in the mid-6s, and 6.5 is the honest
//     "we know nothing yet" value. A title must earn its way above it
//     with real votes.
//   BAYESIAN_PRIOR_WEIGHT = 100 — the prior's strength, in votes. A
//     title needs on the order of a hundred real votes before its own
//     rating starts to dominate the estimate, and ~1,000 before the
//     prior is negligible. Small samples are pulled hard toward 6.5.
//   Confidence tiers (vote counts are the only support signal we have):
//     high:   >= 1,000 votes — a stable average, safe to rank on.
//     medium: >= 100 votes — usable, still shrunk toward the prior.
//     low:    < 100 votes, zero, or unknown — not enough evidence to
//             call a title "well-regarded". Low-confidence titles are
//             never Hidden Gems and never the hero, however high the
//             raw rating looks.
//
// Honesty rule: vote counts are NEVER fabricated. A missing vote_count
// is treated as zero evidence (tier low, Bayesian = prior mean), never
// as an average or a guess. Where the catalogue carries no vote counts
// at all, home-rails.ts falls back to its documented Tier 2 (a
// TMDb-matched title whose provider rating is TMDb's vote_average) —
// this module itself never invents the fallback, it only scores what
// it is given.

/** Prior mean rating — see the header note. */
export const BAYESIAN_PRIOR_MEAN = 6.5

/** Prior strength, in votes — see the header note. */
export const BAYESIAN_PRIOR_WEIGHT = 100

/** Votes needed for the "medium" confidence tier. */
export const CONFIDENCE_MIN_MEDIUM_VOTES = 100

/** Votes needed for the "high" confidence tier. */
export const CONFIDENCE_MIN_HIGH_VOTES = 1000

export type ConfidenceTier = "high" | "medium" | "low"

export interface BayesianOptions {
  /** Override the prior mean (default BAYESIAN_PRIOR_MEAN). */
  priorMean?: number
  /** Override the prior weight in votes (default BAYESIAN_PRIOR_WEIGHT). */
  priorWeight?: number
}

function cleanVoteCount(voteCount: number | undefined | null): number {
  if (typeof voteCount !== "number" || !Number.isFinite(voteCount)) return 0
  return Math.max(0, Math.floor(voteCount))
}

function cleanRating(rating: number | undefined | null): number | undefined {
  if (typeof rating !== "number" || !Number.isFinite(rating)) return undefined
  if (rating <= 0) return undefined
  return Math.min(rating, 10)
}

/**
 * Bayesian weighted rating for a title.
 *
 * - No rating at all → the prior mean (we know nothing; say so).
 * - No votes → exactly the prior mean, whatever the raw rating claims.
 *   A 10.0 with zero votes scores 6.5, below any well-supported 8.0.
 * - Many votes → converges on the title's own rating.
 *
 * Always returns a finite number in [0, 10]. Pure and deterministic.
 */
export function bayesianRating(
  rating: number | undefined | null,
  voteCount: number | undefined | null,
  opts: BayesianOptions = {},
): number {
  const priorMean = opts.priorMean ?? BAYESIAN_PRIOR_MEAN
  const priorWeight = Math.max(0, opts.priorWeight ?? BAYESIAN_PRIOR_WEIGHT)
  const votes = cleanVoteCount(voteCount)
  const clean = cleanRating(rating)
  if (clean === undefined) return priorMean
  return (priorMean * priorWeight + clean * votes) / (priorWeight + votes)
}

/**
 * Confidence tier for a title from its vote count alone.
 * Absent, zero, or tiny vote counts are LOW — never "average".
 */
export function confidenceTier(
  voteCount: number | undefined | null,
): ConfidenceTier {
  const votes = cleanVoteCount(voteCount)
  if (votes >= CONFIDENCE_MIN_HIGH_VOTES) return "high"
  if (votes >= CONFIDENCE_MIN_MEDIUM_VOTES) return "medium"
  return "low"
}

/**
 * True when a title has enough real votes to support a quality claim
 * ("well-regarded", "hidden gem", hero). Default floor is the medium
 * tier (100 votes); callers that need stronger evidence pass more.
 */
export function hasSufficientSupport(
  voteCount: number | undefined | null,
  minVotes: number = CONFIDENCE_MIN_MEDIUM_VOTES,
): boolean {
  return cleanVoteCount(voteCount) >= minVotes
}
