// Collection selectors (0.11.8 W1, brief §3.2–§3.5, §4.4, §14, fixes §1.2).
//
// Top-K shelf selection over a prepared CatalogIndex. Selectors return
// ranked IDs + small metadata (SelectorResult) — never redundant full
// copies of catalogue rows; callers resolve entries via index.byId.
// Selection is Top-K (bounded heap + diversity pass), never a
// full-sort of thousands of entries to pick 8–12. Results are cached
// per catalogue revision + profile/taste revision (see the caching
// note below); volatile inputs bypass the cache unless the caller
// supplies a stable cache discriminator.
//
// SCORING INPUTS (documented per brief §14 — every selector below
// cites the components it uses):
//   quality   — Bayesian evidence-weighted rating from the index
//               (rating-evidence.ts). A provider 10 with no votes
//               scores near the prior mean, never like an
//               established film. Unrated titles are identifiable
//               and never silently treated as well-rated.
//   taste     — affinity from the local taste model (taste.ts):
//               genre weights built ONLY from liked titles
//               (completed / favourited / explicitly liked).
//               Opening a title is NOT a like. "Not interested" is
//               a hard exclusion on every discovery shelf.
//   freshness — unwatched/discovery bias: completed/watched titles
//               are penalised (or excluded with excludeWatched),
//               favourites are mildly penalised on discovery
//               shelves (already loved, not a discovery).
//   identity  — verified TMDb identity present (small bonus: the
//               title is reliably identified, artwork/metadata
//               resolve).
//   poster    — artwork present (small bonus; REQUIRED for Featured).
//   exposure  — caller-supplied exposure counts rotate titles out
//               of repeated shelf appearances.
//   ai        — cached verified AI Discovery recommendations may
//               boost a title ONLY via the explicit optional
//               aiRecommendations input AND aiRecommendationsAllowed
//               (privacy permission). Default path is local-only:
//               no fresh paid calls, no new LLM workflow.
//
// Determinism: every selector is deterministic given the same index
// revision + taste + options. Featured rotates only when the caller
// changes rotationSeed (e.g. a daily bucket) — never per page open.

import {
  CANONICAL_MOVIE_GENRES,
  CANONICAL_SERIES_GENRES,
} from "@/scripts/lib/genres.ts"
import { hasCredibleRating } from "@/scripts/lib/rating-evidence.ts"
import type {
  CatalogIndex,
  GroupAggregate,
  ProfileLayer,
} from "@/scripts/lib/catalog-index.ts"
import type { TasteModel, TasteSignals } from "@/scripts/lib/taste.ts"

export interface SelectorResult {
  /** Displayed group primary id. Resolve via index.byId / index.meta. */
  id: string
  /** Composite score (selector-specific scale; higher ranks first). */
  score: number
  /** Short honest reasons naming the evidence used (max 3). */
  reasons: string[]
  progressFraction?: number
  updatedAt?: number
  addedMs?: number | null
  groupId?: string
}

export interface ContinueWatchingInput {
  kind: "vod" | "episode" | "series"
  id: string | number
  /** Owning series id for episode progress (roll-up key). */
  seriesId?: string | number | null
  position?: number | null
  duration?: number | null
  progressFraction?: number | null
  completed?: boolean
  updatedAt?: number | null
}

export interface SelectorOptions {
  /** Layered profile state (createProfileLayer). Revision "" disables selector caching. */
  profile?: ProfileLayer | null
  watchedIds?: Iterable<string | number> | null
  completedIds?: Iterable<string | number> | null
  favouriteIds?: Iterable<string | number> | null
  /** Times each title id has already been surfaced (rotation input). */
  exposureCounts?: Map<string, number> | Record<string, number> | null
  /** Progress entries for Continue Watching (see ContinueWatchingInput). */
  progressEntries?: ContinueWatchingInput[] | null
  /** Featured rotation seed. Default: the index revision (stable). Pass a date bucket to rotate daily. */
  rotationSeed?: string | number | null
  /** Recently-added cutoff: epoch ms (or seconds), or a Date. Titles older than it are never returned. */
  cutoff?: number | Date | null
  nowMs?: number
  /**
   * Cached verified AI Discovery recommendations (explicit input
   * only). Ignored unless aiRecommendationsAllowed is true.
   */
  aiRecommendations?: Array<{ id: string | number; rank?: number }> | null
  aiRecommendationsAllowed?: boolean
  /** Exclude watched/completed titles outright instead of penalising them. */
  excludeWatched?: boolean
  /**
   * Exclude COMPLETED titles outright, while still allowing
   * in-progress titles (a featured film may be one the viewer is
   * mid-way through — its primary action is Continue). Completed
   * titles never headline Featured and never fill Worth Watching.
   */
  excludeCompleted?: boolean
  /** Extra cache discriminator for volatile inputs. */
  cacheKey?: string | null
  profileRevision?: string | null
}

export type TasteInput = TasteModel | TasteSignals | null | undefined

/** Convenience: ranked ids from selector results. */
export function selectorIds(results: SelectorResult[]): string[] {
  return (results || []).map((result) => result.id)
}

// ── Taste projection ─────────────────────────────────────────────────

interface TasteView {
  /** Normalised genre key -> weight (from liked titles only). */
  genreWeights: Map<string, number>
  notInterested: Set<string>
  likedIds: Set<string>
  favouriteIds: Set<string>
  /** Explicit dislikes (weight >= 1): hard exclusions. */
  hardDislikedIds: Set<string>
  /** Weak negatives (abandoned, weight < 1): penalised, not excluded. */
  softDislikedIds: Set<string>
  fingerprint: string
}

function normaliseTasteKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function genreAffinityKeys(genreId: string, kind: "vod" | "series"): string[] {
  const table = kind === "series" ? CANONICAL_SERIES_GENRES : CANONICAL_MOVIE_GENRES
  const entry = table.find((candidate) => candidate.id === genreId)
  const keys = new Set<string>([normaliseTasteKey(genreId)])
  if (entry) {
    keys.add(normaliseTasteKey(entry.label))
    for (const alias of entry.aliases) keys.add(normaliseTasteKey(alias))
  }
  return [...keys].filter(Boolean)
}

function kindMatchesRef(refKind: string, kind: "vod" | "series"): boolean {
  const text = String(refKind ?? "").trim().toLowerCase()
  if (kind === "vod") return text === "movie" || text === "vod" || text === "film"
  return text === "series" || text === "tv" || text === "show"
}

function tasteViewFor(taste: TasteInput, kind: "vod" | "series"): TasteView {
  const genreWeights = new Map<string, number>()
  const notInterested = new Set<string>()
  const likedIds = new Set<string>()
  const favouriteIds = new Set<string>()
  const hardDislikedIds = new Set<string>()
  const softDislikedIds = new Set<string>()
  let updatedAt = 0
  if (taste) {
    for (const [key, weight] of Object.entries(taste.genreWeights || {})) {
      const normed = normaliseTasteKey(key)
      if (normed && Number.isFinite(weight)) {
        genreWeights.set(normed, (genreWeights.get(normed) ?? 0) + weight)
      }
    }
    for (const rawKey of taste.notInterestedKeys || []) {
      const key = String(rawKey ?? "")
      const colon = key.indexOf(":")
      if (colon > 0) {
        const refKind = key.slice(0, colon)
        if (kindMatchesRef(refKind, kind)) notInterested.add(key.slice(colon + 1))
      } else if (key) {
        notInterested.add(key)
      }
    }
    const collect = (refs: Array<{ kind: string; id: string | number; weight?: number }> | undefined, target: Set<string>) => {
      for (const ref of refs || []) {
        if (ref && kindMatchesRef(ref.kind, kind)) target.add(String(ref.id))
      }
    }
    collect(taste.likedTitles, likedIds)
    collect(taste.favouriteTitles, favouriteIds)
    for (const ref of taste.dislikedTitles || []) {
      if (!ref || !kindMatchesRef(ref.kind, kind)) continue
      const id = String(ref.id)
      if ((ref.weight ?? 1) >= 1) hardDislikedIds.add(id)
      else softDislikedIds.add(id)
    }
    if ("updatedAt" in taste && typeof taste.updatedAt === "number") updatedAt = taste.updatedAt
  }
  const fingerprintParts = [
    `u:${updatedAt}`,
    `g:${[...genreWeights.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(",")}`,
    `n:${[...notInterested].sort().join(",")}`,
    `l:${likedIds.size}`,
    `f:${favouriteIds.size}`,
    `d:${hardDislikedIds.size}/${softDislikedIds.size}`,
  ]
  return {
    genreWeights,
    notInterested,
    likedIds,
    favouriteIds,
    hardDislikedIds,
    softDislikedIds,
    fingerprint: fingerprintParts.join("|").slice(0, 1024),
  }
}

/** Taste affinity in [0, 1): summed per-genre best-key weights, saturating. */
function tasteAffinity(genreIds: string[], kind: "vod" | "series", view: TasteView): { score: number; topGenreId: string | null } {
  let affinity = 0
  let topGenreId: string | null = null
  let topWeight = 0
  for (const genreId of genreIds) {
    let best = 0
    for (const key of genreAffinityKeys(genreId, kind)) {
      best = Math.max(best, view.genreWeights.get(key) ?? 0)
    }
    if (best > 0) {
      affinity += best
      if (best > topWeight) {
        topWeight = best
        topGenreId = genreId
      }
    }
  }
  return { score: affinity <= 0 ? 0 : affinity / (affinity + 2), topGenreId }
}

function genreLabel(kind: "vod" | "series", genreId: string): string {
  const table = kind === "series" ? CANONICAL_SERIES_GENRES : CANONICAL_MOVIE_GENRES
  return table.find((entry) => entry.id === genreId)?.label ?? genreId
}

// ── Shared scoring context ───────────────────────────────────────────

interface ScoringContext {
  view: TasteView
  watched: Set<string>
  completed: Set<string>
  favourites: Set<string>
  exposure: Map<string, number>
  aiBoost: Map<string, number>
  excludeWatched: boolean
  excludeCompleted: boolean
}

function idSetOf(values: Iterable<string | number> | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!values) return out
  for (const value of values) {
    const id = String(value ?? "").trim()
    if (id) out.add(id)
  }
  return out
}

function scoringContext(
  index: CatalogIndex,
  taste: TasteInput,
  opts: SelectorOptions,
): ScoringContext {
  const view = tasteViewFor(taste, index.kind)
  const watched = new Set<string>(view.likedIds)
  const completed = new Set<string>()
  const favourites = new Set<string>(view.favouriteIds)
  for (const id of idSetOf(opts.watchedIds)) watched.add(id)
  for (const id of idSetOf(opts.completedIds)) {
    completed.add(id)
    watched.add(id)
  }
  for (const id of idSetOf(opts.favouriteIds)) favourites.add(id)
  if (opts.profile) {
    for (const id of opts.profile.favouriteIds) favourites.add(id)
    for (const [id, progress] of opts.profile.progressById) {
      if (progress.completed || progress.fraction > 0) watched.add(id)
      if (progress.completed) completed.add(id)
    }
  }
  const exposure = new Map<string, number>()
  if (opts.exposureCounts instanceof Map) {
    for (const [key, value] of opts.exposureCounts) {
      if (Number.isFinite(value) && value > 0) exposure.set(String(key), value)
    }
  } else if (opts.exposureCounts && typeof opts.exposureCounts === "object") {
    for (const [key, value] of Object.entries(opts.exposureCounts)) {
      if (Number.isFinite(value) && value > 0) exposure.set(key, value)
    }
  }
  const aiBoost = new Map<string, number>()
  if (opts.aiRecommendationsAllowed && Array.isArray(opts.aiRecommendations)) {
    opts.aiRecommendations.forEach((rec, position) => {
      if (!rec) return
      const rank = Number(rec.rank ?? position + 1)
      const boost = Number.isFinite(rank) && rank <= 3 ? 0.1 : 0.08
      const id = String(rec.id ?? "").trim()
      if (id && !aiBoost.has(id)) aiBoost.set(id, boost)
    })
  }
  return { view, watched, completed, favourites, exposure, aiBoost, excludeWatched: !!opts.excludeWatched, excludeCompleted: !!opts.excludeCompleted }
}

function groupHits(ids: Set<string>, group: TitleGroupLike): boolean {
  for (const memberId of group.variantIds) {
    if (ids.has(memberId)) return true
  }
  return false
}

interface TitleGroupLike {
  variantIds: string[]
}

function exposureOf(ctx: ScoringContext, group: TitleGroupLike): number {
  let max = 0
  for (const memberId of group.variantIds) {
    max = Math.max(max, ctx.exposure.get(memberId) ?? 0)
  }
  return max
}

function aiBoostOf(ctx: ScoringContext, group: TitleGroupLike): number {
  let best = 0
  for (const memberId of group.variantIds) {
    best = Math.max(best, ctx.aiBoost.get(memberId) ?? 0)
  }
  return best
}

/** Quality component in [0, 1] from the Bayesian score (prior mean -> ~0.38, never "perfect" without votes). */
function quality01(bayesian: number): number {
  return Math.max(0, Math.min(1, (bayesian - 5) / 4))
}

interface ScoredCandidate {
  id: string
  groupId: string
  aggregate: GroupAggregate
  score: number
  reasons: string[]
  tasteScore: number
  topGenreId: string | null
}

const QUALITY_WEIGHT = 0.45
const TASTE_WEIGHT = 0.3
const POSTER_WEIGHT = 0.1
const IDENTITY_WEIGHT = 0.05
const WATCHED_PENALTY = 0.25
const FAVOURITE_PENALTY = 0.1
const SOFT_DISLIKE_PENALTY = 0.15

function scoreCandidate(
  index: CatalogIndex,
  ctx: ScoringContext,
  group: TitleGroupLike & { id: string; primaryId: string; tmdbId?: number },
  aggregate: GroupAggregate,
  opts: { watchedPenalty?: number; favouritePenalty?: number },
): ScoredCandidate | null {
  // Hard exclusions: not-interested + explicit dislikes (any variant).
  if (groupHits(ctx.view.notInterested, group)) return null
  if (groupHits(ctx.view.hardDislikedIds, group)) return null
  const isWatched = groupHits(ctx.watched, group)
  if (ctx.excludeWatched && isWatched) return null
  if (ctx.excludeCompleted && groupHits(ctx.completed, group)) return null

  const { score: tasteScore, topGenreId } = tasteAffinity(aggregate.genreIds, index.kind, ctx.view)
  const ai = aiBoostOf(ctx, group)
  let score =
    QUALITY_WEIGHT * quality01(aggregate.bayesian) +
    TASTE_WEIGHT * tasteScore +
    POSTER_WEIGHT * (aggregate.hasPoster ? 1 : 0) +
    IDENTITY_WEIGHT * (group.tmdbId != null ? 1 : 0) +
    ai
  if (isWatched) score -= opts.watchedPenalty ?? WATCHED_PENALTY
  if (groupHits(ctx.favourites, group)) score -= opts.favouritePenalty ?? FAVOURITE_PENALTY
  if (groupHits(ctx.view.softDislikedIds, group)) score -= SOFT_DISLIKE_PENALTY
  const exposure = exposureOf(ctx, group)
  if (exposure > 0) score -= Math.min(0.3, 0.08 * exposure)
  score = Math.max(0, score)

  const reasons: string[] = []
  const evidence = aggregate.rating
  if (evidence && aggregate.bayesian >= 7 && evidence.score10 >= 7) {
    if (evidence.source === "tmdb" && evidence.voteCount != null) {
      reasons.push(`TMDb ${evidence.score10.toFixed(1)} · ${evidence.voteCount.toLocaleString("en")} votes`)
    } else if (evidence.source === "tmdb" || evidence.source === "enrichment") {
      reasons.push(`Rated ${evidence.score10.toFixed(1)}`)
    } else {
      reasons.push(`Provider rating ${evidence.score10.toFixed(1)}`)
    }
  }
  if (topGenreId && tasteScore > 0.15) {
    reasons.push(`Matches your taste in ${genreLabel(index.kind, topGenreId)}`)
  }
  if (ai > 0) reasons.push("Picked by AI Discovery")
  return {
    id: group.primaryId,
    groupId: group.id,
    aggregate,
    score,
    reasons: reasons.slice(0, 3),
    tasteScore,
    topGenreId,
  }
}

// ── Top-K (bounded heap) + diversity ─────────────────────────────────

function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.score !== b.score) return a.score - b.score
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function topK(candidates: Iterable<ScoredCandidate>, k: number): ScoredCandidate[] {
  const heap: ScoredCandidate[] = []
  const push = (candidate: ScoredCandidate) => {
    heap.push(candidate)
    let i = heap.length - 1
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2)
      if (compareCandidates(heap[i], heap[parent]) >= 0) break
      ;[heap[i], heap[parent]] = [heap[parent], heap[i]]
      i = parent
    }
  }
  const popMin = (): ScoredCandidate | undefined => {
    if (!heap.length) return undefined
    const min = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = 2 * i + 2
        let smallest = i
        if (left < heap.length && compareCandidates(heap[left], heap[smallest]) < 0) smallest = left
        if (right < heap.length && compareCandidates(heap[right], heap[smallest]) < 0) smallest = right
        if (smallest === i) break
        ;[heap[i], heap[smallest]] = [heap[smallest], heap[i]]
        i = smallest
      }
    }
    return min
  }
  for (const candidate of candidates) {
    if (heap.length < k) {
      push(candidate)
    } else if (k > 0 && compareCandidates(candidate, heap[0]) > 0) {
      popMin()
      push(candidate)
    }
  }
  return heap.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function decadeOf(aggregate: GroupAggregate): string {
  if (aggregate.year == null) return ""
  if (aggregate.year < 1980) return "older"
  return `${Math.floor(aggregate.year / 10) * 10}s`
}

/**
 * Greedy MMR diversity pass: each pick maximises base score minus
 * repetition penalties (0.10 per prior pick sharing the primary
 * genre, capped at 0.20; 0.05 per prior pick sharing the decade,
 * capped at 0.10). Deterministic: pool order breaks ties.
 */
function diversify(pool: ScoredCandidate[], limit: number): ScoredCandidate[] {
  const picked: ScoredCandidate[] = []
  const remaining = [...pool]
  const genreCounts = new Map<string, number>()
  const decadeCounts = new Map<string, number>()
  while (picked.length < limit && remaining.length) {
    let bestIndex = 0
    let bestMarginal = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const primaryGenre = candidate.aggregate.genreIds[0] ?? ""
      const decade = decadeOf(candidate.aggregate)
      const genrePenalty = 0.1 * Math.min(2, genreCounts.get(primaryGenre) ?? 0)
      const decadePenalty = 0.05 * Math.min(2, decadeCounts.get(decade) ?? 0)
      const marginal = candidate.score - genrePenalty - decadePenalty
      if (marginal > bestMarginal) {
        bestMarginal = marginal
        bestIndex = i
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1)
    picked.push(chosen)
    const primaryGenre = chosen.aggregate.genreIds[0] ?? ""
    genreCounts.set(primaryGenre, (genreCounts.get(primaryGenre) ?? 0) + 1)
    const decade = decadeOf(chosen.aggregate)
    decadeCounts.set(decade, (decadeCounts.get(decade) ?? 0) + 1)
  }
  return picked
}

function toResults(candidates: ScoredCandidate[]): SelectorResult[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    score: candidate.score,
    reasons: candidate.reasons,
    groupId: candidate.groupId,
  }))
}

// ── Revision-aware selector cache ────────────────────────────────────

const selectorCache = new Map<string, SelectorResult[]>()
const SELECTOR_CACHE_MAX = 64

/** Clear all cached selector results (tests / revision changes that bypass keys). */
export function invalidateSelectorCache(): void {
  selectorCache.clear()
}

function cacheable(
  index: CatalogIndex,
  view: TasteView,
  opts: SelectorOptions,
  selector: string,
  limit: number,
  extra: string,
): string | null {
  const volatile = opts.exposureCounts != null || opts.progressEntries != null
  const profileRevision = opts.profileRevision ?? opts.profile?.revision ?? null
  const cacheKey = opts.cacheKey ?? null
  if (volatile && cacheKey == null && profileRevision == null) return null
  if (opts.profile && (profileRevision == null || profileRevision === "")) return null
  return [
    selector,
    index.kind,
    index.revision,
    // D36: the build sequence identifies THIS index object. The
    // revision string + group count alone collide across different
    // catalogues (same playlist, same count, different titles).
    String(index.seq),
    String(index.totalGroups),
    view.fingerprint,
    String(limit),
    extra,
    profileRevision ?? "",
    cacheKey ?? "",
  ].join("|")
}

function cacheGet(key: string | null): SelectorResult[] | null {
  if (key == null) return null
  const hit = selectorCache.get(key)
  return hit ? [...hit] : null
}

function cachePut(key: string | null, results: SelectorResult[]): SelectorResult[] {
  if (key != null) {
    if (selectorCache.size >= SELECTOR_CACHE_MAX) {
      const oldest = selectorCache.keys().next().value
      if (oldest !== undefined) selectorCache.delete(oldest)
    }
    selectorCache.set(key, [...results])
  }
  return [...results]
}

/** Cache discriminator for the (gated) AI input: ungated input fingerprints empty, like no input. */
function aiFingerprint(opts: SelectorOptions): string {
  if (!opts.aiRecommendationsAllowed || !Array.isArray(opts.aiRecommendations)) return ""
  return opts.aiRecommendations.map((rec) => `${rec?.id ?? ""}:${rec?.rank ?? ""}`).join(",")
}

function clampLimit(limit: unknown, fallback: number): number {
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(50, n))
}

function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ── Argument normalisation (canonical + shorthand call shapes) ───────

const SELECTOR_OPTION_KEYS = new Set([
  "profile", "watchedIds", "completedIds", "favouriteIds", "exposureCounts",
  "progressEntries", "rotationSeed", "cutoff", "nowMs", "aiRecommendations",
  "aiRecommendationsAllowed", "excludeWatched", "excludeCompleted", "cacheKey", "profileRevision",
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
}

function looksLikeTaste(value: unknown): value is TasteModel | TasteSignals {
  if (!isPlainObject(value)) return false
  return (
    "likedTitles" in value ||
    "favouriteTitles" in value ||
    "genreWeights" in value ||
    "notInterestedKeys" in value ||
    "profileId" in value
  )
}

function looksLikeOptions(value: unknown): value is SelectorOptions {
  if (!isPlainObject(value)) return false
  if (looksLikeTaste(value)) return false
  return Object.keys(value).some((key) => SELECTOR_OPTION_KEYS.has(key)) || Object.keys(value).length === 0
}

interface NormalisedArgs {
  taste: TasteInput
  limit: number
  cutoff: number | Date | null
  opts: SelectorOptions
}

/**
 * Accepts both the canonical (index, taste, limit?, cutoff?, opts?)
 * shape and the shorthand (index, limit?, cutoff?, opts?) shape used
 * by brief §4 for Recently Added / Hidden Gems. A numeric second
 * argument is always the limit; an options-shaped object is always
 * options; a Date/number after the limit is always the cutoff.
 */
function normaliseArgs(
  a2: unknown,
  a3: unknown,
  a4: unknown,
  a5: unknown,
  defaultLimit: number,
): NormalisedArgs {
  let taste: TasteInput = null
  let limit: number | undefined
  let cutoff: number | Date | null = null
  let opts: SelectorOptions = {}
  const rest: unknown[] = []
  if (typeof a2 === "number") {
    limit = a2
    rest.push(a3, a4, a5)
  } else if (a2 == null || looksLikeTaste(a2)) {
    taste = (a2 as TasteInput) ?? null
    rest.push(a3, a4, a5)
  } else if (looksLikeOptions(a2)) {
    opts = a2 as SelectorOptions
    rest.push(a3, a4, a5)
  } else {
    rest.push(a3, a4, a5)
  }
  for (const arg of rest) {
    if (arg == null) continue
    if (typeof arg === "number" && limit === undefined) {
      limit = arg
    } else if ((typeof arg === "number" || arg instanceof Date) && cutoff == null) {
      cutoff = arg
    } else if (looksLikeOptions(arg)) {
      opts = { ...opts, ...(arg as SelectorOptions) }
    }
  }
  if (opts.cutoff != null && cutoff == null) cutoff = opts.cutoff
  return { taste, limit: clampLimit(limit, defaultLimit), cutoff, opts }
}

function cutoffMs(cutoff: number | Date | null | undefined): number | null {
  if (cutoff == null) return null
  const ms = cutoff instanceof Date ? cutoff.getTime() : Number(cutoff)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms > 1e11 ? ms : ms * 1000
}

// ── Featured ─────────────────────────────────────────────────────────

/**
 * ONE defensible, STABLE featured film (brief §14.1).
 * Scoring: quality evidence (Bayesian) + taste affinity + verified
 * identity + optional AI boost, with watched/favourite penalties and
 * a poster requirement. Never first-with-poster, newest upload, or
 * a bare provider 10/10: quality must be EVIDENCED (Bayesian score)
 * and the pick is the best composite in the top pool, chosen
 * deterministically by hash(rotationSeed + revision + id) so it
 * cannot randomly change per page open. Diversity over time comes
 * from the caller rotating rotationSeed (e.g. a daily bucket).
 * Returns null only when the index holds no groups.
 */
export function selectFeaturedFilm(
  index: CatalogIndex | null | undefined,
  taste: TasteInput,
  _limit?: number,
  opts: SelectorOptions = {},
): SelectorResult | null {
  if (!index || !index.groups.length) return null
  const ctx = scoringContext(index, taste, opts)
  const cacheKey = cacheable(index, ctx.view, opts, "featured", 1, `${String(opts.rotationSeed ?? index.revision)}|${aiFingerprint(opts)}`)
  const cached = cacheGet(cacheKey)
  if (cached) return cached[0] ?? null

  const seed = String(opts.rotationSeed ?? index.revision)
  const pickFrom = (requirePoster: boolean, penaliseWatched: boolean): SelectorResult | null => {
    const scored: ScoredCandidate[] = []
    for (const group of index.groups) {
      const aggregate = index.groupAggregates.get(group.id)
      if (!aggregate) continue
      if (requirePoster && !aggregate.hasPoster) continue
      const candidate = scoreCandidate(index, ctx, group, aggregate, {
        watchedPenalty: penaliseWatched ? 0.35 : 0,
        favouritePenalty: 0.15,
      })
      if (candidate) scored.push(candidate)
    }
    if (!scored.length) return null
    // Near-best pool by composite (within 0.05 of the max, max 8),
    // then a stable seeded pick inside it: rotation can only ever
    // surface a title as strong as the best composite.
    const pool = topK(scored, Math.min(8, scored.length))
    const maxScore = pool[0].score
    const nearBest = pool.filter((candidate) => candidate.score >= maxScore - 0.05)
    let best = nearBest[0]
    let bestHash = hashString(`${seed}|${index.revision}|${best.id}`)
    for (const candidate of nearBest) {
      const hash = hashString(`${seed}|${index.revision}|${candidate.id}`)
      if (hash < bestHash) {
        bestHash = hash
        best = candidate
      }
    }
    return { id: best.id, score: best.score, reasons: best.reasons, groupId: best.groupId }
  }

  const strict = pickFrom(true, true)
  if (strict) return cachePut(cacheKey, [strict])[0] ?? null
  const relaxedWatched = pickFrom(true, false)
  if (relaxedWatched) return cachePut(cacheKey, [relaxedWatched])[0] ?? null
  const anyTitle = pickFrom(false, false)
  if (anyTitle) return cachePut(cacheKey, [anyTitle])[0] ?? null
  return null
}

// ── Worth Watching ───────────────────────────────────────────────────

/**
 * The strongest shelf (brief §14.2): quality evidence + taste +
 * diversity across genres/eras, unwatched/discovery bias, exposure
 * rotation. NOT the rating-8+ shortcut: mid-rated titles with
 * strong taste affinity and real evidence can outrank thinly
 * supported high ratings, and diversity (MMR) keeps the shelf from
 * collapsing into one genre or decade.
 */
export function selectWorthWatching(
  index: CatalogIndex | null | undefined,
  taste: TasteInput,
  limit = 12,
  opts: SelectorOptions = {},
): SelectorResult[] {
  if (!index || !index.groups.length) return []
  const capped = clampLimit(limit, 12)
  const ctx = scoringContext(index, taste, opts)
  const cacheKey = cacheable(index, ctx.view, opts, "worth", capped, aiFingerprint(opts))
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const scored: ScoredCandidate[] = []
  for (const group of index.groups) {
    const aggregate = index.groupAggregates.get(group.id)
    if (!aggregate) continue
    const candidate = scoreCandidate(index, ctx, group, aggregate, {})
    if (candidate) scored.push(candidate)
  }
  const pool = topK(scored, Math.min(300, Math.max(24, capped * 6)))
  return cachePut(cacheKey, toResults(diversify(pool, capped)))
}

// ── Recently Added ───────────────────────────────────────────────────

/**
 * Recently added titles (brief §14.3): provider ADDED timestamps,
 * never release years; deduped at group level; honest about
 * cutoffs — titles with unknown added dates are excluded, and a
 * cutoff returns ONLY titles inside it (never padded with older
 * titles). Score is the added timestamp (epoch ms).
 * Call shapes: (index, taste, limit?, cutoff?, opts?) or
 * (index, limit?, cutoff?, opts?).
 */
export function selectRecentlyAdded(
  index: CatalogIndex | null | undefined,
  tasteOrLimit?: TasteInput | number,
  limitOrCutoff?: number | Date | null,
  cutoffOrOpts?: number | Date | SelectorOptions | null,
  maybeOpts?: SelectorOptions,
): SelectorResult[] {
  if (!index || !index.groups.length) return []
  const { taste, limit, cutoff, opts } = normaliseArgs(
    tasteOrLimit,
    limitOrCutoff,
    cutoffOrOpts,
    maybeOpts,
    12,
  )
  const ctx = scoringContext(index, taste, opts)
  const cutoffValue = cutoffMs(cutoff)
  const cacheKey = cacheable(index, ctx.view, opts, "recent", limit, String(cutoffValue ?? ""))
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const results: SelectorResult[] = []
  for (const group of index.groups) {
    const aggregate = index.groupAggregates.get(group.id)
    if (!aggregate || aggregate.addedMs == null) continue
    if (cutoffValue != null && aggregate.addedMs < cutoffValue) continue
    if (groupHits(ctx.view.notInterested, group)) continue
    if (groupHits(ctx.view.hardDislikedIds, group)) continue
    const date = new Date(aggregate.addedMs).toISOString().slice(0, 10)
    results.push({
      id: group.primaryId,
      score: aggregate.addedMs,
      reasons: [`Added ${date}`],
      addedMs: aggregate.addedMs,
      groupId: group.id,
    })
  }
  results.sort((a, b) => (b.addedMs ?? 0) - (a.addedMs ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return cachePut(cacheKey, results.slice(0, limit))
}

// ── Hidden Gems ──────────────────────────────────────────────────────

/**
 * Hidden gems (brief §14.4): quality + UNDEREXPOSURE evidence.
 * Rating alone is NEVER proof of obscurity: a strict pass requires
 * BOTH a Bayesian score >= 6.8 AND at least one non-rating obscurity
 * signal (few votes, or zero/low exposure + not recently added).
 * When no title carries any obscurity signal, a relaxed pass falls
 * back to quality + lowest exposure and says so in the reasons.
 * AI recommendations do not apply here: gems are defined by
 * evidence + obscurity, and an AI boost would corrupt that.
 * Call shapes: (index, taste, limit?, opts?) or (index, limit?, opts?).
 */
export function selectHiddenGems(
  index: CatalogIndex | null | undefined,
  tasteOrLimit?: TasteInput | number,
  limitOrOpts?: number | SelectorOptions | null,
  maybeOpts?: SelectorOptions,
): SelectorResult[] {
  if (!index || !index.groups.length) return []
  const { taste, limit, opts } = normaliseArgs(tasteOrLimit, limitOrOpts, maybeOpts, undefined, 12)
  const ctx = scoringContext(index, taste, opts)
  const exposureKnown = opts.exposureCounts != null
  const nowMs = opts.nowMs ?? Date.now()
  const cacheKey = cacheable(index, ctx.view, opts, "gems", limit, exposureKnown ? "exp" : "noexp")
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const obscurityOf = (group: TitleGroupLike & { id: string }, aggregate: GroupAggregate): { value: number; signal: string | null } => {
    const votes = aggregate.rating?.voteCount
    if (votes != null) {
      if (votes < 100) return { value: 0.5, signal: `Few votes so far (${votes})` }
      if (votes < 500) return { value: 0.4, signal: `Few votes so far (${votes})` }
      if (votes < 1000) return { value: 0.25, signal: `Modest vote count (${votes})` }
    }
    const exposure = exposureOf(ctx, group)
    if (exposureKnown && exposure === 0) {
      const old = aggregate.addedMs != null && nowMs - aggregate.addedMs > 90 * 24 * 60 * 60 * 1000
      if (old) return { value: 0.25, signal: "Rarely surfaced" }
      return { value: 0.15, signal: "Rarely surfaced" }
    }
    return { value: 0, signal: null }
  }

  const build = (strict: boolean): SelectorResult[] => {
    const scored: ScoredCandidate[] = []
    for (const group of index.groups) {
      const aggregate = index.groupAggregates.get(group.id)
      if (!aggregate) continue
      if (groupHits(ctx.view.notInterested, group)) continue
      if (groupHits(ctx.view.hardDislikedIds, group)) continue
      const isWatched = groupHits(ctx.watched, group)
      if (ctx.excludeWatched && isWatched) continue
      const { value: obscurity, signal } = obscurityOf(group, aggregate)
      if (strict && (aggregate.bayesian < 6.8 || obscurity <= 0)) continue
      if (!strict && aggregate.bayesian < 6.5) continue
      const { score: tasteScore, topGenreId } = tasteAffinity(aggregate.genreIds, index.kind, ctx.view)
      let score = 0.55 * quality01(aggregate.bayesian) + 0.25 * tasteScore + 0.2 * obscurity
      if (isWatched) score -= WATCHED_PENALTY
      if (groupHits(ctx.favourites, group)) score -= FAVOURITE_PENALTY
      score = Math.max(0, score)
      const reasons: string[] = []
      if (signal) reasons.push(signal)
      if (!strict && !signal) reasons.push("Limited exposure data")
      if (aggregate.rating && aggregate.bayesian >= 7) {
        reasons.push(`Rated ${aggregate.rating.score10.toFixed(1)}`)
      }
      if (topGenreId && tasteScore > 0.15) {
        reasons.push(`Matches your taste in ${genreLabel(index.kind, topGenreId)}`)
      }
      scored.push({
        id: group.primaryId,
        groupId: group.id,
        aggregate,
        score,
        reasons: reasons.slice(0, 3),
        tasteScore,
        topGenreId,
      })
    }
    const pool = topK(scored, Math.min(300, Math.max(24, limit * 6)))
    return toResults(diversify(pool, limit))
  }

  const strictResults = build(true)
  if (strictResults.length) return cachePut(cacheKey, strictResults)
  return cachePut(cacheKey, build(false))
}

// ── Continue Watching ────────────────────────────────────────────────

/**
 * Genuinely in-progress titles only (brief §3.4): entries with
 * position > 0 (or a fraction in (0, 1)) that are NOT completed.
 * Never-started, completed and zero-progress entries are excluded.
 * Movies resolve by vod id; series roll up per series id (latest
 * episode progress wins) and resolve to series-level entries only —
 * episode records are never returned as titles. Progress comes
 * from opts.progressEntries (preferred) or opts.profile; the taste
 * argument is accepted for signature uniformity and ignored — this
 * is a factual shelf, and "not interested" does not hide a title
 * the viewer is mid-way through.
 */
export function selectContinueWatching(
  index: CatalogIndex | null | undefined,
  _taste: TasteInput,
  limit = 12,
  opts: SelectorOptions = {},
): SelectorResult[] {
  if (!index) return []
  const capped = clampLimit(limit, 12)
  const view = tasteViewFor(null, index.kind)
  const cacheKey = cacheable(index, view, opts, "continue", capped, "")
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  interface RolledUp {
    primaryId: string
    groupId: string
    fraction: number | null
    updatedAt: number
  }
  const rolled = new Map<string, RolledUp>()

  const consider = (resolvedId: string, fraction: number | null, updatedAt: number) => {
    const groupId = index.groupIdByEntryId.get(resolvedId)
    const group = groupId ? index.groupById.get(groupId) : undefined
    if (!group) return
    const primaryId = group.primaryId
    const existing = rolled.get(primaryId)
    if (!existing || updatedAt >= existing.updatedAt) {
      rolled.set(primaryId, { primaryId, groupId: group.id, fraction, updatedAt })
    }
  }

  const fractionOf = (input: {
    position?: number | null
    duration?: number | null
    progressFraction?: number | null
  }): number | null => {
    const explicit = input.progressFraction
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      return Math.max(0, Math.min(1, explicit))
    }
    const position = Number(input.position)
    const duration = Number(input.duration)
    if (Number.isFinite(position) && position > 0 && Number.isFinite(duration) && duration > 0) {
      return Math.max(0, Math.min(1, position / duration))
    }
    if (Number.isFinite(position) && position > 0) return null
    return 0
  }

  const progressInputs: ContinueWatchingInput[] = [...(opts.progressEntries ?? [])]
  if (opts.profile) {
    for (const [id, progress] of opts.profile.progressById) {
      progressInputs.push({
        kind: progress.seriesId != null ? "episode" : index.kind === "series" ? "series" : "vod",
        id,
        seriesId: progress.seriesId,
        progressFraction: progress.fraction,
        completed: progress.completed,
        updatedAt: progress.updatedAt,
      })
    }
  }

  for (const input of progressInputs) {
    if (!input || input.completed) continue
    const fraction = fractionOf(input)
    // Genuinely in progress: started (fraction > 0, or position > 0
    // with unknown duration) and not finished (fraction < 1).
    if (fraction === 0) continue
    if (fraction != null && fraction >= 1) continue
    const updatedAt = Number(input.updatedAt) || 0
    if (input.kind === "episode") {
      if (index.kind !== "series") continue
      const seriesId = input.seriesId == null ? null : String(input.seriesId)
      if (!seriesId) continue
      consider(seriesId, fraction, updatedAt)
    } else if (input.kind === "vod") {
      if (index.kind !== "vod") continue
      consider(String(input.id), fraction, updatedAt)
    } else {
      if (index.kind !== "series") continue
      consider(String(input.id), fraction, updatedAt)
    }
  }

  const results = [...rolled.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.primaryId < b.primaryId ? -1 : 1))
    .slice(0, capped)
    .map((entry): SelectorResult => {
      const result: SelectorResult = {
        id: entry.primaryId,
        score: entry.updatedAt,
        reasons:
          entry.fraction != null
            ? [`${Math.round(entry.fraction * 100)}% watched`]
            : ["In progress"],
        updatedAt: entry.updatedAt,
        groupId: entry.groupId,
      }
      if (entry.fraction != null) result.progressFraction = entry.fraction
      return result
    })
  return cachePut(cacheKey, results)
}

// ── Series Worth Starting ────────────────────────────────────────────

/**
 * Series-level entries only (brief §4.4): returns [] for a movies
 * index, never surfaces episode records, and never claims
 * season-completeness — season counts play no part in scoring or
 * reasons. Scoring mirrors Worth Watching (quality + taste +
 * diversity, unwatched bias); series with any recorded progress
 * are excluded (already started, not "worth starting").
 */
export function selectSeriesWorthStarting(
  index: CatalogIndex | null | undefined,
  taste: TasteInput,
  limit = 12,
  opts: SelectorOptions = {},
): SelectorResult[] {
  if (!index || index.kind !== "series" || !index.groups.length) return []
  const capped = clampLimit(limit, 12)
  const ctx = scoringContext(index, taste, opts)
  const cacheKey = cacheable(index, ctx.view, opts, "series-start", capped, aiFingerprint(opts))
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const started = new Set<string>(ctx.watched)
  for (const input of opts.progressEntries ?? []) {
    if (input.kind === "episode" && input.seriesId != null) started.add(String(input.seriesId))
    else if (input.kind === "series") started.add(String(input.id))
  }
  if (opts.profile) {
    for (const [id, progress] of opts.profile.progressById) {
      if (progress.seriesId) started.add(progress.seriesId)
      else if (progress.fraction > 0 || progress.completed) started.add(id)
    }
  }

  const scored: ScoredCandidate[] = []
  for (const group of index.groups) {
    if (groupHits(started, group)) continue
    const aggregate = index.groupAggregates.get(group.id)
    if (!aggregate) continue
    // Confirmed-empty series (explicit episode evidence of 0) have
    // nothing to start — never surface them. Unknown counts (null)
    // stay eligible: absence of cached episode data is not emptiness.
    const primaryMeta = index.meta.get(group.primaryId)
    if (primaryMeta?.episodeCount === 0) continue
    const candidate = scoreCandidate(index, ctx, group, aggregate, {})
    if (candidate) scored.push(candidate)
  }
  const pool = topK(scored, Math.min(300, Math.max(24, capped * 6)))
  return cachePut(cacheKey, toResults(diversify(pool, capped)))
}

// ── AI-ranked picks (0.11.14, W5) ────────────────────────────────────

/**
 * Verified AI picks in MODEL order (brief §13, §18): the model must
 * influence the actual order — this selector never re-sorts by local
 * score and never diversifies the model's ranking. It only
 * VALIDATES: each pick must resolve to a displayed group primary in
 * THIS index (variant ids resolve to their group primary), must pass
 * the same hard exclusions as every other shelf (not-interested,
 * explicit dislikes, excludeWatched/excludeCompleted), and must not
 * repeat. Picks that fail validation are dropped, never replaced —
 * an empty result means "no verified AI picks", and the caller falls
 * back to local shelves with an honest label. The model reason is
 * carried as the first reason (the ranker already sanitised it
 * against real metadata); evidence reasons follow. This is the
 * Home wiring for `aiRecommendations` — the boost path in
 * scoreCandidate stays for callers that want AI as a nudge inside a
 * local ranking, and must never be used to label a local shelf "AI".
 */
export function selectAiRankedPicks(
  index: CatalogIndex | null | undefined,
  picks: Array<{ id: string | number; rank?: number; reason?: string | null }> | null | undefined,
  taste: TasteInput,
  limit = 16,
  opts: SelectorOptions = {},
): SelectorResult[] {
  if (!index || !index.groups.length || !Array.isArray(picks) || picks.length === 0) return []
  const capped = clampLimit(limit, 16)
  const ctx = scoringContext(index, taste, opts)
  const ordered = [...picks].sort((a, b) => {
    const ra = Number(a?.rank ?? 0)
    const rb = Number(b?.rank ?? 0)
    if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return ra - rb
    return 0
  })
  const results: SelectorResult[] = []
  const seen = new Set<string>()
  for (const pick of ordered) {
    if (results.length >= capped) break
    if (!pick) continue
    const rawId = String(pick.id ?? "").trim()
    if (!rawId) continue
    const groupId = index.groupIdByEntryId.get(rawId)
    const group = groupId ? index.groupById.get(groupId) : undefined
    if (!group) continue
    const primaryId = group.primaryId
    if (seen.has(primaryId)) continue
    const aggregate = index.groupAggregates.get(group.id)
    if (!aggregate) continue
    // Hard exclusions — identical to scoreCandidate's.
    if (groupHits(ctx.view.notInterested, group)) continue
    if (groupHits(ctx.view.hardDislikedIds, group)) continue
    if (ctx.excludeWatched && groupHits(ctx.watched, group)) continue
    if (ctx.excludeCompleted && groupHits(ctx.completed, group)) continue
    seen.add(primaryId)
    const reasons: string[] = []
    const modelReason = typeof pick.reason === "string" ? pick.reason.trim() : ""
    if (modelReason) reasons.push(modelReason)
    const evidence = aggregate.rating
    if (evidence && aggregate.bayesian >= 7 && evidence.score10 >= 7) {
      reasons.push(`Rated ${evidence.score10.toFixed(1)}`)
    }
    results.push({
      id: primaryId,
      score: results.length === 0 ? 1 : Math.round(((capped - results.length) / capped) * 100) / 100,
      reasons: reasons.slice(0, 3),
      groupId: group.id,
    })
  }
  return results
}

// ── Something Different (0.11.14, W5) ────────────────────────────────

/**
 * Controlled exploration (brief §14): variety OUTSIDE the viewer's
 * strongest genre preferences, without random poor-quality titles.
 * Scoring rewards quality + high-confidence metadata + distance from
 * taste affinity; titles matching the strongest taste genres are
 * penalised, never boosted. A strict pass requires a quality floor
 * (Bayesian >= 6.5), credible rating evidence or a TMDb identity,
 * and artwork; a relaxed pass (Bayesian >= 6.0, artwork or TMDb
 * identity) fills the shelf only when the strict pass is empty, so
 * thin catalogues still get exploration without rubbish. With no
 * taste signal at all, exploration is undefined — the shelf falls
 * back to quality + diversity and says so in its reasons (the model
 * layer labels it honestly; nothing here claims personalisation).
 * AI recommendations do not apply: exploration is defined by
 * distance from taste, and an AI boost would corrupt that.
 */
export function selectSomethingDifferent(
  index: CatalogIndex | null | undefined,
  taste: TasteInput,
  limit = 16,
  opts: SelectorOptions = {},
): SelectorResult[] {
  if (!index || !index.groups.length) return []
  const capped = clampLimit(limit, 16)
  const ctx = scoringContext(index, taste, opts)
  const hasTaste = ctx.view.genreWeights.size > 0 || ctx.view.likedIds.size > 0
  const cacheKey = cacheable(index, ctx.view, opts, "different", capped, hasTaste ? "taste" : "notaste")
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const build = (strict: boolean): SelectorResult[] => {
    const scored: ScoredCandidate[] = []
    for (const group of index.groups) {
      const aggregate = index.groupAggregates.get(group.id)
      if (!aggregate) continue
      if (groupHits(ctx.view.notInterested, group)) continue
      if (groupHits(ctx.view.hardDislikedIds, group)) continue
      if (ctx.excludeWatched && groupHits(ctx.watched, group)) continue
      if (ctx.excludeCompleted && groupHits(ctx.completed, group)) continue
      const qualityFloor = strict ? 6.5 : 6.0
      if (aggregate.bayesian < qualityFloor) continue
      const credible = hasCredibleRating(aggregate.rating)
      const identified = group.tmdbId != null
      if (strict && !credible && !identified) continue
      if (strict && !aggregate.hasPoster) continue
      if (!strict && !aggregate.hasPoster && !identified) continue
      const { score: tasteScore, topGenreId } = tasteAffinity(aggregate.genreIds, index.kind, ctx.view)
      const exploration = hasTaste ? 1 - tasteScore : 0.5
      let score =
        0.55 * quality01(aggregate.bayesian) +
        0.3 * exploration +
        0.1 * (aggregate.hasPoster ? 1 : 0) +
        0.05 * (identified ? 1 : 0)
      if (groupHits(ctx.watched, group)) score -= WATCHED_PENALTY
      if (groupHits(ctx.favourites, group)) score -= FAVOURITE_PENALTY
      score = Math.max(0, score)
      const reasons: string[] = []
      if (hasTaste && tasteScore < 0.15 && aggregate.genreIds.length > 0) {
        reasons.push("Outside your usual genres")
      } else if (!hasTaste) {
        reasons.push("Worth a look beyond the top picks")
      }
      if (aggregate.rating && aggregate.bayesian >= 7) {
        reasons.push(`Rated ${aggregate.rating.score10.toFixed(1)}`)
      }
      if (topGenreId && tasteScore >= 0.15 && hasTaste) {
        reasons.push(genreLabel(index.kind, topGenreId))
      }
      scored.push({
        id: group.primaryId,
        groupId: group.id,
        aggregate,
        score,
        reasons: reasons.slice(0, 3),
        tasteScore,
        topGenreId,
      })
    }
    const pool = topK(scored, Math.min(300, Math.max(24, capped * 6)))
    return toResults(diversify(pool, capped))
  }

  const strictResults = build(true)
  if (strictResults.length) return cachePut(cacheKey, strictResults)
  return cachePut(cacheKey, build(false))
}

// ── Cross-shelf diversity ────────────────────────────────────────────

export interface ShelfInput {
  name: string
  items: SelectorResult[]
  /** Exempt shelves pass through untouched and never mark ids as seen. */
  exempt?: boolean
}

function isContinueWatchingShelf(shelf: ShelfInput): boolean {
  if (shelf.exempt) return true
  return shelf.name.toLowerCase().replace(/[-_\s]+/g, "") === "continuewatching"
}

/**
 * Diversity rule helper (brief §14): given multiple shelves for one
 * page, reduce repeated exposure of the same title across Featured /
 * Worth Watching / Recently Added / genre rows — the first shelf
 * (in the given order) keeps a title, later shelves drop it.
 * Continue Watching is EXCEPTED: it keeps its own items and its
 * titles may still appear on other shelves. Within-shelf duplicates
 * are removed too. Inputs are never mutated.
 */
export function reduceRepeatedExposure(shelves: ShelfInput[]): ShelfInput[] {
  const seen = new Set<string>()
  return (shelves || []).map((shelf) => {
    if (isContinueWatchingShelf(shelf)) {
      return { ...shelf, items: [...shelf.items] }
    }
    const kept: SelectorResult[] = []
    const shelfSeen = new Set<string>()
    for (const item of shelf.items || []) {
      if (shelfSeen.has(item.id) || seen.has(item.id)) continue
      shelfSeen.add(item.id)
      kept.push(item)
    }
    for (const id of shelfSeen) seen.add(id)
    return { ...shelf, items: kept }
  })
}
