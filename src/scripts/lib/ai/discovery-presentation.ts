// Discover presentation helpers (0.11.6, W3) — REAL code, not a shim.
//
// Pure helpers for the AI-first Discover UI: client-side availability
// filtering, refinement context, detail-href derivation from a
// recommendation match, taste-summary formatting, and the honest
// status / error copy. Everything here is pure and runs under vitest
// with no browser globals, so the UI's behaviour is testable without
// mounting Svelte.
//
// Honesty rules baked in:
// - The "Available in My Library" toggle is a client-side filter over
//   results already returned. Filtering never calls the model, never
//   substitutes titles, and never fills empty slots.
// - An unverified recommendation never gains a detail link or artwork
//   from anywhere: without a catalogue match there is no href, and
//   without verification there is no claim the metadata is real.
// - Taste is only ever formatted when the caller has already checked
//   the share-taste preference (default OFF); this module formats, it
//   never decides to share.

import type { TasteSummaryShape } from "../taste.ts"
import type { ConversationState } from "./generation.ts"
import type {
  DiscoveryProgressPhase,
  VerifiedRecommendation,
} from "./discovery-orchestrator.ts"

// ---------------------------------------------------------------------------
// Availability filtering (client-side only — never a new model call)
// ---------------------------------------------------------------------------

/**
 * The recommendations to show for the current toggle state. OFF shows
 * every verified recommendation; ON shows only confidently matched,
 * playable entries. The input order is preserved and nothing is ever
 * substituted or padded: if only two are available, two are shown.
 */
export function visibleRecommendations(
  results: VerifiedRecommendation[],
  availableOnly: boolean
): VerifiedRecommendation[] {
  if (!availableOnly) return [...results]
  return results.filter((rec) => rec.verified && rec.match != null)
}

/** How many recommendations are verified AND matched (playable). */
export function countMatched(results: VerifiedRecommendation[]): number {
  return results.reduce((n, rec) => (rec.verified && rec.match ? n + 1 : n), 0)
}

// ---------------------------------------------------------------------------
// Detail / play flow: reuse the app's real detail routes, via the match.
// ---------------------------------------------------------------------------

/**
 * Detail href for a recommendation, derived ONLY from its catalogue
 * match (`kind:id`) AND only when TMDB verified the identity. Returns
 * null when there is no match, when verification failed, or when the
 * match key is malformed — an unavailable or unverified title must
 * never link anywhere, and a malformed key must never produce a
 * guessed route. The detail page is where playback starts (the
 * existing flow).
 */
export function recommendationDetailHref(
  rec: VerifiedRecommendation
): string | null {
  if (!rec.verified) return null
  const key = rec.match?.catalogueKey
  if (!key) return null
  const colon = key.indexOf(":")
  if (colon <= 0 || colon === key.length - 1) return null
  const kind = key.slice(0, colon)
  const id = key.slice(colon + 1)
  if (kind === "movie") return `/movies/detail?id=${encodeURIComponent(id)}`
  if (kind === "series") return `/series/detail?id=${encodeURIComponent(id)}`
  return null
}

// ---------------------------------------------------------------------------
// Refinement context
// ---------------------------------------------------------------------------

/**
 * True when a submit should be treated as a refinement of the results
 * on screen: a conversation already exists AND AI results are showing
 * AND the user typed something. Anything else is a fresh question
 * (or a local search), never a silent refinement.
 */
export function isRefinementSubmit(
  conversation: ConversationState,
  hasAiResults: boolean,
  query: string
): boolean {
  return (
    hasAiResults && conversation.turns.length > 0 && query.trim().length > 0
  )
}

/**
 * The subtle context line shown while refining: the ORIGINAL question
 * ("Refining: “dark anime”"), never a chat transcript. Empty when
 * there is no conversation to refine.
 */
export function refinementContextLabel(
  conversation: ConversationState
): string {
  const first = conversation.turns[0]?.query?.trim()
  if (!first) return ""
  return `Refining: “${first}”`
}

// ---------------------------------------------------------------------------
// In-flight + completion status copy
// ---------------------------------------------------------------------------

export const AI_DISCOVERY_PROGRESS_LABELS: Record<
  DiscoveryProgressPhase,
  string
> = {
  asking: "Asking AI for recommendations",
  verifying: "Verifying titles with TMDB",
  checking: "Checking your library",
}

/** In-flight status line, with an ellipsis while work is in progress. */
export function aiDiscoveryProgressText(
  phase: DiscoveryProgressPhase
): string {
  return `${AI_DISCOVERY_PROGRESS_LABELS[phase]}…`
}

// ---------------------------------------------------------------------------
// Taste summary (sent only when the user opted in to sharing taste)
// ---------------------------------------------------------------------------

/**
 * Format a taste summary as the single string the orchestrator takes.
 * Returns null when there is nothing to say — an empty taste model
 * must not produce an empty or invented summary. Only real signals
 * are named: favourite genres, liked titles, disliked titles, an
 * observed runtime preference and pace. Never more than the model
 * actually recorded.
 */
export function formatTasteSummaryForAi(
  summary: TasteSummaryShape | null | undefined
): string | null {
  if (!summary) return null
  const parts: string[] = []
  const genres = (summary.favouriteGenres ?? []).filter(Boolean)
  if (genres.length) parts.push(`Favourite genres: ${genres.join(", ")}`)
  const liked = (summary.likedTitles ?? []).filter(Boolean)
  if (liked.length) parts.push(`Liked: ${liked.join(", ")}`)
  const disliked = (summary.dislikedTitles ?? []).filter(Boolean)
  if (disliked.length) parts.push(`Disliked: ${disliked.join(", ")}`)
  if (summary.preferredRuntimeMax) {
    parts.push(`Prefers films under ${summary.preferredRuntimeMax} minutes`)
  }
  if (summary.pace) parts.push(`Pace: ${summary.pace}`)
  if (!parts.length) return null
  return parts.join(". ") + "."
}

// ---------------------------------------------------------------------------
// Provider errors: short, plain, secret-free
// ---------------------------------------------------------------------------

/**
 * Plain-language message for a provider failure. Only recognised short
 * codes are mapped; anything else (including raw error text, which
 * could echo request details) falls back to the generic message —
 * never surfaced verbatim in the panel. The diagnostics panel may
 * carry the code itself; it never carries request bodies or keys.
 */
export function providerErrorMessage(providerError?: string | null): string {
  switch ((providerError ?? "").trim().toLowerCase()) {
    case "rate_limited":
    case "rate-limited":
      return "The provider is rate-limiting requests. Wait a little and try again."
    case "timeout":
      return "The provider took too long to answer. Check your connection and try again."
    case "invalid_key":
    case "invalid-key":
      return "The provider rejected the API key. Check the key in Settings and try again."
    case "invalid_model":
    case "invalid-model":
      return "That model isn't available on this provider. Pick a model the provider offers."
    case "invalid_endpoint":
    case "invalid-endpoint":
      return "The provider endpoint doesn't look right. Check the endpoint URL in Settings."
    case "unavailable":
    default:
      return "The AI provider couldn't be reached. Check your connection and try again."
  }
}

/**
 * Best-effort code for a thrown orchestrator error: a `providerError`
 * property wins; otherwise a few known phrases map to codes; anything
 * else is "unavailable". The raw message is never returned — it may
 * contain request or endpoint detail that must not reach the UI.
 */
export function providerErrorCodeFor(error: unknown): string {
  const code = (error as { providerError?: unknown } | null)?.providerError
  if (typeof code === "string" && code.trim()) return code.trim()
  const text = String((error as Error)?.message ?? error ?? "").toLowerCase()
  if (text.includes("rate limit")) return "rate_limited"
  if (text.includes("timed out") || text.includes("timeout")) return "timeout"
  if (text.includes("invalid") && text.includes("key")) return "invalid_key"
  if (text.includes("invalid") && text.includes("model")) return "invalid_model"
  if (text.includes("invalid") && text.includes("endpoint")) return "invalid_endpoint"
  return "unavailable"
}
