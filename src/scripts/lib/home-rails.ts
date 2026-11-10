// RedSilk Home — Home rails data layer (W2, Home Production Pass).
//
// The data API the Home view (W3) consumes. Pure composition over the
// data loadDiscoverData already loads (DiscoverData) plus the followed
// episodes the Followed provider reports — no new data sources, no
// network, no paid AI request anywhere on this path. Routine browsing
// is ranked by the local engine (discover.ts rankCandidates) with a
// confidence adjustment (rating-confidence.ts); the AI ranker seam is
// never touched per homepage load.
//
// Honesty rules, enforced in code:
//   - A rail is omitted entirely when it has nothing real to show —
//     never an empty shell, never padded with lookalikes.
//   - Continue Watching and Recently Added are factual rails: their
//     items are never labelled as AI-generated or personalised.
//   - Recently Added only ever shows titles with a real catalogue
//     `added` timestamp (DiscoverData.recentlyAdded). When there is
//     none, the rail hides — "recently added" is never claimed on
//     weak evidence.
//   - Short & Sweet only ever shows films whose runtime is actually
//     known (runtimeMinutes > 0). No runtime, no card.
//   - Tonight's Picks only includes live programmes when real EPG
//     data exists (DiscoverData.nowPlaying). No guide, no live cards.
//   - Only titles with a valid playback target (a detail/play href
//     resolving to real catalogue content) are returned. Trending
//     extras that match nothing in the catalogue are dropped.
//   - No hardcoded demo content. No invented titles.
//   - Not Interested suppresses a title from every personalised
//     section. Already Watched (including the explicit
//     already-watched feedback, which leaves no progress signal)
//     keeps a title out of recommendations. More Like This boosts
//     similar titles through the engine's seed mechanism.
//
// Dedupe rule: one candidate key appears in at most 2 rails, and
// never in adjacent rails — unless one of the two is Continue
// Watching or Continue Your Series (resumption is not a
// recommendation, so a series may sit in both). The "best of" rails
// (Trending, Hidden Gems, Tonight's Picks, Short & Sweet) also fill
// fresh-first: titles not yet placed anywhere lead, and titles
// already in one rail only fill gaps. That keeps each rail surfacing
// something new and stops the last rails (genre rails) starving on
// a small library, where the top titles would otherwise be consumed
// twice before the genre rails are even built.
//
// Caching: getCachedHomeRails() is synchronous and returns the last
// computed payload (module cache, then localStorage) so Home paints
// instantly. loadHomeRails() recomputes from fresh data; on any error
// it returns the cached payload rather than throwing valid content
// away.
//
// Progress rows and trending extras are optional: HomeView already
// loads them (preferences.getContinueWatching, loadTrending), and
// passing them in lets this module show real progress bars and real
// trending titles. Without them the rails still build from
// DiscoverData alone (progress unknown, trending derived from
// vote-backed popularity instead).

import {
  candidateDetailHref,
  candidateKey,
  rankCandidates,
  type DiscoverCandidate,
  type DiscoverData,
  type FollowedEpisode,
  type RankedCandidate,
} from "@/scripts/lib/discover.ts"
import {
  bayesianRating,
  hasSufficientSupport,
} from "./rating-confidence.ts"

// ---------------------------------------------------------------------------
// Contract (W3 builds against these — do not rename)
// ---------------------------------------------------------------------------

export type HomeRailKind =
  | "continue-watching"
  | "new-episodes"
  | "next-obsession"
  | "trending"
  | "hidden-gems"
  | "tonight"
  | "recently-added"
  | "continue-series"
  | "short"
  | "genre"

export interface HomeRailItem {
  key: string
  kind: "movie" | "series" | "live"
  id: string | number
  title: string
  year?: number
  posterUrl?: string
  backdropUrl?: string
  rating?: number
  voteCount?: number
  runtimeMinutes?: number
  progress?: number
  season?: number
  episode?: number
  episodeTitle?: string
  detectedAt?: string
  detailHref: string
  playHref?: string
  reason?: string
  isLive?: boolean
  nowTitle?: string
  nextTitle?: string
}

export interface HomeRail {
  id: string
  kind: HomeRailKind
  title: string
  description?: string
  items: HomeRailItem[]
  seeAllHref?: string
}

export interface HomeHero {
  item: HomeRailItem
  reason?: string
}

export interface HomePayload {
  hero: HomeHero | null
  rails: HomeRail[]
}

// The public functions getCachedHomeRails() and loadHomeRails(data,
// followed, extras?) are implemented below. `extras` is optional, so
// the two-argument call in the contract works as written.

// ---------------------------------------------------------------------------
// Tunables (documented in one place)
// ---------------------------------------------------------------------------

/** Max cards per rail. */
export const HOME_RAILS_LIMIT = 12
/** A title may appear in at most this many rails. */
export const HOME_MAX_RAILS_PER_TITLE = 2
/** Minimum Bayesian rating for the hero. */
export const HERO_MIN_BAYESIAN = 7.0
/** Minimum real votes for the hero (medium confidence tier). */
export const HERO_MIN_VOTES = 100
/** Minimum Bayesian rating for Hidden Gems. */
export const GEM_MIN_BAYESIAN = 7.5
/** Minimum real votes for Hidden Gems. */
export const GEM_MIN_VOTES = 100
/** Minimum Bayesian rating for Trending (fallback source). */
export const TRENDING_MIN_BAYESIAN = 7.0
/** Minimum real votes for Trending (fallback source). */
export const TRENDING_MIN_VOTES = 100
/** Minimum Bayesian rating for Short & Sweet. */
export const SHORT_MIN_BAYESIAN = 7.0
/** Minimum real votes for Short & Sweet. */
export const SHORT_MIN_VOTES = 100
/** "Short" means under two hours, on verified runtime only. */
export const SHORT_MAX_RUNTIME_MINUTES = 120
/** Minimum Bayesian rating for the Prestige Drama genre rail. */
export const PRESTIGE_DRAMA_MIN_BAYESIAN = 7.5
/** Minimum real votes for the Prestige Drama genre rail. */
export const PRESTIGE_DRAMA_MIN_VOTES = 100
/** A genre rail needs at least this many titles to be worth showing. */
export const GENRE_RAIL_MIN_ITEMS = 4
/** At most this many genre rails per launch — never all of them. */
export const GENRE_RAILS_MAX = 3
/** Tonight's Picks needs at least this many cards or it hides. */
export const TONIGHT_MIN_ITEMS = 3
/** Recently shown hero keys remembered to avoid repetition. */
export const HERO_HISTORY_MAX = 10
/** Small bonus so a title with a real backdrop wins the hero over an equal one. */
const HERO_BACKDROP_BONUS = 2
/** Small bonus so an in-progress title wins the hero over an equal one. */
const HERO_CONTINUE_BONUS = 5

// ---------------------------------------------------------------------------
// Optional extras (everything here already exists in the app; nothing new)
// ---------------------------------------------------------------------------

/**
 * One row from preferences.getContinueWatching() — the shape the app
 * already returns (kind/position/duration/episode routing). Mirrors
 * couch-home's HomeProgressRow structurally so this module stays
 * independent of the 0.5.0 assembly layer.
 */
export interface HomeProgressInput {
  kind: "vod" | "episode" | "live"
  id: string | number
  position?: number
  duration?: number
  completed?: boolean
  updatedAt?: number
  seriesId?: string | number | null
  seriesName?: string | null
  season?: number | null
  episodeNum?: number | null
  episodeTitle?: string | null
}

/** One catalogue-matched trending title, e.g. from loadTrending(). */
export interface HomeTrendingInput {
  kind: "movie" | "series"
  id: string | number
  title: string
  year?: number
  rating?: number
  posterUrl?: string
}

export interface LoadHomeRailsExtras {
  /** Progress rows for real Continue Watching / Continue Your Series cards. */
  progressRows?: HomeProgressInput[]
  /** Trending titles already matched to the catalogue (unmatched ones are dropped). */
  trending?: HomeTrendingInput[]
  /** Injectable clock (tests); defaults to Date.now(). */
  nowMs?: number
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanTitle(title: string | undefined | null): string {
  return (title || "").trim()
}

/** Sane year, or undefined when the catalogue year cannot be trusted. */
function cleanYear(year: number | undefined | null, nowMs: number): number | undefined {
  if (typeof year !== "number" || !Number.isFinite(year)) return undefined
  const currentYear = new Date(nowMs).getFullYear()
  if (year < 1900 || year > currentYear + 1) return undefined
  return year
}

function progressFraction(row: HomeProgressInput): number | undefined {
  if (!row.duration || row.duration <= 0) return undefined
  const fraction = (row.position || 0) / row.duration
  if (!Number.isFinite(fraction) || fraction <= 0) return undefined
  return Math.max(0, Math.min(1, fraction))
}

function withAutoplay(href: string): string {
  return href.includes("?") ? `${href}&autoplay=1` : `${href}?autoplay=1`
}

function candidateToItem(
  candidate: DiscoverCandidate,
  overrides: Partial<HomeRailItem> = {},
): HomeRailItem {
  const detailHref = candidateDetailHref(candidate)
  return {
    key: candidateKey(candidate),
    kind: candidate.kind,
    id: candidate.id,
    title: candidate.title,
    year: candidate.year,
    posterUrl: candidate.posterUrl,
    backdropUrl: candidate.backdropUrl,
    rating: candidate.rating,
    voteCount: candidate.voteCount,
    runtimeMinutes: candidate.runtimeMinutes,
    detailHref,
    playHref:
      candidate.kind === "live" ? detailHref : withAutoplay(detailHref),
    ...overrides,
  }
}

/**
 * Parse the "Now: X · Next: Y" overview liveChannelToCandidate builds
 * (discover.ts) back into its parts. Returns empty when the overview
 * is not in that shape — the caller falls back to the raw overview.
 */
function parseNowNext(overview: string | undefined): {
  nowTitle?: string
  nextTitle?: string
} {
  if (!overview) return {}
  const withNext = /^Now: (.+?) · Next: (.+)$/.exec(overview)
  if (withNext) {
    return { nowTitle: withNext[1]?.trim(), nextTitle: withNext[2]?.trim() }
  }
  const nowOnly = /^Now: (.+)$/.exec(overview)
  if (nowOnly) return { nowTitle: nowOnly[1]?.trim() }
  return {}
}

/** Detail URL for a followed episode (autoplay: a new episode is Watch Now). */
export function newEpisodeHref(episode: FollowedEpisode): string {
  const params = new URLSearchParams({ id: String(episode.seriesId) })
  params.set("season", String(episode.season))
  params.set("epnum", String(episode.episode))
  params.set("autoplay", "1")
  return `/series/detail?${params.toString()}`
}

/**
 * Confidence-adjusted rank score: rankCandidates' rating term is the
 * raw catalogue rating, so a no-vote 10.0 would outscore a
 * well-supported 8.0 on rating alone. Swap the raw term for the
 * Bayesian term — the rest of the score (taste, seeds, mood, recency)
 * is untouched, so personalisation still decides between titles of
 * equal proven quality.
 */
function confidenceAdjustedScore(item: RankedCandidate): number {
  const raw = item.candidate.rating
  const rawPoints =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.min(10, raw)
      : 0
  const bayesianPoints = bayesianRating(
    item.candidate.rating,
    item.candidate.voteCount,
  )
  return item.score - rawPoints + bayesianPoints
}

function byAdjustedScore(a: RankedCandidate, b: RankedCandidate): number {
  const scoreDiff = confidenceAdjustedScore(b) - confidenceAdjustedScore(a)
  if (scoreDiff !== 0) return scoreDiff
  const bayesDiff =
    bayesianRating(b.candidate.rating, b.candidate.voteCount) -
    bayesianRating(a.candidate.rating, a.candidate.voteCount)
  if (bayesDiff !== 0) return bayesDiff
  return a.candidate.title.localeCompare(b.candidate.title)
}

// ---------------------------------------------------------------------------
// Dedupe tracker (the at-most-2-rails / never-adjacent rule)
// ---------------------------------------------------------------------------

const ADJACENCY_EXEMPT_RAILS = new Set(["continue-watching", "continue-series"])

class PlacementTracker {
  private counts = new Map<string, number>()
  private lastRailIndex = new Map<string, number>()
  private lastRailId = new Map<string, string>()

  canPlace(key: string, railIndex: number, railId: string): boolean {
    if ((this.counts.get(key) || 0) >= HOME_MAX_RAILS_PER_TITLE) return false
    const last = this.lastRailIndex.get(key)
    // Already in this rail: a title never appears twice in one row
    // (this also makes fresh-first two-pass loops safe).
    if (last !== undefined && last === railIndex) return false
    if (last !== undefined && last === railIndex - 1) {
      // Adjacent rails — allowed only when resumption is involved
      // (this rail or the previous one is Continue Watching /
      // Continue Your Series).
      if (ADJACENCY_EXEMPT_RAILS.has(railId)) return true
      const prevId = this.lastRailId.get(key)
      if (prevId && ADJACENCY_EXEMPT_RAILS.has(prevId)) return true
      return false
    }
    return true
  }

  place(key: string, railIndex: number, railId: string): void {
    this.counts.set(key, (this.counts.get(key) || 0) + 1)
    this.lastRailIndex.set(key, railIndex)
    this.lastRailId.set(key, railId)
  }

  count(key: string): number {
    return this.counts.get(key) || 0
  }
}

// ---------------------------------------------------------------------------
// Cache (module + localStorage) + hero history
// ---------------------------------------------------------------------------

const PAYLOAD_STORAGE_KEY = "nylah_home_rails_v1"
const HERO_HISTORY_STORAGE_KEY = "nylah_home_hero_history_v1"

let moduleCache: HomePayload | null = null
let heroHistory: string[] = []

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined"
}

function readStoredPayload(): HomePayload | null {
  if (!storageAvailable()) return null
  try {
    const raw = localStorage.getItem(PAYLOAD_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HomePayload>
    if (!parsed || !Array.isArray(parsed.rails)) return null
    return {
      hero: parsed.hero ?? null,
      rails: parsed.rails,
    }
  } catch {
    return null
  }
}

function writeStoredPayload(payload: HomePayload): void {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(PAYLOAD_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Storage full / unavailable: the module cache still serves.
  }
}

function readStoredHeroHistory(): string[] {
  if (!storageAvailable()) return []
  try {
    const raw = localStorage.getItem(HERO_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === "string")
  } catch {
    return []
  }
}

function writeStoredHeroHistory(): void {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(
      HERO_HISTORY_STORAGE_KEY,
      JSON.stringify(heroHistory.slice(0, HERO_HISTORY_MAX)),
    )
  } catch {
    // History is a nicety; losing it never breaks the hero.
  }
}

function currentHeroHistory(): string[] {
  if (!heroHistory.length) {
    const stored = readStoredHeroHistory()
    if (stored.length) heroHistory = stored
  }
  return heroHistory
}

function recordHeroShown(key: string): void {
  heroHistory = [key, ...heroHistory.filter((k) => k !== key)].slice(
    0,
    HERO_HISTORY_MAX,
  )
  writeStoredHeroHistory()
}

/** Test helper (also useful on profile switch): clear every cache. */
export function clearHomeRailsCache(): void {
  moduleCache = null
  heroHistory = []
  if (!storageAvailable()) return
  try {
    localStorage.removeItem(PAYLOAD_STORAGE_KEY)
    localStorage.removeItem(HERO_HISTORY_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

export function getCachedHomeRails(): HomePayload | null {
  if (moduleCache) return moduleCache
  const stored = readStoredPayload()
  if (stored) moduleCache = stored
  return moduleCache
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

interface BuildContext {
  data: DiscoverData
  followed: FollowedEpisode[]
  extras: LoadHomeRailsExtras
  nowMs: number
  byKey: Map<string, DiscoverCandidate>
  /** Keys excluded from every recommendation rail. */
  recommendationExcluded: Set<string>
  notInterested: Set<string>
  continueWatchingKeys: Set<string>
  placements: PlacementTracker
  ranked: RankedCandidate[]
}

function buildContext(
  data: DiscoverData,
  followed: FollowedEpisode[],
  extras: LoadHomeRailsExtras,
): BuildContext {
  const nowMs = extras.nowMs ?? Date.now()
  const byKey = new Map(
    data.candidates.map((c) => [candidateKey(c), c] as const),
  )
  const taste = data.taste
  const notInterested = new Set(taste.notInterestedKeys || [])

  // Already Watched prevents repeated recommendations. The explicit
  // already-watched feedback leaves no progress signal, so it never
  // lands in watchedKeys — but it does land in likedTitles (weight
  // 0.6, see taste.ts). Excluding every liked title closes that gap:
  // finished, favourited, liked and already-watched titles alike
  // stay out of the recommendation rails.
  const recommendationExcluded = new Set<string>([
    ...data.watchedKeys,
    ...notInterested,
  ])
  for (const ref of taste.likedTitles || []) {
    recommendationExcluded.add(`${ref.kind}:${ref.id}`)
  }
  for (const ref of taste.dislikedTitles || []) {
    if (ref.weight >= 1) recommendationExcluded.add(`${ref.kind}:${ref.id}`)
  }

  const continueWatchingKeys = new Set(
    data.continueWatching.map((c) => candidateKey(c)),
  )

  // More Like This boosts relevant ranking: the engine's seed
  // mechanism (+genre/+cast/+director) is fed from the titles the
  // user explicitly picked as "more like this".
  const seedTitles: Array<{
    title: string
    genres: string[]
    cast: string[]
    director?: string | null
  }> = []
  const selected = taste.selectedRecommendations || {}
  for (const key of Object.keys(selected)) {
    const candidate = byKey.get(key)
    if (!candidate || !cleanTitle(candidate.title)) continue
    seedTitles.push({
      title: candidate.title,
      genres: candidate.genres,
      cast: candidate.cast,
      director: candidate.director ?? null,
    })
    if (seedTitles.length >= 5) break
  }

  // One ranked pass, reused by Next Obsession, Tonight's Picks, hero
  // and the genre rails — a single local-engine ranking per load,
  // never one AI call per rail. The limit must cover every rail that
  // consumes the ranking (Next Obsession + Tonight's Picks + up to
  // three genre rails), or the later rails starve on a small library.
  const ranked = rankCandidates(data.candidates, taste, {
    excludeKeys: notInterested,
    watchedKeys: data.watchedKeys,
    excludeWatched: true,
    seedTitles,
    limit: HOME_RAILS_LIMIT * 4,
    perGroupCap: 1,
    nowMs,
  }).sort(byAdjustedScore)

  return {
    data,
    followed,
    extras,
    nowMs,
    byKey,
    recommendationExcluded,
    notInterested,
    continueWatchingKeys,
    placements: new PlacementTracker(),
    ranked,
  }
}

// ---------------------------------------------------------------------------
// Rail builders (each returns null when it has nothing real to show)
// ---------------------------------------------------------------------------

function buildContinueWatching(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  const seen = new Set<string>()
  const rows = ctx.extras.progressRows
  if (rows) {
    // Progress rows carry the real resume state. Live-channel history
    // is dropped by rule — tuning back to a channel is not resuming
    // a film or an episode — as are completed rows and rows with no
    // real progress.
    for (const row of rows) {
      if (row.kind !== "vod" && row.kind !== "episode") continue
      if (row.completed || (row.position ?? 0) <= 0) continue
      const progress = progressFraction(row)
      if (row.kind === "vod") {
        const candidate = ctx.byKey.get(`movie:${row.id}`)
        if (!candidate || !cleanTitle(candidate.title)) continue
        const key = candidateKey(candidate)
        if (seen.has(key)) continue
        seen.add(key)
        if (!ctx.placements.canPlace(key, railIndex, "continue-watching")) continue
        ctx.placements.place(key, railIndex, "continue-watching")
        items.push(
          candidateToItem(candidate, {
            progress,
            reason: "Continue watching",
          }),
        )
        continue
      }
      if (row.seriesId == null) continue
      const candidate = ctx.byKey.get(`series:${row.seriesId}`)
      if (!candidate || !cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-watching")) continue
      ctx.placements.place(key, railIndex, "continue-watching")
      const detailHref = candidateDetailHref(candidate)
      items.push(
        candidateToItem(candidate, {
          progress,
          season: row.season ?? undefined,
          episode: row.episodeNum ?? undefined,
          episodeTitle: row.episodeTitle ?? undefined,
          detailHref,
          playHref: `${detailHref}&autoplay=1&episode=${encodeURIComponent(row.id)}`,
          reason: "Continue watching",
        }),
      )
    }
  } else {
    // No progress rows supplied: fall back to the genuinely unfinished
    // candidates loadDiscoverData already derived from the progress
    // store (progress itself unknown here — no bar, no invented %).
    for (const candidate of ctx.data.continueWatching) {
      if (!cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-watching")) continue
      ctx.placements.place(key, railIndex, "continue-watching")
      items.push(candidateToItem(candidate, { reason: "Continue watching" }))
    }
  }
  if (!items.length) return null
  return {
    id: "continue-watching",
    kind: "continue-watching",
    title: "Continue Watching",
    items: items.slice(0, HOME_RAILS_LIMIT),
  }
}

function buildNewEpisodes(ctx: BuildContext, railIndex: number): HomeRail | null {
  const episodes = [...ctx.followed]
    .filter((ep) => !ep.watched && cleanTitle(ep.seriesTitle))
    .sort((a, b) => {
      const at = Date.parse(a.detectedAt || "") || 0
      const bt = Date.parse(b.detectedAt || "") || 0
      if (bt !== at) return bt - at
      return a.seriesTitle.localeCompare(b.seriesTitle)
    })
  const items: HomeRailItem[] = []
  const seen = new Set<string>()
  for (const ep of episodes) {
    const key = `followed:${ep.seriesId}:S${ep.season}E${ep.episode}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!ctx.placements.canPlace(key, railIndex, "new-episodes")) continue
    ctx.placements.place(key, railIndex, "new-episodes")
    const href = newEpisodeHref(ep)
    items.push({
      key,
      kind: "series",
      id: String(ep.seriesId),
      title: ep.seriesTitle,
      posterUrl: ep.posterUrl,
      season: ep.season,
      episode: ep.episode,
      episodeTitle: ep.episodeTitle,
      detectedAt: ep.detectedAt,
      detailHref: href,
      playHref: href,
      reason: `New: S${ep.season} E${ep.episode}${ep.episodeTitle ? ` — ${ep.episodeTitle}` : ""}`,
    })
  }
  if (!items.length) return null
  return {
    id: "new-episodes",
    kind: "new-episodes",
    title: "New Episodes",
    description: "From the series you follow",
    items: items.slice(0, HOME_RAILS_LIMIT),
    seeAllHref: "/followed",
  }
}

function buildNextObsession(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  for (const ranked of ctx.ranked) {
    const candidate = ranked.candidate
    if (!cleanTitle(candidate.title)) continue
    const key = candidateKey(candidate)
    if (ctx.recommendationExcluded.has(key)) continue
    if (!ctx.placements.canPlace(key, railIndex, "next-obsession")) continue
    ctx.placements.place(key, railIndex, "next-obsession")
    items.push(
      candidateToItem(candidate, { reason: ranked.reason || undefined }),
    )
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (!items.length) return null
  const hasHistory = ctx.data.hasHistory
  return {
    id: "next-obsession",
    kind: "next-obsession",
    title: "Your Next Obsession",
    description: hasHistory
      ? "Based on what you've watched and loved"
      : "Highly rated in your library",
    items,
    seeAllHref: "/discover",
  }
}

function buildTrending(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  const extras = ctx.extras.trending
  if (extras?.length) {
    // Real trending source (Google/TMDB, already matched to the
    // library by loadTrending). Catalogue availability is re-checked
    // here: an item with no candidate is dropped, never shown dead.
    // "Well-regarded" needs evidence — an unrated trending match is
    // dropped rather than presented as worth watching.
    const ranked = [...extras]
      .map((item) => ({ item, candidate: ctx.byKey.get(`${item.kind}:${item.id}`) }))
      .filter(
        (entry): entry is { item: HomeTrendingInput; candidate: DiscoverCandidate } =>
          !!entry.candidate && cleanTitle(entry.candidate.title) !== "",
      )
      .filter((entry) => !ctx.recommendationExcluded.has(candidateKey(entry.candidate)))
      .filter((entry) => {
        const rating =
          typeof entry.item.rating === "number" ? entry.item.rating : entry.candidate.rating
        return typeof rating === "number" && rating >= TRENDING_MIN_BAYESIAN
      })
      .sort((a, b) => {
        const ra = a.item.rating ?? a.candidate.rating ?? 0
        const rb = b.item.rating ?? b.candidate.rating ?? 0
        if (rb !== ra) return rb - ra
        return a.candidate.title.localeCompare(b.candidate.title)
      })
    for (const pass of [0, 1]) {
      for (const { item, candidate } of ranked) {
        if (items.length >= HOME_RAILS_LIMIT) break
        const key = candidateKey(candidate)
        if (pass === 0 && ctx.placements.count(key) > 0) continue
        if (!ctx.placements.canPlace(key, railIndex, "trending")) continue
        ctx.placements.place(key, railIndex, "trending")
        items.push(
          candidateToItem(candidate, {
            rating: item.rating ?? candidate.rating,
            reason: "Trending now",
          }),
        )
      }
      if (items.length >= HOME_RAILS_LIMIT) break
    }
  } else {
    // No trending feed supplied: popularity = real vote volume, and
    // "well-regarded" = confidence-aware quality. Provider catalogue
    // order is never the ranking — the most-voted, best-regarded
    // titles lead. Finished, already-watched and dismissed titles
    // stay out: Trending is a personalised Home surface, not history.
    const pool = ctx.data.candidates
      .filter((c) => (c.kind === "movie" || c.kind === "series"))
      .filter((c) => cleanTitle(c.title))
      .filter((c) => !ctx.recommendationExcluded.has(candidateKey(c)))
      .filter(
        (c) =>
          hasSufficientSupport(c.voteCount, TRENDING_MIN_VOTES) &&
          bayesianRating(c.rating, c.voteCount) >= TRENDING_MIN_BAYESIAN,
      )
      .sort((a, b) => {
        const votesDiff = (b.voteCount ?? 0) - (a.voteCount ?? 0)
        if (votesDiff !== 0) return votesDiff
        const bayesDiff =
          bayesianRating(b.rating, b.voteCount) -
          bayesianRating(a.rating, a.voteCount)
        if (bayesDiff !== 0) return bayesDiff
        return a.title.localeCompare(b.title)
      })
    for (const pass of [0, 1]) {
      for (const candidate of pool) {
        if (items.length >= HOME_RAILS_LIMIT) break
        const key = candidateKey(candidate)
        if (pass === 0 && ctx.placements.count(key) > 0) continue
        if (!ctx.placements.canPlace(key, railIndex, "trending")) continue
        ctx.placements.place(key, railIndex, "trending")
        items.push(
          candidateToItem(candidate, { reason: "Popular and well-regarded" }),
        )
      }
      if (items.length >= HOME_RAILS_LIMIT) break
    }
  }
  if (!items.length) return null
  return {
    id: "trending",
    kind: "trending",
    title: "Trending & Worth Watching",
    description: extras?.length
      ? "Trending now, matched to your library"
      : "Popular and well-regarded in your library",
    items,
  }
}

function buildHiddenGems(ctx: BuildContext, railIndex: number): HomeRail | null {
  // Genuinely worthwhile, less obvious: high confidence-aware quality
  // with real vote support, unwatched, never dismissed. An obscure
  // 10.0 with no votes is excluded by the support floor — its
  // Bayesian rating is the prior mean (6.5) and it fails both gates.
  const pool = ctx.data.candidates
    .filter((c) => (c.kind === "movie" || c.kind === "series"))
    .filter((c) => cleanTitle(c.title))
    .filter((c) => !ctx.recommendationExcluded.has(candidateKey(c)))
    .filter(
      (c) =>
        hasSufficientSupport(c.voteCount, GEM_MIN_VOTES) &&
        bayesianRating(c.rating, c.voteCount) >= GEM_MIN_BAYESIAN,
    )
    .sort((a, b) => {
      const bayesDiff =
        bayesianRating(b.rating, b.voteCount) -
        bayesianRating(a.rating, a.voteCount)
      if (bayesDiff !== 0) return bayesDiff
      // Equal proven quality: the less-seen title is the better gem.
      const votesDiff = (a.voteCount ?? 0) - (b.voteCount ?? 0)
      if (votesDiff !== 0) return votesDiff
      return a.title.localeCompare(b.title)
    })
  const items: HomeRailItem[] = []
  // Fresh titles first: a gem already starring in Next Obsession does
  // not need to headline here too — the rail should surface new
  // discoveries, and fresh-first keeps the later genre rails fed.
  // Already-placed-once titles fill any gaps, within the cap.
  for (const pass of [0, 1]) {
    for (const candidate of pool) {
      if (items.length >= HOME_RAILS_LIMIT) break
      const key = candidateKey(candidate)
      if (pass === 0 && ctx.placements.count(key) > 0) continue
      if (!ctx.placements.canPlace(key, railIndex, "hidden-gems")) continue
      ctx.placements.place(key, railIndex, "hidden-gems")
      items.push(
        candidateToItem(candidate, { reason: "Highly rated, waiting to be discovered" }),
      )
    }
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (!items.length) return null
  return {
    id: "hidden-gems",
    kind: "hidden-gems",
    title: "Hidden Gems",
    description: "Highly rated, not watched yet",
    items,
    seeAllHref: "/discover",
  }
}

function buildTonight(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  // Live programmes first — but ONLY from real EPG data. An empty
  // programme map means no live cards, never an invented listing.
  for (const candidate of ctx.data.nowPlaying.slice(0, 4)) {
    if (candidate.kind !== "live" || !cleanTitle(candidate.title)) continue
    const key = candidateKey(candidate)
    if (!ctx.placements.canPlace(key, railIndex, "tonight")) continue
    ctx.placements.place(key, railIndex, "tonight")
    const { nowTitle, nextTitle } = parseNowNext(candidate.overview)
    items.push(
      candidateToItem(candidate, {
        isLive: true,
        nowTitle,
        nextTitle,
        reason: nowTitle ? `Now: ${nowTitle}` : "On now",
      }),
    )
  }
  // Then the best taste-ranked unwatched picks not already placed.
  // Fresh titles first (a rail that just repeats Next Obsession is
  // not curation); already-placed-once titles fill any gaps, within
  // the at-most-2-rails rule.
  for (const pass of [0, 1]) {
    for (const ranked of ctx.ranked) {
      if (items.length >= HOME_RAILS_LIMIT) break
      const candidate = ranked.candidate
      if (!cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (ctx.recommendationExcluded.has(key)) continue
      if (pass === 0 && ctx.placements.count(key) > 0) continue
      if (!ctx.placements.canPlace(key, railIndex, "tonight")) continue
      ctx.placements.place(key, railIndex, "tonight")
      items.push(
        candidateToItem(candidate, { reason: ranked.reason || undefined }),
      )
    }
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (items.length < TONIGHT_MIN_ITEMS) return null
  return {
    id: "tonight",
    kind: "tonight",
    title: "Tonight's Picks",
    description: "Films, series and live TV for tonight",
    items,
  }
}

function buildRecentlyAdded(ctx: BuildContext, railIndex: number): HomeRail | null {
  // Factual rail: only titles with a real catalogue `added`
  // timestamp (DiscoverData.recentlyAdded). Movies only, per the rail
  // title. When there is no addition evidence, the rail hides.
  const items: HomeRailItem[] = []
  for (const candidate of ctx.data.recentlyAdded) {
    if (candidate.kind !== "movie") continue
    if (!cleanTitle(candidate.title)) continue
    const key = candidateKey(candidate)
    if (!ctx.placements.canPlace(key, railIndex, "recently-added")) continue
    ctx.placements.place(key, railIndex, "recently-added")
    items.push(
      candidateToItem(candidate, { reason: "Recently added to your library" }),
    )
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (!items.length) return null
  return {
    id: "recently-added",
    kind: "recently-added",
    title: "Recently Added Movies",
    description: "New to your library",
    items,
    seeAllHref: "/recently-added",
  }
}

function buildContinueSeries(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  const seen = new Set<string>()
  const rows = ctx.extras.progressRows
  if (rows) {
    for (const row of rows) {
      if (row.kind !== "episode" || row.seriesId == null) continue
      if (row.completed || (row.position ?? 0) <= 0) continue
      const candidate = ctx.byKey.get(`series:${row.seriesId}`)
      if (!candidate || !cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-series")) continue
      ctx.placements.place(key, railIndex, "continue-series")
      const detailHref = candidateDetailHref(candidate)
      items.push(
        candidateToItem(candidate, {
          progress: progressFraction(row),
          season: row.season ?? undefined,
          episode: row.episodeNum ?? undefined,
          episodeTitle: row.episodeTitle ?? undefined,
          detailHref,
          playHref: `${detailHref}&autoplay=1&episode=${encodeURIComponent(row.id)}`,
          reason: "Continue watching",
        }),
      )
    }
  } else {
    for (const candidate of ctx.data.continueWatching) {
      if (candidate.kind !== "series") continue
      if (!cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-series")) continue
      ctx.placements.place(key, railIndex, "continue-series")
      items.push(candidateToItem(candidate, { reason: "Continue watching" }))
    }
  }
  if (!items.length) return null
  return {
    id: "continue-series",
    kind: "continue-series",
    title: "Continue Your Series",
    description: "Pick up your series where you left off",
    items: items.slice(0, HOME_RAILS_LIMIT),
    seeAllHref: "/series",
  }
}

function buildShort(ctx: BuildContext, railIndex: number): HomeRail | null {
  // Verified runtime only: a film with no runtime metadata is never
  // presented as "under two hours". Quality-gated like the other
  // "best of" rails — a no-vote 10.0 cannot lead it.
  const pool = ctx.data.candidates
    .filter((c) => c.kind === "movie")
    .filter((c) => cleanTitle(c.title))
    .filter((c) => !ctx.recommendationExcluded.has(candidateKey(c)))
    .filter(
      (c) =>
        typeof c.runtimeMinutes === "number" &&
        c.runtimeMinutes > 0 &&
        c.runtimeMinutes < SHORT_MAX_RUNTIME_MINUTES,
    )
    .filter(
      (c) =>
        hasSufficientSupport(c.voteCount, SHORT_MIN_VOTES) &&
        bayesianRating(c.rating, c.voteCount) >= SHORT_MIN_BAYESIAN,
    )
    .sort((a, b) => {
      const bayesDiff =
        bayesianRating(b.rating, b.voteCount) -
        bayesianRating(a.rating, a.voteCount)
      if (bayesDiff !== 0) return bayesDiff
      const runtimeDiff = (a.runtimeMinutes ?? 0) - (b.runtimeMinutes ?? 0)
      if (runtimeDiff !== 0) return runtimeDiff
      return a.title.localeCompare(b.title)
    })
  const items: HomeRailItem[] = []
  // Fresh titles first (see Hidden Gems): the shortest great films
  // should not all be repeats of earlier rails.
  for (const pass of [0, 1]) {
    for (const candidate of pool) {
      if (items.length >= HOME_RAILS_LIMIT) break
      const key = candidateKey(candidate)
      if (pass === 0 && ctx.placements.count(key) > 0) continue
      if (!ctx.placements.canPlace(key, railIndex, "short")) continue
      ctx.placements.place(key, railIndex, "short")
      items.push(
        candidateToItem(candidate, {
          reason: `${candidate.runtimeMinutes} min · Highly rated`,
        }),
      )
    }
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (!items.length) return null
  return {
    id: "short",
    kind: "short",
    title: "Short & Sweet",
    description: "Highly rated films under two hours",
    items,
  }
}

// ---------------------------------------------------------------------------
// Genre rails
// ---------------------------------------------------------------------------

interface GenreRailDef {
  id: string
  title: string
  /** Lower-cased substrings matched against the candidate's genres. */
  match: string[]
  /** Quality floor for this rail (default: not below the prior mean). */
  minBayesian?: number
  minVotes?: number
}

const GENRE_RAIL_DEFS: GenreRailDef[] = [
  { id: "genre-crime-mystery", title: "Crime & Mystery", match: ["crime", "mystery", "detective", "noir"] },
  { id: "genre-action-thrillers", title: "Action & Thrillers", match: ["action", "thriller", "adventure"] },
  { id: "genre-sci-fi", title: "Science Fiction", match: ["sci-fi", "science fiction", "sci fi"] },
  { id: "genre-comedy", title: "Comedy", match: ["comedy"] },
  { id: "genre-documentary", title: "Documentary", match: ["documentary"] },
  {
    id: "genre-prestige-drama",
    title: "Prestige Drama",
    match: ["drama"],
    minBayesian: PRESTIGE_DRAMA_MIN_BAYESIAN,
    minVotes: PRESTIGE_DRAMA_MIN_VOTES,
  },
  { id: "genre-horror", title: "Horror", match: ["horror"] },
]

function buildGenreRails(ctx: BuildContext, startIndex: number): HomeRail[] {
  const taste = ctx.data.taste
  const scored: Array<{ def: GenreRailDef; items: RankedCandidate[]; score: number }> = []
  for (const def of GENRE_RAIL_DEFS) {
    const minBayesian = def.minBayesian ?? 6.5
    const minVotes = def.minVotes ?? 0
    const pool = ctx.ranked.filter((ranked) => {
      const candidate = ranked.candidate
      if (!cleanTitle(candidate.title)) return false
      if (ctx.recommendationExcluded.has(candidateKey(candidate))) return false
      const genres = candidate.genres.map((g) => g.toLowerCase())
      if (!genres.some((g) => def.match.some((m) => g.includes(m)))) return false
      if (bayesianRating(candidate.rating, candidate.voteCount) < minBayesian) return false
      if (minVotes > 0 && !hasSufficientSupport(candidate.voteCount, minVotes)) return false
      return true
    })
    if (pool.length < GENRE_RAIL_MIN_ITEMS) continue
    // Rail priority: taste affinity for these genres first, then
    // proven quality — so the rails that surface are the ones this
    // household actually leans toward, never all seven every launch.
    const affinity = def.match.reduce(
      (sum, m) => sum + (taste.genreWeights[m] || 0),
      0,
    )
    const meanBayesian =
      pool.reduce(
        (sum, r) => sum + bayesianRating(r.candidate.rating, r.candidate.voteCount),
        0,
      ) / pool.length
    scored.push({ def, items: pool, score: affinity * 2 + meanBayesian })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.def.title.localeCompare(b.def.title)
  })
  const rails: HomeRail[] = []
  let railIndex = startIndex
  for (const { def, items } of scored.slice(0, GENRE_RAILS_MAX)) {
    const railItems: HomeRailItem[] = []
    for (const ranked of items) {
      const candidate = ranked.candidate
      const key = candidateKey(candidate)
      if (!ctx.placements.canPlace(key, railIndex, def.id)) continue
      ctx.placements.place(key, railIndex, def.id)
      railItems.push(
        candidateToItem(candidate, { reason: ranked.reason || undefined }),
      )
      if (railItems.length >= HOME_RAILS_LIMIT) break
    }
    if (railItems.length < GENRE_RAIL_MIN_ITEMS) continue
    rails.push({
      id: def.id,
      kind: "genre",
      title: def.title,
      items: railItems,
    })
    railIndex++
  }
  return rails
}

// ---------------------------------------------------------------------------
// Hero selection
// ---------------------------------------------------------------------------

function pickHomeHero(ctx: BuildContext): HomeHero | null {
  const taste = ctx.data.taste
  // Hard gates — a hero must be all of these:
  //   - real catalogue title with artwork (poster is the artwork the
  //     catalogue carries; backdropUrl is used when one exists)
  //   - sane year when the catalogue carries one (mismatched years
  //     and junk metadata are out)
  //   - credible, confidence-aware quality: Bayesian >= 7.0 with at
  //     least 100 real votes. A perfect 10.0 with no votes scores the
  //     prior mean (6.5) and never qualifies.
  //   - not dismissed, not finished, not already-watched. In-progress
  //     titles stay eligible — resuming is strong relevance.
  const heroExcluded = new Set<string>([
    ...ctx.recommendationExcluded,
  ])
  for (const key of ctx.continueWatchingKeys) heroExcluded.delete(key)

  const pool = ctx.data.candidates
    .filter((c) => (c.kind === "movie" || c.kind === "series"))
    .filter((c) => cleanTitle(c.title))
    .filter((c) => !!c.posterUrl)
    .filter((c) => c.year === undefined || cleanYear(c.year, ctx.nowMs) !== undefined)
    .filter((c) => !heroExcluded.has(candidateKey(c)))
    .filter(
      (c) =>
        hasSufficientSupport(c.voteCount, HERO_MIN_VOTES) &&
        bayesianRating(c.rating, c.voteCount) >= HERO_MIN_BAYESIAN,
    )
  if (!pool.length) return null

  // Relevance: the same local ranking, confidence-adjusted.
  const rankedByKey = new Map(
    ctx.ranked.map((r) => [candidateKey(r.candidate), r] as const),
  )
  const sparseProfile =
    !ctx.data.hasHistory &&
    (taste.likedTitles || []).length === 0 &&
    (taste.favouriteTitles || []).length === 0

  let ordered: DiscoverCandidate[]
  if (sparseProfile) {
    // No taste to learn from: credible catalogue-matched quality
    // decides — best Bayesian first, then most votes. Never catalogue
    // order, never random.
    ordered = [...pool].sort((a, b) => {
      const bayesDiff =
        bayesianRating(b.rating, b.voteCount) -
        bayesianRating(a.rating, a.voteCount)
      if (bayesDiff !== 0) return bayesDiff
      const votesDiff = (b.voteCount ?? 0) - (a.voteCount ?? 0)
      if (votesDiff !== 0) return votesDiff
      return a.title.localeCompare(b.title)
    })
  } else {
    ordered = [...pool].sort((a, b) => {
      const ra = rankedByKey.get(candidateKey(a))
      const rb = rankedByKey.get(candidateKey(b))
      const scoreA =
        (ra ? confidenceAdjustedScore(ra) : 0) +
        bayesianRating(a.rating, a.voteCount) * 2 +
        (a.backdropUrl ? HERO_BACKDROP_BONUS : 0) +
        (ctx.continueWatchingKeys.has(candidateKey(a)) ? HERO_CONTINUE_BONUS : 0)
      const scoreB =
        (rb ? confidenceAdjustedScore(rb) : 0) +
        bayesianRating(b.rating, b.voteCount) * 2 +
        (b.backdropUrl ? HERO_BACKDROP_BONUS : 0) +
        (ctx.continueWatchingKeys.has(candidateKey(b)) ? HERO_CONTINUE_BONUS : 0)
      if (scoreB !== scoreA) return scoreB - scoreA
      return a.title.localeCompare(b.title)
    })
  }

  // Avoid excessive repetition: prefer a hero not shown in the last
  // 10 loads; only repeat when every eligible title was recently
  // shown (then the least-recently-shown leads).
  const history = currentHeroHistory()
  const fresh = ordered.filter((c) => !history.includes(candidateKey(c)))
  let pick = fresh[0]
  if (!pick) {
    // Every eligible title was recently shown: repeat the
    // least-recently-shown one (largest history index wins).
    pick = [...ordered].sort((a, b) => {
      const ia = history.indexOf(candidateKey(a))
      const ib = history.indexOf(candidateKey(b))
      return ib - ia
    })[0]
  }
  if (!pick) return null
  recordHeroShown(candidateKey(pick))
  const ranked = rankedByKey.get(candidateKey(pick))
  const item = candidateToItem(pick)
  return {
    item,
    reason:
      ranked?.reason ||
      `Highly rated (${pick.rating?.toFixed(1) ?? "—"}/10)`,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadHomeRails(
  data: DiscoverData,
  followed: FollowedEpisode[],
  extras: LoadHomeRailsExtras = {},
): Promise<HomePayload> {
  try {
    if (!data || !Array.isArray(data.candidates) || !data.taste) {
      throw new Error("loadHomeRails: invalid DiscoverData")
    }
    const ctx = buildContext(data, followed ?? [], extras)
    const rails: HomeRail[] = []
    // Rail indices count emitted rails only: an omitted rail does not
    // sit between two displayed rails, so adjacency is judged on the
    // rails the user actually sees, in order.
    const maybePush = (rail: HomeRail | null) => {
      if (rail) rails.push(rail)
    }
    maybePush(buildContinueWatching(ctx, rails.length))
    maybePush(buildNewEpisodes(ctx, rails.length))
    maybePush(buildNextObsession(ctx, rails.length))
    maybePush(buildTrending(ctx, rails.length))
    maybePush(buildHiddenGems(ctx, rails.length))
    maybePush(buildTonight(ctx, rails.length))
    maybePush(buildRecentlyAdded(ctx, rails.length))
    maybePush(buildContinueSeries(ctx, rails.length))
    maybePush(buildShort(ctx, rails.length))
    for (const genreRail of buildGenreRails(ctx, rails.length)) {
      rails.push(genreRail)
    }
    const hero = pickHomeHero(ctx)
    const payload: HomePayload = { hero, rails }
    moduleCache = payload
    writeStoredPayload(payload)
    return payload
  } catch {
    // Never throw valid cached content away on a metadata failure:
    // serve the last good payload, or an empty one when there is none.
    return getCachedHomeRails() ?? { hero: null, rails: [] }
  }
}
