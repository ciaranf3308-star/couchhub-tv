// RedSilk Discover — local recommendation engine (W1, Discover CORE).
//
// Deterministic, works with NO key and NO network: every score below is
// computed from the active catalogue + the local taste model (taste.ts).
// Results are deliberately NOT just "most popular": the rating term is
// capped at 10 of ~100 points — and it is confidence-based (B10, shared
// C2 engine in recommendations.ts): a rating only earns points when
// real votes back it, so a no-vote 10.0 can never top a rail. Row
// selection caps how many titles one genre or one title-group may
// contribute, so a single franchise cannot fill a row.
//
// Seams (defined here, wired by the coordinator):
//   - AI ranker: worker W2's module registers via registerAIRanker. The
//     page only calls it for natural-language questions, and every
//     returned id is validated against the real catalogue — unknown ids
//     are dropped silently. With no ranker registered, local ranking
//     runs. This file NEVER imports `./ai/*`.
//   - Followed series: worker W3's provider registers via
//     registerFollowedProvider. The "New Episodes" row renders from it
//     when present and hides when absent. This file NEVER imports any
//     followed-series module.
//
// The pure functions (rankCandidates / searchDiscover / getDiscoverRows /
// validateRankedCandidates) take explicit data and run under vitest with
// no browser globals. The async loaders at the bottom (loadCatalogCandidates
// / loadDiscoverData) are the only part that touches the app's IndexedDB
// cache, preferences and EPG — they dynamic-import those modules so the
// pure core stays dependency-free.

import {
  summarizeTaste,
  recordFeedback,
  type TasteFeedbackAction,
  type TasteModel,
} from "@/scripts/lib/taste.ts"
import { confidenceScore, votesFor } from "./recommendations.ts"
import { normalize } from "@/scripts/lib/text.ts"

// ---------------------------------------------------------------------------
// Contract shapes (exact — the coordinator wires W2/W3 against these)
// ---------------------------------------------------------------------------

export interface DiscoverCandidate {
  id: string
  kind: "movie" | "series" | "live"
  title: string
  year?: number
  rating?: number
  /** TMDB vote count behind the rating, when the row carries one.
   * Absent means "no evidence" — never guessed (home-rails treats
   * it as zero support). Added by the Home Production Pass (W2). */
  voteCount?: number
  /** TMDb id the provider itself attached to this row (mapped from
   * the row's `tmdb` field). A title carrying one is TMDb-matched by
   * definition — its provider rating is TMDb's vote_average surfaced
   * through the provider, so the rating is vote-backed in substance
   * even though the count itself is unsurfaced (see home-rails.ts,
   * "Vote-count decision"). Absent means "no TMDb match known". */
  tmdbId?: number
  genres: string[]
  cast: string[]
  director?: string
  runtimeMinutes?: number
  overview?: string
  posterUrl?: string
  /** Backdrop artwork URL, when the row carries one (W2). */
  backdropUrl?: string
  source: "catalog" | "tmdb" | "epg"
}

export interface RankedCandidate {
  candidate: DiscoverCandidate
  score: number
  reason: string
}

export interface TasteSummary {
  favouriteGenres: string[]
  likedTitles: string[]
  dislikedTitles: string[]
  preferredRuntimeMax?: number
  pace?: string
}

export interface AIRanker {
  rank(
    query: string,
    candidates: DiscoverCandidate[],
    tasteSummary: TasteSummary
  ): Promise<RankedCandidate[]>
}

export interface FollowedEpisode {
  seriesId: string
  seriesTitle: string
  season: number
  episode: number
  episodeTitle?: string
  detectedAt: string
  posterUrl?: string
  watched: boolean
}

export interface FollowedProvider {
  getNewEpisodes(): FollowedEpisode[]
}

// ---------------------------------------------------------------------------
// Registries (AI ranker + followed-series provider)
// ---------------------------------------------------------------------------

let aiRanker: AIRanker | null = null

export function registerAIRanker(ranker: AIRanker | null): void {
  aiRanker = ranker
}

export function getAIRanker(): AIRanker | null {
  return aiRanker
}

let followedProvider: FollowedProvider | null = null

export function registerFollowedProvider(p: FollowedProvider | null): void {
  followedProvider = p
}

export function getFollowedProvider(): FollowedProvider | null {
  return followedProvider
}

// ---------------------------------------------------------------------------
// Keys, grouping, mood presets
// ---------------------------------------------------------------------------

export function candidateKey(candidate: DiscoverCandidate): string {
  return `${candidate.kind}:${candidate.id}`
}

export function candidateKeyOf(kind: string, id: string | number): string {
  return `${kind}:${String(id)}`
}

/** Title-group key: language variants of one title collapse together. */
export function titleGroupKey(candidate: DiscoverCandidate): string {
  const title = normalize(candidate.title)
  if (!title) return `id:${candidate.kind}:${candidate.id}`
  return `${title}|${candidate.year ?? ""}`
}

export interface MoodPreset {
  id: string
  label: string
  /** Single glyph shown on the quick-pick card (no image asset). */
  icon: string
  /** Genres that count as a mood match (lower-cased). */
  genres?: string[]
  kind?: "movie" | "series"
  maxRuntimeMinutes?: number
  minRating?: number
  /** Hidden gems: highly rated, but not something already watched/loved. */
  hiddenGem?: boolean
}

export const MOOD_PRESETS: MoodPreset[] = [
  { id: "surprise-me", label: "Surprise Me", icon: "✦" },
  { id: "hidden-gems", label: "Hidden Gems", icon: "◆", minRating: 7.5, hiddenGem: true },
  {
    id: "intense",
    label: "Something Intense",
    icon: "▲",
    genres: ["action", "thriller", "horror", "crime", "war", "mystery"],
  },
  {
    id: "easy",
    label: "Easy Watching",
    icon: "☀",
    genres: ["comedy", "family", "animation", "romance", "musical"],
  },
  { id: "short", label: "Short Films", icon: "◷", kind: "movie", maxRuntimeMinutes: 60 },
  { id: "binge", label: "Binge-worthy Series", icon: "▸▸", kind: "series", minRating: 7.0 },
]

/** Example natural-language prompts shown on the Discover page (B05).
 * They are plain suggestions — tapping one fills the search box and
 * submits it, exactly as if the user had typed it. */
export const EXAMPLE_PROMPTS: string[] = [
  "Something funny for tonight",
  "A gripping crime series",
  "A short film under an hour",
  "Hidden gems I haven't seen",
  "Something relaxing after a long day",
  "A feel-good film for the family",
]

export function moodPreset(id: string): MoodPreset | null {
  return MOOD_PRESETS.find((preset) => preset.id === id) ?? null
}

const INTENSE_GENRES = new Set([
  "action",
  "thriller",
  "horror",
  "crime",
  "war",
  "mystery",
])
const LIGHT_GENRES = new Set([
  "comedy",
  "family",
  "animation",
  "romance",
  "musical",
  "music",
])

/** Mood words a natural-language query may contain, mapped to presets. */
const MOOD_WORDS: Array<{ words: string[]; presetId: string }> = [
  { words: ["intense", "thrilling", "scary", "dark", "gripping", "edge"], presetId: "intense" },
  { words: ["easy", "light", "relaxing", "chill", "feel-good", "feelgood", "funny", "comedy"], presetId: "easy" },
  { words: ["short", "quick", "under an hour"], presetId: "short" },
  { words: ["binge", "series", "show", "season"], presetId: "binge" },
  { words: ["hidden", "gem", "underrated", "obscure"], presetId: "hidden-gems" },
  { words: ["surprise", "random", "anything"], presetId: "surprise-me" },
]

const NATURAL_LANGUAGE_HINTS = [
  "something",
  "in the mood",
  "feel like",
  "i want",
  "i fancy",
  "looking for",
  "suggest",
  "recommend",
  "what should",
  "tonight",
  "?",
]

/**
 * True when the query reads like a natural-language question ("something
 * intense for tonight?") rather than a plain title/keyword search. Only
 * NL questions are ever sent to a registered AI ranker.
 */
export function isNaturalLanguageQuery(query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  if (q.split(/\s+/).length > 3) return true
  return NATURAL_LANGUAGE_HINTS.some((hint) => q.includes(hint))
}

/** Preset ids whose mood words appear in the query (may be several). */
export function detectMoodPresets(query: string): MoodPreset[] {
  const q = ` ${query.trim().toLowerCase()} `
  const found: MoodPreset[] = []
  for (const { words, presetId } of MOOD_WORDS) {
    if (words.some((word) => q.includes(word))) {
      const preset = moodPreset(presetId)
      if (preset && !found.includes(preset)) found.push(preset)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Scoring (pure, deterministic — same inputs, same order, every time)
// ---------------------------------------------------------------------------

export interface RankOptions {
  /** Hard-excluded candidate keys (not-interested / disliked). */
  excludeKeys?: Set<string>
  /** Keys the profile already watched; dropped when excludeWatched. */
  watchedKeys?: Set<string>
  excludeWatched?: boolean
  /** Liked titles to cite as "because you watched" seeds. */
  seedTitles?: Array<{ title: string; genres: string[]; cast: string[]; director?: string | null }>
  /** Active mood preset(s): matched candidates get a mood bonus. */
  moods?: MoodPreset[]
  limit?: number
  /** Max titles one title-group may contribute to a row (default 1). */
  perGroupCap?: number
  /** Max titles one primary genre may contribute (default: no cap). */
  perGenreCap?: number
  nowMs?: number
}

interface Contribution {
  label: string
  points: number
}

const GENRE_MATCH_POINTS = 8
const GENRE_MATCH_CAP = 24
const CAST_MATCH_POINTS = 6
const CAST_MATCH_CAP = 18
const DIRECTOR_MATCH_POINTS = 10
const SEED_GENRE_POINTS = 12
const SEED_CAST_POINTS = 6
const SEED_DIRECTOR_POINTS = 10
const MOOD_MATCH_POINTS = 15
const RATING_MAX_POINTS = 10
const RECENCY_POINTS = 3
const RUNTIME_FIT_POINTS = 5
const RUNTIME_OVER_POINTS = -5
const PACE_MATCH_POINTS = 4
const NOVELTY_POINTS = 2
const ABANDONED_PENALTY = -15

function scoreOne(
  candidate: DiscoverCandidate,
  taste: TasteModel,
  summary: TasteSummary,
  opts: RankOptions
): { score: number; contributions: Contribution[] } | null {
  const key = candidateKey(candidate)
  if (opts.excludeKeys?.has(key)) return null
  if (opts.excludeWatched && opts.watchedKeys?.has(key)) return null
  // Explicit dislikes (weight >= 1) are hard exclusions; weak abandoned
  // signals (weight 0.5) only penalise, so a rewatch is still possible.
  const disliked = taste.dislikedTitles.find(
    (ref) => `${ref.kind}:${ref.id}` === key
  )
  if (disliked && disliked.weight >= 1) return null

  const contributions: Contribution[] = []
  const genres = candidate.genres.map((g) => g.toLowerCase())
  const genreSet = new Set(genres)
  const favGenres = new Set(summary.favouriteGenres.map((g) => g.toLowerCase()))

  let genreMatches = 0
  for (const genre of genres) {
    if (favGenres.has(genre)) genreMatches++
  }
  if (genreMatches > 0) {
    contributions.push({
      label: `Matches your taste for ${[...genreSet].filter((g) => favGenres.has(g)).slice(0, 2).join(" and ")}`,
      points: Math.min(GENRE_MATCH_CAP, genreMatches * GENRE_MATCH_POINTS),
    })
  }

  const castLower = new Set(candidate.cast.map((c) => c.toLowerCase()))
  let castMatches = 0
  let castName = ""
  for (const name of Object.keys(taste.castWeights)) {
    if (castLower.has(name)) {
      castMatches++
      if (!castName) castName = name
    }
  }
  if (castMatches > 0) {
    contributions.push({
      label: `Shares cast with titles you loved${castName ? ` (${castName})` : ""}`,
      points: Math.min(CAST_MATCH_CAP, castMatches * CAST_MATCH_POINTS),
    })
  }

  if (
    candidate.director &&
    taste.directorWeights[candidate.director.toLowerCase()]
  ) {
    contributions.push({
      label: `From ${candidate.director}, whose work you liked`,
      points: DIRECTOR_MATCH_POINTS,
    })
  }

  // "Because you watched" seeds: cite the actual seed title.
  if (opts.seedTitles?.length) {
    let bestSeed: { title: string; points: number; label: string } | null = null
    for (const seed of opts.seedTitles) {
      const seedGenres = new Set(seed.genres.map((g) => g.toLowerCase()))
      const sharedGenre = genres.some((g) => seedGenres.has(g))
      const seedCast = new Set(seed.cast.map((c) => c.toLowerCase()))
      const sharedCast = [...castLower].some((c) => seedCast.has(c))
      const sharedDirector =
        !!candidate.director &&
        !!seed.director &&
        candidate.director.toLowerCase() === seed.director.toLowerCase()
      let points = 0
      if (sharedGenre) points += SEED_GENRE_POINTS
      if (sharedCast) points += SEED_CAST_POINTS
      if (sharedDirector) points += SEED_DIRECTOR_POINTS
      if (points > 0 && (!bestSeed || points > bestSeed.points)) {
        bestSeed = {
          title: seed.title,
          points,
          label: `Because you watched ${seed.title}`,
        }
      }
    }
    if (bestSeed) {
      contributions.push({ label: bestSeed.label, points: bestSeed.points })
    }
  }

  // Mood: a match is a real signal, but it never outranks taste.
  for (const mood of opts.moods ?? []) {
    if (moodMatches(candidate, mood)) {
      contributions.push({
        label: `Fits “${mood.label}”`,
        points: MOOD_MATCH_POINTS,
      })
      break
    }
  }

  // Rating is deliberately a small term: popularity must not dominate —
  // and it is confidence-based (B10, shared C2 engine): a rating only
  // earns points when real votes back it. confidenceScore() shrinks a
  // no-vote 10.0 to the prior mean (6.5), never 10 — and with no votes
  // behind the rating at all we award no rating points and print no
  // rating-based reason, so an unproven title can never top a rail on
  // a bare "10.0". A null/unknown rating scores -Infinity in the
  // engine and earns nothing here, as before. (A TMDb match alone is
  // not evidence for this term: recommendations.ts requires a real
  // vote count before a rating counts as proven.)
  const rating =
    typeof candidate.rating === "number" &&
    Number.isFinite(candidate.rating) &&
    candidate.rating > 0
      ? Math.min(candidate.rating, 10)
      : undefined
  const votes = votesFor(candidate)
  if (rating !== undefined && votes >= 1) {
    const confidence = confidenceScore(rating, votes)
    contributions.push({
      label: `Highly rated${genres[0] ? ` ${genres[0]}` : ""} (${rating.toFixed(1)}/10)`,
      points: Math.min(RATING_MAX_POINTS, (confidence / 10) * RATING_MAX_POINTS),
    })
  }

  const nowMs = opts.nowMs ?? Date.now()
  const currentYear = new Date(nowMs).getFullYear()
  if (candidate.year && candidate.year >= currentYear - 2) {
    contributions.push({ label: "Recently released", points: RECENCY_POINTS })
  }

  if (summary.preferredRuntimeMax && candidate.runtimeMinutes) {
    if (candidate.runtimeMinutes <= summary.preferredRuntimeMax) {
      contributions.push({
        label: `About the length you usually finish (${candidate.runtimeMinutes} min)`,
        points: RUNTIME_FIT_POINTS,
      })
    } else if (candidate.runtimeMinutes > summary.preferredRuntimeMax + 60) {
      contributions.push({
        label: "Longer than you usually watch",
        points: RUNTIME_OVER_POINTS,
      })
    }
  }

  if (summary.pace === "intense" && genres.some((g) => INTENSE_GENRES.has(g))) {
    contributions.push({ label: "Matches your taste for intense viewing", points: PACE_MATCH_POINTS })
  } else if (summary.pace === "light" && genres.some((g) => LIGHT_GENRES.has(g))) {
    contributions.push({ label: "Matches your taste for easy viewing", points: PACE_MATCH_POINTS })
  }

  if (disliked && disliked.weight < 1) {
    contributions.push({
      label: "You stopped this one early before",
      points: ABANDONED_PENALTY,
    })
  }

  if (!opts.watchedKeys?.has(key)) {
    contributions.push({ label: "New to you", points: NOVELTY_POINTS })
  }

  const score = contributions.reduce((sum, c) => sum + c.points, 0)
  return { score, contributions }
}

export function moodMatches(candidate: DiscoverCandidate, mood: MoodPreset): boolean {
  if (mood.kind && candidate.kind !== mood.kind) return false
  if (mood.maxRuntimeMinutes != null) {
    // Only a match when the runtime is actually known — never guess.
    if (!candidate.runtimeMinutes) return false
    if (candidate.runtimeMinutes > mood.maxRuntimeMinutes) return false
  }
  if (mood.minRating != null) {
    if (!candidate.rating || candidate.rating < mood.minRating) return false
  }
  if (mood.hiddenGem) {
    // Hidden gem: highly rated (checked above) and not already loved —
    // the caller also excludes watched keys for this preset.
    if (!candidate.rating || candidate.rating < 7.5) return false
  }
  if (mood.genres?.length) {
    const genres = new Set(candidate.genres.map((g) => g.toLowerCase()))
    if (!mood.genres.some((g) => genres.has(g))) return false
  }
  return true
}

function buildReason(
  candidate: DiscoverCandidate,
  contributions: Contribution[]
): string {
  const ranked = [...contributions]
    .filter((c) => c.points > 0)
    .sort((a, b) => b.points - a.points)
  if (!ranked.length) {
    return candidate.kind === "live"
      ? "On now"
      : "In your library"
  }
  const top = ranked.slice(0, 2).map((c) => c.label)
  return top.join(" · ")
}

/**
 * Deterministic local ranking. Ties break on title so the same inputs
 * always produce the same order. Diversity caps keep one franchise or one
 * genre from filling the row.
 */
export function rankCandidates(
  candidates: DiscoverCandidate[],
  taste: TasteModel,
  opts: RankOptions = {}
): RankedCandidate[] {
  const summary: TasteSummary = summarizeTaste(taste)
  const limit = opts.limit ?? 12
  const perGroupCap = opts.perGroupCap ?? 1
  const scored: RankedCandidate[] = []

  for (const candidate of candidates) {
    const result = scoreOne(candidate, taste, summary, opts)
    if (!result) continue
    scored.push({
      candidate,
      score: result.score,
      reason: buildReason(candidate, result.contributions),
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.candidate.title.localeCompare(b.candidate.title)
  })

  // Diversity pass: per title-group and per primary-genre caps.
  const perGenreCap =
    opts.perGenreCap ?? Math.max(3, Math.ceil(limit / 3))
  const groupCounts = new Map<string, number>()
  const genreCounts = new Map<string, number>()
  const picked: RankedCandidate[] = []
  const deferred: RankedCandidate[] = []
  for (const item of scored) {
    const group = titleGroupKey(item.candidate)
    const genre = (item.candidate.genres[0] || "").toLowerCase()
    const groupCount = groupCounts.get(group) || 0
    const genreCount = genre ? genreCounts.get(genre) || 0 : 0
    if (groupCount >= perGroupCap || (genre && genreCount >= perGenreCap)) {
      deferred.push(item)
      continue
    }
    groupCounts.set(group, groupCount + 1)
    if (genre) genreCounts.set(genre, genreCount + 1)
    picked.push(item)
    if (picked.length >= limit) break
  }
  // Fill any remaining slots from the deferred pool (a repeat genre is
  // better than a short row), still in score order — but a title-group
  // that already hit its cap never comes back: language variants of one
  // title must not re-enter through the back door.
  for (const item of deferred) {
    if (picked.length >= limit) break
    const group = titleGroupKey(item.candidate)
    if ((groupCounts.get(group) || 0) >= perGroupCap) continue
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1)
    picked.push(item)
  }
  return picked
}

// ---------------------------------------------------------------------------
// Search + mood search (pure)
// ---------------------------------------------------------------------------

export interface SearchOptions extends RankOptions {
  moodId?: string
}

function tokenize(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    // normalize() leaves punctuation like "?" and "'" in place, so strip
    // anything non-alphanumeric here — "tonight?" must tokenize as
    // "tonight" (a stop word), not as a text token that matches nothing.
    .map((t) => t.replace(/[^a-z0-9]+/g, "").trim())
    .filter((t) => t.length > 1)
}

/** Filler words that carry no search meaning ("something to watch tonight"). */
const STOP_WORDS = new Set([
  "something",
  "anything",
  "watch",
  "tonight",
  "for",
  "the",
  "a",
  "an",
  "me",
  "us",
  "we",
  "i",
  "like",
  "fancy",
  "feel",
  "mood",
  "should",
  "what",
  "show",
  "movie",
  "film",
  "series",
  "please",
])

/** Local text match: title, genres, cast and director — no network. */
function textMatchScore(candidate: DiscoverCandidate, tokens: string[]): number {
  if (!tokens.length) return 0
  const haystacks = [
    normalize(candidate.title),
    ...candidate.genres.map((g) => normalize(g)),
    ...candidate.cast.map((c) => normalize(c)),
    normalize(candidate.director || ""),
  ]
  let score = 0
  for (const token of tokens) {
    const inTitle = normalize(candidate.title).includes(token)
    const anywhere = haystacks.some((h) => h.includes(token))
    if (!anywhere) return 0
    score += inTitle ? 30 : 12
    if (normalize(candidate.title).startsWith(token)) score += 10
  }
  return score
}

/**
 * Mood/text search over the local catalogue. Plain title queries match
 * text; mood words ("something intense", "short") also apply the matching
 * preset as a scoring boost. Returns ranked candidates, best first.
 */
export function searchDiscover(
  query: string,
  candidates: DiscoverCandidate[],
  taste: TasteModel,
  opts: SearchOptions = {}
): RankedCandidate[] {
  const trimmed = query.trim()
  const moods = [...detectMoodPresets(trimmed)]
  if (opts.moodId) {
    const preset = moodPreset(opts.moodId)
    if (preset && !moods.includes(preset)) moods.push(preset)
  }
  const tokens = tokenize(trimmed).filter(
    (t) =>
      !STOP_WORDS.has(t) &&
      !MOOD_WORDS.some(({ words }) => words.includes(t))
  )

  // "Surprise Me" is the only non-deterministic path, and it is explicit:
  // the user asked for a random pick. Everything else is ranked.
  if (moods.some((m) => m.id === "surprise-me") && !tokens.length) {
    const ranked = rankCandidates(candidates, taste, { ...opts, moods: [] })
    const pick = pickRandomCandidate(ranked, opts)
    return pick ? [pick] : ranked.slice(0, opts.limit ?? 1)
  }

  // A mood with no text tokens is a filter, not a hint: "something
  // intense" should only return intense titles. With text tokens the
  // mood is a scoring boost on top of the text match instead.
  let pool = candidates
  if (moods.length && !tokens.length) {
    const activeMoods = moods.filter((m) => m.id !== "surprise-me")
    if (activeMoods.length) {
      pool = candidates.filter((c) =>
        activeMoods.some((m) => moodMatches(c, m))
      )
    }
  } else if (tokens.length > 0) {
    pool = candidates.filter((c) => textMatchScore(c, tokens) > 0)
  }
  const ranked = rankCandidates(pool, taste, { ...opts, moods })
  if (!tokens.length) return ranked

  // Text relevance outranks taste for an explicit title search: re-sort
  // by text score first, taste score second (stable, deterministic).
  const withText = ranked.map((item) => ({
    item,
    text: textMatchScore(item.candidate, tokens),
  }))
  withText.sort((a, b) => {
    if (b.text !== a.text) return b.text - a.text
    if (b.item.score !== a.item.score) return b.item.score - a.item.score
    return a.item.candidate.title.localeCompare(b.item.candidate.title)
  })
  return withText.map((entry) => entry.item)
}

/** Explicit random pick (Surprise Me). `random` is injectable for tests. */
export function pickRandomCandidate(
  ranked: RankedCandidate[],
  opts: { random?: () => number } = {}
): RankedCandidate | null {
  if (!ranked.length) return null
  const random = opts.random ?? Math.random
  const idx = Math.floor(random() * ranked.length)
  return ranked[Math.min(Math.max(idx, 0), ranked.length - 1)] ?? null
}

// ---------------------------------------------------------------------------
// Candidate ID validation + AI ranking with local fallback
// ---------------------------------------------------------------------------

/**
 * Drop any ranked result whose candidate is not in the real catalogue.
 * Unknown ids (hallucinated or stale) disappear silently — the row just
 * shows fewer items, never a dead card.
 */
export function validateRankedCandidates(
  ranked: RankedCandidate[],
  knownCandidates: DiscoverCandidate[]
): RankedCandidate[] {
  const known = new Set(knownCandidates.map((c) => candidateKey(c)))
  return ranked.filter((item) => known.has(candidateKey(item.candidate)))
}

/**
 * Rank a shortlist, preferring the registered AI ranker when the user
 * asked a natural-language question. Any failure, empty result, or
 * unknown id falls back to the local engine — Discover never goes blank
 * because the AI path did. The returned `source` tells the page which
 * engine actually produced the results, so it can label them honestly
 * ("AI picks" vs "Local recommendations") and say when a fallback
 * happened (AI04 / AI06).
 */
export interface DiscoverSearchResult {
  results: RankedCandidate[]
  source: "ai" | "local"
  /** Set when AI was attempted but the local engine answered instead. */
  fallbackReason?: string
}

function aiFallbackReason(error: unknown): string {
  const kind = (error as { kind?: string })?.kind
  switch (kind) {
    case "invalid_key":
      return "The AI provider rejected the saved key, so these are local picks. Check the key in Settings."
    case "rate_limited":
      return "The AI provider is rate-limiting requests, so these are local picks for now."
    case "not_configured":
      return "AI isn't set up, so these are local picks."
    default:
      return "AI couldn't answer just now, so these are local picks."
  }
}

export async function rankDiscover(
  query: string,
  candidates: DiscoverCandidate[],
  taste: TasteModel
): Promise<DiscoverSearchResult> {
  const ranker = getAIRanker()
  if (ranker && isNaturalLanguageQuery(query)) {
    try {
      const summary = summarizeTaste(taste) as TasteSummary
      const ranked = await ranker.rank(query, candidates, summary)
      const valid = validateRankedCandidates(
        Array.isArray(ranked) ? ranked : [],
        candidates
      )
      if (valid.length) return { results: valid, source: "ai" }
      return {
        results: searchDiscover(query, candidates, taste),
        source: "local",
        fallbackReason: "AI didn't rank any titles in your library, so these are local picks.",
      }
    } catch (error) {
      return {
        results: searchDiscover(query, candidates, taste),
        source: "local",
        fallbackReason: aiFallbackReason(error),
      }
    }
  }
  return { results: searchDiscover(query, candidates, taste), source: "local" }
}

export async function rankWithAI(
  query: string,
  candidates: DiscoverCandidate[],
  taste: TasteModel
): Promise<RankedCandidate[]> {
  return (await rankDiscover(query, candidates, taste)).results
}

// ---------------------------------------------------------------------------
// Feedback application (Discover card controls)
// ---------------------------------------------------------------------------

/**
 * Apply a Discover feedback action to the taste model and return the new
 * model. The caller persists it (taste.saveTaste) and re-ranks. Selections
 * ("more-like-this") also count as "commonly selected recommendations":
 * they bump the candidate's selection count in the model.
 */
export function applyDiscoverFeedback(
  model: TasteModel,
  candidate: DiscoverCandidate,
  action: TasteFeedbackAction
): TasteModel {
  return recordFeedback(model, {
    kind: candidate.kind === "live" ? "live" : candidate.kind,
    id: candidate.id,
    title: candidate.title,
    action,
    genres: candidate.genres,
    cast: candidate.cast,
    director: candidate.director,
    runtimeMinutes: candidate.runtimeMinutes,
  })
}

// ---------------------------------------------------------------------------
// Rows (pure composition over already-loaded data)
// ---------------------------------------------------------------------------

export interface DiscoverRow {
  id: string
  title: string
  subtitle?: string
  items: RankedCandidate[]
  emptyReason?: string
}

export interface DiscoverRowsInput {
  candidates: DiscoverCandidate[]
  taste: TasteModel
  /** In-progress titles, most recent first (already mapped to candidates). */
  continueWatching: DiscoverCandidate[]
  /** Catalogue rows with a real `added` timestamp, newest first. */
  recentlyAdded: DiscoverCandidate[]
  /** Live channels with a REAL current programme (EPG); never invented.
   * Accepted for compatibility — Discover (0.10.0) does not render a
   * Live TV row, so loaders leave this empty. */
  nowPlaying: DiscoverCandidate[]
  /** Because-you-watched items (seed-based), when history exists. */
  becauseItems?: RankedCandidate[]
  /** New episodes from the registered followed provider, when present. */
  followedEpisodes?: FollowedEpisode[]
  excludeWatched?: boolean
  watchedKeys?: Set<string>
  limitPerRow?: number
  nowMs?: number
}

export function getDiscoverRows(input: DiscoverRowsInput): DiscoverRow[] {
  const limit = input.limitPerRow ?? 12
  const excludeWatched = input.excludeWatched ?? true
  const baseOpts: RankOptions = {
    excludeKeys: new Set(input.taste.notInterestedKeys),
    watchedKeys: input.watchedKeys,
    excludeWatched,
    limit,
    nowMs: input.nowMs,
  }
  const rows: DiscoverRow[] = []
  const hasHistory =
    input.taste.likedTitles.length > 0 || input.taste.favouriteTitles.length > 0

  // Picked for You — personalised when there is taste to learn from,
  // honestly labelled as top-rated library picks when there is not.
  const picked = rankCandidates(input.candidates, input.taste, baseOpts)
  rows.push({
    id: "picked-for-you",
    title: hasHistory ? "Picked for You" : "Highly Rated in Your Library",
    subtitle: hasHistory
      ? "Based on what you've watched and loved"
      : "No watch history yet — these are the best-rated titles in your library",
    items: picked,
    emptyReason: picked.length ? undefined : "No titles match yet",
  })

  if (input.becauseItems?.length) {
    rows.push({
      id: "because-you-watched",
      title: "Because You Watched…",
      subtitle: "More like the titles you've enjoyed",
      items: input.becauseItems.slice(0, limit),
    })
  }

  if (input.continueWatching.length) {
    rows.push({
      id: "continue-watching",
      title: "Continue Watching",
      items: input.continueWatching.slice(0, limit).map((candidate) => ({
        candidate,
        score: 100,
        reason: "Continue watching",
      })),
    })
  }

  // New and Worth Watching: recently added, best first — ranked by the
  // shared C2 confidence score (B10), never the raw rating. Titles
  // with real votes behind their rating always sort before titles
  // with none (the preferEvidence shape: evidence first, then
  // confidence) — a no-vote 10.0 scores the prior mean (6.5) in the
  // engine and can never lead while any proven title is in the row.
  // Ties keep input order, and recentlyAdded arrives newest-first, so
  // recency is the tiebreak; the raw rating never ranks. An unrated
  // title scores -Infinity in the engine and sinks to the end.
  const recentRanked = input.recentlyAdded
    .filter((c) => !baseOpts.excludeKeys?.has(candidateKey(c)))
    .filter((c) => !(excludeWatched && input.watchedKeys?.has(candidateKey(c))))
    .map((candidate, index) => ({
      candidate,
      score: confidenceScore(candidate.rating ?? null, votesFor(candidate)),
      index,
      reason: "Recently added to your library",
    }))
    .sort((a, b) => {
      const evidenceDiff =
        Number(votesFor(b.candidate) >= 1) - Number(votesFor(a.candidate) >= 1)
      if (evidenceDiff !== 0) return evidenceDiff
      if (b.score !== a.score) return b.score - a.score
      return a.index - b.index
    })
    .slice(0, limit)
    .map(({ candidate, score, reason }) => ({ candidate, score, reason }))
  if (recentRanked.length) {
    rows.push({
      id: "new-and-worth-watching",
      title: "New and Worth Watching",
      subtitle: "Recently added to your library",
      items: recentRanked,
    })
  }

  // Discover is separate from Live TV (0.10.0): there is no "On TV
  // Right Now" row here. Live listings live on the Live TV destination
  // only; `input.nowPlaying` is accepted for call-site compatibility
  // and deliberately ignored.

  // New Episodes of Followed Shows — renders only when a provider is
  // registered AND it reports episodes; otherwise the row hides.
  const followed = input.followedEpisodes ?? getFollowedProvider()?.getNewEpisodes() ?? []
  const unwatchedFollowed = followed.filter((ep) => !ep.watched)
  if (unwatchedFollowed.length) {
    rows.push({
      id: "new-episodes",
      title: "New Episodes of Followed Shows",
      subtitle: "New episodes detected since you last checked",
      items: unwatchedFollowed.slice(0, limit).map((ep) => ({
        candidate: {
          id: ep.seriesId,
          kind: "series",
          title: ep.seriesTitle,
          posterUrl: ep.posterUrl,
          genres: [],
          cast: [],
          source: "catalog",
        } satisfies DiscoverCandidate,
        score: 100,
        reason: `New: S${ep.season} E${ep.episode}${ep.episodeTitle ? ` — ${ep.episodeTitle}` : ""}`,
      })),
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Catalogue mapping (pure: provider rows -> DiscoverCandidate)
// ---------------------------------------------------------------------------

export interface ProviderRow {
  id: number | string
  name?: string
  category?: string | null
  rating?: unknown
  /** TMDB vote count, when the provider/TMDB data carries one (W2). */
  vote_count?: unknown
  /** TMDb id the provider attached to the row (Xtream `tmdb` /
   * `tmdb_id`), when one is known. Mapped rows carry it (see
   * catalog-mappers.js); absent on rows that predate the field. */
  tmdb?: unknown
  year?: unknown
  logo?: string | null
  stream_icon?: string | null
  cover?: string | null
  /** Backdrop artwork URL, when the row carries one (W2). */
  backdrop?: string | null
  plot?: string | null
  added?: number | string | null
  duration_secs?: unknown
  runtime_minutes?: unknown
}

export interface ProviderPeople {
  castNames: string[]
  directorName: string | null
}

function parseYear(value: unknown): number | undefined {
  const match = /(?:19|20)\d{2}/.exec(String(value ?? ""))
  if (!match) return undefined
  const year = Number(match[0])
  return year >= 1900 && year <= 2999 ? year : undefined
}

function parseRating(value: unknown): number | undefined {
  if (value == null || value === "") return undefined
  const n = parseFloat(String(value))
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(n, 10)
}

function parseVoteCount(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.floor(n)
}

/** TMDb id from a provider row — only a real positive id counts. */
function parseTmdbId(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.floor(n)
}

/**
 * Backdrop URL, only when the row carries a complete URL. A bare
 * TMDB path ("/abc.jpg") is not a URL — never fabricate the host.
 */
function parseBackdropUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const url = value.trim()
  return /^https?:\/\//i.test(url) ? url : undefined
}

function parseRuntimeMinutes(row: ProviderRow): number | undefined {
  const secs = Number(row.duration_secs)
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs / 60)
  const mins = Number(row.runtime_minutes)
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins)
  return undefined
}

/** One provider category string ("Action", "Comedy / Drama") -> genres. */
export function genresFromCategory(category: string | null | undefined): string[] {
  if (!category) return []
  return category
    .split(/[/,;|]/)
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 4)
}

export function catalogRowToCandidate(
  kind: "movie" | "series",
  row: ProviderRow,
  people?: ProviderPeople | null,
  infoPlot?: string | null
): DiscoverCandidate {
  return {
    id: String(row.id),
    kind,
    title: String(row.name || ""),
    year: parseYear(row.year),
    rating: parseRating(row.rating),
    voteCount: parseVoteCount(row.vote_count),
    tmdbId: parseTmdbId(row.tmdb),
    genres: genresFromCategory(row.category),
    cast: people?.castNames ?? [],
    director: people?.directorName ?? undefined,
    runtimeMinutes: parseRuntimeMinutes(row),
    overview: infoPlot || row.plot || undefined,
    posterUrl: row.logo || row.stream_icon || row.cover || undefined,
    backdropUrl: parseBackdropUrl(row.backdrop),
    source: "catalog",
  }
}

export function liveChannelToCandidate(
  channel: { id: number | string; name?: string; logo?: string | null; stream_icon?: string | null },
  nowTitle?: string | null,
  nextTitle?: string | null
): DiscoverCandidate {
  const overview = nowTitle
    ? nextTitle
      ? `Now: ${nowTitle} · Next: ${nextTitle}`
      : `Now: ${nowTitle}`
    : undefined
  return {
    id: String(channel.id),
    kind: "live",
    title: String(channel.name || ""),
    genres: [],
    cast: [],
    overview,
    posterUrl: channel.logo || channel.stream_icon || undefined,
    source: "epg",
  }
}

/** Detail/playback href for a candidate — the app's real routes. */
export function candidateDetailHref(candidate: DiscoverCandidate): string {
  if (candidate.kind === "movie") {
    return `/movies/detail?id=${encodeURIComponent(candidate.id)}`
  }
  if (candidate.kind === "series") {
    return `/series/detail?id=${encodeURIComponent(candidate.id)}`
  }
  return `/livetv?channel=${encodeURIComponent(candidate.id)}`
}

// ---------------------------------------------------------------------------
// In-memory candidate cache (parsed once per catalogue version)
// ---------------------------------------------------------------------------

interface CandidateCacheEntry {
  candidates: DiscoverCandidate[]
  fetchedAt: number
  stamp: number
}

const candidateCache = new Map<string, CandidateCacheEntry>()
const CANDIDATE_CACHE_TTL_MS = 10 * 60 * 1000

export function getCandidateCache(
  playlistId: string,
  stamp: number
): DiscoverCandidate[] | null {
  const entry = candidateCache.get(playlistId)
  if (!entry) return null
  if (entry.stamp !== stamp) return null
  if (Date.now() - entry.fetchedAt > CANDIDATE_CACHE_TTL_MS) return null
  return entry.candidates
}

export function setCandidateCache(
  playlistId: string,
  candidates: DiscoverCandidate[],
  stamp: number
): void {
  candidateCache.set(playlistId, { candidates, fetchedAt: Date.now(), stamp })
}

export function clearDiscoverCache(playlistId?: string): void {
  if (playlistId) candidateCache.delete(playlistId)
  else candidateCache.clear()
}

// ---------------------------------------------------------------------------
// Async loaders (browser only — dynamic imports keep the pure core clean)
// ---------------------------------------------------------------------------

export interface DiscoverData {
  candidates: DiscoverCandidate[]
  taste: TasteModel
  hasHistory: boolean
  watchedKeys: Set<string>
  continueWatching: DiscoverCandidate[]
  recentlyAdded: DiscoverCandidate[]
  nowPlaying: DiscoverCandidate[]
  becauseItems: RankedCandidate[]
}

function infoLookupFromRows(
  rows: Array<{ kind: string; data: unknown }>,
  prefixLength: number,
  kind: "vod" | "series",
  parseProviderPeople: (info: any) => ProviderPeople
): (id: number | string) => ProviderPeople | null {
  const map = new Map<number, ProviderPeople>()
  for (const row of rows) {
    const id = Number(row.kind.slice(prefixLength))
    if (!Number.isFinite(id)) continue
    const data = row.data as Record<string, unknown> | null
    const info =
      kind === "vod"
        ? ((data?.info ?? data?.movie_data ?? data ?? {}) as Record<string, unknown>)
        : ((data?.info ?? {}) as Record<string, unknown>)
    map.set(id, parseProviderPeople(info))
  }
  return (id) => map.get(Number(id)) || null
}

function plotFromInfoRow(
  row: { kind: string; data: unknown } | undefined,
  kind: "vod" | "series"
): string | null {
  if (!row) return null
  const data = row.data as Record<string, unknown> | null
  const info =
    kind === "vod"
      ? ((data?.info ?? data?.movie_data ?? data ?? {}) as Record<string, unknown>)
      : ((data?.info ?? {}) as Record<string, unknown>)
  const plot = info?.plot
  return typeof plot === "string" && plot.trim() ? plot.trim() : null
}

/**
 * Load + parse the active catalogue (movies + series) into candidates.
 * Parsed metadata is cached in memory per playlist+stamp so reopening
 * Discover does not re-parse thousands of entries.
 */
export async function loadCatalogCandidates(
  playlistId: string
): Promise<DiscoverCandidate[]> {
  if (!playlistId) return []
  const cache = await import("@/scripts/lib/cache.js")
  const { parseProviderPeople } = await import("@/scripts/lib/similar-local.ts")

  let stamp = 0
  try {
    stamp = (await cache.getNewestCacheTimeAsync?.(playlistId)) || 0
  } catch {
    // No cache timestamp readable: stamp stays 0, cache is bypassed.
  }
  const cached = getCandidateCache(playlistId, stamp)
  if (cached) return cached

  await Promise.all([
    cache.hydrate(playlistId, "vod"),
    cache.hydrate(playlistId, "series"),
  ])
  const vodRows: ProviderRow[] = cache.getCached(playlistId, "vod")?.data || []
  const seriesRows: ProviderRow[] = cache.getCached(playlistId, "series")?.data || []
  const [vodInfoRows, seriesInfoRows] = await Promise.all([
    cache.getCachedByKindPrefix(playlistId, "vod_info_"),
    cache.getCachedByKindPrefix(playlistId, "series_info_"),
  ])
  const vodInfo = infoLookupFromRows(vodInfoRows, "vod_info_".length, "vod", parseProviderPeople)
  const seriesInfo = infoLookupFromRows(seriesInfoRows, "series_info_".length, "series", parseProviderPeople)
  const vodPlotById = new Map<number, string>()
  for (const row of vodInfoRows) {
    const id = Number(row.kind.slice("vod_info_".length))
    const plot = plotFromInfoRow(row, "vod")
    if (Number.isFinite(id) && plot) vodPlotById.set(id, plot)
  }
  const seriesPlotById = new Map<number, string>()
  for (const row of seriesInfoRows) {
    const id = Number(row.kind.slice("series_info_".length))
    const plot = plotFromInfoRow(row, "series")
    if (Number.isFinite(id) && plot) seriesPlotById.set(id, plot)
  }

  const candidates: DiscoverCandidate[] = []
  for (const row of vodRows) {
    if (!row?.name) continue
    candidates.push(
      catalogRowToCandidate("movie", row, vodInfo(row.id), vodPlotById.get(Number(row.id)) ?? null)
    )
  }
  for (const row of seriesRows) {
    if (!row?.name) continue
    candidates.push(
      catalogRowToCandidate("series", row, seriesInfo(row.id), seriesPlotById.get(Number(row.id)) ?? null)
    )
  }

  setCandidateCache(playlistId, candidates, stamp)
  return candidates
}

/**
 * Load everything the Discover page needs in one pass: candidates, the
 * taste model (built from existing watched state + favourites), continue
 * watching, recently added, and the Because row (via the existing
 * similarity engine — reused, not duplicated).
 *
 * No network happens here beyond what the app's own cache warmup already
 * does. Discover loads no EPG and no Live TV state (0.10.0).
 */
export async function loadDiscoverData(
  playlistId: string,
  profileId: string
): Promise<DiscoverData> {
  const empty: DiscoverData = {
    candidates: [],
    taste: (await import("@/scripts/lib/taste.ts")).emptyTasteModel(profileId, playlistId),
    hasHistory: false,
    watchedKeys: new Set(),
    continueWatching: [],
    recentlyAdded: [],
    nowPlaying: [],
    becauseItems: [],
  }
  if (!playlistId) return empty

  const tasteMod = await import("@/scripts/lib/taste.ts")
  const prefs = await import("@/scripts/lib/preferences.js")
  const profiles = await import("@/scripts/lib/profiles.ts")
  const cache = await import("@/scripts/lib/cache.js")

  const candidates = await loadCatalogCandidates(playlistId)
  const byKey = new Map(candidates.map((c) => [candidateKey(c), c]))

  // --- Taste: shared store for the household profile, namespaced history
  // --- for Ciaran/Aisling (profiles.ts owns that split; we only read it).
  type SignalInput = Parameters<typeof tasteMod.buildTasteModel>[0]["signals"][number]
  type FavouriteInput = Parameters<typeof tasteMod.buildTasteModel>[0]["favourites"][number]
  const isShared = profileId === profiles.SHARED_PROFILE_ID
  let signals: SignalInput[]
  let favourites: FavouriteInput[] = []
  if (isShared) {
    await prefs.ensureLoaded()
    signals = (prefs.getWatchedSignals(playlistId, 200) || []).map((s: any) => ({
      kind: s.kind,
      id: s.id,
      name: s.name ?? null,
      seriesId: s.seriesId ?? null,
      seriesName: s.seriesName ?? null,
      updatedAt: s.updatedAt || 0,
      completed: !!s.completed,
      progressFraction: prefs.getProgressFraction(playlistId, s.kind, s.id),
    }))
    for (const kind of ["vod", "series"] as const) {
      const ids = (prefs.getFavorites(playlistId, kind as never) || new Set<number>()) as Set<number>
      for (const id of ids) {
        const meta = prefs.getFavoriteMeta(playlistId, kind, id)
        favourites.push({
          kind: kind === "vod" ? "movie" : "series",
          id,
          title: meta?.name || "",
          addedAt: Date.now(),
        })
      }
    }
  } else {
    profiles.ensureProfileClaimed(playlistId, profileId)
    signals = profiles.getProfileHistory(profileId).map((s: any) => ({
      kind: s.kind,
      id: s.id,
      name: s.name ?? null,
      seriesId: s.seriesId ?? null,
      seriesName: s.seriesName ?? null,
      updatedAt: s.updatedAt || 0,
      completed: !!s.completed,
      progressFraction: prefs.getProgressFraction(playlistId, s.kind, s.id),
    }))
    favourites = profiles.getProfileFavorites(profileId).map((f: any) => ({
      kind: f.kind === "vod" ? "movie" : "series",
      id: f.id,
      title: f.name || "",
      addedAt: f.addedAt || 0,
    }))
  }

  // Stored explicit feedback (likes/dislikes/not-interested) merges over
  // the rebuilt model so feedback survives a rebuild.
  const stored = tasteMod.loadTaste(profileId, playlistId)
  const rebuilt = tasteMod.buildTasteModel({
    profileId,
    playlistId,
    signals,
    favourites,
    resolveMeta: (kind, id) => {
      const candidate = byKey.get(`${kind}:${id}`)
      if (!candidate) return null
      return {
        genres: candidate.genres,
        cast: candidate.cast,
        director: candidate.director ?? null,
        runtimeMinutes: candidate.runtimeMinutes ?? null,
      }
    },
  })
  const taste: TasteModel = {
    ...rebuilt,
    likedTitles: tasteMod.dedupeTitleRefs([...stored.likedTitles, ...rebuilt.likedTitles]),
    dislikedTitles: tasteMod.dedupeTitleRefs([...stored.dislikedTitles, ...rebuilt.dislikedTitles]),
    notInterestedKeys: [...new Set([...stored.notInterestedKeys, ...rebuilt.notInterestedKeys])],
    favouriteTitles: tasteMod.dedupeTitleRefs([...stored.favouriteTitles, ...rebuilt.favouriteTitles]),
    selectedRecommendations: { ...rebuilt.selectedRecommendations, ...stored.selectedRecommendations },
  }

  const watchedKeys = new Set<string>()
  for (const signal of signals) {
    if (signal.kind === "vod") watchedKeys.add(`movie:${signal.id}`)
    else if (signal.seriesId != null) watchedKeys.add(`series:${signal.seriesId}`)
  }
  for (const fav of favourites) watchedKeys.add(`${fav.kind}:${fav.id}`)

  // --- Continue Watching (existing progress store, mapped to candidates).
  const continueWatching: DiscoverCandidate[] = []
  for (const row of prefs.getContinueWatching(playlistId, 12) || []) {
    const key =
      row.kind === "vod" ? `movie:${row.id}` : row.seriesId != null ? `series:${row.seriesId}` : ""
    const candidate = key ? byKey.get(key) : undefined
    if (candidate) continueWatching.push(candidate)
  }

  // --- Recently added: catalogue rows carrying a real `added` timestamp.
  const vodRows: ProviderRow[] = cache.getCached(playlistId, "vod")?.data || []
  const seriesRows: ProviderRow[] = cache.getCached(playlistId, "series")?.data || []
  const recentlyAdded = [...vodRows, ...seriesRows]
    .filter((row) => row && Number(row.added) > 0)
    .sort((a, b) => Number(b.added) - Number(a.added))
    .slice(0, 24)
    .map((row) => {
      const kind = vodRows.includes(row) ? "movie" : "series"
      return byKey.get(`${kind}:${row.id}`)
    })
    .filter((c): c is DiscoverCandidate => !!c)

  // --- On TV Right Now is NOT loaded here (0.10.0): Discover is
  // --- separate from Live TV. nowPlaying stays empty; Live listings
  // --- live on the Live TV destination only.

  // --- Because You Watched: the existing similarity engine, seeded from
  // --- the profile's most recent watched titles.
  let becauseItems: RankedCandidate[] = []
  try {
    const { pickBecauseSeedPool, buildBecauseRow } = await import(
      "@/scripts/lib/because-watched.ts"
    )
    const { parseProviderPeople } = await import("@/scripts/lib/similar-local.ts")
    const seeds = pickBecauseSeedPool(
      signals.map((s: any) => ({
        kind: s.kind,
        id: s.id,
        name: s.name ?? null,
        seriesId: s.seriesId ?? null,
        seriesName: s.seriesName ?? null,
        updatedAt: s.updatedAt || 0,
        completed: !!s.completed,
      })),
      3
    )
    const [vodInfoRows, seriesInfoRows] = await Promise.all([
      cache.getCachedByKindPrefix(playlistId, "vod_info_"),
      cache.getCachedByKindPrefix(playlistId, "series_info_"),
    ])
    const vodInfo = infoLookupFromRows(vodInfoRows, "vod_info_".length, "vod", parseProviderPeople)
    const seriesInfo = infoLookupFromRows(seriesInfoRows, "series_info_".length, "series", parseProviderPeople)
    const seen = new Set<string>()
    for (const seed of seeds) {
      const kind = seed.kind === "series" ? "series" : "vod"
      const catalog = kind === "vod" ? vodRows : seriesRows
      const rows = buildBecauseRow(seed as never, catalog as never, {
        limit: 6,
        infoLookup: kind === "vod" ? vodInfo : seriesInfo,
        isWatched: (id: number | string) =>
          watchedKeys.has(`${kind === "vod" ? "movie" : "series"}:${id}`),
      })
      for (const row of rows as ProviderRow[]) {
        const candidate = byKey.get(`${kind === "vod" ? "movie" : "series"}:${row.id}`)
        if (!candidate || seen.has(candidateKey(candidate))) continue
        seen.add(candidateKey(candidate))
        becauseItems.push({
          candidate,
          score: 80,
          reason: `Because you watched ${seed.name}`,
        })
      }
      if (becauseItems.length >= 12) break
    }
  } catch {
    becauseItems = []
  }

  return {
    candidates,
    taste,
    hasHistory: signals.length > 0 || favourites.length > 0,
    watchedKeys,
    continueWatching,
    recentlyAdded,
    nowPlaying: [],
    becauseItems: becauseItems.slice(0, 12),
  }
}
