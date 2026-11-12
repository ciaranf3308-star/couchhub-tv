// AI Discovery orchestration (AI Discovery 3.0, 0.11.6) — the ONE
// orchestration layer for the AI-first flow:
//
//   runAiDiscovery:  generate (generation.ts, LLM's own knowledge)
//                 -> verify (verification.ts, W2: TMDB + catalogue)
//                 -> presentation data (VerifiedRecommendation[])
//
// The reranker (ranking.ts / rankDiscover) STAYS as a secondary tool
// for available-library refinement; it does not define this flow and
// this module never routes through it or through the 20-candidate
// shortlist contract.
//
// Invocation rule (cost + privacy): runAiDiscovery is called ONLY from
// an explicit user action — Ask AI, search submit (with automatic
// requests on), or a refinement. Never from background work, scroll,
// focus, or Home load. The orchestrator itself makes no model call
// except inside runAiDiscovery.
//
// Cache: identical requests (normalised query + conversation-context
// hash + profile + model + endpoint + taste-summary hash + pipeline
// version + catalogue fingerprint) return the stored result with ZERO
// model calls and a "cached" receipt. A refinement is a new turn, so
// it is a new key and a fresh request. The Available-in-My-Library
// toggle is a VIEW filter owned by the UI: `availableOnly` is accepted
// on the request for API stability but is deliberately NOT a cache
// dimension and never filters `results` — all verified recommendations
// are always returned.
//
// Failure behaviour (honest, never disguised):
// - generation failure -> phase "unavailable", empty results, an
//   honest message in the receipt's fallbackReason. A local fallback
//   is offered separately by the UI, never labelled as AI results.
// - TMDB failure -> handled inside verification: results come back
//   verified=false with a verificationNote, never claimed verified.
//   A wholesale verifier throw is converted here into unverified
//   results with an honest note (same contract).
// - catalogue absent -> verification proceeds with availability
//   unknown; the UI must pass the real catalogue (see below).
// - cancellation (AbortSignal) -> rethrown, never converted into an
//   "unavailable" result and never cached.
//
// Catalogue source: the orchestrator never loads the catalogue itself
// — it has no playlist context. The caller passes the SAME candidates
// DiscoverView already loads via loadDiscoverData() (discover.ts),
// i.e. data.candidates. When deps.catalogue is absent, matching is
// unknown, not "not in library".

import { chatCompletions, AiError } from "./client.js"
import { getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import {
  generateRecommendations,
  conversationContextFor,
  constraintsForConversation,
  gateTasteSummary,
  clampCount,
  type AiChatTransport,
  type ConversationState,
  type GeneratedRecommendation,
} from "./generation.js"
import {
  verifyRecommendations,
  defaultTmdbSearch,
  type TmdbSearchFn,
  type VerifiedRecommendation,
} from "./verification.js"
import type {
  AiSearchDiagnostics,
  AiSearchPhase,
  AiSearchReceipt,
} from "./status.js"
import type { DiscoverCandidate } from "../discover.js"

/** Bump when the prompt, verification, matching or cache identity changes. */
export const DISCOVERY_PIPELINE_VERSION = 1

export const DISCOVERY_DEFAULT_COUNT = 10

export interface DiscoveryRunRequest {
  query: string
  conversation: ConversationState
  tasteSummary?: string | null
  /**
   * View filter owned by the UI. The orchestrator always returns ALL
   * verified recommendations and never filters on this flag; it is
   * not a cache dimension either.
   */
  availableOnly: boolean
  count?: number
  signal?: AbortSignal
}

export interface DiscoveryRunResult {
  results: VerifiedRecommendation[]
  receipt: AiSearchReceipt
  diagnostics: AiSearchDiagnostics
  conversation: ConversationState
}

export interface DiscoveryRunDeps {
  chat?: AiChatTransport
  searchTmdb?: TmdbSearchFn
  catalogue?: DiscoverCandidate[]
  profileId?: string
  tasteRevision?: string
}

// ---------------------------------------------------------------------------
// Phase observation (mirrors ranking.ts subscribeAiRankStatus: the UI
// subscribes to show "Asking AI…" / "Verifying…" honestly, from real
// transitions — never invented phases)
// ---------------------------------------------------------------------------

export type DiscoveryPhaseListener = (phase: AiSearchPhase) => void

const phaseListeners = new Set<DiscoveryPhaseListener>()
let lastDiscoveryPhase: AiSearchPhase | null = null

export function subscribeAiDiscoveryPhase(listener: DiscoveryPhaseListener): () => void {
  phaseListeners.add(listener)
  if (lastDiscoveryPhase) {
    try {
      listener(lastDiscoveryPhase)
    } catch {
      // A UI listener must never break discovery.
    }
  }
  return () => {
    phaseListeners.delete(listener)
  }
}

export function getLastAiDiscoveryPhase(): AiSearchPhase | null {
  return lastDiscoveryPhase
}

function emitDiscoveryPhase(phase: AiSearchPhase): void {
  lastDiscoveryPhase = phase
  for (const listener of [...phaseListeners]) {
    try {
      listener(phase)
    } catch {
      // A UI listener must never break discovery.
    }
  }
}

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash, hex. Deterministic; no crypto needed for a key. */
function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

/** Provider identity for the cache key, each getter guarded (ranking.ts pattern). */
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

/**
 * Catalogue fingerprint (additive safety beyond the frozen key list):
 * a changed playlist must never reuse matches computed against the old
 * one. Sorted composite ids, hashed — O(n log n) once per explicit
 * run. Empty when no catalogue was supplied (availability unknown).
 */
function catalogueFingerprint(catalogue: DiscoverCandidate[] | undefined): string {
  if (!catalogue) return ""
  const ids = catalogue.map((c) => `${c.kind}:${c.id}`).sort()
  return `${catalogue.length}:${hashString(ids.join(","))}`
}

interface DiscoveryCacheEntry {
  results: VerifiedRecommendation[]
  model: string
  generatedCount: number
  verifiedCount: number
  matchedCount: number
  verificationFailures: number
  catalogueSize?: number
  queryType: AiSearchDiagnostics["queryType"]
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>()

export function clearAiDiscoveryCache(): void {
  discoveryCache.clear()
}

function buildCacheKey(input: {
  query: string
  contextLines: string[]
  effectiveTaste: string | null
  profileId?: string
  tasteRevision?: string
  endpoint: string
  model: string
  catalogue?: DiscoverCandidate[]
  count: number
}): string {
  return JSON.stringify({
    v: DISCOVERY_PIPELINE_VERSION,
    q: normalizeQuery(input.query),
    ctx: hashString(input.contextLines.join("\n")),
    profileId: input.profileId ?? "",
    tasteRevision: input.tasteRevision ?? "",
    model: input.model,
    endpoint: input.endpoint,
    taste: hashString(input.effectiveTaste ?? ""),
    catalogue: catalogueFingerprint(input.catalogue),
    count: input.count,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function queryTypeFor(query: string): AiSearchDiagnostics["queryType"] {
  const trimmed = query.trim()
  if (!trimmed) return "none"
  // Mirrors isNaturalLanguageQuery's word-count rule (discover.ts):
  // a multi-word request reads as natural language, a short one as a
  // keyword/title search. Display only — never sent anywhere.
  return trimmed.split(/\s+/).length > 3 || trimmed.includes("?") ? "natural-language" : "keyword"
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const kind = (error as { kind?: string })?.kind
  if (kind === "aborted") return true
  const name = (error as Error)?.name || ""
  return name === "AbortError" || name === "TimeoutError"
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AiError("aborted", "The AI request was cancelled.")
  }
}

/** Honest user-facing message for a generation failure. No secrets, ever. */
function generationFailureMessage(error: unknown): string {
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
    case "unavailable":
    default:
      return "AI couldn't answer just now, so no recommendations were generated."
  }
}

function providerErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ""
  // AiError messages are already safe (client.ts never includes bodies
  // or keys). Anything else gets the generic fallback — never echo an
  // unknown error's text into diagnostics the UI might display.
  return error instanceof AiError && message ? message : fallback
}

/** Wholesale verifier failure -> every result unverified, honestly noted. */
function unverifiedFromGenerated(
  recs: GeneratedRecommendation[],
  note: string
): VerifiedRecommendation[] {
  return recs.map((generated) => ({
    generated,
    verified: false,
    tmdbId: null,
    title: generated.title,
    year: generated.year,
    kind: generated.kind,
    reason: generated.reason,
    tone: generated.tone,
    genres: [],
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    match: null,
    verificationNote: note,
  }))
}

function countVerified(results: VerifiedRecommendation[]): {
  verifiedCount: number
  matchedCount: number
} {
  return {
    verifiedCount: results.filter((r) => r.verified).length,
    matchedCount: results.filter((r) => r.match !== null).length,
  }
}

function appendTurn(
  conversation: ConversationState,
  query: string,
  results: VerifiedRecommendation[]
): ConversationState {
  return {
    turns: [
      ...(conversation?.turns ?? []),
      { query, generatedTitles: results.map((r) => r.title).filter(Boolean) },
    ],
  }
}

// ---------------------------------------------------------------------------
// The orchestration layer
// ---------------------------------------------------------------------------

export async function runAiDiscovery(
  request: DiscoveryRunRequest,
  deps: DiscoveryRunDeps = {}
): Promise<DiscoveryRunResult> {
  const startedAt = Date.now()
  const query = (request.query ?? "").trim()
  const conversation = request.conversation ?? { turns: [] }
  const count = clampCount(request.count ?? DISCOVERY_DEFAULT_COUNT)
  const queryType = queryTypeFor(query)

  const unavailable = (message: string, providerError?: string): DiscoveryRunResult => {
    emitDiscoveryPhase("unavailable")
    const diagnostics: AiSearchDiagnostics = {
      queryType,
      catalogueSize: deps.catalogue?.length,
      acceptedCount: 0,
      rejectedCount: 0,
      sentToModelCount: 0,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      fallbackReason: message,
      generatedCount: 0,
      verifiedCount: 0,
      matchedCount: 0,
      verificationFailures: 0,
      providerError,
    }
    return {
      results: [],
      receipt: {
        phase: "unavailable",
        engine: "ai",
        query,
        durationMs: Date.now() - startedAt,
        cacheHit: false,
        fallbackReason: message,
        diagnostics,
      },
      diagnostics,
      // No turn recorded: nothing was suggested, so a retry is not a
      // refinement and must not inherit exclusions from a failed run.
      conversation,
    }
  }

  // An empty query is nothing to ask the model — answer honestly
  // without spending a request.
  if (!query) {
    return unavailable("Type a question first, then ask AI.")
  }

  throwIfAborted(request.signal)

  const contextLines = conversationContextFor(conversation)
  const effectiveTaste = gateTasteSummary(request.tasteSummary)
  const identity = readProviderIdentity()
  const cacheKey = buildCacheKey({
    query,
    contextLines,
    effectiveTaste,
    profileId: deps.profileId,
    tasteRevision: deps.tasteRevision,
    endpoint: identity.endpoint,
    model: identity.model,
    catalogue: deps.catalogue,
    count,
  })

  const cached = discoveryCache.get(cacheKey)
  if (cached) {
    emitDiscoveryPhase("cached")
    const durationMs = Date.now() - startedAt
    const diagnostics: AiSearchDiagnostics = {
      queryType: cached.queryType,
      catalogueSize: cached.catalogueSize,
      acceptedCount: cached.results.length,
      rejectedCount: 0,
      sentToModelCount: 0,
      model: cached.model,
      cacheHit: true,
      durationMs,
      generatedCount: cached.generatedCount,
      verifiedCount: cached.verifiedCount,
      matchedCount: cached.matchedCount,
      verificationFailures: cached.verificationFailures,
    }
    return {
      results: [...cached.results],
      receipt: {
        phase: "cached",
        engine: "cached-ai",
        query,
        model: cached.model,
        answeredAt: null,
        durationMs,
        cacheHit: true,
        diagnostics,
      },
      diagnostics,
      conversation: appendTurn(conversation, query, cached.results),
    }
  }

  // --- Phase 1: ask the model to generate from its own knowledge. ---
  emitDiscoveryPhase("asking-ai")
  let generated: GeneratedRecommendation[]
  let model: string
  try {
    const constraints = constraintsForConversation(conversation, query)
    const generation = await generateRecommendations(
      {
        query,
        conversationContext: contextLines,
        tasteSummary: request.tasteSummary,
        constraints,
        count,
        signal: request.signal,
      },
      { chat: deps.chat ?? chatCompletions }
    )
    generated = generation.recommendations
    model = generation.model
    if (!generated.length) {
      // The model answered but nothing parsed: a generation failure,
      // not an empty recommendation set to display.
      return unavailable(
        "The AI reply contained no usable recommendations. Try asking again.",
        generation.providerError ?? "The AI reply contained no usable recommendations."
      )
    }
  } catch (error) {
    if (isAbortLike(error, request.signal)) throw error
    return unavailable(
      generationFailureMessage(error),
      providerErrorText(error, "The AI provider could not be reached.")
    )
  }

  throwIfAborted(request.signal)

  // --- Phase 2+3: TMDB verification + library matching (W2). --------
  // W2's verifier performs both in one call, so the two phases are
  // reported back-to-back: "verifying-tmdb" before the call (the work
  // genuinely starts there) and "checking-library" on its return (the
  // catalogue matching genuinely happened inside the call).
  emitDiscoveryPhase("verifying-tmdb")
  let results: VerifiedRecommendation[]
  try {
    results = await verifyRecommendations(generated, {
      searchTmdb: deps.searchTmdb ?? defaultTmdbSearch,
      catalogue: deps.catalogue,
    })
  } catch (error) {
    if (isAbortLike(error, request.signal)) throw error
    results = unverifiedFromGenerated(
      generated,
      "TMDB verification failed, so these titles are unverified."
    )
  }
  emitDiscoveryPhase("checking-library")

  throwIfAborted(request.signal)

  const { verifiedCount, matchedCount } = countVerified(results)
  const verificationFailures = generated.length - verifiedCount
  const durationMs = Date.now() - startedAt
  const diagnostics: AiSearchDiagnostics = {
    queryType,
    catalogueSize: deps.catalogue?.length,
    acceptedCount: results.length,
    rejectedCount: 0,
    // Generation sends no candidate list to the model, by design:
    // 0 is the honest count, and it proves the answer space was the
    // model's own knowledge, not a catalogue shortlist.
    sentToModelCount: 0,
    model,
    cacheHit: false,
    durationMs,
    generatedCount: generated.length,
    verifiedCount,
    matchedCount,
    verificationFailures,
  }

  discoveryCache.set(cacheKey, {
    results: [...results],
    model,
    generatedCount: generated.length,
    verifiedCount,
    matchedCount,
    verificationFailures,
    catalogueSize: deps.catalogue?.length,
    queryType,
  })

  emitDiscoveryPhase("ready")
  return {
    results,
    receipt: {
      phase: "ready",
      engine: "ai",
      query,
      model,
      answeredAt: Date.now(),
      durationMs,
      cacheHit: false,
      diagnostics,
    },
    diagnostics,
    conversation: appendTurn(conversation, query, results),
  }
}
