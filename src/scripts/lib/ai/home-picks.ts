// Home AI picks (0.11.14, W4) — the ONE Home-facing AI core for
// Movies/Series Home shelves. W5 builds presentation against the
// contract in this file; Discover keeps using discovery-orchestrator
// untouched.
//
// =====================================================================
// HOME-FACING API CONTRACT (W5 reads this)
// =====================================================================
// RENDER (sync, zero network, safe on every page load):
//   readCachedHomeAiPicks(request) -> HomeAiResult | null
//     Fresh durable-cache picks, re-validated against the CURRENT
//     pool. Null when absent/expired/stale. Never a model call.
//
// EXPLICIT (viewer pressed "Generate AI Picks"):
//   requestHomeAiPicks({..., trigger: "explicit", forceFresh: true})
//     -> HomeAiResult. Makes at most ONE model call (rerank path),
//     deduped in flight. forceFresh bypasses the fresh cache — the
//     button promises fresh picks, so it must request them.
//   requestHomeAiDiscovery({..., brief, forceFresh?}) -> HomeAiResult
//     Generation + TMDb verification path for mood/brief entry
//     points. Serves a fresh cache entry unless forceFresh (only
//     "Surprise me" forces fresh). Picks are verified+matched only;
//     verified-but-unmatched titles arrive in `verifiedUnmatched`
//     and must NEVER be rendered as playable.
//
// QUIET AUTO-REFRESH (optional preference, default OFF):
//   maybeAutoRefreshHomeAiPicks(request, deps) -> HomeAiResult | null
//     Null when no refresh is allowed/needed (preference off, fresh
//     cache present, in-flight, or inside the 24h attempt bound).
//     When it refreshes, it resolves with the fresh result; W5 swaps
//     the shelf in place without moving focus. Never called from
//     focus/scroll/filter handlers — W5 calls it once per Home mount
//     at most, and the core enforces the rest.
//   decideHomeAiAutoRefresh(request) -> decision (sync, for tests/UI)
//
// RESULTS (HomeAiResult):
//   picks: HomeAiPick[] — ONLY playable, validated catalogue entries
//     (compositeId `${kind}:${id}`, kind == requested kind, no
//     episode targets). Empty when AI produced nothing usable.
//   source: "fresh-ai" | "cached-ai" | "local-only" | "ai-unavailable"
//     Shelf labels MUST derive from this, and only this. An AI badge
//     is honest only for fresh-ai / cached-ai with picks.
//   model / answeredAt / cacheHit / sentToModelCount / droppedCount
//     Receipt fields for honest labels + diagnostics. No secrets.
//   fallbackReason: why local/ai-unavailable, in user-facing words.
//   verifiedUnmatched: generation path only, verified but NOT in the
//     library — never playable, never a detail link to a guess.
//
// SELECTOR INPUT (collection-selectors.ts):
//   toSelectorAiRecommendations(picks) -> [{id, rank}] (bare ids).
//   Pass them ONLY with aiRecommendationsAllowed=true, and only when
//   homeAiAllowsSelectorBoost(result) is true (fresh/cached AI with
//   picks). Local picks must never travel as aiRecommendations.
//
// COST / PRIVACY RULES ENFORCED HERE (brief §16/§18):
// - No model call except inside requestHomeAiPicks /
//   requestHomeAiDiscovery. Page loads, focus, scroll, filter
//   changes and metadata refreshes never reach this module's
//   request paths except through the explicit/auto entry points.
// - At most one auto-refresh per content type per ~24h (attempt
//   ledger); in-flight dedup; no retries (one attempt, then the
//   honest unavailable result). Failures record an attempt too, so
//   a failing provider cannot storm.
// - Taste content reaches the provider ONLY when getAiShareTaste()
//   allows (gated here AND inside ranking/generation — defence in
//   depth). With sharing off, the model still evaluates a bounded
//   non-personal candidate shortlist on explicit request.
// - Keys stay in the secure store (client.ts/keystore.ts). Nothing
//   here reads, logs, or stores a key, endpoint, or request body.
// - The 20-candidate model-shortlist cap (applyRerankCap) is reused
//   for ranking; generation clamps to 12. The full catalogue is
//   never submitted.
// - The model must influence the ranking when AI is claimed: picks
//   come ONLY from validated model output. Local order is never
//   relabelled as AI.
//
// PIPELINE REUSE (§11): ranking via aiRanker.rankShortlist
// (ranking.ts, incl. its ID validation + relatedness checks);
// generation via generateRecommendations (generation.ts) +
// verifyRecommendations (verification.ts, TMDb identity + confident
// catalogue matching). No second pipeline, no second credential
// system, no verification removal, no fuzzy title -> playable
// matching anywhere in this module.

import { getAiEnabled, getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import { getAiShareTaste, getAiHomeAutoRefresh } from "./status.js"
import {
  aiRanker,
  applyRerankCap,
  compositeCandidateId,
  sanitizeReason,
  RANKING_PIPELINE_VERSION,
  type DiscoverCandidate as RankCandidate,
  type RankedCandidate,
  type TasteSummary,
} from "./ranking.js"
import {
  generateRecommendations,
  clampCount,
  type AiChatTransport,
  type GeneratedRecommendation,
} from "./generation.js"
import {
  verifyRecommendations,
  defaultTmdbSearch,
  defaultFetchDetails,
  defaultResolveExternalId,
  type ExternalIdResolver,
  type TmdbDetailsFn,
  type TmdbSearchFn,
  type VerifiedRecommendation,
} from "./verification.js"
import {
  buildHomeAiCacheKey,
  buildHomeAiLedgerKey,
  clearHomeAiCache as clearHomeCacheStore,
  isHomeAiAttemptBounded,
  readHomeAiCacheEntry,
  writeHomeAiCacheEntry,
  recordHomeAiAttempt,
  HOME_AI_CACHE_TTL_MS,
  type HomeAiCacheEntry,
  type HomeAiKind,
  type HomeAiPick,
  type HomeAiRequestType,
} from "./home-cache.js"
import type { DiscoverCandidate } from "../discover.js"
import type { TasteSummaryShape } from "../taste.ts"

export type { HomeAiKind, HomeAiPick, HomeAiRequestType }
export { HOME_AI_CACHE_TTL_MS }

/**
 * Bump when the Home prompt, validation rules, pick shape or cache
 * identity change — including when ranking/generation/verification
 * behaviour changes in a way that alters Home picks. Old cached
 * picks must never be reused against a new pipeline.
 */
export const HOME_AI_PIPELINE_VERSION = 1

export const HOME_AI_DEFAULT_COUNT = 10
export const HOME_AI_MAX_COUNT = 12

/** Re-exported for W5: the rerank cost control, unchanged. */
export const HOME_AI_MAX_SHORTLIST = 20

export type HomeAiTrigger = "explicit" | "auto-refresh"

export type HomeAiSource = "fresh-ai" | "cached-ai" | "local-only" | "ai-unavailable"

export function homeAiSourceLabel(source: HomeAiSource): string {
  switch (source) {
    case "fresh-ai":
      return "AI picks"
    case "cached-ai":
      return "AI picks · cached"
    case "local-only":
      return "Local recommendations"
    case "ai-unavailable":
      return "AI unavailable — local recommendations"
  }
}

export interface HomeAiResult {
  picks: HomeAiPick[]
  source: HomeAiSource
  kind: HomeAiKind
  requestType: HomeAiRequestType
  /** Model id that produced the picks, when a real request ran (or was cached). */
  model?: string
  /** When a real provider call completed; null for cache/local results. */
  answeredAt: number | null
  cacheHit: boolean
  /** Candidates actually sent to the model (0 for cache/local). */
  sentToModelCount: number
  /** Model/verification outputs dropped by validation. */
  droppedCount: number
  /** User-facing reason when source is local-only / ai-unavailable. */
  fallbackReason?: string
  /**
   * Generation path only: TMDb-verified titles with NO confident
   * catalogue match. Real titles, not playable — W5 must never
   * render these as in-library or link them to a guessed detail
   * page. Always [] on the rerank path.
   */
  verifiedUnmatched: VerifiedRecommendation[]
  /** Durable-cache key for this request (diagnostics, no secrets). */
  cacheKey: string
}

export interface HomeAiPicksRequest {
  kind: HomeAiKind
  /**
   * W5's relevance-ordered candidate pool for this kind (taste /
   * quality / diversity shaped, hard exclusions already applied by
   * W5 where it knows them). The core re-applies kind + exclusion
   * filtering, then the 20-cap keeps the head of THIS order — W5
   * must never pass raw catalogue order and call it a pool.
   */
  candidates: DiscoverCandidate[]
  /** Composite ids (`kind:id`) to exclude, e.g. completed / disliked. */
  excludeCompositeIds?: string[]
  /** Normalised titles to exclude (already-suggested, disliked). */
  excludeTitles?: string[]
  /** Local taste summary; sent ONLY when taste sharing allows. */
  taste?: TasteSummaryShape | TasteSummary | null
  /** Taste-model revision stamp (e.g. updatedAt); "" when unknown. */
  tasteRevision?: string
  /** Shelf brief for the model, e.g. "dark and tense". Never history. */
  mood?: string
  /** Runtime cap in minutes, when the shelf states one. */
  maxRuntimeMinutes?: number
  /** Picks wanted (1..12, default 10). */
  count?: number
  profileId?: string
  playlistId?: string
  catalogueRevision?: string | number | null
  trigger: HomeAiTrigger
  /** Explicit "Generate AI Picks" passes true: bypass a fresh cache. */
  forceFresh?: boolean
}

export interface HomeAiDiscoveryRequest {
  kind: HomeAiKind
  /** The viewer's brief, e.g. "A gripping crime series". Required. */
  brief: string
  /** Full catalogue for confident matching (both kinds OK; kind-filtered inside). */
  catalogue: DiscoverCandidate[]
  excludeTitles?: string[]
  /** Pre-formatted taste string (formatTasteSummaryForAi); gated inside generation too. */
  tasteSummary?: string | null
  tasteRevision?: string
  count?: number
  profileId?: string
  playlistId?: string
  catalogueRevision?: string | number | null
  /** Only "Surprise me" forces fresh; repeat briefs serve the cache. */
  forceFresh?: boolean
}

/**
 * Injectable deps. Production callers pass nothing: the real chat
 * transport, TMDb search, details fetch and external-id resolver are
 * wired by default. Tests inject fakes — no real LLM/TMDb calls.
 */
export interface HomeAiDeps {
  chat?: AiChatTransport
  searchTmdb?: TmdbSearchFn
  fetchDetails?: TmdbDetailsFn
  resolveExternalId?: ExternalIdResolver
  /** Clock override for tests; defaults to Date.now. */
  clock?: () => number
}

// ---------------------------------------------------------------------------
// Provider identity (guarded getters, ranking.ts pattern)
// ---------------------------------------------------------------------------

function readProviderIdentity(): { endpoint: string; model: string } {
  let endpoint = ""
  let model = ""
  try {
    if (typeof getAiEndpoint === "function") endpoint = String(getAiEndpoint() ?? "").trim()
  } catch {
    endpoint = ""
  }
  try {
    if (typeof getAiModel === "function") model = String(getAiModel() ?? "").trim()
  } catch {
    model = ""
  }
  return { endpoint, model }
}

function pipelineVersionFor(requestType: HomeAiRequestType): string {
  return `home:${HOME_AI_PIPELINE_VERSION}|rank:${RANKING_PIPELINE_VERSION}|type:${requestType}`
}

function aiEnabled(): boolean {
  try {
    return typeof getAiEnabled === "function" ? !!getAiEnabled() : false
  } catch {
    return false
  }
}

function tasteSharingAllowed(): boolean {
  try {
    return !!getAiShareTaste()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Pool preparation + final validation (§18)
// ---------------------------------------------------------------------------

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Hard pool filter: kind separation + exclusions. Live entries and
 * wrong-kind entries never reach the model; excluded ids/titles are
 * removed before the cap so excluded rows cannot consume shortlist
 * slots.
 */
export function prepareHomePool(
  candidates: DiscoverCandidate[],
  kind: HomeAiKind,
  excludeCompositeIds?: string[],
  excludeTitles?: string[]
): DiscoverCandidate[] {
  const excludeIds = new Set((excludeCompositeIds ?? []).map((id) => id.trim()).filter(Boolean))
  const excludeNames = new Set((excludeTitles ?? []).map((t) => normalizeText(t)).filter(Boolean))
  const out: DiscoverCandidate[] = []
  for (const candidate of candidates ?? []) {
    if (!candidate || candidate.kind !== kind) continue
    if (excludeIds.has(`${candidate.kind}:${candidate.id}`)) continue
    if (excludeIds.has(String(candidate.id))) continue
    if (excludeNames.has(normalizeText(candidate.title))) continue
    out.push(candidate)
  }
  return out
}

export interface HomeAiDrop {
  compositeId: string
  title: string
  reason: "not-in-pool" | "kind-mismatch" | "duplicate"
}

/**
 * FINAL validation for Home picks (§18): every pick must name a pool
 * entry, of the requested kind, exactly once. Model-invented ids,
 * wrong-kind ids and duplicates are dropped — never surfaced, never
 * fuzzy-matched into playable. Reasons are re-sanitised against the
 * pool candidate's real metadata. Survivors keep model order and are
 * re-scored by position. Returning fewer picks (including zero) is
 * correct when the evidence is weak; empty slots are never filled
 * with arbitrary catalogue entries.
 */
export function validateHomeAiPicks(
  picks: HomeAiPick[],
  pool: DiscoverCandidate[],
  kind: HomeAiKind
): { picks: HomeAiPick[]; dropped: HomeAiDrop[] } {
  const byComposite = new Map(pool.map((c) => [`${c.kind}:${c.id}`, c]))
  const seen = new Set<string>()
  const kept: HomeAiPick[] = []
  const dropped: HomeAiDrop[] = []
  for (const pick of picks ?? []) {
    if (!pick || pick.kind !== kind) {
      dropped.push({
        compositeId: pick?.compositeId ?? "",
        title: pick?.title ?? "",
        reason: "kind-mismatch",
      })
      continue
    }
    const candidate = byComposite.get(pick.compositeId)
    if (!candidate || candidate.kind !== kind || String(candidate.id) !== String(pick.id)) {
      dropped.push({ compositeId: pick.compositeId, title: pick.title ?? "", reason: "not-in-pool" })
      continue
    }
    if (seen.has(pick.compositeId)) {
      dropped.push({ compositeId: pick.compositeId, title: pick.title ?? "", reason: "duplicate" })
      continue
    }
    seen.add(pick.compositeId)
    kept.push({
      ...pick,
      title: candidate.title,
      year: typeof candidate.year === "number" ? candidate.year : pick.year ?? null,
      tmdbId: typeof candidate.tmdbId === "number" ? candidate.tmdbId : pick.tmdbId ?? null,
      reason: sanitizeReason(pick.reason ?? "", candidate as RankCandidate),
    })
  }
  const total = kept.length
  return {
    picks: kept.map((pick, index) => ({
      ...pick,
      score: total ? Math.round(((total - index) / total) * 100) / 100 : 0,
    })),
    dropped,
  }
}

function rankedToPicks(rankings: RankedCandidate[], kind: HomeAiKind): HomeAiPick[] {
  return rankings.map((entry) => ({
    compositeId: compositeCandidateId(entry.candidate),
    kind,
    id: String(entry.candidate.id),
    title: entry.candidate.title,
    year: typeof entry.candidate.year === "number" ? entry.candidate.year : null,
    score: entry.score,
    reason: entry.reason,
    tmdbId: typeof entry.candidate.tmdbId === "number" ? entry.candidate.tmdbId : null,
  }))
}

function clampHomeCount(count: number | undefined): number {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : HOME_AI_DEFAULT_COUNT
  return Math.min(HOME_AI_MAX_COUNT, Math.max(1, n))
}

function effectiveTaste(
  taste: TasteSummaryShape | TasteSummary | null | undefined
): TasteSummary {
  // Defence in depth: the ranker gates taste itself, but Home never
  // even hands it taste content when sharing is off.
  if (!tasteSharingAllowed() || !taste) {
    return { favouriteGenres: [], likedTitles: [], dislikedTitles: [] }
  }
  return {
    favouriteGenres: [...(taste.favouriteGenres ?? [])],
    likedTitles: [...(taste.likedTitles ?? [])],
    dislikedTitles: [...(taste.dislikedTitles ?? [])],
    preferredRuntimeMax: taste.preferredRuntimeMax,
    pace: taste.pace,
  }
}

/** Honest user-facing message for a provider failure. No secrets, ever. */
function providerFailureMessage(error: unknown): string {
  const kind = (error as { kind?: string })?.kind
  switch (kind) {
    case "not_configured":
      return "AI isn't set up yet, so no recommendations were generated. Check Settings."
    case "invalid_key":
      return "The AI provider rejected the saved key, so no recommendations were generated. Check the key in Settings."
    case "rate_limited":
      return "The AI provider is rate-limiting requests. Wait a little and try again."
    case "bad_output":
      return "The AI reply couldn't be used. Try asking again."
    case "aborted":
      return "The AI request was cancelled."
    case "unavailable":
    default:
      return "AI couldn't answer just now, so no recommendations were generated."
  }
}

// ---------------------------------------------------------------------------
// Cache-key assembly (one place — read, write, dedup, ledger agree)
// ---------------------------------------------------------------------------

interface HomeAiKeyMaterial {
  cacheKey: string
  ledgerKey: string
  identity: { endpoint: string; model: string }
}

function keyMaterialForPicks(
  request: HomeAiPicksRequest,
  identity: { endpoint: string; model: string }
): HomeAiKeyMaterial {
  return {
    cacheKey: buildHomeAiCacheKey({
      kind: request.kind,
      requestType: "picks",
      profileId: request.profileId,
      playlistId: request.playlistId,
      catalogueRevision: request.catalogueRevision,
      endpoint: identity.endpoint,
      model: identity.model,
      pipelineVersion: pipelineVersionFor("picks"),
      tasteRevision: request.tasteRevision ?? "",
      excludeTitles: request.excludeTitles,
      excludeCompositeIds: request.excludeCompositeIds,
      mood: request.mood,
      maxRuntimeMinutes: request.maxRuntimeMinutes,
    }),
    ledgerKey: buildHomeAiLedgerKey({
      kind: request.kind,
      requestType: "picks",
      profileId: request.profileId,
      playlistId: request.playlistId,
      endpoint: identity.endpoint,
      model: identity.model,
    }),
    identity,
  }
}

function keyMaterialForDiscovery(
  request: HomeAiDiscoveryRequest,
  identity: { endpoint: string; model: string }
): HomeAiKeyMaterial {
  return {
    cacheKey: buildHomeAiCacheKey({
      kind: request.kind,
      requestType: "discovery",
      profileId: request.profileId,
      playlistId: request.playlistId,
      catalogueRevision: request.catalogueRevision,
      endpoint: identity.endpoint,
      model: identity.model,
      pipelineVersion: pipelineVersionFor("discovery"),
      tasteRevision: request.tasteRevision ?? "",
      brief: request.brief,
      excludeTitles: request.excludeTitles,
    }),
    ledgerKey: buildHomeAiLedgerKey({
      kind: request.kind,
      requestType: "discovery",
      profileId: request.profileId,
      playlistId: request.playlistId,
      endpoint: identity.endpoint,
      model: identity.model,
    }),
    identity,
  }
}

// ---------------------------------------------------------------------------
// Cached reads (sync, no network) + cache-to-result shaping
// ---------------------------------------------------------------------------

function cachedEntryToResult(
  entry: HomeAiCacheEntry,
  pool: DiscoverCandidate[],
  kind: HomeAiKind,
  requestType: HomeAiRequestType
): HomeAiResult | null {
  // Read-time validation: a changed playlist must never serve stale
  // playable links. Picks that no longer resolve are dropped; an
  // entry with nothing surviving is a miss, not a shelf.
  const { picks } = validateHomeAiPicks(entry.picks, pool, kind)
  if (!picks.length) return null
  return {
    picks,
    source: "cached-ai",
    kind,
    requestType,
    model: entry.model || undefined,
    answeredAt: null,
    cacheHit: true,
    sentToModelCount: 0,
    droppedCount: entry.picks.length - picks.length,
    verifiedUnmatched: [],
    cacheKey: entry.key,
  }
}

/**
 * Sync cached read for the picks path. Safe on every Home render:
 * zero network, zero model calls. Returns null when there is no
 * fresh, still-valid cached entry.
 */
export function readCachedHomeAiPicks(
  request: HomeAiPicksRequest,
  nowMs: number = Date.now()
): HomeAiResult | null {
  const identity = readProviderIdentity()
  const { cacheKey } = keyMaterialForPicks(request, identity)
  const entry = readHomeAiCacheEntry(cacheKey, nowMs)
  if (!entry) return null
  const pool = prepareHomePool(
    request.candidates,
    request.kind,
    request.excludeCompositeIds,
    request.excludeTitles
  )
  return cachedEntryToResult(entry, pool, request.kind, "picks")
}

/** Sync cached read for the discovery path (same guarantees). */
export function readCachedHomeAiDiscovery(
  request: HomeAiDiscoveryRequest,
  nowMs: number = Date.now()
): HomeAiResult | null {
  const identity = readProviderIdentity()
  const { cacheKey } = keyMaterialForDiscovery(request, identity)
  const entry = readHomeAiCacheEntry(cacheKey, nowMs)
  if (!entry) return null
  const pool = prepareHomePool(request.catalogue, request.kind, undefined, request.excludeTitles)
  return cachedEntryToResult(entry, pool, request.kind, "discovery")
}

// ---------------------------------------------------------------------------
// In-flight dedup (identical concurrent requests share one promise)
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<HomeAiResult>>()

function deduped<T extends HomeAiResult>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const promise = run().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

/** Test/support hook: is an identical request already in flight? */
export function isHomeAiRequestInflight(cacheKey: string): boolean {
  return inflight.has(cacheKey)
}

// ---------------------------------------------------------------------------
// Rerank path — guaranteed local-library picks (§13/§18)
// ---------------------------------------------------------------------------

export async function requestHomeAiPicks(
  request: HomeAiPicksRequest,
  deps: HomeAiDeps = {}
): Promise<HomeAiResult> {
  const now = deps.clock ?? Date.now
  const nowMs = now()
  if (request.kind !== "movie" && request.kind !== "series") {
    throw new TypeError("requestHomeAiPicks requires kind 'movie' or 'series'.")
  }
  const identity = readProviderIdentity()
  const { cacheKey, ledgerKey } = keyMaterialForPicks(request, identity)
  const count = clampHomeCount(request.count)

  const pool = prepareHomePool(
    request.candidates,
    request.kind,
    request.excludeCompositeIds,
    request.excludeTitles
  )
  if (!pool.length) {
    return {
      picks: [],
      source: "local-only",
      kind: request.kind,
      requestType: "picks",
      answeredAt: null,
      cacheHit: false,
      sentToModelCount: 0,
      droppedCount: 0,
      fallbackReason: "No titles were available for AI ranking.",
      verifiedUnmatched: [],
      cacheKey,
    }
  }

  // Fresh cache wins unless the viewer explicitly asked for fresh
  // picks (forceFresh). Auto-refresh never forces fresh.
  if (!request.forceFresh) {
    const entry = readHomeAiCacheEntry(cacheKey, nowMs)
    if (entry) {
      const cached = cachedEntryToResult(entry, pool, request.kind, "picks")
      if (cached) return cached
    }
  }

  // AI off: no attempt, no ledger entry, no doomed request. The
  // caller shows local shelves and says why AI is unavailable.
  if (!aiEnabled()) {
    return {
      picks: [],
      source: "ai-unavailable",
      kind: request.kind,
      requestType: "picks",
      answeredAt: null,
      cacheHit: false,
      sentToModelCount: 0,
      droppedCount: 0,
      fallbackReason: "AI Discovery is off. Turn it on in Settings to get AI picks.",
      verifiedUnmatched: [],
      cacheKey,
    }
  }

  return deduped(cacheKey, async () => {
    const startedAt = now()
    // The 20-cap keeps the head of W5's relevance-ordered pool —
    // never raw catalogue order (see prepareHomePool + the pool
    // contract on HomeAiPicksRequest).
    const shortlist = applyRerankCap(pool)
    try {
      // Home has no user query: the shortlist IS the relevance
      // selection, so the query is empty and ranking validation
      // defers to the model + shortlist (ranking.ts's own rule for
      // an empty query with no intent genres). The kind constraint
      // still enforces medium separation inside the ranker.
      const ranked = await aiRanker.rankShortlist({
        query: "",
        shortlist: shortlist as RankCandidate[],
        tasteSummary: effectiveTaste(request.taste),
        constraints: {
          kind: request.kind,
          ...(request.mood ? { mood: request.mood } : {}),
          ...(typeof request.maxRuntimeMinutes === "number"
            ? { maxRuntimeMinutes: request.maxRuntimeMinutes }
            : {}),
          ...(request.excludeTitles?.length ? { excludeTitles: request.excludeTitles } : {}),
        },
        context: {
          playlistId: request.playlistId,
          catalogueStamp:
            typeof request.catalogueRevision === "number"
              ? request.catalogueRevision
              : typeof request.catalogueRevision === "string" &&
                  request.catalogueRevision.trim() !== "" &&
                  Number.isFinite(Number(request.catalogueRevision))
                ? Number(request.catalogueRevision)
                : undefined,
          profileId: request.profileId,
          tasteRevision: request.tasteRevision,
        },
        ...(deps.chat ? { chat: deps.chat } : {}),
        // Home enforces its own, stronger discipline (durable cache
        // + 24h attempt ledger + in-flight dedup); the ranker's 60s
        // Discover repeat guard would otherwise block the second
        // content type's refresh and every explicit re-generate.
        skipRepeatGuard: true,
      })
      recordHomeAiAttempt(ledgerKey, now())
      const { picks, dropped } = validateHomeAiPicks(
        rankedToPicks(ranked.rankings, request.kind).slice(0, count),
        pool,
        request.kind
      )
      const droppedCount = ranked.validation.dropped.length + dropped.length
      if (!picks.length) {
        return {
          picks: [],
          source: "ai-unavailable" as HomeAiSource,
          kind: request.kind,
          requestType: "picks" as HomeAiRequestType,
          model: ranked.status.model || undefined,
          answeredAt: startedAt,
          cacheHit: false,
          sentToModelCount: shortlist.length,
          droppedCount,
          fallbackReason:
            ranked.status.fallbackReason ??
            "AI's picks didn't fit your library, so these are local recommendations.",
          verifiedUnmatched: [],
          cacheKey,
        }
      }
      // A ranker session-cache hit is honestly a cached result, even
      // on an explicit request: no request left the device.
      const fromRankerCache = ranked.source === "cached"
      writeHomeAiCacheEntry(
        {
          key: cacheKey,
          kind: request.kind,
          requestType: "picks",
          picks,
          model: ranked.status.model || identity.model,
          sentToModelCount: fromRankerCache ? 0 : shortlist.length,
        },
        now()
      )
      return {
        picks,
        source: fromRankerCache ? ("cached-ai" as HomeAiSource) : ("fresh-ai" as HomeAiSource),
        kind: request.kind,
        requestType: "picks" as HomeAiRequestType,
        model: ranked.status.model || identity.model || undefined,
        answeredAt: fromRankerCache ? null : now(),
        cacheHit: fromRankerCache,
        sentToModelCount: fromRankerCache ? 0 : shortlist.length,
        droppedCount,
        verifiedUnmatched: [],
        cacheKey,
      }
    } catch (error) {
      // One attempt, no retries. A failed attempt still records in
      // the ledger so auto-refresh cannot storm a failing provider.
      // (Explicit requests ignore the ledger, so the viewer can
      // always retry deliberately with the button.)
      recordHomeAiAttempt(ledgerKey, now())
      return {
        picks: [],
        source: "ai-unavailable",
        kind: request.kind,
        requestType: "picks",
        answeredAt: null,
        cacheHit: false,
        sentToModelCount: 0,
        droppedCount: 0,
        fallbackReason: providerFailureMessage(error),
        verifiedUnmatched: [],
        cacheKey,
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Generation + verification path — broader discovery (§18)
// ---------------------------------------------------------------------------

function discoveryPickFromVerified(
  verified: VerifiedRecommendation,
  poolByComposite: Map<string, DiscoverCandidate>,
  kind: HomeAiKind,
  score: number
): HomeAiPick | null {
  if (!verified.verified || !verified.match) return null
  if (verified.kind !== kind || verified.match.kind !== kind) return null
  const candidate = poolByComposite.get(verified.match.catalogueKey)
  if (!candidate || candidate.kind !== kind) return null
  return {
    compositeId: verified.match.catalogueKey,
    kind,
    id: String(candidate.id),
    title: candidate.title,
    year: typeof candidate.year === "number" ? candidate.year : verified.year,
    score,
    reason: sanitizeReason(verified.reason, candidate as RankCandidate),
    tmdbId: verified.tmdbId,
  }
}

export async function requestHomeAiDiscovery(
  request: HomeAiDiscoveryRequest,
  deps: HomeAiDeps = {}
): Promise<HomeAiResult> {
  const now = deps.clock ?? Date.now
  const nowMs = now()
  if (request.kind !== "movie" && request.kind !== "series") {
    throw new TypeError("requestHomeAiDiscovery requires kind 'movie' or 'series'.")
  }
  const brief = (request.brief ?? "").trim()
  const identity = readProviderIdentity()
  const { cacheKey, ledgerKey } = keyMaterialForDiscovery(
    { ...request, brief },
    identity
  )
  const count = clampCount(request.count ?? HOME_AI_DEFAULT_COUNT)

  const unavailable = (fallbackReason: string): HomeAiResult => ({
    picks: [],
    source: "ai-unavailable",
    kind: request.kind,
    requestType: "discovery",
    answeredAt: null,
    cacheHit: false,
    sentToModelCount: 0,
    droppedCount: 0,
    fallbackReason,
    verifiedUnmatched: [],
    cacheKey,
  })

  if (!brief) return unavailable("Type a request first, then ask AI.")

  const pool = prepareHomePool(request.catalogue, request.kind, undefined, request.excludeTitles)
  if (!pool.length) {
    return {
      ...unavailable("No titles were available to match AI suggestions against."),
      source: "local-only",
    }
  }

  if (!request.forceFresh) {
    const entry = readHomeAiCacheEntry(cacheKey, nowMs)
    if (entry) {
      const cached = cachedEntryToResult(entry, pool, request.kind, "discovery")
      if (cached) return cached
    }
  }

  if (!aiEnabled()) {
    return unavailable("AI Discovery is off. Turn it on in Settings to get AI picks.")
  }

  return deduped(cacheKey, async () => {
    const startedAt = now()
    let generated: GeneratedRecommendation[]
    let model: string
    try {
      const generation = await generateRecommendations(
        {
          query: brief,
          tasteSummary: request.tasteSummary ?? null,
          constraints: {
            kind: request.kind,
            ...(request.excludeTitles?.length ? { excludeTitles: request.excludeTitles } : {}),
          },
          count,
        },
        { chat: deps.chat }
      )
      generated = generation.recommendations
      model = generation.model
    } catch (error) {
      recordHomeAiAttempt(ledgerKey, now())
      return unavailable(providerFailureMessage(error))
    }
    recordHomeAiAttempt(ledgerKey, now())

    // Kind separation, defence in depth: a model that returns a film
    // for a series brief (or vice versa) cannot leak through — the
    // mismatched items are dropped BEFORE verification, never
    // verified into the wrong shelf.
    let droppedCount = 0
    const kindMatched = generated.filter((rec) => {
      if (rec.kind !== request.kind) {
        droppedCount += 1
        return false
      }
      return true
    })
    if (!kindMatched.length) {
      return {
        ...unavailable("The AI reply contained no usable recommendations. Try asking again."),
        model,
        answeredAt: startedAt,
        droppedCount,
      }
    }

    let verified: VerifiedRecommendation[]
    try {
      verified = await verifyRecommendations(kindMatched, {
        searchTmdb: deps.searchTmdb ?? defaultTmdbSearch(),
        fetchDetails: deps.fetchDetails ?? defaultFetchDetails,
        resolveExternalId: deps.resolveExternalId ?? defaultResolveExternalId(),
        catalogue: request.catalogue,
      })
    } catch {
      // A wholesale verifier failure degrades to unverified results
      // with an honest note (orchestrator contract) — never to
      // claimed-verified picks.
      verified = kindMatched.map((rec) => ({
        generated: rec,
        verified: false,
        tmdbId: null,
        title: rec.title,
        year: rec.year,
        kind: rec.kind,
        reason: rec.reason,
        tone: rec.tone,
        genres: [],
        synopsis: null,
        posterUrl: null,
        backdropUrl: null,
        match: null,
        verificationNote: "TMDB verification failed, so these titles are unverified.",
      }))
    }

    const poolByComposite = new Map(pool.map((c) => [`${c.kind}:${c.id}`, c]))
    const picks: HomeAiPick[] = []
    const verifiedUnmatched: VerifiedRecommendation[] = []
    verified.forEach((rec) => {
      if (!rec.verified) {
        droppedCount += 1
        return
      }
      const pick = discoveryPickFromVerified(rec, poolByComposite, request.kind, 1)
      if (pick) {
        picks.push(pick)
      } else if (rec.match) {
        // Verified + matched, but the match is not in the current
        // pool (excluded or gone): dropped, never a stale link.
        droppedCount += 1
      } else {
        // Verified real title, not in this library: reported
        // separately, never as playable.
        verifiedUnmatched.push(rec)
      }
    })
    const { picks: validatedPicks, dropped } = validateHomeAiPicks(
      picks.slice(0, count),
      pool,
      request.kind
    )
    droppedCount += dropped.length

    if (!validatedPicks.length) {
      return {
        ...unavailable(
          verifiedUnmatched.length
            ? "AI suggested real titles, but none of them are in your library."
            : "AI couldn't verify any suggestions for this request."
        ),
        model,
        answeredAt: startedAt,
        droppedCount,
        verifiedUnmatched,
      }
    }
    writeHomeAiCacheEntry(
      {
        key: cacheKey,
        kind: request.kind,
        requestType: "discovery",
        picks: validatedPicks,
        model: model || identity.model,
        sentToModelCount: 0,
      },
      now()
    )
    return {
      picks: validatedPicks,
      source: "fresh-ai",
      kind: request.kind,
      requestType: "discovery",
      model: model || identity.model || undefined,
      answeredAt: startedAt,
      cacheHit: false,
      // Generation sends no candidate list to the model (orchestrator
      // contract): 0 is the honest count.
      sentToModelCount: 0,
      droppedCount,
      verifiedUnmatched,
      cacheKey,
    }
  })
}

// ---------------------------------------------------------------------------
// Auto-refresh trigger (§16) — the ONLY background path, and it is
// bounded, preference-gated, and focus-safe by construction (it only
// ever resolves a result; W5 decides how to render it).
// ---------------------------------------------------------------------------

export interface HomeAiAutoRefreshDecision {
  shouldRefresh: boolean
  /** Short machine-readable reason (diagnostics; never shown raw). */
  reason:
    | "auto-refresh-off"
    | "ai-off"
    | "fresh-cache"
    | "in-flight"
    | "attempt-bounded"
    | "refresh-allowed"
  /** Fresh cached picks to display immediately, when present. */
  cached: HomeAiResult | null
}

/**
 * Sync auto-refresh decision. NEVER reinterpret getAiAutoRequests()
 * (Discover search-submit) as Home permission: only the dedicated
 * getAiHomeAutoRefresh() preference (default OFF) authorises a Home
 * background request, and only when no fresh cache exists, nothing
 * identical is in flight, and no attempt was recorded in the last
 * ~24h for this content type.
 */
export function decideHomeAiAutoRefresh(
  request: HomeAiPicksRequest,
  nowMs: number = Date.now()
): HomeAiAutoRefreshDecision {
  const cached = readCachedHomeAiPicks(request, nowMs)
  let autoRefresh: boolean
  try {
    autoRefresh = !!getAiHomeAutoRefresh()
  } catch {
    autoRefresh = false
  }
  if (!autoRefresh) return { shouldRefresh: false, reason: "auto-refresh-off", cached }
  if (!aiEnabled()) return { shouldRefresh: false, reason: "ai-off", cached }
  if (cached) return { shouldRefresh: false, reason: "fresh-cache", cached }
  const identity = readProviderIdentity()
  const { cacheKey, ledgerKey } = keyMaterialForPicks(request, identity)
  if (isHomeAiRequestInflight(cacheKey)) {
    return { shouldRefresh: false, reason: "in-flight", cached: null }
  }
  if (isHomeAiAttemptBounded(ledgerKey, nowMs)) {
    return { shouldRefresh: false, reason: "attempt-bounded", cached: null }
  }
  return { shouldRefresh: true, reason: "refresh-allowed", cached: null }
}

/**
 * Quiet auto-refresh: returns null when no refresh is allowed or
 * needed; otherwise the fresh result (or an honest unavailable
 * result on failure). W5 calls this at most once per Home mount and
 * renders the resolution without moving focus. It never throws for
 * provider/config failures.
 */
export async function maybeAutoRefreshHomeAiPicks(
  request: HomeAiPicksRequest,
  deps: HomeAiDeps = {}
): Promise<HomeAiResult | null> {
  const nowMs = (deps.clock ?? Date.now)()
  const decision = decideHomeAiAutoRefresh(request, nowMs)
  if (!decision.shouldRefresh) return null
  return requestHomeAiPicks({ ...request, trigger: "auto-refresh", forceFresh: false }, deps)
}

// ---------------------------------------------------------------------------
// Selector seam (collection-selectors.ts)
// ---------------------------------------------------------------------------

/**
 * Map Home picks to the collection-selectors aiRecommendations input:
 * bare catalogue ids + 1-based model rank. The selectors match bare
 * ids against group variant ids; the kind prefix must NOT travel.
 */
export function toSelectorAiRecommendations(
  picks: HomeAiPick[]
): Array<{ id: string; rank: number }> {
  return (picks ?? []).map((pick, index) => ({ id: pick.id, rank: index + 1 }))
}

/**
 * True ONLY when the model genuinely influenced the ranking behind
 * these picks (a fresh or cached AI result with picks). Local-only
 * and unavailable results must never enable the selector AI boost —
 * an AI badge over locally-ranked content is forbidden (§18).
 */
export function homeAiAllowsSelectorBoost(result: HomeAiResult | null | undefined): boolean {
  if (!result) return false
  if (result.picks.length === 0) return false
  return result.source === "fresh-ai" || result.source === "cached-ai"
}

/** Test/support hook: clear the durable Home cache (not the ledger). */
export function clearHomeAiPicksCache(): void {
  clearHomeCacheStore()
}
