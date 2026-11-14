// AI ranking for RedSilk Discover (0.11.5, W2 — rerank + validation +
// composite IDs + cache identity).
//
// PIPELINE (one engine — `rankShortlist` / `aiRanker.rank` funnel into the
// same core, `runRerank`):
//   1. W1's retrieval supplies a RELEVANCE-RANKED shortlist + structured
//      intent (see `RerankRequest`). This module never re-implements
//      retrieval and never consumes raw catalogue order.
//   2. A token-cost ceiling (`AI_MAX_CANDIDATES`) is applied AFTER that
//      relevance selection, to the shortlist only — never to the raw
//      catalogue. The old code sliced the first 20 catalogue entries
//      before any ranking, which is how "some fucked up dark anime"
//      returned 'G' Men (1935), .com for Murder, .raw (2018), '71
//      (2014) and ...And Justice for All: punctuation-first catalogue
//      order, not relevance.
//   3. The LLM reranks the shortlist from grounded metadata only
//      (id, title, year, kind, genres, rating, runtime, one-line
//      overview). It may return an EMPTY list — a zero-result response
//      beats five unrelated titles.
//   4. Post-ranking validation (`validateAiRankings`) checks every
//      returned title against the shortlist: composite-ID validity,
//      duplicates, hard-constraint violations, medium mismatches and
//      unrelated recommendations are dropped; reasons are checked
//      against real metadata. Survivors keep model order.
//   5. Results are cached under a full-identity fingerprint (query +
//      constraints + ordered composite shortlist IDs + catalogue
//      identity/stamp + profile + taste + provider/model + pipeline
//      version). A changed playlist, catalogue, profile, model or
//      candidate selection is a cache MISS, never a stale reuse.
//
// Identity: movies and series may share a provider ID, so every ID
// that crosses a boundary (prompt, parse, validation, cache) is the
// stable composite `${kind}:${id}` — e.g. `movie:123` vs `series:123`.
// A bare ID from the model is accepted ONLY when it matches exactly one
// candidate across all kinds; an ambiguous bare ID is dropped, never
// remapped.
//
// Privacy: `rank()` sends ONE model request per discovery query — the
// user's query, the compact shortlist and (only with the explicit
// taste-sharing opt-in) the taste summary. It never sends raw viewing
// history, IPTV credentials, provider URLs, stream links or poster
// URLs. Request/response bodies are NEVER logged.
//
// On any failure `rank()` throws a typed `AiError` (see client.ts) and
// the caller falls back to the local engine — use `fallbackRank()` for
// the local-order stand-in. It never silently returns unranked results
// as if the model had ranked them. One exception: an explicit empty
// model reply (valid JSON, empty rankings list) is a legitimate
// rejection, not an error — `rank()` resolves to `[]` and reports the
// `rejected` lifecycle phase, so the caller can fall back to local
// picks with an honest reason.
//
// Types here are local copies of the seam the coordinator defines in
// `src/scripts/lib/discover.ts` (not present in this branch): same shape,
// same field names. This file must NOT import from `../discover`.

import { AiError, chatCompletions } from "./client.js"
import { getAiEnabled, getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import { getAiShareTaste } from "./status.js"
import type { AiChatTransport } from "./generation.js"

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

/**
 * Bump when the prompt, validation rules or cache identity change: old
 * cached results must never be reused against the new pipeline.
 */
export const RANKING_PIPELINE_VERSION = 2

/**
 * Token-cost ceiling on how many shortlist entries ever reach the model
 * in one request. This is applied AFTER relevance selection (W1), to the
 * relevance-ranked shortlist only — it is a cost control, never a
 * selection mechanism. Do NOT apply it to raw catalogue order.
 */
export const AI_MAX_CANDIDATES = 20
const MAX_QUERY_CHARS = 500
const MAX_OVERVIEW_CHARS = 160
const MAX_REASON_CHARS = 140
const FALLBACK_REASON = "AI is unavailable — showing local order."
const GENERIC_REASON = "Ranked by AI for this search."

// ---------------------------------------------------------------------------
// Composite candidate identity (Bug 5)
// ---------------------------------------------------------------------------

/** Stable identity across prompt, validation and cache: `movie:123`. */
export function compositeCandidateId(candidate: DiscoverCandidate): string {
  return `${candidate.kind}:${candidate.id}`
}

/**
 * Split a composite ID back into kind + bare id. Returns null when the
 * value is not a well-formed composite ID (bare IDs are handled by the
 * caller's unambiguous-match rule, never here).
 */
export function parseCompositeCandidateId(
  value: string
): { kind: string; id: string } | null {
  const colon = value.indexOf(":")
  if (colon <= 0 || colon === value.length - 1) return null
  const kind = value.slice(0, colon)
  if (kind !== "movie" && kind !== "series" && kind !== "live") return null
  return { kind, id: value.slice(colon + 1) }
}

/** Title-group key: language variants / re-listings of one title collapse together. */
function titleGroupKey(candidate: DiscoverCandidate): string {
  const title = normalizeText(candidate.title)
  if (!title) return `id:${candidate.kind}:${candidate.id}`
  return `${title}|${candidate.year ?? ""}`
}

// ---------------------------------------------------------------------------
// Structured constraints (W1's intent, consumed — never re-derived here)
// ---------------------------------------------------------------------------

/**
 * Hard constraints for one rerank, supplied by W1's retrieval stage
 * from the structured intent it parsed out of the query. The model
 * may NOT override these; validation enforces them after the reply.
 * Every field is optional — absent means "no constraint stated".
 */
export interface RankingConstraints {
  genres?: string[]
  kind?: "movie" | "series" | "live"
  maxRuntimeMinutes?: number
  minRating?: number
  minYear?: number
  maxYear?: number
  excludeTitles?: string[]
  excludeGenres?: string[]
  mood?: string
  referenceTitles?: string[]
}

/**
 * Catalogue / profile context that identifies WHAT was ranked. The
 * caller (DiscoverView via the coordinator) supplies these when known;
 * all are optional so the ranker still works (and still caches safely
 * on the shortlist identity) when a caller cannot provide them. When
 * `playlistId` is unknown the cache degrades to shortlist-identity
 * only — still safe against a changed candidate selection, but NOT
 * against the same provider IDs under a different playlist, so
 * callers that know the playlist MUST pass it.
 */
export interface RerankContext {
  /** Active playlist / provider entry id (DiscoverView: entry._id). */
  playlistId?: string
  /** Catalogue revision stamp (Discover's candidate-cache stamp). */
  catalogueStamp?: number
  /** Active profile id (DiscoverView: getActiveProfileId()). */
  profileId?: string
  /** Taste-model revision, when the caller tracks one. The taste summary itself is always keyed too. */
  tasteRevision?: string
}

/** One rerank request: W1's relevance-ranked shortlist + intent. */
export interface RerankRequest {
  query: string
  /** Relevance-ranked by W1. Order is meaningful — the token ceiling keeps the head of THIS order. */
  shortlist: DiscoverCandidate[]
  tasteSummary: TasteSummary
  constraints?: RankingConstraints
  context?: RerankContext
  /**
   * Optional chat transport override (0.11.14, Home core + tests).
   * Defaults to chatCompletions; Discover passes nothing and is
   * unaffected. The Home core injects its deps' transport so the
   * same reranker serves Home without a second pipeline.
   */
  chat?: AiChatTransport
  /**
   * Skip the 60s same-query repeat guard + sent-marking (0.11.14,
   * Home core only). Discover keeps the guard. Home enforces
   * stronger discipline of its own (durable cache + 24h attempt
   * ledger + in-flight dedup), and the guard keys on the query
   * string alone — Home's empty query would otherwise block the
   * second content type's refresh and every explicit re-generate
   * within 60s of any other Home rank.
   */
  skipRepeatGuard?: boolean
}

/** Options for the legacy `rank()` seam (same fields, flat). */
export interface RankOptions {
  constraints?: RankingConstraints
  context?: RerankContext
}

// ---------------------------------------------------------------------------
// Text helpers (validation + relatedness)
// ---------------------------------------------------------------------------

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function tokenize(value: string | undefined): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "me", "my", "i",
  "want", "please", "something", "anything", "show", "watch",
  "watching", "find", "get", "give", "tonight", "today", "night", "now",
])

/** Content-bearing tokens of the query: stopwords and 1-char tokens dropped. */
function queryContentTokens(query: string): string[] {
  return tokenize(query).filter((token) => !STOPWORDS.has(token))
}

/**
 * Conservative synonym expansion, used ONLY for relatedness evidence
 * (never to invent metadata). Deliberately narrow: "dark" maps to
 * horror/thriller/mystery/noir — NOT to crime/drama, so a crime drama
 * cannot launder itself into a "dark anime" answer on a synonym.
 */
const SYNONYMS: Record<string, string[]> = {
  anime: ["animation"],
  animation: ["anime"],
  cartoon: ["animation"],
  dark: ["horror", "thriller", "mystery", "noir"],
  scary: ["horror"],
  funny: ["comedy"],
  hilarious: ["comedy"],
  romantic: ["romance"],
  sad: ["drama"],
  kids: ["family", "animation"],
  children: ["family", "animation"],
  "sci-fi": ["science fiction"],
  "science fiction": ["sci-fi"],
}

function expandToken(token: string): string[] {
  return [token, ...(SYNONYMS[token] ?? [])]
}

function lowerSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean))
}

/** Genre overlap, synonym-aware in both directions (anime ~= animation). */
function genresOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const genre of a) {
    if (b.has(genre)) return true
    for (const synonym of SYNONYMS[genre] ?? []) {
      if (b.has(synonym)) return true
    }
  }
  for (const genre of b) {
    for (const synonym of SYNONYMS[genre] ?? []) {
      if (a.has(synonym)) return true
    }
  }
  return false
}

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
  const parts = [`${index + 1}. [${compositeCandidateId(candidate)}] ${candidate.title}`]
  if (candidate.year) parts.push(`(${candidate.year})`)
  parts.push(`· ${candidate.kind}`)
  if (candidate.genres?.length) parts.push(`· ${candidate.genres.slice(0, 5).join(", ")}`)
  if (typeof candidate.rating === "number") parts.push(`· ★${candidate.rating.toFixed(1)}`)
  if (candidate.runtimeMinutes) parts.push(`· ${candidate.runtimeMinutes} min`)
  const overview = cleanLine(candidate.overview, MAX_OVERVIEW_CHARS)
  return parts.join(" ") + (overview ? ` — ${overview}` : "")
}

function formatConstraints(constraints: RankingConstraints | undefined): string[] {
  if (!constraints) return []
  const lines: string[] = []
  if (constraints.kind) lines.push(`- Only ${constraints.kind} titles.`)
  if (constraints.genres?.length) lines.push(`- Wanted genres: ${constraints.genres.join(", ")}.`)
  if (typeof constraints.maxRuntimeMinutes === "number" && constraints.maxRuntimeMinutes > 0) {
    lines.push(`- No title longer than ${constraints.maxRuntimeMinutes} minutes.`)
  }
  if (typeof constraints.minRating === "number") {
    lines.push(`- Only titles rated ${constraints.minRating} or higher.`)
  }
  if (typeof constraints.minYear === "number" || typeof constraints.maxYear === "number") {
    lines.push(
      `- Only titles from ${constraints.minYear ?? "any year"} to ${constraints.maxYear ?? "any year"}.`
    )
  }
  if (constraints.excludeTitles?.length) {
    lines.push(`- Do NOT include: ${constraints.excludeTitles.join(", ")}.`)
  }
  if (constraints.excludeGenres?.length) {
    lines.push(`- Avoid these genres: ${constraints.excludeGenres.join(", ")}.`)
  }
  if (constraints.mood) lines.push(`- Mood: ${constraints.mood}.`)
  if (constraints.referenceTitles?.length) {
    lines.push(`- Similar in spirit to: ${constraints.referenceTitles.join(", ")}.`)
  }
  return lines
}

/**
 * Build the system + user messages for one ranking request. Only the query,
 * the compact candidate list (composite id, title, year, kind, genres,
 * rating, runtime, one-line overview), the stated requirements and the
 * taste summary are included — no raw history, no credentials, no URLs,
 * no stream links, no poster URLs.
 *
 * The candidate list is rendered EXACTLY as given: this function applies
 * no cap and no selection. The caller applies the token ceiling
 * (`applyRerankCap`) to the relevance-ranked shortlist before calling.
 */
export function buildAiPrompt(
  query: string,
  candidates: DiscoverCandidate[],
  tasteSummary: TasteSummary,
  constraints?: RankingConstraints
): { system: string; user: string } {
  const system =
    "You rank titles for a TV discovery screen. Reply with JSON only, no other text: " +
    '{"intent": {"genres": [], "mood": "", "pace": "", "maxRuntimeMinutes": 0, "exclude": [], "referenceTitles": []}, ' +
    '"rankings": [{"id": "movie:123", "reason": ""}]}. ' +
    "Rank ONLY the IDs listed below, best match first, using each ID exactly as listed (kind:id, e.g. movie:123 — never return a bare number). " +
    "One short reason per title (max 12 words), grounded in the listed metadata. " +
    "Never invent titles or IDs. If nothing fits, return an empty rankings list — a short honest list beats a long unrelated one. " +
    "Never pad the list with weak matches."
  const tasteLines = [
    `Favourite genres: ${(tasteSummary.favouriteGenres || []).slice(0, 8).join(", ") || "none stated"}`,
    `Liked: ${(tasteSummary.likedTitles || []).slice(0, 8).join(", ") || "none stated"}`,
    `Disliked (avoid similar): ${(tasteSummary.dislikedTitles || []).slice(0, 8).join(", ") || "none stated"}`,
  ]
  if (tasteSummary.preferredRuntimeMax) {
    tasteLines.push(`Prefers titles up to ${tasteSummary.preferredRuntimeMax} minutes.`)
  }
  if (tasteSummary.pace) tasteLines.push(`Prefers a ${tasteSummary.pace} pace.`)
  const requirementLines = formatConstraints(constraints)
  const user = [
    `Search: ${cleanLine(query, MAX_QUERY_CHARS) || "(no query)"}`,
    "",
    ...(requirementLines.length ? ["Requirements:", ...requirementLines, ""] : []),
    "Taste:",
    ...tasteLines,
    "",
    "Candidates:",
    ...candidates.map((candidate, index) => formatCandidate(candidate, index)),
    "",
    "Rank the candidates for this search as JSON.",
  ].join("\n")
  return { system, user }
}

/**
 * Token-cost ceiling, applied AFTER relevance selection to the
 * relevance-ranked shortlist. The head of a relevance-ranked list is
 * the right head to keep; the head of raw catalogue order is not —
 * callers must never pass an unranked catalogue here and call it a
 * shortlist.
 */
export function applyRerankCap(shortlist: DiscoverCandidate[]): DiscoverCandidate[] {
  return shortlist.slice(0, AI_MAX_CANDIDATES)
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
 * Resolve one model-returned id against the shortlist. Composite IDs
 * (`movie:123`) resolve exactly. A bare ID resolves ONLY when exactly
 * one candidate carries it across all kinds — an ambiguous bare ID
 * (movie 123 AND series 123) resolves to nothing, never to a guess.
 */
export function resolveModelId(
  id: string,
  candidates: DiscoverCandidate[]
): DiscoverCandidate | null {
  const composite = parseCompositeCandidateId(id)
  if (composite) {
    return (
      candidates.find(
        (candidate) => candidate.kind === composite.kind && candidate.id === composite.id
      ) ?? null
    )
  }
  const matches = candidates.filter((candidate) => candidate.id === id)
  return matches.length === 1 ? matches[0]! : null
}

/**
 * Validate a model reply against the supplied candidates. Unknown or
 * invented IDs are dropped, duplicates collapse to the first mention,
 * and the score is derived from rank position (top = 1.0, descending).
 *
 * An explicitly EMPTY rankings list is a legitimate model rejection
 * (the model found nothing that fits) — it resolves to zero rankings,
 * it does NOT throw. A non-empty list in which nothing survives is a
 * broken reply and throws `AiError` ("bad_output"), as does missing or
 * malformed JSON. Further checks (constraints, relatedness, reasons)
 * run in `validateAiRankings`, which may still reduce this to zero.
 */
export function parseAiRankResponse(text: string, candidates: DiscoverCandidate[]): AiRankResponse {
  const parsed = extractJsonObject(text)
  if (!parsed || typeof parsed !== "object") {
    throw new AiError("bad_output", "The AI reply was not usable JSON.")
  }
  const rawRankings = (parsed as Record<string, unknown>).rankings
  if (!Array.isArray(rawRankings)) {
    throw new AiError("bad_output", "The AI reply had no rankings list.")
  }
  const intent = parseIntent((parsed as Record<string, unknown>).intent)
  if (!rawRankings.length) {
    // Explicit rejection: the model ranked nothing. Allowed — the
    // caller falls back to local picks with an honest reason.
    return { rankings: [], intent }
  }
  const seen = new Set<string>()
  const valid: Array<{ candidate: DiscoverCandidate; reason: string }> = []
  for (const item of rawRankings) {
    if (!item || typeof item !== "object") continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== "string") continue
    const candidate = resolveModelId(id, candidates)
    if (!candidate) continue // invented / ambiguous ID — dropped, never surfaced
    const composite = compositeCandidateId(candidate)
    if (seen.has(composite)) continue
    seen.add(composite)
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
    intent,
  }
}

// ---------------------------------------------------------------------------
// Post-ranking validation (Bug 7)
// ---------------------------------------------------------------------------

export type DroppedReason =
  | "unknown-id"
  | "duplicate"
  | "title-group-duplicate"
  | "constraint-kind"
  | "constraint-runtime"
  | "constraint-rating"
  | "constraint-year"
  | "constraint-excluded"
  | "unrelated-medium"
  | "unrelated"

export interface DroppedRanking {
  compositeId: string
  title: string
  reason: DroppedReason
}

export interface ValidationReport {
  /** Candidates sent to the model. */
  requested: number
  /** Entries the model returned (after parse-level ID validation). */
  returned: number
  /** Entries that survived validation. */
  kept: number
  dropped: DroppedRanking[]
  /** True when the model returned an explicitly empty list. */
  explicitRejection: boolean
}

const COMMON_GENRE_WORDS = [
  "action", "adventure", "animation", "anime", "comedy", "crime", "documentary",
  "drama", "family", "fantasy", "history", "horror", "music", "musical",
  "mystery", "romance", "sci-fi", "science fiction", "thriller", "war",
  "western", "noir",
]

/**
 * A reason must reflect real metadata. If it names a genre the
 * candidate does not have, or a year that is not the candidate's year,
 * the reason is replaced with the generic one — the title is kept
 * (its fit was judged on metadata), the false claim is not.
 */
export function sanitizeReason(reason: string, candidate: DiscoverCandidate): string {
  const text = normalizeText(reason)
  if (!text) return GENERIC_REASON
  const candidateGenres = lowerSet(candidate.genres)
  // Word-boundary split that KEEPS hyphenated words ("sci-fi" stays one
  // word), so a genre claim is never matched inside another word
  // ("satisfaction" must not read as "action").
  const reasonWords = new Set(text.split(/[\s,.;:!?()"[\]]+/).filter(Boolean))
  const hasGenreWord = (word: string) =>
    word.includes(" ")
      ? word.split(" ").every((part) => reasonWords.has(part))
      : reasonWords.has(word)
  for (const genreWord of COMMON_GENRE_WORDS) {
    if (!hasGenreWord(genreWord)) continue
    // "anime" in a reason is a claim about the Animation genre.
    const claimed = genreWord === "anime" ? "animation" : genreWord
    if (!genresOverlap(new Set([claimed]), candidateGenres)) return GENERIC_REASON
  }
  const yearMatch = reason.match(/\b(19|20)\d{2}\b/)
  if (yearMatch && typeof candidate.year === "number") {
    if (parseInt(yearMatch[0], 10) !== candidate.year) return GENERIC_REASON
  }
  return reason
}

interface MediumRequirement {
  test: RegExp
  label: string
  satisfiedBy: (candidate: DiscoverCandidate) => boolean
}

const MEDIUM_REQUIREMENTS: MediumRequirement[] = [
  {
    test: /\banime\b/,
    label: "anime",
    satisfiedBy: (c) => lowerSet(c.genres).has("animation"),
  },
  {
    test: /\banimated\b|\bcartoon\b/,
    label: "animation",
    satisfiedBy: (c) => lowerSet(c.genres).has("animation"),
  },
  {
    test: /\bseries\b/,
    label: "series",
    satisfiedBy: (c) => c.kind === "series",
  },
  {
    test: /\bmovie\b|\bfilm\b/,
    label: "movie",
    satisfiedBy: (c) => c.kind === "movie",
  },
  {
    test: /\bdocumentary\b/,
    label: "documentary",
    satisfiedBy: (c) => lowerSet(c.genres).has("documentary"),
  },
]

/**
 * Does this candidate show ANY evidence of fitting the query + intent?
 * Evidence is one of: genre overlap with the stated/model intent
 * genres, a query content-token (synonym-expanded) appearing in the
 * candidate's title/genres/overview/director/cast, or a reference-title
 * token appearing in the candidate title. With no query tokens, no
 * intent genres and no reference titles there is nothing to judge
 * against, so the check passes (validation defers to the model and the
 * shortlist). A candidate that fails every signal is unrelated and is
 * dropped — never surfaced as an "AI pick".
 */
function hasRelatednessEvidence(
  candidate: DiscoverCandidate,
  queryTokens: string[],
  intentGenres: Set<string>,
  referenceTitleTokens: string[]
): boolean {
  const candidateGenres = lowerSet(candidate.genres)
  if (intentGenres.size && genresOverlap(intentGenres, candidateGenres)) return true
  if (referenceTitleTokens.length) {
    const titleTokens = new Set(tokenize(candidate.title))
    if (referenceTitleTokens.some((token) => titleTokens.has(token))) return true
  }
  if (!queryTokens.length) {
    // Nothing stated to judge against — do not invent a rejection.
    return intentGenres.size === 0 && referenceTitleTokens.length === 0 ? true : false
  }
  const candidateText = new Set([
    ...tokenize(candidate.title),
    ...tokenize((candidate.genres ?? []).join(" ")),
    ...tokenize(candidate.overview),
    ...tokenize(candidate.director),
    ...(candidate.cast ?? []).flatMap((name) => tokenize(name)),
  ])
  for (const token of queryTokens) {
    for (const variant of expandToken(token)) {
      if (candidateText.has(variant)) return true
    }
  }
  return false
}

/**
 * Post-ranking validation. Drops, in model order: entries not in the
 * shortlist, duplicates, same-title re-listings, hard-constraint
 * violations (kind / runtime / rating / year / exclusions), medium
 * mismatches (the query names anime, a series or a film and the title
 * cannot be one), and unrelated recommendations with no evidence in
 * the query or the intent. Reasons are sanitised against real
 * metadata. Survivors are re-scored by position. Returning FEWER
 * matches — including zero — is the correct outcome when the evidence
 * is weak; empty slots are never filled with arbitrary catalogue
 * entries. No playable item is ever fabricated.
 *
 * Hard constraints come ONLY from W1's `constraints`. The model's own
 * returned intent contributes genre evidence only — the model cannot
 * launder a bad pick by inventing a permissive intent, and cannot
 * impose a runtime/genre constraint the user never stated.
 */
export function validateAiRankings(
  rankings: RankedCandidate[],
  shortlist: DiscoverCandidate[],
  constraints?: RankingConstraints,
  query = "",
  modelIntent?: AiIntent
): { rankings: RankedCandidate[]; report: ValidationReport } {
  const byComposite = new Map(shortlist.map((c) => [compositeCandidateId(c), c]))
  const queryTokens = queryContentTokens(query)
  const intentGenres = lowerSet([
    ...(constraints?.genres ?? []),
    ...(modelIntent?.genres ?? []),
  ])
  const referenceTitleTokens = [
    ...(constraints?.referenceTitles ?? []),
    ...(modelIntent?.referenceTitles ?? []),
  ]
    .flatMap((title) => tokenize(title))
    .filter((token) => token.length >= 3)
  const excludeTitles = lowerSet(constraints?.excludeTitles)
  const excludeGenres = lowerSet(constraints?.excludeGenres)
  const requiredMedia = MEDIUM_REQUIREMENTS.filter((medium) => medium.test.test(query))

  const seen = new Set<string>()
  const seenTitleGroups = new Set<string>()
  const kept: RankedCandidate[] = []
  const dropped: DroppedRanking[] = []
  const drop = (candidate: DiscoverCandidate, reason: DroppedReason) => {
    dropped.push({ compositeId: compositeCandidateId(candidate), title: candidate.title, reason })
  }

  for (const entry of rankings) {
    const candidate = entry.candidate
    const composite = compositeCandidateId(candidate)
    if (!byComposite.has(composite)) {
      drop(candidate, "unknown-id")
      continue
    }
    if (seen.has(composite)) {
      drop(candidate, "duplicate")
      continue
    }
    seen.add(composite)
    const group = titleGroupKey(candidate)
    if (seenTitleGroups.has(group)) {
      drop(candidate, "title-group-duplicate")
      continue
    }
    if (constraints?.kind && candidate.kind !== constraints.kind) {
      drop(candidate, "constraint-kind")
      continue
    }
    if (
      typeof constraints?.maxRuntimeMinutes === "number" &&
      constraints.maxRuntimeMinutes > 0 &&
      typeof candidate.runtimeMinutes === "number" &&
      candidate.runtimeMinutes > constraints.maxRuntimeMinutes
    ) {
      drop(candidate, "constraint-runtime")
      continue
    }
    if (
      typeof constraints?.minRating === "number" &&
      typeof candidate.rating === "number" &&
      candidate.rating < constraints.minRating
    ) {
      drop(candidate, "constraint-rating")
      continue
    }
    if (
      (typeof constraints?.minYear === "number" &&
        typeof candidate.year === "number" &&
        candidate.year < constraints.minYear) ||
      (typeof constraints?.maxYear === "number" &&
        typeof candidate.year === "number" &&
        candidate.year > constraints.maxYear)
    ) {
      drop(candidate, "constraint-year")
      continue
    }
    if (
      excludeTitles.has(normalizeText(candidate.title)) ||
      (candidate.genres ?? []).some((genre) => excludeGenres.has(normalizeText(genre)))
    ) {
      drop(candidate, "constraint-excluded")
      continue
    }
    if (requiredMedia.some((medium) => !medium.satisfiedBy(candidate))) {
      drop(candidate, "unrelated-medium")
      continue
    }
    if (!hasRelatednessEvidence(candidate, queryTokens, intentGenres, referenceTitleTokens)) {
      drop(candidate, "unrelated")
      continue
    }
    seenTitleGroups.add(group)
    kept.push({
      candidate,
      score: entry.score,
      reason: sanitizeReason(entry.reason, candidate),
    })
  }

  const total = kept.length
  const rescored = kept.map((entry, index) => ({
    ...entry,
    score: total ? Math.round(((total - index) / total) * 100) / 100 : 0,
  }))
  return {
    rankings: rescored,
    report: {
      requested: shortlist.length,
      returned: rankings.length,
      kept: rescored.length,
      dropped,
      explicitRejection: rankings.length === 0,
    },
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

// --- Session cache + usage guard (AI07) ----------------------------------
// Paid requests only ever leave on an explicit user action (the caller
// decides when to call rank()). Within a session, an identical query is
// answered from the session cache, and re-asking the same query within
// 60s never sends a second request: the caller falls back to local
// ranking instead. All storage access is guarded — vitest runs in node,
// where sessionStorage doesn't exist.
const SESSION_CACHE_KEY = "rs-ai-rank-cache-v2"
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

// ---------------------------------------------------------------------------
// Request lifecycle status (W3 consumes this)
// ---------------------------------------------------------------------------

/**
 * Real request lifecycle for the Discover UI (W3). Phases, in order:
 * - "sending": an AI request is being sent to the provider.
 * - "response-received": the provider answered; validation is running.
 * - "validated": the AI result passed validation (keptCount >= 1).
 * - "rejected": the AI result was rejected — the model returned an
 *   empty list, or validation dropped every entry. The UI must NOT
 *   label these "AI picks"; the caller falls back to local picks.
 * - "cached": a valid previous AI result was reused (no request sent).
 * - "error": the request failed (see errorKind); the caller falls back.
 * - "local-search" / "local-fallback": set by the Discover caller, not
 *   by this module — the caller reports when it answers locally (no AI
 *   request, or after an AI failure/rejection). Included in the union
 *   so W3 has one status type for the whole search.
 */
export type AiRankPhase =
  | "idle"
  | "local-search"
  | "sending"
  | "response-received"
  | "validated"
  | "rejected"
  | "cached"
  | "local-fallback"
  | "error"

export interface AiRankStatus {
  phase: AiRankPhase
  query: string
  /** Active model id — from the provider reply when a request was made, else the configured model. */
  model: string
  /** Provider endpoint the request went to (base URL, no key material). */
  endpoint: string
  startedAt: number
  /** Milliseconds from request start to the terminal phase; null while in flight. */
  durationMs: number | null
  /** True when this result came from the cache (no request was sent). */
  cacheHit: boolean
  cacheSource?: "memory" | "session"
  /** Human-readable reason when the UI falls back to local picks. */
  fallbackReason?: string
  /** Candidates sent to the model. */
  requestedCount: number
  /** Entries the model returned. */
  returnedCount: number
  /** Entries that survived validation. */
  keptCount: number
  /** Entries validation dropped. */
  droppedCount: number
  droppedReasons?: DroppedRanking[]
  errorKind?: string
}

type AiRankStatusListener = (status: AiRankStatus) => void
const rankStatusListeners = new Set<AiRankStatusListener>()
let lastRankStatus: AiRankStatus | null = null

/**
 * W3's Discover UI subscribes to show the real lifecycle: local search
 * running, AI request being sent, API response received, AI result
 * validated / rejected, cached recommendation, local fallback — plus
 * the active model, request duration, cache hit/miss and fallback
 * reason. The listener is also called immediately with the last known
 * status when one exists, so a late subscriber still sees the outcome.
 */
export function subscribeAiRankStatus(listener: AiRankStatusListener): () => void {
  rankStatusListeners.add(listener)
  if (lastRankStatus) {
    try {
      listener(lastRankStatus)
    } catch {
      // A UI listener must never break ranking.
    }
  }
  return () => {
    rankStatusListeners.delete(listener)
  }
}

/** Last lifecycle status, or null before any rank call this session. */
export function getLastAiRankStatus(): AiRankStatus | null {
  return lastRankStatus
}

function emitAiRankStatus(status: AiRankStatus): void {
  lastRankStatus = status
  for (const listener of [...rankStatusListeners]) {
    try {
      listener(status)
    } catch {
      // A UI listener must never break ranking.
    }
  }
}

// ---------------------------------------------------------------------------
// Cache identity (Bug 6)
// ---------------------------------------------------------------------------

interface RankCacheEntry {
  /** Fingerprint of the full ranking context (see buildCacheFingerprint). */
  key: string
  model: string
  endpoint: string
  cachedAt: number
  rankings: Array<{ id: string; score: number; reason: string }>
}

/** In-memory cache: every distinct ranking context keeps its own entry. */
const rankCache = new Map<string, RankCacheEntry>()

/**
 * Provider identity for the cache fingerprint. Each getter is read in
 * its own try/catch: one missing or throwing getter must never zero
 * the other. (A test mock that omits `getAiEndpoint` throws on the
 * binding access itself, so a single shared try/catch returned
 * {"",""} and a model change silently reused the stale cache — the
 * T5 model-change regression. In production all three exist; the
 * guards are for partial environments, not for hiding real errors.)
 */
function readProviderIdentity(): { endpoint: string; model: string } {
  let endpoint = ""
  let model = ""
  try {
    if (typeof getAiEndpoint === "function") {
      endpoint = String(getAiEndpoint() ?? "").trim()
    }
  } catch {
    endpoint = ""
  }
  try {
    if (typeof getAiModel === "function") {
      model = String(getAiModel() ?? "").trim()
    }
  } catch {
    model = ""
  }
  return { endpoint, model }
}

function normalizeConstraints(constraints: RankingConstraints | undefined): RankingConstraints {
  if (!constraints) return {}
  const sorted = (values: string[] | undefined) =>
    values ? [...new Set(values.map((v) => normalizeText(v)))].filter(Boolean).sort() : undefined
  return {
    genres: sorted(constraints.genres),
    kind: constraints.kind,
    maxRuntimeMinutes: constraints.maxRuntimeMinutes,
    minRating: constraints.minRating,
    minYear: constraints.minYear,
    maxYear: constraints.maxYear,
    excludeTitles: sorted(constraints.excludeTitles),
    excludeGenres: sorted(constraints.excludeGenres),
    mood: constraints.mood ? normalizeText(constraints.mood) : undefined,
    referenceTitles: sorted(constraints.referenceTitles),
  }
}

function normalizeTaste(taste: TasteSummary): TasteSummary {
  return {
    favouriteGenres: [...(taste.favouriteGenres ?? [])].sort(),
    likedTitles: [...(taste.likedTitles ?? [])].sort(),
    dislikedTitles: [...(taste.dislikedTitles ?? [])].sort(),
    preferredRuntimeMax: taste.preferredRuntimeMax,
    pace: taste.pace,
  }
}

/**
 * Full-identity fingerprint. Two calls share a cache entry ONLY when
 * every one of these matches: the query, the structured constraints,
 * the ordered composite shortlist IDs, the effective taste summary,
 * the catalogue identity + stamp, the profile, the taste revision,
 * the provider endpoint + model, and the pipeline version. A changed
 * playlist, catalogue, profile, model or candidate selection is a
 * MISS — a stale recommendation is never reused against different
 * data. The fingerprint contains no credentials and no history.
 */
function buildCacheFingerprint(input: {
  query: string
  shortlist: DiscoverCandidate[]
  effectiveTaste: TasteSummary
  constraints?: RankingConstraints
  context?: RerankContext
  endpoint: string
  model: string
}): string {
  return JSON.stringify({
    v: RANKING_PIPELINE_VERSION,
    q: normalizeQuery(input.query),
    ids: input.shortlist.map((candidate) => compositeCandidateId(candidate)),
    taste: normalizeTaste(input.effectiveTaste),
    constraints: normalizeConstraints(input.constraints),
    playlistId: input.context?.playlistId ?? "",
    catalogueStamp: input.context?.catalogueStamp ?? 0,
    profileId: input.context?.profileId ?? "",
    tasteRevision: input.context?.tasteRevision ?? "",
    endpoint: input.endpoint,
    model: input.model,
  })
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

/**
 * Reconstruct a cached entry against the CURRENT shortlist. Every
 * stored composite ID must still resolve to a candidate in the current
 * shortlist; a single missing or changed ID invalidates the whole
 * entry (defence in depth — the fingerprint should already have
 * missed, but a cache must never resurrect a title that is gone).
 */
function reconstructCached(
  entry: RankCacheEntry,
  shortlist: DiscoverCandidate[]
): RankedCandidate[] | null {
  const byComposite = new Map(shortlist.map((c) => [compositeCandidateId(c), c]))
  const out: RankedCandidate[] = []
  for (const stored of entry.rankings) {
    const candidate = byComposite.get(stored.id)
    if (!candidate) return null
    out.push({ candidate, score: stored.score, reason: stored.reason })
  }
  return out
}

function readSessionCache(
  fingerprint: string,
  shortlist: DiscoverCandidate[]
): { rankings: RankedCandidate[]; entry: RankCacheEntry } | null {
  try {
    const raw = readSession(SESSION_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RankCacheEntry>
    if (
      parsed?.key !== fingerprint ||
      !Array.isArray(parsed.rankings) ||
      typeof parsed.model !== "string"
    ) {
      return null
    }
    const entry = parsed as RankCacheEntry
    const rankings = reconstructCached(entry, shortlist)
    if (rankings === null) return null
    return { rankings, entry }
  } catch {
    return null
  }
}

function writeSessionCache(entry: RankCacheEntry): void {
  writeSession(SESSION_CACHE_KEY, JSON.stringify(entry))
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

export function clearAiRankCache(): void {
  rankCache.clear()
}

// One request per query; a new search cancels the previous in-flight one.
let currentRankController: AbortController | null = null

// ---------------------------------------------------------------------------
// The reranker (the seam contract — signature must not drift)
// ---------------------------------------------------------------------------

export interface RerankResult {
  rankings: RankedCandidate[]
  /** "ai" when a request was sent, "cached" when a valid previous result was reused. */
  source: "ai" | "cached"
  status: AiRankStatus
  validation: ValidationReport
}

function baseStatus(input: {
  query: string
  model: string
  endpoint: string
  startedAt: number
  requestedCount: number
}): AiRankStatus {
  return {
    phase: "idle",
    query: input.query,
    model: input.model,
    endpoint: input.endpoint,
    startedAt: input.startedAt,
    durationMs: null,
    cacheHit: false,
    requestedCount: input.requestedCount,
    returnedCount: 0,
    keptCount: 0,
    droppedCount: 0,
  }
}

async function runRerank(request: RerankRequest): Promise<RerankResult> {
  const startedAt = Date.now()
  const { query, tasteSummary } = request
  if (!getAiEnabled()) {
    throw new AiError("not_configured", "AI Discovery is off.")
  }
  // The token ceiling runs AFTER relevance selection: W1 already
  // ordered this shortlist, so keeping its head is keeping the most
  // relevant candidates — never the first 20 catalogue entries.
  const shortlist = applyRerankCap(request.shortlist ?? [])
  const identity = readProviderIdentity()
  const status = baseStatus({
    query,
    model: identity.model,
    endpoint: identity.endpoint,
    startedAt,
    requestedCount: shortlist.length,
  })
  if (!shortlist.length) {
    const empty: AiRankStatus = {
      ...status,
      phase: "rejected",
      durationMs: Date.now() - startedAt,
      fallbackReason: "No candidates to rank.",
    }
    emitAiRankStatus(empty)
    return {
      rankings: [],
      source: "ai",
      status: empty,
      validation: {
        requested: 0,
        returned: 0,
        kept: 0,
        dropped: [],
        explicitRejection: true,
      },
    }
  }

  // Privacy (AI05): without an explicit opt-in, the taste summary
  // never leaves the device — the model sees query + candidates only.
  const effectiveTaste: TasteSummary = getAiShareTaste()
    ? tasteSummary
    : { favouriteGenres: [], likedTitles: [], dislikedTitles: [] }

  const fingerprint = buildCacheFingerprint({
    query,
    shortlist,
    effectiveTaste,
    constraints: request.constraints,
    context: request.context,
    endpoint: identity.endpoint,
    model: identity.model,
  })

  const finishCached = (
    rankings: RankedCandidate[],
    entry: RankCacheEntry,
    source: "memory" | "session"
  ): RerankResult => {
    const cached: AiRankStatus = {
      ...status,
      phase: "cached",
      model: entry.model || identity.model,
      endpoint: entry.endpoint || identity.endpoint,
      durationMs: Date.now() - startedAt,
      cacheHit: true,
      cacheSource: source,
      returnedCount: rankings.length,
      keptCount: rankings.length,
    }
    emitAiRankStatus(cached)
    return {
      rankings: [...rankings],
      source: "cached",
      status: cached,
      validation: {
        requested: shortlist.length,
        returned: rankings.length,
        kept: rankings.length,
        dropped: [],
        explicitRejection: rankings.length === 0,
      },
    }
  }

  const memoryCached = rankCache.get(fingerprint)
  if (memoryCached) {
    const rankings = reconstructCached(memoryCached, shortlist)
    if (rankings !== null) return finishCached(rankings, memoryCached, "memory")
    rankCache.delete(fingerprint)
  }
  const sessionCached = readSessionCache(fingerprint, shortlist)
  if (sessionCached) {
    rankCache.set(fingerprint, sessionCached.entry)
    return finishCached(sessionCached.rankings, sessionCached.entry, "session")
  }

  // Same question within 60s: never send a second paid request.
  // (Home skips this guard — see RerankRequest.skipRepeatGuard.)
  if (!request.skipRepeatGuard && wasRecentlySent(query)) {
    const limited: AiRankStatus = {
      ...status,
      phase: "error",
      durationMs: Date.now() - startedAt,
      errorKind: "rate_limited",
      fallbackReason: "That question was just asked — showing local recommendations.",
    }
    emitAiRankStatus(limited)
    throw new AiError(
      "rate_limited",
      "That question was just asked — showing local recommendations."
    )
  }

  currentRankController?.abort()
  const controller = new AbortController()
  currentRankController = controller
  try {
    const { system, user } = buildAiPrompt(query, shortlist, effectiveTaste, request.constraints)
    emitAiActivity({ type: "start", at: Date.now(), query })
    emitAiRankStatus({ ...status, phase: "sending" })
    if (!request.skipRepeatGuard) markSent(query)
    const chat = request.chat ?? chatCompletions
    const result = await chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal: controller.signal,
    })
    emitAiRankStatus({
      ...status,
      phase: "response-received",
      model: result.model || identity.model,
    })
    const parsed = parseAiRankResponse(result.text, shortlist)
    const { rankings, report } = validateAiRankings(
      parsed.rankings,
      shortlist,
      request.constraints,
      query,
      parsed.intent
    )
    const entry: RankCacheEntry = {
      key: fingerprint,
      model: result.model || identity.model,
      endpoint: identity.endpoint,
      cachedAt: Date.now(),
      rankings: rankings.map((r) => ({
        id: compositeCandidateId(r.candidate),
        score: r.score,
        reason: r.reason,
      })),
    }
    rankCache.set(fingerprint, entry)
    writeSessionCache(entry)
    const terminal: AiRankStatus = {
      ...status,
      phase: report.kept > 0 ? "validated" : "rejected",
      model: result.model || identity.model,
      durationMs: Date.now() - startedAt,
      returnedCount: report.returned,
      keptCount: report.kept,
      droppedCount: report.dropped.length,
      droppedReasons: report.dropped.length ? report.dropped : undefined,
      fallbackReason:
        report.kept > 0
          ? undefined
          : report.explicitRejection
            ? "AI found nothing in your library that fits this search, so these are local picks."
            : "AI's picks didn't fit this search, so these are local picks.",
    }
    emitAiRankStatus(terminal)
    emitAiActivity({ type: "done", at: Date.now(), query })
    return { rankings, source: "ai", status: terminal, validation: report }
  } catch (error) {
    const kind = (error as { kind?: string })?.kind
    // A superseded request is not a failure of the current search: the
    // replacement request owns the UI, so an abort emits no status.
    // Every other failure is a terminal "error" status.
    if (kind !== "aborted") {
      const failed: AiRankStatus = {
        ...status,
        phase: "error",
        durationMs: Date.now() - startedAt,
        errorKind: kind ?? "unavailable",
      }
      emitAiRankStatus(failed)
    }
    emitAiActivity({ type: "error", at: Date.now(), query })
    throw error
  } finally {
    if (currentRankController === controller) currentRankController = null
  }
}

export const aiRanker = {
  /**
   * Legacy seam (discover.ts `AIRanker`): rank a relevance-ranked
   * shortlist for one query. Callers MUST pass W1's shortlist — the
   * token ceiling keeps the head of the given order, so passing raw
   * catalogue order here would reintroduce the first-20 bug at the
   * call site. Prefer `rankShortlist` for the full result + status.
   */
  async rank(
    query: string,
    candidates: DiscoverCandidate[],
    tasteSummary: TasteSummary,
    opts: RankOptions = {}
  ): Promise<RankedCandidate[]> {
    const result = await runRerank({
      query,
      shortlist: candidates,
      tasteSummary,
      constraints: opts.constraints,
      context: opts.context,
    })
    return result.rankings
  },

  /**
   * Primary entry: rerank W1's relevance-ranked shortlist under the
   * structured constraints, with post-ranking validation, full-identity
   * caching and a typed lifecycle status for W3's UI.
   */
  async rankShortlist(request: RerankRequest): Promise<RerankResult> {
    return runRerank(request)
  },
}
