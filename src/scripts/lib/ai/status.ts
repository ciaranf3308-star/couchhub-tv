// AI Discovery status model (C4 — single source of truth, 0.10.0).
//
// `getAiStatus()` reads settings + key presence + the last recorded test
// result. It NEVER makes a network request, so Discover can show the
// active mode on every load without spending a paid AI call.
//
// `testAiConnection()` is the REAL verification: it runs the Rust-side
// test (GET {endpoint}/models with the key held on the Rust side, so the
// key never enters JS) and then verifies the configured model actually
// appears in the provider's model list (transient key read, one request,
// no chat completion — so no per-token charge). A stored key alone is
// NOT proof AI works: a mode of "connected" requires a passing test
// against the CURRENT endpoint + model.
//
// Error codes are short machine strings; `aiStatusMessage()` turns them
// into user-facing text. Secrets are never included in any message,
// result, or log.
//
// Privacy / cost preferences (AI05) also live here — plain localStorage
// flags, read by the ranker and the Settings card:
// - share taste (default OFF): taste summary is only sent to the
//   provider when the user opts in. With it off, the model sees the
//   query + candidate list only.
// - automatic requests (default OFF / manual): with it off, a search
//   runs locally and the user taps "Ask AI" to send one explicit
//   request. With it on, submitting a natural-language search sends
//   the request automatically.
// - provider preset ("openai" | "other"): only picks the endpoint
//   default + key-management link; the endpoint itself stays editable.

import { getAiEnabled, getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js"
import { getAiKey, hasAiKey, testAiConnection as testAiConnectionRust } from "./keystore.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"

export type AiMode = "not-configured" | "connected" | "unavailable" | "local"

export const AI_MODE_LABELS: Record<AiMode, string> = {
  "not-configured": "AI not set up",
  connected: "AI connected",
  unavailable: "AI unavailable",
  local: "Local recommendations",
}

export interface AiStatus {
  mode: AiMode
  detail: string
  lastTestedAt: number | null
}

export type AiTestErrorCode =
  | "not_configured"
  | "no_key"
  | "invalid_key"
  | "invalid_endpoint"
  | "invalid_model"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "store_error"

export interface AiTestResult {
  ok: boolean
  error?: AiTestErrorCode
  /** True when the configured model was found in the provider's list. */
  modelVerified?: boolean
}

const LAST_TEST_KEY = "xt_ai_last_test_v1"
const SHARE_TASTE_KEY = "xt_ai_share_taste"
const AUTO_REQUESTS_KEY = "xt_ai_auto_requests"
const PROVIDER_KEY = "xt_ai_provider"
const ONBOARDING_DISMISSED_KEY = "rs-ai-onboarding-dismissed-v1"

/** OpenAI-compatible model choices offered in Settings (AI02). */
export const SUPPORTED_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "gpt-4o-mini", label: "gpt-4o-mini — fast, low cost" },
  { id: "gpt-4o", label: "gpt-4o — higher quality" },
  { id: "gpt-4.1-mini", label: "gpt-4.1-mini — fast, low cost" },
  { id: "gpt-4.1", label: "gpt-4.1 — higher quality" },
  { id: "o4-mini", label: "o4-mini — reasoning, low cost" },
]

export const OPENAI_ENDPOINT = "https://api.openai.com/v1"
export const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys"

/**
 * Resolve the Model control's state from the stored model (0.11.4): one
 * select with a Custom entry — selecting Custom reveals a single inline
 * text field that is visibly part of the same control. Pure helper so the
 * select/custom pairing is testable without a DOM.
 */
export function resolveAiModelControl(current: string): {
  selectValue: string
  showCustom: boolean
  customValue: string
} {
  const model = typeof current === "string" ? current.trim() : ""
  if (model && SUPPORTED_MODELS.some((entry) => entry.id === model)) {
    return { selectValue: model, showCustom: false, customValue: "" }
  }
  return { selectValue: "custom", showCustom: true, customValue: model }
}

interface LastTestRecord {
  ok: boolean
  at: number
  error?: AiTestErrorCode
  endpoint: string
  model: string
  modelVerified?: boolean
}

function readLS(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLS(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(key, value)
  } catch {
    // Private mode / unavailable storage: preferences simply don't persist.
  }
}

export function aiStatusMessage(error?: AiTestErrorCode | string | null): string {
  switch (error) {
    case "not_configured":
      return "AI Discovery isn't set up yet."
    case "no_key":
      return "No API key is saved yet."
    case "invalid_key":
      return "The provider rejected the API key. Check the key and try again."
    case "invalid_endpoint":
      return "The provider endpoint doesn't look right. Check the endpoint URL."
    case "invalid_model":
      return "That model isn't available on this provider. Pick a model the provider offers."
    case "rate_limited":
      return "The provider is rate-limiting requests. Wait a little and try again."
    case "timeout":
      return "The provider took too long to answer. Check your connection and try again."
    case "store_error":
      return "The credential store couldn't be reached. AI stays off on this device."
    case "unavailable":
    default:
      return "The provider couldn't be reached."
  }
}

function readLastTest(): LastTestRecord | null {
  try {
    const raw = readLS(LAST_TEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastTestRecord>
    if (typeof parsed?.at !== "number" || typeof parsed?.ok !== "boolean") return null
    return {
      ok: parsed.ok,
      at: parsed.at,
      error: typeof parsed.error === "string" ? (parsed.error as AiTestErrorCode) : undefined,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      modelVerified: parsed.modelVerified === true,
    }
  } catch {
    return null
  }
}

export function recordAiTestResult(result: AiTestResult, endpoint: string, model: string): void {
  const record: LastTestRecord = {
    ok: result.ok,
    at: Date.now(),
    error: result.error,
    endpoint,
    model,
    modelVerified: result.modelVerified,
  }
  writeLS(LAST_TEST_KEY, JSON.stringify(record))
}

export function clearAiTestRecord(): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(LAST_TEST_KEY)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Privacy / cost preferences (AI05)
// ---------------------------------------------------------------------------

/** Sharing viewing-history / taste data with the AI provider. Default OFF. */
export function getAiShareTaste(): boolean {
  return readLS(SHARE_TASTE_KEY) === "1"
}

export function setAiShareTaste(share: boolean): void {
  writeLS(SHARE_TASTE_KEY, share ? "1" : "0")
}

/** Automatic AI requests on search submit. Default OFF (manual "Ask AI"). */
export function getAiAutoRequests(): boolean {
  return readLS(AUTO_REQUESTS_KEY) === "1"
}

export function setAiAutoRequests(auto: boolean): void {
  writeLS(AUTO_REQUESTS_KEY, auto ? "1" : "0")
}

export type AiProviderPreset = "openai" | "other"

export function getAiProvider(): AiProviderPreset {
  return readLS(PROVIDER_KEY) === "other" ? "other" : "openai"
}

export function setAiProvider(provider: AiProviderPreset): void {
  writeLS(PROVIDER_KEY, provider)
}

// ---------------------------------------------------------------------------
// Onboarding dismissal (AI01) — a declined setup is never re-shown.
// ---------------------------------------------------------------------------

export function hasDismissedAiOnboarding(): boolean {
  return readLS(ONBOARDING_DISMISSED_KEY) === "1"
}

export function dismissAiOnboarding(): void {
  writeLS(ONBOARDING_DISMISSED_KEY, "1")
}

// ---------------------------------------------------------------------------
// Status (no network — safe to call on every Discover load)
// ---------------------------------------------------------------------------

export async function getAiStatus(): Promise<AiStatus> {
  const enabled = getAiEnabled()
  const endpoint = getAiEndpoint().trim()
  const model = getAiModel().trim()
  if (!enabled) {
    // 0.11.4: a saved key with the toggle off is NOT "not set up" — the
    // key is saved, AI is just off. Say so, and use the "local" mode
    // (Discover really is using local recommendations; Ask AI stays
    // unavailable because aiConfigured only counts connected/unavailable).
    let keyPresent = false
    try {
      keyPresent = await hasAiKey()
    } catch {
      keyPresent = false
    }
    if (keyPresent) {
      return {
        mode: "local",
        detail: "Key saved. Turn on AI Discovery to use it.",
        lastTestedAt: readLastTest()?.at ?? null,
      }
    }
    return {
      mode: "not-configured",
      detail: "AI Discovery is off.",
      lastTestedAt: readLastTest()?.at ?? null,
    }
  }
  if (!endpoint || !model) {
    return {
      mode: "not-configured",
      detail: "Finish setup in Settings — add a model to use AI Discovery.",
      lastTestedAt: readLastTest()?.at ?? null,
    }
  }
  let keyPresent = false
  try {
    keyPresent = await hasAiKey()
  } catch {
    keyPresent = false
  }
  if (!keyPresent) {
    return {
      mode: "not-configured",
      detail: "Save an API key in Settings to use AI Discovery.",
      lastTestedAt: readLastTest()?.at ?? null,
    }
  }
  const last = readLastTest()
  const matchesCurrentConfig = !!last && last.endpoint === endpoint && last.model === model
  if (matchesCurrentConfig && last.ok) {
    return {
      mode: "connected",
      detail: last.modelVerified
        ? "Connected — endpoint, key and model verified."
        : "Connected — endpoint and key verified.",
      lastTestedAt: last.at,
    }
  }
  if (matchesCurrentConfig && !last.ok) {
    return {
      mode: "unavailable",
      detail: `${aiStatusMessage(last.error)} Using local recommendations.`,
      lastTestedAt: last.at,
    }
  }
  return {
    mode: "local",
    detail: "Not tested yet — using local recommendations. Test the connection in Settings.",
    lastTestedAt: last?.at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Real verification (AI03)
// ---------------------------------------------------------------------------

const MODEL_LIST_TIMEOUT_MS = 10_000

/**
 * Verify the configured endpoint + stored key + model, for real:
 * 1. Rust-side GET {endpoint}/models (key never enters JS).
 * 2. JS-side GET {endpoint}/models with a transient key read, checking
 *    the configured model id is actually in the provider's list.
 * Step 2 is best-effort: if the list can't be read but step 1 passed,
 * the connection still counts as verified (auth + endpoint proven) —
 * only a list that definitively lacks the model fails the test.
 * No chat completion is sent, so the test costs nothing per token.
 */
export async function testAiConnection(): Promise<AiTestResult> {
  const endpoint = getAiEndpoint().trim().replace(/\/+$/, "")
  const model = getAiModel().trim()
  // 0.11.4: testing is a diagnostic, not a use of AI — it runs against
  // the STORED key whatever the Enable toggle says. The old code refused
  // to test while the toggle was off and returned "not_configured", so
  // Test connection answered "AI Discovery isn't set up yet." on a
  // device with a saved key, a set endpoint and a picked model, and the
  // test never actually tested. The toggle only gates whether Discover
  // USES AI; it must never gate whether the connection can be verified.
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
    const result: AiTestResult = { ok: false, error: "invalid_endpoint" }
    recordAiTestResult(result, endpoint, model)
    return result
  }
  if (!model) {
    const result: AiTestResult = { ok: false, error: "invalid_model" }
    recordAiTestResult(result, endpoint, model)
    return result
  }

  const rust = await testAiConnectionRust(endpoint, model)
  if (!rust.ok) {
    const error = (typeof rust.error === "string" ? rust.error : "unavailable") as AiTestErrorCode
    const result: AiTestResult = { ok: false, error }
    recordAiTestResult(result, endpoint, model)
    return result
  }

  // Rust proved auth + endpoint. Now check the model is really offered.
  let modelVerified: boolean | undefined
  try {
    const key = await getAiKey()
    if (key) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS)
      try {
        const response = await providerFetch(`${endpoint}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
          logKind: "ai",
        })
        if (response.ok) {
          const data = (await response.json()) as {
            data?: Array<{ id?: unknown }>
          }
          const ids = Array.isArray(data?.data)
            ? data.data.map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
            : []
          if (ids.length) {
            modelVerified = ids.includes(model)
            if (!modelVerified) {
              const result: AiTestResult = { ok: false, error: "invalid_model", modelVerified: false }
              recordAiTestResult(result, endpoint, model)
              return result
            }
          }
        }
      } finally {
        clearTimeout(timer)
      }
    }
  } catch {
    // List unreadable (network / parse): Rust already verified auth +
    // endpoint, so don't fail the test on the model check alone.
    modelVerified = undefined
  }

  const result: AiTestResult = { ok: true, modelVerified }
  recordAiTestResult(result, endpoint, model)
  return result
}
