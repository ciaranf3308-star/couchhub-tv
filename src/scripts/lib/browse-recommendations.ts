// Browse recommendations — the ONE engine Home, Movies and Series
// rank and search through (0.11.5, W4).
//
// It wraps the Discover local engine (discover.ts rankCandidates /
// searchDiscover) — it does not fork a second scoring system — and
// adds the three things the browse surfaces need on top:
//
//   - kind scoping: a surface asks for movies, series, or all, and
//     never sees the other kind leak in;
//   - hard filtering applied the same way everywhere: the household's
//     not-interested keys (and the engine's own dislike exclusions)
//     are honoured before any ranking happens;
//   - composite identity: results are keyed `kind:id` throughout, so
//     a movie and a series sharing provider id 123 are two titles,
//     never one.
//
// LOCAL ONLY, by construction: nothing in this module imports the
// AI ranker, the AI client, or any network. No paid LLM request can
// leave from a Home load, a rail refresh, controller movement,
// typing or scrolling — those paths all run through here. Manual
// "Ask AI" stays the only route to the model, and it lives in
// Discover (rankDiscover with forceAi), not here.
//
// 0.11.14 (W5 Homes) — one narrow, still-local exception, added
// where the brief explicitly wires AI in: `applyVerifiedAiOrder`
// reorders ALREADY-RANKED local results by a list of VERIFIED AI
// picks the caller supplies (ids the ranker proved are in the
// catalogue, from home-ai-picks.ts). It makes no request, imports
// no AI code, and invents nothing: picks naming ids outside the
// ranked set are dropped, unranked items keep local order after the
// AI-ordered head, and the caller — not this module — owns the
// honest source label. The default paths (rankBrowseCandidates,
// searchBrowse, recommendForBrowse) remain local-only and
// unchanged.
//
// When W1's query-aware retrieval lands, it lands in the engine
// this module wraps (or behind rankBrowseCandidates / searchBrowse),
// and Home, Movies and Series inherit it together. Do not add a
// second ranker here.
//
// Pure and testable: no UI, no network, no storage. Taste is passed
// in by the caller; when a caller has none yet it passes an empty
// model and the engine ranks honestly from ratings/recency/novelty
// (cold start), never inventing personalisation.

import {
  rankCandidates,
  searchDiscover,
  isNaturalLanguageQuery,
  candidateKey,
  type DiscoverCandidate,
  type RankedCandidate,
  type RankOptions,
  type SearchOptions,
} from "./discover.ts"
import { emptyTasteModel, type TasteModel } from "./taste.ts"

export type BrowseKind = "movie" | "series"

export interface BrowseRecommendationResult {
  items: RankedCandidate[]
  /** Browse surfaces are always local. The field exists so a caller
   * can label honestly without guessing ("Local recommendations"). */
  source: "local"
}

export interface RankBrowseOptions extends RankOptions {
  /** Content kind to rank. "all" keeps movies + series together
   * (Home); "movie" / "series" scopes to one kind. */
  kind?: BrowseKind | "all"
}

export interface SearchBrowseOptions extends SearchOptions {
  kind?: BrowseKind | "all"
}

function asTaste(taste: TasteModel | undefined, playlistId: string): TasteModel {
  return taste ?? emptyTasteModel("shared", playlistId)
}

/** Hard exclusions for one taste model, as candidate keys. */
export function browseExcludeKeys(taste: TasteModel): Set<string> {
  return new Set(taste.notInterestedKeys ?? [])
}

function scopeToKind(
  candidates: DiscoverCandidate[],
  kind: BrowseKind | "all" | undefined,
): DiscoverCandidate[] {
  if (!kind || kind === "all") return candidates
  return candidates.filter((c) => c.kind === kind)
}

function withExclusions(
  opts: RankOptions | undefined,
  taste: TasteModel,
): RankOptions {
  const excludeKeys = new Set([...browseExcludeKeys(taste), ...(opts?.excludeKeys ?? [])])
  return { ...opts, excludeKeys }
}

/**
 * Rank candidates for a browse surface through the shared local
 * engine. Kind-scoped, hard-filtered, composite-keyed, deterministic.
 * Never calls the AI ranker.
 */
export function rankBrowseCandidates(
  candidates: DiscoverCandidate[],
  taste: TasteModel | undefined,
  opts: RankBrowseOptions = {},
  playlistId = "",
): RankedCandidate[] {
  const model = asTaste(taste, playlistId)
  const { kind, ...rankOpts } = opts
  return rankCandidates(scopeToKind(candidates, kind), model, withExclusions(rankOpts, model))
}

/**
 * Query search for a browse surface through the shared local engine
 * (mood-aware text search + taste ranking). Kind-scoped; for a
 * search grid, title-group dedup is disabled — distinct catalogue
 * entries that share a title must all stay findable — and the limit
 * defaults to the whole pool so a search never truncates to a rail
 * length. Never calls the AI ranker.
 */
export function searchBrowse(
  query: string,
  candidates: DiscoverCandidate[],
  taste: TasteModel | undefined,
  opts: SearchBrowseOptions = {},
  playlistId = "",
): RankedCandidate[] {
  const model = asTaste(taste, playlistId)
  const { kind, limit, perGroupCap, ...searchOpts } = opts
  const pool = scopeToKind(candidates, kind)
  return searchDiscover(
    query,
    pool,
    model,
    withExclusions(
      {
        // The caller-supplied limit / cap win when given; the
        // defaults only apply when the caller did not set them.
        limit: limit ?? pool.length,
        perGroupCap: perGroupCap ?? Number.MAX_SAFE_INTEGER,
        ...searchOpts,
      },
      model,
    ),
  )
}

/**
 * The "Recommended" answer for a browse surface: the shared local
 * engine, kind-scoped, honestly labelled local. Home uses this for
 * its ranked pass; Movies / Series use it for their Recommended
 * rails and kind-scoped search. No paid calls, ever.
 */
export function recommendForBrowse(
  candidates: DiscoverCandidate[],
  taste: TasteModel | undefined,
  opts: RankBrowseOptions = {},
  playlistId = "",
): BrowseRecommendationResult {
  const { limit, ...rest } = opts
  return {
    items: rankBrowseCandidates(candidates, taste, { limit: limit ?? 12, ...rest }, playlistId),
    source: "local",
  }
}

/** Composite key of a ranked result (`kind:id`). */
export function browseResultKey(ranked: RankedCandidate): string {
  return candidateKey(ranked.candidate)
}

/**
 * Reorder locally-ranked results by VERIFIED AI picks (0.11.14,
 * brief §19/§20): picks the ranker proved are in the catalogue,
 * supplied by the caller (home-ai-picks.ts). Pure and local — no
 * request, no AI import. Model order wins for the head of the
 * list; ranked items the model did not pick keep their local order
 * after it; picks naming ids outside the ranked set are dropped
 * (never fabricated into results). Kind is enforced: a pick only
 * matches a result of the same kind. The caller must label the
 * result with the picks' real source (ai / cached-ai) — this
 * function only orders, it never claims AI produced the list.
 */
export function applyVerifiedAiOrder(
  ranked: RankedCandidate[],
  aiPicks: Array<{ id: string | number; kind?: string; rank?: number }> | null | undefined,
  kind?: BrowseKind,
): RankedCandidate[] {
  if (!Array.isArray(aiPicks) || aiPicks.length === 0) return [...ranked]
  const orderedPicks = [...aiPicks].sort((a, b) => {
    const ra = Number(a?.rank ?? 0)
    const rb = Number(b?.rank ?? 0)
    if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return ra - rb
    return 0
  })
  const byKey = new Map<string, RankedCandidate>()
  for (const entry of ranked) {
    const key = candidateKey(entry.candidate)
    if (!byKey.has(key)) byKey.set(key, entry)
  }
  const head: RankedCandidate[] = []
  const used = new Set<string>()
  for (const pick of orderedPicks) {
    const pickKind = pick.kind ?? kind
    if (!pickKind) continue
    const key = `${pickKind}:${String(pick.id)}`
    const entry = byKey.get(key)
    if (!entry || used.has(key)) continue
    used.add(key)
    head.push(entry)
  }
  const tail = ranked.filter((entry) => !used.has(candidateKey(entry.candidate)))
  return [...head, ...tail]
}

/**
 * True when a browse search query should run through the relevance
 * engine instead of the plain substring matcher: natural-language
 * questions ("something intense for tonight", "something dark").
 * Plain title / genre / single-keyword queries keep the exact
 * substring matcher they already have — the engine would only
 * reinterpret them — and NL questions are exactly the queries the
 * substring matcher answers with nothing (no title contains
 * "something"), so routing them here is a strict improvement.
 */
export function isRelevanceQuery(query: string | undefined | null): boolean {
  const q = (query ?? "").trim()
  if (!q) return false
  return isNaturalLanguageQuery(q)
}

/**
 * Run a relevance search over browse rows and return the matching
 * rows in relevance order. The caller maps each row to its
 * candidate (catalogRowToCandidate) and applies its remaining
 * filters (genre / year / rating / list) afterwards; the returned
 * order is the relevance order, so the caller's sort must preserve
 * it for relevance queries (see the adapters' applySort).
 */
export function relevanceSearchRows<T extends { id: number | string }>(
  rows: T[],
  query: string,
  kind: BrowseKind,
  toCandidate: (row: T) => DiscoverCandidate,
  taste?: TasteModel,
  playlistId = "",
): T[] {
  const candidates = rows.map(toCandidate)
  const ranked = searchBrowse(query, candidates, taste, { kind }, playlistId)
  const order = new Map(ranked.map((entry, index) => [entry.candidate.id, index]))
  return rows
    .filter((row) => order.has(String(row.id)))
    .sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0))
}
