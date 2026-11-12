// STUB — 0.11.6 W5: deleted at integration, replaced by the real implementation.
//
// Minimal, behaviourally transparent stand-in for W1's generation service,
// written ONLY so the 0.11.6 acceptance tests (tests/ai-discovery-3.0.test.ts)
// compile and their LOGIC is verified in the W5 worktree. It calls through
// to the injected chat transport and applies only the frozen contract's
// stated semantics in the most literal way possible: prompt assembly from
// the request fields, JSON parsing of the reply, per-item validation, and
// conversation-context rendering. No retrieval, no catalogue access, no
// caching (caching lives in the orchestrator stub), no cleverness.
//
// Frozen-contract assumptions this stub pins (see the W5 report — if W1
// chooses differently, the tests adapt at integration, not silently):
//   - tasteSummary is a pre-rendered string.
//   - The model wire format is a JSON array of recommendation objects,
//     or a {"recommendations": [...]} envelope. Both are accepted.
//   - Unparsable JSON does NOT throw: it returns providerError with no
//     recommendations, as does a reply whose items are ALL invalid.
//     Transport failures DO throw (the orchestrator turns them into an
//     honest receipt).
//   - Invalid items are dropped; an invalid year coerces to null
//     (TMDB corrects years — a bad year never drops a title here).
//   - With no injected chat transport, generateRecommendations throws:
//     wiring the real default transport is W1's job. Tests always inject.

import type { AiChatOptions, AiChatResult } from "./client.ts"

export interface GeneratedRecommendation {
  title: string
  year: number | null
  kind: "movie" | "series"
  reason: string
  tone: string
  externalId?: string
}

export interface GenerationConstraints {
  kind?: "movie" | "series"
  yearMin?: number
  yearMax?: number
  maxRuntimeMinutes?: number
  excludeTitles?: string[]
}

export interface GenerationRequest {
  query: string
  conversationContext?: string[]
  tasteSummary?: string
  constraints?: GenerationConstraints
  count: number
  signal?: AbortSignal
}

export interface GenerationResult {
  recommendations: GeneratedRecommendation[]
  model: string
  durationMs: number
  cached: boolean
  providerError?: string
}

export type AiChatTransport = (options: AiChatOptions) => Promise<AiChatResult>

export interface ConversationTurn {
  query: string
  generatedTitles: string[]
}

export interface ConversationState {
  turns: ConversationTurn[]
}

export function newConversation(): ConversationState {
  return { turns: [] }
}

/** One context line per past turn: the request plus the titles it produced. */
export function conversationContextFor(state: ConversationState): string[] {
  return (state?.turns ?? []).map((turn, index) => {
    const titles =
      turn.generatedTitles.length > 0
        ? turn.generatedTitles.join(", ")
        : "no suggestions"
    return `Previous request ${index + 1}: "${turn.query}" — suggested: ${titles}`
  })
}

function constraintLines(constraints: GenerationConstraints | undefined): string[] {
  if (!constraints) return []
  const lines: string[] = []
  if (constraints.kind) lines.push(`kind: ${constraints.kind}`)
  if (typeof constraints.yearMin === "number") lines.push(`year >= ${constraints.yearMin}`)
  if (typeof constraints.yearMax === "number") lines.push(`year <= ${constraints.yearMax}`)
  if (typeof constraints.maxRuntimeMinutes === "number") {
    lines.push(`runtime <= ${constraints.maxRuntimeMinutes} minutes`)
  }
  if (constraints.excludeTitles?.length) {
    lines.push(`exclude: ${constraints.excludeTitles.join(", ")}`)
  }
  return lines
}

function buildMessages(request: GenerationRequest): AiChatOptions["messages"] {
  const systemLines = [
    "You recommend films and series from your own knowledge.",
    `Return up to ${request.count} recommendations as a JSON array.`,
    "Each item has title, year (number or null), kind (movie or series), reason, and tone.",
  ]
  const constraints = constraintLines(request.constraints)
  if (constraints.length) {
    systemLines.push(`Constraints: ${constraints.join("; ")}`)
  }
  const userLines = [`Request: ${request.query}`]
  if (request.conversationContext?.length) {
    userLines.push("Conversation so far:")
    userLines.push(...request.conversationContext)
  }
  if (request.tasteSummary) {
    userLines.push(`Taste summary: ${request.tasteSummary}`)
  }
  return [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n") },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cleanYear(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const year = Math.trunc(value)
  return year >= 1900 && year <= 2100 ? year : null
}

function cleanRecommendation(value: unknown): GeneratedRecommendation | null {
  if (!isRecord(value)) return null
  const title = typeof value.title === "string" ? value.title.trim() : ""
  if (!title) return null
  const kind = value.kind
  if (kind !== "movie" && kind !== "series") return null
  const rec: GeneratedRecommendation = {
    title,
    year: cleanYear(value.year),
    kind,
    reason: typeof value.reason === "string" ? value.reason : "",
    tone: typeof value.tone === "string" ? value.tone : "",
  }
  if (typeof value.externalId === "string" && value.externalId.trim()) {
    rec.externalId = value.externalId
  }
  return rec
}

function parseRecommendations(text: string): { valid: GeneratedRecommendation[]; total: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : null
  if (items == null) return null
  const valid: GeneratedRecommendation[] = []
  for (const item of items) {
    const cleaned = cleanRecommendation(item)
    if (cleaned) valid.push(cleaned)
  }
  return { valid, total: items.length }
}

export async function generateRecommendations(
  request: GenerationRequest,
  deps: { chat?: AiChatTransport } = {},
): Promise<GenerationResult> {
  const chat = deps.chat
  if (!chat) {
    throw new Error("generateRecommendations: no chat transport injected (stub has no default).")
  }
  const startedAt = Date.now()
  const result = await chat({
    messages: buildMessages(request),
    signal: request.signal,
  })
  const durationMs = Date.now() - startedAt
  const parsed = parseRecommendations(result.text)
  if (parsed == null) {
    return {
      recommendations: [],
      model: result.model,
      durationMs,
      cached: false,
      providerError: "The AI provider returned a reply that could not be read as recommendations.",
    }
  }
  if (parsed.total > 0 && parsed.valid.length === 0) {
    return {
      recommendations: [],
      model: result.model,
      durationMs,
      cached: false,
      providerError: "The AI provider returned no usable recommendations.",
    }
  }
  const recommendations = request.count > 0 ? parsed.valid.slice(0, request.count) : parsed.valid
  return { recommendations, model: result.model, durationMs, cached: false }
}
