// AI ranking for RedSilk Discover.
//
// `aiRanker.rank()` sends ONE model request per discovery query: the user's
// natural-language query, a compact candidate list and the taste summary —
// nothing else. It never sends raw viewing history, IPTV credentials,
// provider URLs, stream links or poster URLs. Every ID the model returns
// is validated against the supplied candidates; unknown or invented IDs
// are dropped, so a title can only ever surface if it was in the input.
//
// On any failure `rank()` throws a typed `AiError` (see client.ts) and the
// caller falls back to the local engine — use `fallbackRank()` for the
// local-order stand-in. It never silently returns unranked results as if
// the model had ranked them.
//
// Types here are local copies of the seam the coordinator defines in
// `src/scripts/lib/discover.ts` (not present in this branch): same shape,
// same field names. This file must NOT import from `../discover`.

import { AiError, chatCompletions } from "./client.js"
import { getAiEnabled } from "@/scripts/lib/app-settings.js"
import { getAiShareTaste } from "./status.js"

export interface DiscoverCandidate {
  id: string
  kind: "movie" | "series" | "live"
  title: string
  year?: number
  rating?: number
  genres: string[]
  cast: string[]
  director?: string
  runtimeMinutes?: number
  overview?: string
  posterUrl?: string
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

/** Structured intent the model may return alongside its ranking. Best-effort: ignored when malformed. */
export interface AiIntent {
  genres?: string[]
  mood?: string
  pace?: string
  maxRuntimeMinutes?: number
  exclude?: string[]
  referenceTitles?: string[]
}

export interface AiRankResponse {
  rankings: RankedCandidate[]
  intent?: AiIntent
}

/** Hard cap on how many candidates ever reach the model in one request. */
export const AI_MAX_CANDIDATES = 20
const MAX_QUERY_CHARS = 500
const MAX_OVERVIEW_CHARS = 160
const MAX_REASON_CHARS = 140
const FALLBACK_REASON = "AI is unavailable — showing local order."
const GENERIC_REASON = "Ranked by AI for this search."

// ---------------------------------------------------------------------------
// Prompt construction (exported for tests: the payload must stay clean)
// ---------------------------------------------------------------------------

function cleanLine(value: string | undefined, maxChars: number): string {
  if (!value) return ""
  return value
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxChars)
}

function formatCandidate(candidate: DiscoverCandidate, index: number): string {
  const parts = [`${index + 1}. [${candidate.id}] ${candidate.title}`]
  if (candidate.year) parts.push(`(${candidate.year})`)
  parts.push(`· ${candidate.kind}`)
  if (candidate.genres?.length) parts.push(`· ${candidate.genres.slice(0, 5).join(", ")}`)
  if (typeof candidate.rating === "number") parts.push(`· ★${candidate.rating.toFixed(1)}`)
  if (candidate.runtimeMinutes) parts.push(`· ${candidate.runtimeMinutes} min`)
  const overview = cleanLine(candidate.overview, MAX_OVERVIEW_CHARS)
  return parts.join(" ") + (overview ? ` — ${overview}` : "")
}

/**
 * Build the system + user messages for one ranking request. Only the query,
 * the compact candidate list (id, title, year, kind, genres, rating,
 * runtime, one-line overview) and the taste summary are included — no raw
 * history, no credentials, no URLs, no stream links, no poster URLs.
 */
export function buildAiPrompt(
  query: string,
  candidates: DiscoverCandidate[],
  tasteSummary: TasteSummary
): { system: string; user: string } {
  const system =
    "You rank titles for a TV discovery screen. Reply with JSON only, no other text: " +
    '{"intent": {"genres": [], "mood": "", "pace": "", "maxRuntimeMinutes": 0, "exclude": [], "referenceTitles": []}, ' +
    '"rankings": [{"id": "", "reason": ""}]}. ' +
    "Rank ONLY the IDs listed below, best match first. One short reason per title (max 12 words). " +
    "Never invent titles or IDs. If nothing fits, return an empty rankings list."
  const tasteLines = [
    `Favourite genres: ${(tasteSummary.favouriteGenres || []).slice(0, 8).join(", ") || "none stated"}`,
    `Liked: ${(tasteSummary.likedTitles || []).slice(0, 8).join(", ") || "none stated"}`,
    `Disliked (avoid similar): ${(tasteSummary.dislikedTitles || []).slice(0, 8).join(", ") || "none stated"}`,
  ]
  if (tasteSummary.preferredRuntimeMax) {
    tasteLines.push(`Prefers titles up to ${tasteSummary.preferredRuntimeMax} minutes.`)
  }
  if (tasteSummary.pace) tasteLines.push(`Prefers a ${tasteSummary.pace} pace.`)
  const user = [
    `Search: ${cleanLine(query, MAX_QUERY_CHARS) || "(no query)"}`,
    "",
    "Taste:",
    ...tasteLines,
    "",
    "Candidates:",
    ...candidates.slice(0, AI_MAX_CANDIDATES).map((candidate, index) => formatCandidate(candidate, index)),
    "",
    "Rank the candidates for this search as JSON.",
  ].join("\n")
  return { system, user }
}

// ---------------------------------------------------------------------------
// Response parsing + ID validation (exported for tests)
// ---------------------------------------------------------------------------

function extractJsonObject(text: string): unknown {
  const trimmed = (text || "").trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // Tolerate a fenced code block or prose around the JSON.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const body = fenced ? fenced[1] : trimmed
    const start = body.indexOf("{")
    const end = body.lastIndexOf("}")
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function cleanStringList(value: unknown, maxItems = 8): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((item): item is string => typeof item === "string" && !!item.trim())
    .map((item) => item.trim().slice(0, 80))
    .slice(0, maxItems)
  return out.length ? out : undefined
}

function parseIntent(raw: unknown): AiIntent | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const intent = raw as Record<string, unknown>
  const parsed: AiIntent = {}
  const genres = cleanStringList(intent.genres)
  if (genres) parsed.genres = genres
  if (typeof intent.mood === "string" && intent.mood.trim()) parsed.mood = intent.mood.trim().slice(0, 80)
  if (typeof intent.pace === "string" && intent.pace.trim()) parsed.pace = intent.pace.trim().slice(0, 80)
  if (typeof intent.maxRuntimeMinutes === "number" && Number.isFinite(intent.maxRuntimeMinutes)) {
    parsed.maxRuntimeMinutes = Math.max(0, Math.round(intent.maxRuntimeMinutes))
  }
  const exclude = cleanStringList(intent.exclude)
  if (exclude) parsed.exclude = exclude
  const referenceTitles = cleanStringList(intent.referenceTitles)
  if (referenceTitles) parsed.referenceTitles = referenceTitles
  return Object.keys(parsed).length ? parsed : undefined
}

/**
 * Validate a model reply against the supplied candidates. Unknown or
 * invented IDs are dropped, duplicates collapse to the first mention, and
 * the score is derived from rank position (top = 1.0, descending). Throws
 * `AiError` ("bad_output") when nothing usable survives.
 */
export function parseAiRankResponse(text: string, candidates: DiscoverCandidate[]): AiRankResponse {
  const parsed = extractJsonObject(text)
  if (!parsed || typeof parsed !== "object") {
    throw new AiError("bad_output", "The AI reply was not usable JSON.")
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const rawRankings = (parsed as Record<string, unknown>).rankings
  if (!Array.isArray(rawRankings)) {
    throw new AiError("bad_output", "The AI reply had no rankings list.")
  }
  const seen = new Set<string>()
  const valid: Array<{ candidate: DiscoverCandidate; reason: string }> = []
  for (const item of rawRankings) {
    if (!item || typeof item !== "object") continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== "string" || seen.has(id)) continue
    const candidate = byId.get(id)
    if (!candidate) continue // invented ID — dropped, never surfaced
    seen.add(id)
    const rawReason = (item as Record<string, unknown>).reason
    const reason =
      typeof rawReason === "string" && rawReason.trim()
        ? rawReason.trim().slice(0, MAX_REASON_CHARS)
        : GENERIC_REASON
    valid.push({ candidate, reason })
  }
  if (!valid.length) {
    throw new AiError("bad_output", "The AI reply ranked none of the supplied titles.")
  }
  const total = valid.length
  return {
    rankings: valid.map(({ candidate, reason }, index) => ({
      candidate,
      score: Math.round(((total - index) / total) * 100) / 100,
      reason,
    })),
    intent: parseIntent((parsed as Record<string, unknown>).intent),
  }
}

// ---------------------------------------------------------------------------
// Fallback + session cache
// ---------------------------------------------------------------------------

/** Local-order stand-in for the coordinator's catch path: input order, position-derived scores. */
export function fallbackRank(
  candidates: DiscoverCandidate[],
  reason: string = FALLBACK_REASON
): RankedCandidate[] {
  const total = candidates.length
  if (!total) return []
  return candidates.map((candidate, index) => ({
    candidate,
    score: Math.round(((total - index) / total) * 100) / 100,
    reason,
  }))
}

const rankCache = new Map<string, RankedCandidate[]>()

// --- Session cache + usage guard (AI07) ----------------------------------
// Paid requests only ever leave on an explicit user action (the caller
// decides when to call rank()). Within a session, an identical query is
// answered from the session cache, and re-asking the same query within
// 60s never sends a second request: the caller falls back to local
// ranking instead. All storage access is guarded — vitest runs in node,
// where sessionStorage doesn't exist.
const SESSION_CACHE_KEY = "rs-ai-rank-cache-v1"
const SESSION_LAST_SENT_KEY = "rs-ai-last-sent-v1"
export const AI_MIN_REPEAT_SECONDS = 60

export interface AiActivityEvent {
  type: "start" | "done" | "error"
  at: number
  query: string
}

type AiActivityListener = (event: AiActivityEvent) => void
const activityListeners = new Set<AiActivityListener>()

/** Discover subscribes to show when a request leaves the device (AI07). */
export function subscribeAiActivity(listener: AiActivityListener): () => void {
  activityListeners.add(listener)
  return () => {
    activityListeners.delete(listener)
  }
}

function emitAiActivity(event: AiActivityEvent): void {
  for (const listener of [...activityListeners]) {
    try {
      listener(event)
    } catch {
      // A UI listener must never break ranking.
    }
  }
}

function readSession(key: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSession(key: string, value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return
    sessionStorage.setItem(key, value)
  } catch {
    // ignore — the in-memory cache still applies
  }
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

function readSessionCache(
  query: string,
  candidates: DiscoverCandidate[]
): RankedCandidate[] | null {
  try {
    const raw = readSession(SESSION_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      q?: string
      rankings?: Array<{ id: string; score: number; reason: string }>
    }
    if (parsed?.q !== normalizeQuery(query) || !Array.isArray(parsed.rankings)) return null
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const out: RankedCandidate[] = []
    for (const entry of parsed.rankings) {
      const candidate = byId.get(entry.id)
      if (!candidate) continue
      out.push({ candidate, score: entry.score, reason: entry.reason })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

function writeSessionCache(query: string, rankings: RankedCandidate[]): void {
  writeSession(
    SESSION_CACHE_KEY,
    JSON.stringify({
      q: normalizeQuery(query),
      rankings: rankings.map((r) => ({
        id: r.candidate.id,
        score: r.score,
        reason: r.reason,
      })),
    })
  )
}

/** True when this exact query was sent to the provider very recently. */
export function wasRecentlySent(query: string, nowMs: number = Date.now()): boolean {
  try {
    const raw = readSession(SESSION_LAST_SENT_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { q?: string; at?: number }
    if (parsed?.q !== normalizeQuery(query) || typeof parsed?.at !== "number") return false
    return nowMs - parsed.at < AI_MIN_REPEAT_SECONDS * 1000
  } catch {
    return false
  }
}

function markSent(query: string, nowMs: number = Date.now()): void {
  writeSession(
    SESSION_LAST_SENT_KEY,
    JSON.stringify({ q: normalizeQuery(query), at: nowMs })
  )
}

export function clearAiUsageState(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(SESSION_CACHE_KEY)
      sessionStorage.removeItem(SESSION_LAST_SENT_KEY)
    }
  } catch {
    // ignore
  }
}

function cacheKey(
  query: string,
  candidates: DiscoverCandidate[],
  tasteSummary: TasteSummary
): string {
  return JSON.stringify({
    q: query.trim().toLowerCase(),
    ids: candidates.slice(0, AI_MAX_CANDIDATES).map((candidate) => candidate.id),
    taste: tasteSummary,
  })
}

export function clearAiRankCache(): void {
  rankCache.clear()
}

// One request per query; a new search cancels the previous in-flight one.
let currentRankController: AbortController | null = null

// ---------------------------------------------------------------------------
// The ranker (the seam contract — signature must not drift)
// ---------------------------------------------------------------------------

export const aiRanker = {
  async rank(
    query: string,
    candidates: DiscoverCandidate[],
    tasteSummary: TasteSummary
  ): Promise<RankedCandidate[]> {
    if (!getAiEnabled()) {
      throw new AiError("not_configured", "AI Discovery is off.")
    }
    const shortlist = candidates.slice(0, AI_MAX_CANDIDATES)
    if (!shortlist.length) return []

    // Privacy (AI05): without an explicit opt-in, the taste summary
    // never leaves the device — the model sees query + candidates only.
    const effectiveTaste: TasteSummary = getAiShareTaste()
      ? tasteSummary
      : { favouriteGenres: [], likedTitles: [], dislikedTitles: [] }

    const key = cacheKey(query, shortlist, effectiveTaste)
    const cached = rankCache.get(key)
    if (cached) return [...cached]
    const sessionCached = readSessionCache(query, shortlist)
    if (sessionCached) {
      rankCache.set(key, sessionCached)
      return [...sessionCached]
    }
    // Same question within 60s: never send a second paid request.
    if (wasRecentlySent(query)) {
      throw new AiError(
        "rate_limited",
        "That question was just asked — showing local recommendations."
      )
    }

    currentRankController?.abort()
    const controller = new AbortController()
    currentRankController = controller
    try {
      const { system, user } = buildAiPrompt(query, shortlist, effectiveTaste)
      emitAiActivity({ type: "start", at: Date.now(), query })
      markSent(query)
      const result = await chatCompletions({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        signal: controller.signal,
      })
      const parsed = parseAiRankResponse(result.text, shortlist)
      rankCache.set(key, parsed.rankings)
      writeSessionCache(query, parsed.rankings)
      emitAiActivity({ type: "done", at: Date.now(), query })
      return parsed.rankings
    } catch (error) {
      emitAiActivity({ type: "error", at: Date.now(), query })
      throw error
    } finally {
      if (currentRankController === controller) currentRankController = null
    }
  },
}
