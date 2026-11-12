// STUB — 0.11.6 W5: deleted at integration, replaced by the real implementation.
//
// Minimal, behaviourally transparent stand-in for W1's discovery
// orchestrator, written ONLY so the 0.11.6 acceptance tests
// (tests/ai-discovery-3.0.test.ts) compile and their LOGIC is verified in
// the W5 worktree. It composes the generation + verification stubs through
// the frozen seams and applies only the contract's stated semantics in the
// most literal way possible: one generation call, TMDB verification,
// catalogue matching, conversation bookkeeping, receipt/diagnostics, and
// an identity-keyed cache.
//
// Rules this stub pins (see the W5 report — if W1 chooses differently,
// the tests adapt at integration, not silently):
//   - Cache identity is (query, conversation context, tasteSummary,
//     count, profileId, tasteRevision). availableOnly is NOT a cache
//     dimension: the full verified list is cached and the toggle filters
//     at return time, so toggling it never spends a model call.
//   - The cache is module-level and in-memory in this stub. Tests
//     isolate searches with a distinct profileId per test; the same
//     identity twice is a hit by design (Test K pins this).
//   - A cache hit returns the cached post-turn conversation unchanged
//     (the turn is already recorded) and a "cached" receipt.
//   - Generation failure (transport throw) or an unparsable reply
//     resolves — never throws — with zero results, the input
//     conversation unchanged, and a "fallback" receipt whose
//     fallbackReason names the failure. No invented data, no partial
//     silent success.
//   - TMDB / catalogue failures never fail the search: per-title TMDB
//     failures surface as unverified items (verification stub), and a
//     catalogue failure degrades to an empty catalogue (every result
//     honestly unavailable).
//   - The catalogue dep accepts an array OR a loader function returning
//     an array (sync or async). The frozen contract leaves the dep type
//     implicit; the loader form exists so the catalogue-failure case is
//     testable at this seam. Absent catalogue means empty catalogue.
//   - The conversation turn is appended to a NEW state object (the input
//     is never mutated) with the generated titles in generation order.
//   - Default count is 10. Receipt phases use the existing
//     AiSearchPhase vocabulary: "validated" for a completed search,
//     "cached" for a hit, "fallback" for a failed generation. Diagnostics
//     leave retrieval fields unset (3.0 has no retrieval stage — an
//     unset field honestly means "not reported").

import {
  conversationContextFor,
  generateRecommendations,
  type AiChatTransport,
  type ConversationState,
  type GenerationResult,
} from "./generation.ts"
import {
  verifyRecommendations,
  type TmdbDetailsFn,
  type TmdbSearchFn,
  type VerifiedRecommendation,
} from "./verification.ts"
import type { DiscoverCandidate } from "@/scripts/lib/discover.ts"
import type {
  AiSearchDiagnostics,
  AiSearchReceipt,
} from "./status.ts"

export interface AiDiscoveryRequest {
  query: string
  conversation: ConversationState
  tasteSummary?: string
  availableOnly: boolean
  count?: number
  signal?: AbortSignal
}

export type CatalogueSource =
  | DiscoverCandidate[]
  | (() => DiscoverCandidate[] | Promise<DiscoverCandidate[]>)

export interface AiDiscoveryDeps {
  chat?: AiChatTransport
  searchTmdb?: TmdbSearchFn
  fetchDetails?: TmdbDetailsFn
  catalogue?: CatalogueSource
  profileId?: string
  tasteRevision?: string
}

export interface AiDiscoveryOutcome {
  results: VerifiedRecommendation[]
  receipt: AiSearchReceipt
  diagnostics: AiSearchDiagnostics
  conversation: ConversationState
}

const DEFAULT_COUNT = 10

interface CachedEntry {
  results: VerifiedRecommendation[]
  conversation: ConversationState
  model: string
  durationMs: number
}

const cache = new Map<string, CachedEntry>()

function cacheKey(
  request: AiDiscoveryRequest,
  count: number,
  deps: AiDiscoveryDeps,
): string {
  return JSON.stringify({
    v: 1,
    q: request.query,
    ctx: conversationContextFor(request.conversation),
    taste: request.tasteSummary ?? null,
    count,
    profile: deps.profileId ?? "",
    tasteRev: deps.tasteRevision ?? "",
  })
}

async function resolveCatalogue(source: CatalogueSource | undefined): Promise<DiscoverCandidate[]> {
  if (!source) return []
  if (Array.isArray(source)) return source
  return await source()
}

export async function runAiDiscovery(
  request: AiDiscoveryRequest,
  deps: AiDiscoveryDeps = {},
): Promise<AiDiscoveryOutcome> {
  const startedAt = Date.now()
  const count = request.count ?? DEFAULT_COUNT
  const key = cacheKey(request, count, deps)
  const hit = cache.get(key)
  if (hit) {
    const results = request.availableOnly
      ? hit.results.filter((result) => result.match != null)
      : [...hit.results]
    const diagnostics: AiSearchDiagnostics = {
      queryType: "natural-language",
      acceptedCount: results.length,
      model: hit.model,
      cacheHit: true,
      durationMs: hit.durationMs,
    }
    const receipt: AiSearchReceipt = {
      phase: "cached",
      engine: "cached-ai",
      query: request.query,
      model: hit.model,
      answeredAt: null,
      durationMs: hit.durationMs,
      cacheHit: true,
      diagnostics,
    }
    return { results, receipt, diagnostics, conversation: hit.conversation }
  }

  let catalogue: DiscoverCandidate[]
  try {
    catalogue = await resolveCatalogue(deps.catalogue)
  } catch {
    catalogue = []
  }

  const searchTmdb: TmdbSearchFn =
    deps.searchTmdb ?? (async () => [])

  let generated: GenerationResult
  try {
    generated = await generateRecommendations(
      {
        query: request.query,
        conversationContext: conversationContextFor(request.conversation),
        tasteSummary: request.tasteSummary,
        count,
        signal: request.signal,
      },
      { chat: deps.chat },
    )
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const reason =
      error instanceof Error ? error.message : "The AI provider could not be reached."
    const diagnostics: AiSearchDiagnostics = {
      queryType: "natural-language",
      catalogueSize: catalogue.length,
      acceptedCount: 0,
      durationMs,
      fallbackReason: reason,
    }
    const receipt: AiSearchReceipt = {
      phase: "fallback",
      engine: "local",
      query: request.query,
      durationMs,
      fallbackReason: reason,
      diagnostics,
    }
    return { results: [], receipt, diagnostics, conversation: request.conversation }
  }

  if (generated.providerError) {
    const durationMs = Date.now() - startedAt
    const diagnostics: AiSearchDiagnostics = {
      queryType: "natural-language",
      catalogueSize: catalogue.length,
      acceptedCount: 0,
      model: generated.model,
      durationMs,
      fallbackReason: generated.providerError,
    }
    const receipt: AiSearchReceipt = {
      phase: "fallback",
      engine: "local",
      query: request.query,
      model: generated.model,
      durationMs,
      fallbackReason: generated.providerError,
      diagnostics,
    }
    return { results: [], receipt, diagnostics, conversation: request.conversation }
  }

  const verified = await verifyRecommendations(generated.recommendations, {
    searchTmdb,
    catalogue,
    fetchDetails: deps.fetchDetails,
  })

  const conversation: ConversationState = {
    turns: [
      ...request.conversation.turns,
      {
        query: request.query,
        generatedTitles: generated.recommendations.map((rec) => rec.title),
      },
    ],
  }

  const durationMs = Date.now() - startedAt
  cache.set(key, {
    results: verified,
    conversation,
    model: generated.model,
    durationMs,
  })

  const results = request.availableOnly
    ? verified.filter((result) => result.match != null)
    : [...verified]
  const diagnostics: AiSearchDiagnostics = {
    queryType: "natural-language",
    catalogueSize: catalogue.length,
    acceptedCount: results.length,
    model: generated.model,
    cacheHit: false,
    durationMs,
  }
  const receipt: AiSearchReceipt = {
    phase: "validated",
    engine: "ai",
    query: request.query,
    model: generated.model,
    answeredAt: Date.now(),
    durationMs,
    cacheHit: false,
    diagnostics,
  }
  return { results, receipt, diagnostics, conversation }
}
