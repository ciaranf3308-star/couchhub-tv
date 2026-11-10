// OpenAI-compatible chat completions client for AI Discovery.
//
// Transport is the app's existing safe-fetch path (`providerFetch`, which
// routes through @tauri-apps/plugin-http on desktop and native fetch on
// web) — no second HTTP stack. The API key is fetched transiently from the
// OS credential store per request (see keystore.ts) and lives in JS memory
// only for the duration of the call. Request/response bodies are NEVER
// logged: prompts may contain the user's own words and must stay private.
//
// Error taxonomy (surfaced in the Discover UI; the coordinator falls back
// to the local engine on any of these):
// - not_configured — AI off, or endpoint/model/key missing
// - invalid_key — provider rejected the key (401/403)
// - rate_limited — provider throttled us (429)
// - unavailable — network failure or a 5xx / unexpected status
// - bad_output — provider answered but the payload was unusable
// - aborted — the request was cancelled (new search superseded it, or timeout)

import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import { getAiKey } from "./keystore.js"
import { log } from "@/scripts/lib/log.js"

export type AiErrorKind =
  | "not_configured"
  | "unavailable"
  | "rate_limited"
  | "invalid_key"
  | "bad_output"
  | "aborted"

export class AiError extends Error {
  kind: AiErrorKind
  status?: number
  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message)
    this.name = "AiError"
    this.kind = kind
    if (typeof status === "number") this.status = status
  }
}

export interface AiChatMessage {
  role: "system" | "user"
  content: string
}

export interface AiChatOptions {
  messages: AiChatMessage[]
  /** Overrides the configured endpoint (tests / coordinator). */
  endpoint?: string
  /** Overrides the configured model (tests / coordinator). */
  model?: string
  maxTokens?: number
  /** Caller signal (e.g. ranking's per-search controller). */
  signal?: AbortSignal
  timeoutMs?: number
}

export interface AiChatResult {
  text: string
  model: string
}

/** Model calls are slow; 30s bounds a hung provider without cutting normal replies short. */
export const AI_REQUEST_TIMEOUT_MS = 30_000
/** Ranked IDs + one-line reasons fit comfortably in this budget. */
export const AI_MAX_OUTPUT_TOKENS = 800

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const name = (error as Error)?.name || ""
  return name === "AbortError" || name === "TimeoutError"
}

export async function chatCompletions(options: AiChatOptions): Promise<AiChatResult> {
  const endpoint = (options.endpoint ?? getAiEndpoint()).trim().replace(/\/+$/, "")
  const model = (options.model ?? getAiModel()).trim()
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
    throw new AiError("not_configured", "AI provider endpoint is missing or invalid.")
  }
  if (!model) {
    throw new AiError("not_configured", "AI model is not set.")
  }
  const key = await getAiKey().catch((error: unknown) => {
    throw new AiError(
      "not_configured",
      error instanceof Error ? error.message : "AI key storage is unavailable."
    )
  })
  if (!key) {
    throw new AiError("not_configured", "No AI API key is saved.")
  }

  const timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  const callerSignal = options.signal
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException("AI request timed out.", "TimeoutError"))
    } catch {
      controller.abort()
    }
  }, timeoutMs)

  const url = `${endpoint}/chat/completions`
  // A caller that already aborted (e.g. a superseded search) must fail fast
  // instead of issuing a request whose signal can never fire again.
  if (controller.signal.aborted) {
    clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort)
    throw new AiError("aborted", "The AI request was cancelled.")
  }
  try {
    const response = await providerFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: 0.2,
        max_tokens: options.maxTokens ?? AI_MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
      logKind: "ai",
    })

    if (response.status === 401 || response.status === 403) {
      throw new AiError("invalid_key", "The provider rejected the API key.", response.status)
    }
    if (response.status === 429) {
      throw new AiError("rate_limited", "The AI provider is rate-limiting requests.", 429)
    }
    if (!response.ok) {
      throw new AiError(
        "unavailable",
        `The AI provider answered with status ${response.status}.`,
        response.status
      )
    }

    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new AiError("bad_output", "The AI provider returned an unreadable reply.")
    }
    const text = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
      ?.message?.content
    if (typeof text !== "string" || !text.trim()) {
      throw new AiError("bad_output", "The AI provider returned an empty reply.")
    }
    log.log("[xt:ai] chat completions ok", response.status)
    return { text, model }
  } catch (error) {
    if (error instanceof AiError) throw error
    if (isAbortLike(error, controller.signal)) {
      throw new AiError("aborted", "The AI request was cancelled.")
    }
    // Only the kind + status are logged — never the request or the reply.
    log.warn("[xt:ai] chat completions failed:", error)
    throw new AiError("unavailable", "The AI provider could not be reached.")
  } finally {
    clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort)
  }
}
