// AI-first recommendation generation (AI Discovery 3.0, 0.11.6).
//
// THE PRIMARY FLOW. The model generates genuine recommendations from its
// OWN knowledge of film and television. It is NEVER handed an IPTV
// candidate list as its answer space: this module takes no catalogue
// input at all, structurally, so the local catalogue engine cannot
// gatekeep what the model may recommend (the 0.11.5 failure — a local
// shortlist decided the answer before the model was consulted).
//
// Pipeline: generateRecommendations (here) -> verifyRecommendations
// (verification.ts, W2: TMDB identity check + catalogue matching) ->
// presentation. The LLM proposes, TMDB verifies, the catalogue
// determines what is playable. Nothing generated here is shown as
// verified until W2's verifier says so.
//
// Privacy: the model receives the user's own words, the conversation
// context, the taste summary ONLY when the sharing opt-in permits it
// (getAiShareTaste, the same gate ranking.ts applies — checked here
// even when the caller already passed a summary, defence in depth),
// and explicit constraints. It never receives IPTV credentials, stream
// URLs, provider URLs, poster URLs, or raw viewing history. Request /
// response bodies are NEVER logged.
//
// Output budget: AI_MAX_OUTPUT_TOKENS (800, client.ts) was sized for
// the reranker — ranked IDs plus one-line reasons. A generation reply
// carries ~8-10 structured recommendations, each with a title, year,
// kind, a specific reason (~25 words), a tone, and JSON overhead:
// roughly 140-170 output tokens per recommendation. 800 tokens would
// truncate the reply mid-list (and a truncated list parses as FEWER
// recommendations, silently). generationTokenBudget() scales with the
// requested count (160 tokens per item, floor 800, ceiling 2000), so
// the default 10 recommendations get 1600 tokens. Cost stays bounded
// because generation runs only on an explicit user action (Ask AI /
// submit / refine — the orchestrator never calls it otherwise) and
// the orchestrator caches identical requests, so a repeat costs zero
// model calls. Temperature stays at the client's fixed 0.2.

import { chatCompletions, type AiChatOptions, type AiChatResult } from "./client.js"
import { getAiShareTaste } from "./status.js"
import { parseIntent, type QueryIntent } from "@/scripts/lib/retrieval.ts"

export interface GeneratedRecommendation {
  title: string
  year: number | null
  kind: "movie" | "series"
  reason: string
  tone: string
  externalId?: { source: "tmdb" | "imdb" | "tvdb"; id: string } | null
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
  tasteSummary?: string | null
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

// ---------------------------------------------------------------------------
// Output budget (see header for the cost reasoning)
// ---------------------------------------------------------------------------

/** Default generation budget: 10 recommendations at ~160 tokens each. */
export const AI_GENERATION_MAX_OUTPUT_TOKENS = 1600
const GENERATION_TOKENS_PER_ITEM = 160
const GENERATION_TOKEN_FLOOR = 800
const GENERATION_TOKEN_CEILING = 2000

export function generationTokenBudget(count: number): number {
  const clamped = clampCount(count)
  return Math.min(
    GENERATION_TOKEN_CEILING,
    Math.max(GENERATION_TOKEN_FLOOR, clamped * GENERATION_TOKENS_PER_ITEM)
  )
}

// ---------------------------------------------------------------------------
// Count + text bounds
// ---------------------------------------------------------------------------

export const GENERATION_COUNT_MIN = 1
export const GENERATION_COUNT_MAX = 12
const MAX_QUERY_CHARS = 500
const MAX_CONTEXT_CHARS = 600
const MAX_TASTE_CHARS = 600
const MAX_TITLE_CHARS = 200
const MAX_REASON_CHARS = 200
const MAX_TONE_CHARS = 80
const MAX_EXCLUDE_TITLES = 30
const GENERIC_REASON = "Recommended for this search."

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 10
  return Math.min(GENERATION_COUNT_MAX, Math.max(GENERATION_COUNT_MIN, Math.floor(count)))
}

function cleanLine(value: string | undefined, maxChars: number): string {
  if (!value) return ""
  return value
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxChars)
}

// ---------------------------------------------------------------------------
// Taste gate (same setting ranking.ts checks: share taste, default OFF)
// ---------------------------------------------------------------------------

/**
 * The taste summary the model may actually see: the caller's summary
 * only when the user opted in to sharing taste with the AI provider.
 * Checked here, inside generation, so a caller that forgets the gate
 * cannot leak taste data — the same defence-in-depth ranking.ts uses.
 */
export function gateTasteSummary(tasteSummary: string | null | undefined): string | null {
  if (!tasteSummary || !tasteSummary.trim()) return null
  try {
    return getAiShareTaste() ? tasteSummary.trim().slice(0, MAX_TASTE_CHARS) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Prompt construction (exported for tests: the payload must stay clean)
// ---------------------------------------------------------------------------

function formatConstraints(constraints: GenerationConstraints | undefined): string[] {
  if (!constraints) return []
  const lines: string[] = []
  if (constraints.kind) {
    lines.push(`- Only ${constraints.kind === "movie" ? "films" : "series"}.`)
  }
  if (typeof constraints.yearMin === "number" || typeof constraints.yearMax === "number") {
    lines.push(
      `- Only titles released from ${constraints.yearMin ?? "any year"} to ${constraints.yearMax ?? "any year"}.`
    )
  }
  if (typeof constraints.maxRuntimeMinutes === "number" && constraints.maxRuntimeMinutes > 0) {
    lines.push(`- No film longer than ${constraints.maxRuntimeMinutes} minutes.`)
  }
  const excluded = (constraints.excludeTitles ?? []).filter(Boolean).slice(0, MAX_EXCLUDE_TITLES)
  if (excluded.length) {
    lines.push(`- Do NOT include any of these (already suggested or excluded): ${excluded.join(", ")}.`)
  }
  return lines
}

/**
 * Build the system + user messages for one generation request. The
 * model receives ONLY: the user's request, conversation context,
 * explicit constraints, and (when permitted) the taste summary. There
 * is deliberately no candidate-list parameter — generation must never
 * be handed a catalogue shortlist to choose from.
 */
export function buildGenerationPrompt(input: {
  query: string
  conversationContext?: string[]
  tasteSummary?: string | null
  constraints?: GenerationConstraints
  count: number
}): { system: string; user: string } {
  const count = clampCount(input.count)
  const system =
    "You recommend films and TV series for a TV discovery screen, from your own knowledge of film and television. " +
    "Reply with JSON only, no other text: " +
    '{"recommendations": [{"title": "", "year": 1997, "kind": "movie", "reason": "", "tone": "", "externalId": {"source": "tmdb", "id": "123"}}]}. ' +
    `Recommend exactly ${count} titles. ` +
    "Only recommend real, released titles you are confident exist — never invent a title. " +
    "Give the release/first-air year when you know it, otherwise null — never guess a year. " +
    '"kind" is "movie" for a film and "series" for a TV series. ' +
    "Give one specific reason per title (max 25 words) grounded in what the title is actually about and why it fits this request — never a generic platitude. " +
    '"tone" is a short phrase for the title\'s tone or theme (for example "dark psychological thriller"). ' +
    'Include "externalId" only when you confidently know a real TMDB, IMDb or TVDB id for the title; otherwise omit it entirely — never guess an id. ' +
    "If the request names constraints, honour them. Do not pad the list with weak matches: fewer strong recommendations beat a full list of guesses."
  const sections: string[] = [`Request: ${cleanLine(input.query, MAX_QUERY_CHARS) || "(no request)"}`, ""]
  const requirementLines = formatConstraints(input.constraints)
  if (requirementLines.length) {
    sections.push("Requirements:", ...requirementLines, "")
  }
  const context = (input.conversationContext ?? [])
    .map((line) => cleanLine(line, MAX_CONTEXT_CHARS))
    .filter(Boolean)
  if (context.length) {
    sections.push("Earlier in this conversation:", ...context, "")
  }
  const taste = gateTasteSummary(input.tasteSummary)
  if (taste) {
    sections.push("The viewer's taste (shared with their permission):", taste, "")
  }
  sections.push(`Recommend ${count} titles as JSON.`)
  return { system, user: sections.join("\n") }
}

// ---------------------------------------------------------------------------
// Response parsing — validate each item, drop invalid ones individually
// ---------------------------------------------------------------------------

function extractJsonValue(text: string): unknown {
  const trimmed = (text || "").trim()
  if (!trimmed) return null
  // Direct parse first (the common, well-formed case).
  try {
    return JSON.parse(trimmed)
  } catch {
    // Tolerate a fenced code block and/or prose around the JSON.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const body = fenced ? fenced[1].trim() : trimmed
    try {
      return JSON.parse(body)
    } catch {
      // Tolerate trailing text: take the largest JSON-looking span.
      // Prefer an array span, then an object span.
      const arrayStart = body.indexOf("[")
      const arrayEnd = body.lastIndexOf("]")
      if (arrayStart !== -1 && arrayEnd > arrayStart) {
        try {
          return JSON.parse(body.slice(arrayStart, arrayEnd + 1))
        } catch {
          // Fall through to the object span.
        }
      }
      const objectStart = body.indexOf("{")
      const objectEnd = body.lastIndexOf("}")
      if (objectStart !== -1 && objectEnd > objectStart) {
        try {
          return JSON.parse(body.slice(objectStart, objectEnd + 1))
        } catch {
          return null
        }
      }
      return null
    }
  }
}

function currentYearPlus(plus: number): number {
  return new Date().getFullYear() + plus
}

function normalizeKind(value: unknown): "movie" | "series" | null {
  if (typeof value !== "string") return null
  const kind = value.trim().toLowerCase()
  if (kind === "movie" || kind === "film") return "movie"
  if (kind === "series" || kind === "tv" || kind === "show" || kind === "tv series") return "series"
  return null
}

function normalizeYear(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const year = typeof value === "string" ? Number.parseInt(value.trim(), 10) : value
  if (typeof year !== "number" || !Number.isInteger(year)) return null
  // Cinema began in the late 1880s; allow next year for announced
  // releases the model knows about, never further.
  if (year < 1888 || year > currentYearPlus(1)) return null
  return year
}

function normalizeExternalId(
  value: unknown
): { source: "tmdb" | "imdb" | "tvdb"; id: string } | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const source = typeof record.source === "string" ? record.source.trim().toLowerCase() : ""
  if (source !== "tmdb" && source !== "imdb" && source !== "tvdb") return null
  const id = record.id
  const idText = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : ""
  if (!idText) return null
  return { source, id: idText.slice(0, 40) }
}

function normalizeTitleKey(title: string, kind: string): string {
  return `${kind}|${title.trim().toLowerCase().replace(/\s+/g, " ")}`
}

/**
 * Parse one model reply into generated recommendations. Each item is
 * validated on its own: an item with no usable title or kind is
 * dropped, a bad year becomes null (never a guessed year), a bad
 * external id is dropped (never a guessed id), and duplicates collapse
 * to the first mention. A reply that yields zero valid items returns
 * an empty list — the caller reports that honestly instead of
 * fabricating fillers. Never throws on malformed JSON.
 */
export function parseGeneratedRecommendations(text: string): GeneratedRecommendation[] {
  const parsed = extractJsonValue(text)
  let rawItems: unknown[] | null = null
  if (Array.isArray(parsed)) {
    rawItems = parsed
  } else if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.recommendations)) rawItems = record.recommendations
    else if (Array.isArray(record.results)) rawItems = record.results
    else if (Array.isArray(record.titles)) rawItems = record.titles
  }
  if (!rawItems) return []

  const seen = new Set<string>()
  const out: GeneratedRecommendation[] = []
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === "string" ? record.title.trim().slice(0, MAX_TITLE_CHARS) : ""
    if (!title) continue
    const kind = normalizeKind(record.kind)
    if (!kind) continue
    const key = normalizeTitleKey(title, kind)
    if (seen.has(key)) continue
    seen.add(key)
    const reason =
      typeof record.reason === "string" && record.reason.trim()
        ? record.reason.trim().slice(0, MAX_REASON_CHARS)
        : GENERIC_REASON
    const tone =
      typeof record.tone === "string" ? record.tone.trim().slice(0, MAX_TONE_CHARS) : ""
    const externalId = normalizeExternalId(record.externalId)
    const rec: GeneratedRecommendation = {
      title,
      year: normalizeYear(record.year),
      kind,
      reason,
      tone,
    }
    if (externalId) rec.externalId = externalId
    out.push(rec)
  }
  return out
}

// ---------------------------------------------------------------------------
// Conversation state + refinement constraint merging
// ---------------------------------------------------------------------------

export interface ConversationState {
  turns: Array<{ query: string; generatedTitles: string[] }>
}

export function newConversation(): ConversationState {
  return { turns: [] }
}

const MAX_CONTEXT_TURNS = 4
const MAX_TITLES_PER_TURN = 12

/**
 * Render prior turns as bounded context strings for the prompt, so a
 * refinement like "I've seen those, give me others" works: the model
 * sees what it already suggested and what was asked before. Only the
 * most recent turns are kept, and each line is length-bounded, so a
 * long conversation cannot bloat the prompt (or the cost).
 */
export function conversationContextFor(state: ConversationState): string[] {
  const turns = (state?.turns ?? []).slice(-MAX_CONTEXT_TURNS)
  const lines: string[] = []
  for (const turn of turns) {
    const query = cleanLine(turn.query, 200)
    const titles = (turn.generatedTitles ?? []).filter(Boolean).slice(0, MAX_TITLES_PER_TURN)
    if (!query && !titles.length) continue
    const suggested = titles.length ? ` Already suggested: ${titles.join(", ")}.` : ""
    lines.push(`- Earlier request: "${query}"${suggested}`)
  }
  return lines
}

/**
 * Extract the EXPLICIT constraints a query states, via the existing
 * intent parser (retrieval.ts). This is extraction only — never a
 * gatekeeper: the result travels to the model as requirements, and
 * the model does the semantic work. Genre, tone and mood words are
 * deliberately NOT turned into constraints here: GenerationConstraints
 * has no genre field, and the query text itself (plus conversation
 * context) carries those to the model verbatim.
 */
export function intentToGenerationConstraints(intent: QueryIntent): GenerationConstraints {
  const constraints: GenerationConstraints = {}
  if (intent.contentKind) constraints.kind = intent.contentKind
  if (typeof intent.minYear === "number") constraints.yearMin = intent.minYear
  if (typeof intent.maxYear === "number") constraints.yearMax = intent.maxYear
  if (typeof intent.maxRuntimeMinutes === "number") {
    constraints.maxRuntimeMinutes = intent.maxRuntimeMinutes
  }
  return constraints
}

/**
 * MERGE RULE (refinement): scalar fields REPLACE, exclusions UNION.
 *
 * A refinement's explicit constraints replace the accumulated value
 * for that field ("make it a series" replaces an earlier "film";
 * "after 2010" replaces an earlier "after 2000"). Fields the
 * refinement does not mention keep their accumulated value. This is
 * deliberately NOT a growing filter intersection: the LLM performs
 * the semantic refinement from the full query + conversation context,
 * so "something funnier" shifts the request instead of AND-ing a new
 * filter onto every previous one (the progressive sub-filter failure
 * mode, where each refinement narrows the answer space until nothing
 * is left). Exclusions are the one union: titles already suggested or
 * explicitly excluded stay excluded across turns.
 */
export function mergeGenerationConstraints(
  accumulated: GenerationConstraints | undefined,
  fresh: GenerationConstraints | undefined
): GenerationConstraints {
  const merged: GenerationConstraints = { ...(accumulated ?? {}) }
  if (!fresh) return merged
  if (fresh.kind !== undefined) merged.kind = fresh.kind
  if (fresh.yearMin !== undefined) merged.yearMin = fresh.yearMin
  if (fresh.yearMax !== undefined) merged.yearMax = fresh.yearMax
  if (fresh.maxRuntimeMinutes !== undefined) merged.maxRuntimeMinutes = fresh.maxRuntimeMinutes
  const excluded = new Set<string>()
  for (const title of accumulated?.excludeTitles ?? []) {
    if (title) excluded.add(title)
  }
  for (const title of fresh.excludeTitles ?? []) {
    if (title) excluded.add(title)
  }
  if (excluded.size) merged.excludeTitles = [...excluded]
  else delete merged.excludeTitles
  return merged
}

/**
 * Constraints for one run: fold the explicit constraints of every
 * prior turn's query (in order, replace semantics), merge the current
 * query's explicit constraints on top, and union in every title
 * already suggested so a refinement never re-suggests them. The
 * caller may pass additional caller-known constraints (e.g. a UI
 * kind filter); those merge last and win their fields.
 */
export function constraintsForConversation(
  state: ConversationState,
  query: string,
  extra?: GenerationConstraints
): GenerationConstraints {
  let merged: GenerationConstraints = {}
  for (const turn of state?.turns ?? []) {
    merged = mergeGenerationConstraints(merged, intentToGenerationConstraints(parseIntent(turn.query)))
  }
  merged = mergeGenerationConstraints(merged, intentToGenerationConstraints(parseIntent(query)))
  const alreadySuggested = (state?.turns ?? []).flatMap((turn) => turn.generatedTitles ?? [])
  if (alreadySuggested.length) {
    merged = mergeGenerationConstraints(merged, { excludeTitles: alreadySuggested })
  }
  if (extra) merged = mergeGenerationConstraints(merged, extra)
  return merged
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Ask the model to generate recommendations from its own knowledge.
 * The default transport is chatCompletions (client.ts); tests inject
 * a fake transport — no real API calls in tests, ever.
 *
 * Transport / config / abort failures throw the transport's AiError
 * (the orchestrator turns those into an honest "unavailable" phase).
 * A reply that parses to zero valid items is NOT thrown: it resolves
 * with an empty list and providerError set, so the caller can say the
 * reply was unusable without fabricating fillers. `cached` is always
 * false here — caching lives in the orchestrator, the only layer that
 * knows the full cache identity.
 */
export async function generateRecommendations(
  request: GenerationRequest,
  deps?: { chat?: AiChatTransport }
): Promise<GenerationResult> {
  const query = (request.query ?? "").trim()
  if (!query) {
    throw new Error("generateRecommendations requires a non-empty query.")
  }
  const startedAt = Date.now()
  const chat = deps?.chat ?? chatCompletions
  const { system, user } = buildGenerationPrompt({
    query,
    conversationContext: request.conversationContext,
    tasteSummary: request.tasteSummary,
    constraints: request.constraints,
    count: request.count,
  })
  const result = await chat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens: generationTokenBudget(request.count),
    signal: request.signal,
  })
  const recommendations = parseGeneratedRecommendations(result.text)
  const durationMs = Date.now() - startedAt
  if (!recommendations.length) {
    return {
      recommendations: [],
      model: result.model,
      durationMs,
      cached: false,
      providerError: "The AI reply contained no usable recommendations.",
    }
  }
  return {
    recommendations,
    model: result.model,
    durationMs,
    cached: false,
  }
}
