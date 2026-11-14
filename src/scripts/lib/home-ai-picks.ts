// Home AI adapter (0.11.14, W5) — W5-side preparation for the W4
// Home AI core (src/scripts/lib/ai/home-picks.ts). This module owns
// ONLY:
//   - the relevance-ordered candidate pool per kind (W5's selector
//     logic over the local catalogue index),
//   - request assembly (identity, taste revision, exclusions),
//   - grounded reasons and honest shelf notes for presentation.
//
// It owns NO cache, NO trigger entry point, and NO preference — those
// live in the W4 core and are consumed, never re-implemented. The
// core applies the 20-candidate rerank cap to the head of the pool
// order built here, so the pool must be relevance-ordered, never raw
// catalogue order. The core validates every pick against the pool;
// Home defence-in-depth re-validates again at shelf assembly.

import {
  homeAiSourceLabel,
  toSelectorAiRecommendations,
  type HomeAiKind,
  type HomeAiPick,
  type HomeAiResult,
  type HomeAiSource,
} from "@/scripts/lib/ai/home-picks.ts"
import type {
  HomeAiPicksRequest,
  HomeAiDiscoveryRequest,
} from "@/scripts/lib/ai/home-picks.ts"
import { formatTasteSummaryForAi } from "@/scripts/lib/ai/discovery-presentation.ts"
import type { CatalogIndex } from "@/scripts/lib/catalog-index.ts"
import {
  catalogRowToCandidate,
  type DiscoverCandidate,
} from "@/scripts/lib/discover.ts"
import {
  selectHiddenGems,
  selectWorthWatching,
  type SelectorResult,
} from "@/scripts/lib/collection-selectors.ts"
import { summarizeTaste, type TasteModel } from "@/scripts/lib/taste.ts"

export type { HomeAiKind, HomeAiPick, HomeAiResult, HomeAiSource }
export type { HomeAiPicksRequest, HomeAiDiscoveryRequest }
export { homeAiSourceLabel }

/** Picks requested from the core per Home shelf (core caps at 12). */
export const HOME_AI_REQUEST_COUNT = 12

/**
 * Pool over-fetch for the rerank path: the core keeps the head 20 of
 * this order, so a 2x pool lets the model choose across quality and
 * underexposed titles instead of only the top of one selector.
 */
export const HOME_AI_POOL_LIMIT = 40

/**
 * One title-level candidate for a displayed group primary, through
 * the shared catalogue→candidate mapping. Kind is fixed by the
 * caller's index — a series index can never yield a movie candidate.
 * Returns null when the primary row cannot be resolved.
 */
export function candidateFromPrimary(
  index: CatalogIndex,
  primaryId: string,
  kind: HomeAiKind
): DiscoverCandidate | null {
  const row = index.byId.get(primaryId) as
    | Parameters<typeof catalogRowToCandidate>[1]
    | undefined
  if (!row) return null
  return catalogRowToCandidate(kind, row)
}

/**
 * Relevance-ordered candidate pool for the rerank path: the Worth
 * selector's order with Hidden Gems interleaved 2:1 so the model
 * sees quality AND underexposed titles. Hard exclusions (completed /
 * started ids, caller-supplied) are applied by the selectors here
 * AND by the core before the cap. Returns at most
 * HOME_AI_POOL_LIMIT candidates, all of the requested kind.
 */
export function buildHomeAiPool(
  index: CatalogIndex,
  taste: TasteModel | null,
  kind: HomeAiKind,
  opts: { excludeIds?: string[]; rotationSeed?: number } = {}
): DiscoverCandidate[] {
  const excludeIds = opts.excludeIds ?? []
  const worth = selectWorthWatching(index, taste, HOME_AI_POOL_LIMIT, {
    rotationSeed: opts.rotationSeed ?? 0,
    excludeCompleted: true,
    completedIds: excludeIds,
  })
  const gems = selectHiddenGems(index, taste, Math.ceil(HOME_AI_POOL_LIMIT / 2), {
    rotationSeed: opts.rotationSeed ?? 0,
    excludeCompleted: true,
    completedIds: excludeIds,
  })
  const seen = new Set<string>()
  const ordered: SelectorResult[] = []
  let gemIndex = 0
  worth.forEach((entry, position) => {
    ordered.push(entry)
    if ((position + 1) % 2 === 0 && gemIndex < gems.length) {
      ordered.push(gems[gemIndex])
      gemIndex += 1
    }
  })
  while (gemIndex < gems.length) {
    ordered.push(gems[gemIndex])
    gemIndex += 1
  }
  const pool: DiscoverCandidate[] = []
  for (const entry of ordered) {
    if (pool.length >= HOME_AI_POOL_LIMIT) break
    const key = String(entry.id)
    if (seen.has(key)) continue
    seen.add(key)
    const candidate = candidateFromPrimary(index, key, kind)
    if (candidate) pool.push(candidate)
  }
  return pool
}

/**
 * Full title-level catalogue for the discovery (generation +
 * verification) path: every group primary of the requested kind.
 * Order is index order; matching is confident and kind-filtered
 * inside the core, so no relevance shaping is needed here.
 */
export function buildHomeAiCatalogue(
  index: CatalogIndex,
  kind: HomeAiKind
): DiscoverCandidate[] {
  const out: DiscoverCandidate[] = []
  for (const group of index.groups) {
    const candidate = candidateFromPrimary(index, group.primaryId, kind)
    if (candidate) out.push(candidate)
  }
  return out
}

/**
 * Map core picks to the collection-selectors input shape for
 * selectAiRankedPicks: bare ids + 1-based model rank + the model's
 * reason, in model order. The kind prefix must NOT travel.
 */
export function toSelectorPicks(
  picks: HomeAiPick[]
): Array<{ id: string; rank: number; reason: string | null }> {
  const ranked = toSelectorAiRecommendations(picks)
  return ranked.map((rec, position) => ({
    ...rec,
    reason: picks[position]?.reason ?? null,
  }))
}

function tasteRevisionOf(taste: TasteModel | null): string {
  return taste ? String(taste.updatedAt ?? "") : ""
}

function catalogueRevisionOf(index: CatalogIndex): string | number | null {
  return index.revision ?? null
}

/**
 * Assemble a core picks request. Taste content is passed through;
 * the core gates it on getAiShareTaste() (defence in depth with the
 * ranker). Exclusions travel as composite ids (`kind:id`) so the
 * core's pool filter and cache identity agree with the shelf's.
 */
export function buildHomeAiPicksRequest(
  index: CatalogIndex,
  taste: TasteModel | null,
  kind: HomeAiKind,
  opts: {
    trigger: "explicit" | "auto-refresh"
    profileId?: string
    playlistId?: string
    excludeIds?: string[]
    rotationSeed?: number
    mood?: string
    maxRuntimeMinutes?: number
    forceFresh?: boolean
  }
): HomeAiPicksRequest {
  const excludeIds = opts.excludeIds ?? []
  return {
    kind,
    candidates: buildHomeAiPool(index, taste, kind, {
      excludeIds,
      rotationSeed: opts.rotationSeed ?? 0,
    }),
    excludeCompositeIds: excludeIds.map((id) => `${kind}:${id}`),
    taste: taste ? summarizeTaste(taste) : null,
    tasteRevision: tasteRevisionOf(taste),
    ...(opts.mood ? { mood: opts.mood } : {}),
    ...(typeof opts.maxRuntimeMinutes === "number"
      ? { maxRuntimeMinutes: opts.maxRuntimeMinutes }
      : {}),
    count: HOME_AI_REQUEST_COUNT,
    profileId: opts.profileId,
    playlistId: opts.playlistId,
    catalogueRevision: catalogueRevisionOf(index),
    trigger: opts.trigger,
    ...(opts.forceFresh ? { forceFresh: true } : {}),
  }
}

/**
 * Assemble a core discovery request for a mood/brief entry point.
 * tasteSummary is formatted only when the caller confirms taste
 * sharing is allowed (DiscoverView pattern); the core gates it
 * again inside generation. forceFresh is true ONLY for "Surprise
 * me" (the caller decides via discoverPromptForcesFresh).
 */
export function buildHomeAiDiscoveryRequest(
  index: CatalogIndex,
  taste: TasteModel | null,
  kind: HomeAiKind,
  opts: {
    brief: string
    profileId?: string
    playlistId?: string
    shareTaste: boolean
    forceFresh?: boolean
  }
): HomeAiDiscoveryRequest {
  return {
    kind,
    brief: opts.brief,
    catalogue: buildHomeAiCatalogue(index, kind),
    tasteSummary:
      opts.shareTaste && taste ? formatTasteSummaryForAi(summarizeTaste(taste)) : null,
    tasteRevision: tasteRevisionOf(taste),
    count: HOME_AI_REQUEST_COUNT,
    profileId: opts.profileId,
    playlistId: opts.playlistId,
    catalogueRevision: catalogueRevisionOf(index),
    ...(opts.forceFresh ? { forceFresh: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Grounded reasons + honest shelf notes (presentation, W5-owned)
// ---------------------------------------------------------------------------

/** Generic reasons that must never be presented as grounded (§22). */
export const GENERIC_REASONS = new Set([
  "ranked by ai for this search",
  "because you might like it",
  "a great choice for tonight",
  "a local recommendation",
  "recommended for you",
])

export function isGenericReason(reason: string | null | undefined): boolean {
  if (!reason) return true
  return GENERIC_REASONS.has(reason.trim().toLowerCase().replace(/\.$/, ""))
}

export interface GroundedReasonInput {
  modelReason: string | null | undefined
  selectorReasons?: string[]
  genres?: string[]
  ratingLabel?: string
  year?: string
}

/**
 * Ground a model reason against real metadata. Order: the model's
 * own reason (already sanitised by the core against the pool
 * candidate) unless it is generic/empty, then selector evidence,
 * then a genre + rating + year statement, then the honest neutral
 * label (§22).
 */
export function groundedReasonForAiCard(input: GroundedReasonInput): string {
  if (input.modelReason && !isGenericReason(input.modelReason)) {
    return input.modelReason
  }
  const selector = (input.selectorReasons ?? []).find(
    (reason) => reason && !isGenericReason(reason)
  )
  if (selector) return selector
  const parts = [input.genres?.[0], input.ratingLabel, input.year].filter(Boolean)
  if (parts.length > 0) return parts.join(" · ")
  return "AI pick from your library"
}

/**
 * Honest shelf note for a Home AI result. The label derives from
 * the core's source ONLY (homeAiSourceLabel); the model id is
 * appended only for real AI results, as a receipt. Local and
 * unavailable results never carry a model id as if AI had answered.
 */
export function homeAiShelfNote(source: HomeAiSource, model?: string): string {
  const label = homeAiSourceLabel(source)
  if ((source === "fresh-ai" || source === "cached-ai") && model) {
    return `${label} · ${model}`
  }
  return label
}
