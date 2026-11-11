// RedSilk — C2 shared recommendation engine (0.10.0, W4).
//
// The single place Home, Movies, Series and Discover select, rank and
// explain recommendations through. It WRAPS the existing
// rating-confidence.ts (Bayesian prior mean 6.5, prior weight 100) —
// it does not fork a second scoring system.
//
// Honesty rules (H02 / H05 / B10):
// - A rating with no votes behind it is not evidence. confidenceScore()
//   returns -Infinity for a null/unknown rating so an unrated title can
//   never headline, and isHeadlineEligible() requires real votes.
// - Vote counts and ratings are NEVER fabricated here. A missing count
//   is zero evidence, never a guess. (Note for callers: a TMDb-matched
//   title whose provider rating IS TMDb's vote_average is still not
//   headline-eligible through this module until a real vote count is
//   surfaced for it — see home-rails.ts "Vote-count decision".)
// - explain() cites only real preference/viewing/feedback signals
//   (TasteSignals, from taste.ts). Weak or absent evidence returns
//   null and the caller MUST use a neutral label (see neutralLabel()).
//
// Pure and testable: no UI, no network, no AI requests from this
// layer. The only storage touch is trackExposure()'s localStorage
// counter, guarded so every other function runs under node/vitest.

import {
  bayesianRating,
  hasSufficientSupport,
  CONFIDENCE_MIN_MEDIUM_VOTES,
} from "./rating-confidence.ts"
import { kindLabel, type ContentKind } from "./taxonomy.ts"
import type { TasteSignals } from "./taste.ts"

export type { TasteSignals }

/** localStorage key for the exposure counter (B07). */
export const EXPOSURE_STORAGE_KEY = "rs-reco-exposure-v1"

/** Max distinct titles kept in the exposure counter (oldest-lowest pruned). */
export const EXPOSURE_MAX_TITLES = 500

/** A title carrying a rating and, when known, the votes behind it. */
export interface RatedItem {
  rating?: number | null
  voteCount?: number | null
  /** Alternate spellings carried by catalogue rows. */
  votes?: number | null
  vote_count?: number | null
  /** TMDb match flag — noted, but NOT counted as votes (see header). */
  tmdbId?: number | null
}

/** Clean a rating: finite and > 0, clamped to 10, else undefined. */
function cleanRating(rating: number | null | undefined): number | undefined {
  if (typeof rating !== "number" || !Number.isFinite(rating)) return undefined
  if (rating <= 0) return undefined
  return Math.min(rating, 10)
}

/** Votes behind a rating, from whichever field the row carries. */
export function votesFor(item: RatedItem): number {
  for (const v of [item.voteCount, item.votes, item.vote_count]) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v))
  }
  return 0
}

/**
 * Confidence-adjusted score for a title: the Bayesian rating from
 * rating-confidence.ts (prior mean 6.5, prior weight 100).
 *
 * - Null / unknown / non-positive rating -> -Infinity. An unrated
 *   title is never a headline, whatever else it has going for it.
 * - A high rating with no votes shrinks to the prior mean (6.5): a
 *   10.0 from nobody scores below any well-supported 8.0.
 */
export function confidenceScore(rating: number | null, votes: number | null): number {
  const clean = cleanRating(rating)
  if (clean === undefined) return -Infinity
  return bayesianRating(clean, votes)
}

/**
 * True when a title may headline a rail / hero on quality grounds:
 * it has a real rating AND at least `minVotes` real votes behind it
 * (default 100, the medium confidence tier).
 *
 * A 10.0 with no votes is NEVER eligible. A TMDb-matched title with
 * no surfaced vote count is not eligible either — the count must be
 * real and present, never assumed from the match.
 */
export function isHeadlineEligible(item: RatedItem, minVotes: number = CONFIDENCE_MIN_MEDIUM_VOTES): boolean {
  if (cleanRating(item.rating) === undefined) return false
  return hasSufficientSupport(votesFor(item), minVotes)
}

/** Keep only the headline-eligible items, in original order. */
export function filterHeadlineEligible<T extends RatedItem>(items: T[], minVotes?: number): T[] {
  return items.filter((item) => isHeadlineEligible(item, minVotes))
}

/**
 * Rank items by confidence score, highest first. Stable: equal scores
 * keep their input order. Unrated items (score -Infinity) sink to the
 * end rather than being dropped — callers filter them when a rail
 * must only show rated titles.
 */
export function sortByConfidence<T extends RatedItem>(items: T[]): T[] {
  return [...items]
    .map((item, index) => ({ item, index, score: confidenceScore(item.rating ?? null, votesFor(item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item)
}

/**
 * Evidence preference for the ROW layer (Movies / Series rails, C2).
 *
 * MovieRow / SeriesRow carry no vote counts — the only evidence
 * signal they have is the provider's TMDb link (`tmdb`): a linked
 * title's rating is TMDb's vote_average surfaced through the
 * provider, an unlinked title's rating is unproven. Prefer linked
 * titles whenever any qualify; fall back to the full pool only when
 * NONE is linked, so a library with no TMDb links never empties —
 * a no-vote 10.0 with no link can never outrank a proven title, but
 * it is not deleted from the catalogue (the grid and the factual
 * rails still list it). Same Tier 1-else-Tier 2 shape as
 * qualityPool in home-rails.ts, at the evidence the row layer has.
 */
export function preferEvidence<T extends { tmdb?: number | null }>(rows: T[]): T[] {
  const backed = rows.filter((row) => typeof row.tmdb === "number" && row.tmdb > 0)
  return backed.length ? backed : rows
}

// ---------------------------------------------------------------------------
// Explanations (H05) — real signals only, else null
// ---------------------------------------------------------------------------

/** A candidate explain() can reason about. */
export interface ExplainableItem {
  id?: string | number
  title?: string
  kind?: ContentKind | string
  genre?: string
  genres?: string[]
  cast?: string[]
  director?: string | null
}

/** Minimum genre affinity weight explain() will cite (one liked title). */
export const EXPLAIN_MIN_GENRE_WEIGHT = 1
/** Minimum cast affinity weight explain() will cite. */
export const EXPLAIN_MIN_CAST_WEIGHT = 0.8
/** Minimum director affinity weight explain() will cite. */
export const EXPLAIN_MIN_DIRECTOR_WEIGHT = 1

function titleCaseWord(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word
}

/** "sci-fi" -> "Sci-Fi", "true crime" -> "True Crime". */
function displayGenre(genre: string): string {
  return genre
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ")
    .replace(/Sci-fi/i, "Sci-Fi")
}

function itemGenres(item: ExplainableItem): string[] {
  const genres = [...(item.genres ?? [])]
  if (item.genre) genres.push(item.genre)
  return genres.map((g) => String(g).trim()).filter(Boolean)
}

function itemKey(item: ExplainableItem): string | null {
  if (item.id === undefined || item.id === null || item.id === "") return null
  const kind = typeof item.kind === "string" && item.kind ? item.kind : "movie"
  return `${kind}:${String(item.id)}`
}

/**
 * A real, signal-backed reason this title is being recommended — or
 * null when the evidence is too weak to claim one. Null is a real
 * answer: the caller MUST then use a neutral label (neutralLabel()),
 * never invent a reason.
 *
 * What counts as evidence, strongest first:
 *  1. Because-watched seed: the candidate shares a genre with the
 *     seed title the household actually watched.
 *  2. Cast: the candidate stars someone with real cast affinity
 *     (>= 0.8 — at least one liked title featuring them).
 *  3. Director: the candidate is directed by someone with real
 *     director affinity (>= 1).
 *  4. Genre: the candidate's genre carries real affinity (>= 1 —
 *     at least one liked title in that genre).
 *
 * What NEVER produces a reason: a bare open (not a like), an
 * abandoned title, a single weak weight below the floors above, a
 * genre/cast/director the household has no affinity for, a candidate
 * that is itself already liked/favourited (no discovery reason), or
 * a disliked / not-interested title. No signals at all -> null.
 */
export function explain(item: ExplainableItem, signals: TasteSignals | null | undefined): string | null {
  if (!signals) return null
  const key = itemKey(item)
  if (key) {
    if (signals.notInterestedKeys?.includes(key)) return null
    const disliked = (signals.dislikedTitles ?? []).some(
      (ref) => `${ref.kind}:${String(ref.id)}` === key,
    )
    if (disliked) return null
    // Already liked/favourited: known, not a discovery — no reason to cite.
    const alreadyKnown = [...(signals.likedTitles ?? []), ...(signals.favouriteTitles ?? [])].some(
      (ref) => `${ref.kind}:${String(ref.id)}` === key,
    )
    if (alreadyKnown) return null
  }

  const genres = itemGenres(item)
  const lowerGenres = genres.map((g) => g.toLowerCase())

  // 1. Because-watched seed — the candidate shares a genre with the
  //    title actually watched. The seed's genres are the cited link;
  //    a seed with no genres cites nothing.
  const seed = signals.seedTitle
  if (seed?.title?.trim() && seed.genres?.length) {
    const seedGenres = new Set(seed.genres.map((g) => g.toLowerCase()))
    if (lowerGenres.some((g) => seedGenres.has(g))) {
      return `Because you watched ${seed.title.trim()}`
    }
  }

  // 2. Cast — use the candidate's own spelling of the name (affinity
  //    keys are lower-cased, so never print the key itself).
  const castWeights = signals.castWeights ?? {}
  for (const name of item.cast ?? []) {
    const weight = castWeights[String(name).trim().toLowerCase()]
    if (typeof weight === "number" && weight >= EXPLAIN_MIN_CAST_WEIGHT) {
      return `Starring ${String(name).trim()}`
    }
  }

  // 3. Director.
  const directorWeights = signals.directorWeights ?? {}
  if (item.director) {
    const weight = directorWeights[String(item.director).trim().toLowerCase()]
    if (typeof weight === "number" && weight >= EXPLAIN_MIN_DIRECTOR_WEIGHT) {
      return `Directed by ${String(item.director).trim()}`
    }
  }

  // 4. Genre — the strongest matching affinity wins.
  const genreWeights = signals.genreWeights ?? {}
  let bestGenre: string | null = null
  let bestWeight = -Infinity
  for (const genre of genres) {
    const weight = genreWeights[genre.toLowerCase()]
    if (typeof weight === "number" && weight >= EXPLAIN_MIN_GENRE_WEIGHT && weight > bestWeight) {
      bestWeight = weight
      bestGenre = genre
    }
  }
  if (bestGenre) return `Because you liked ${displayGenre(bestGenre)}`

  return null
}

/**
 * Neutral label for a recommendation when explain() returns null.
 * Genre is an attribute here, never a claimed reason: "Featured
 * Crime Series" says what the title is, not why it was picked.
 */
export function neutralLabel(item: ExplainableItem): string {
  const kind = (typeof item.kind === "string" ? item.kind : "movie") as ContentKind
  const label = kindLabel(kind)
  const genres = itemGenres(item)
  if (genres.length) return `Featured ${displayGenre(genres[0])} ${label}`
  return `Featured ${label}`
}

// ---------------------------------------------------------------------------
// Exposure tracking + diversification (B07)
// ---------------------------------------------------------------------------

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined"
}

interface ExposureStore {
  version: 1
  counts: Record<string, number>
  updatedAt: number
}

/** Read the stored exposure counts ({} when nothing is stored). */
export function readExposure(): Record<string, number> {
  if (!storageAvailable()) return {}
  try {
    const raw = localStorage.getItem(EXPOSURE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<ExposureStore>
    if (!parsed || typeof parsed !== "object" || !parsed.counts) return {}
    const counts: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.counts)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        counts[key] = Math.floor(value)
      }
    }
    return counts
  } catch {
    return {}
  }
}

/** Times one title id has been shown in a recommendation rail. */
export function exposureCount(id: string): number {
  return readExposure()[id] ?? 0
}

/**
 * Record that these title ids were shown in recommendation rails, so
 * the same small group of titles stops dominating Home and Browse.
 * Stored as counts under `rs-reco-exposure-v1`; capped at
 * EXPOSURE_MAX_TITLES titles (lowest counts pruned first). Safe to
 * call with no storage (node tests, private mode) — it no-ops.
 */
export function trackExposure(ids: string[]): void {
  if (!storageAvailable()) return
  const counts = readExposure()
  for (const id of ids) {
    const key = String(id)
    if (!key) continue
    counts[key] = (counts[key] ?? 0) + 1
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const pruned: Record<string, number> = {}
  for (const [key, value] of entries.slice(0, EXPOSURE_MAX_TITLES)) {
    pruned[key] = value
  }
  try {
    localStorage.setItem(
      EXPOSURE_STORAGE_KEY,
      JSON.stringify({ version: 1, counts: pruned, updatedAt: Date.now() } satisfies ExposureStore),
    )
  } catch {
    // Storage full / unavailable: exposure stays in memory only.
  }
}

/** Identity of one item inside a rail, for the diversify cap. */
export function diversifyKey(item: unknown): string | null {
  if (typeof item === "string") return item.trim() ? `s:${item.trim()}` : null
  if (typeof item === "number" && Number.isFinite(item)) return `n:${item}`
  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>
    if (obj.key !== undefined && obj.key !== null && obj.key !== "") {
      return `k:${String(obj.key)}`
    }
    if (obj.id !== undefined && obj.id !== null && obj.id !== "") {
      return `id:${String(obj.id)}`
    }
    if (typeof obj.title === "string" && obj.title.trim()) {
      return `t:${obj.title.trim().toLowerCase()}`
    }
  }
  return null
}

/**
 * Diversify recommendation rails (B07): the same title may appear in
 * at most `maxPerTitle` rails (default 2) and never in adjacent rails.
 * Order inside each rail is preserved; rails keep their positions
 * (an emptied rail stays an empty list). Items with no identifiable
 * key can never be recognised as repeats, so they are always kept.
 */
export function diversify<T>(lists: T[][], maxPerTitle: number = 2): T[][] {
  const cap = Math.max(1, Math.floor(maxPerTitle) || 2)
  const counts = new Map<string, number>()
  const lastKeptRail = new Map<string, number>()
  return lists.map((list, railIndex) => {
    const kept: T[] = []
    for (const item of list ?? []) {
      const key = diversifyKey(item)
      if (key === null) {
        kept.push(item)
        continue
      }
      if ((counts.get(key) ?? 0) >= cap) continue
      if (lastKeptRail.get(key) === railIndex - 1) continue
      kept.push(item)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      lastKeptRail.set(key, railIndex)
    }
    return kept
  })
}
