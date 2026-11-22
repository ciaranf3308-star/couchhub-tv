// Unified keys onboarding — core (storage + status, no DOM).
//
// One onboarding for the three user-entered API keys (AI, TMDB,
// football-data.org). It composes the three existing stores into a
// single status, and it is the ONLY place that decides whether the
// prompt shows.
//
// STORAGE SCOPE — profile finding (21 Nov 2026): all three keys are
// ALREADY global, not per-profile, so there is nothing to move and no
// migration. Evidence:
// - Profiles (`profiles.ts`) only namespace watch history / favorites /
//   Continue Watching into `nylah_profile_data_<id>_v1` buckets
//   (`ProfileData`: history, favorites, continueWatching, claimedAt,
//   lastMirroredAt, updatedAt). No settings and no keys live there, and
//   no code outside profiles.ts reads those buckets.
// - AI key: one OS-credential-store entry, service "Nylah Studios" /
//   user "ai-discovery-api-key" (`src-tauri/src/ai_keyring.rs:22-23`).
// - TMDB key: plain localStorage `xt_tmdb_key` (app-settings.js:40).
// - football-data.org key: plain localStorage `xt_football_data_key`
//   (football-data.ts:60).
// The single WebView localStorage and the single OS credential entry are
// shared by every profile, so switching profile never loses a key or
// re-triggers this onboarding. A key saved on this device before this
// onboarding existed is seen as saved on first launch — the user is
// never asked to re-enter it.
//
// NEVER-RE-PROMPT RULE: the trigger is purely "is a key stored?"
// (presence), never "is it valid?". A stored key that later fails
// validation is an error state, not a fresh prompt: `validateSavedKey()`
// reports it for Settings / the done-state row, and
// `shouldShowKeysOnboarding()` stays false for that key. The onboarding
// only ever appears for keys that are actually missing.
//
// CHECK-FAILURE RULE (0.11.22): a presence check that FAILS is not
// "missing" either. `hasAiKey()` rejects when the store cannot be
// reached, `getKeysOnboardingStatus()` propagates that rejection, and
// `maybeOpenKeysOnboarding()` catches it into "do not show" (fail
// closed). The old code swallowed the failure into `aiSaved = false`
// twice upstream, so the gate re-prompted for a saved key — the
// false-missing bug (22 Nov 2026).
//
// SKIP RULE: skip / "I'll do it later" / B / Escape dismisses the
// CURRENT prompt only. The dismissal is session-scoped
// (`sessionStorage`, `KEYS_ONBOARDING_DISMISSED_KEY`); it recurs on
// next launch and on entering a key-dependent feature until every key
// is saved. It is never permanent. The old AI-only flag
// `rs-ai-onboarding-dismissed-v1` is deliberately NEVER consulted here:
// the user explicitly asked to be forced through this onboarding, so a
// decline of the old AI-only prompt must not suppress it.
//
// SECRETS: a key value is never logged and never shown on screen in
// full. The only display form is `maskKeyForDisplay()` (last 4 chars).
// The AI key can never be masked — the keystore never reads it back —
// so its entry carries `masked: null` and the UI says "saved" without
// a suffix. Saves go through the SAME storage each key already uses,
// so Settings and onboarding can never disagree.

import {
  getAiEnabled,
  getAiModel,
  getFootballDataApiKey,
  getTmdbApiKey,
  setAiEnabled,
  setAiEndpoint,
  setAiModel,
  setFootballDataApiKey,
  setTmdbApiKey,
} from "@/scripts/lib/app-settings.js"
import { hasAiKey, saveAiKey } from "@/scripts/lib/ai/keystore.js"
import {
  aiStatusMessage,
  OPENAI_KEYS_URL,
  testAiConnection as testAiConnectionStatus,
} from "@/scripts/lib/ai/status.ts"
import { validateTmdbKey } from "@/scripts/lib/tmdb.ts"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  validateFootballDataKey,
} from "@/scripts/lib/football-data.ts"

export type KeyOnboardingId = "ai" | "tmdb" | "football-data"

/** Canonical step order: AI, TMDB, football-data. */
export const KEY_ONBOARDING_ORDER: readonly KeyOnboardingId[] = [
  "ai",
  "tmdb",
  "football-data",
]

/** Session-scoped dismissal flag. sessionStorage on purpose: skip is
 *  never permanent (see header). */
export const KEYS_ONBOARDING_DISMISSED_KEY = "rs-keys-onboarding-dismissed-v1"

/** The old AI-only dismissal flag. Named here so the non-reuse rule is
 *  greppable — this module NEVER reads it. */
export const LEGACY_AI_ONBOARDING_DISMISSED_KEY = "rs-ai-onboarding-dismissed-v1"

export const TMDB_KEYS_URL = "https://www.themoviedb.org/settings/api"
export const FOOTBALL_DATA_REGISTER_URL =
  "https://www.football-data.org/client/register"

export type KeysOnboardingReason =
  | "launch"
  | "settings"
  | "ai"
  | "tmdb"
  | "football-data"

export interface KeyOnboardingDefinition {
  name: string
  /** What the key unlocks, in one line. */
  unlocks: string
  getKeyUrl: string
  getKeyLabel: string
}

export const KEY_ONBOARDING_DEFS: Record<KeyOnboardingId, KeyOnboardingDefinition> = {
  ai: {
    name: "AI key",
    unlocks: "AI Discovery — personalised picks and Ask AI in Discover.",
    getKeyUrl: OPENAI_KEYS_URL,
    getKeyLabel: "Get a key at platform.openai.com",
  },
  tmdb: {
    name: "TMDB key",
    unlocks: "Posters, trailers, cast and similar titles for movies and series.",
    getKeyUrl: TMDB_KEYS_URL,
    getKeyLabel: "Get a key at themoviedb.org",
  },
  "football-data": {
    name: "football-data.org key",
    unlocks: "Manchester United table and next fixtures in Sports Corner.",
    getKeyUrl: FOOTBALL_DATA_REGISTER_URL,
    getKeyLabel: "Register free at football-data.org",
  },
}

export interface KeyOnboardingEntry extends KeyOnboardingDefinition {
  id: KeyOnboardingId
  /** A key is stored. Presence only — never validity (see header). */
  saved: boolean
  /** Masked display (last 4 chars). Null for the AI key: the keystore
   *  never reads the key back, so there is nothing to mask. */
  masked: string | null
  /** AI only, saved-but-not-usable-yet note (model not picked, or AI off). */
  setupNote?: string
}

export interface KeysOnboardingStatus {
  entries: KeyOnboardingEntry[]
  /** Missing keys, in canonical step order. */
  missing: KeyOnboardingId[]
  allSaved: boolean
  savedCount: number
}

/** Injectable seams for tests. Defaults are the real stores/validators;
 *  tests inject fakes and never hit the live API.
 *  `hasAiKey` is tri-state (0.11.22): it resolves true/false when
 *  presence is known and REJECTS when presence is unknown (store
 *  unreachable). That rejection must propagate out of
 *  `getKeysOnboardingStatus` — never be collapsed into "missing" —
 *  so the launch gate's fail-safe ("do not show") engages. */
export interface KeysOnboardingDeps {
  hasAiKey?: () => Promise<boolean>
  saveAiKey?: (key: string) => Promise<void>
  testAiConnection?: () => Promise<{
    ok: boolean
    error?: string
    modelVerified?: boolean
  }>
  validateTmdbKey?: (key: string) => Promise<{ ok: boolean; status?: number }>
  validateFootballDataKey?: (
    key: string,
    fetchImpl?: unknown,
  ) => Promise<{ ok: boolean; status?: number }>
  /** Passed through to validateFootballDataKey (its injectable fetch). */
  footballFetchImpl?: unknown
}

export type KeyTestErrorCode =
  | "invalid_key"
  | "invalid_endpoint"
  | "invalid_model"
  | "no_key"
  | "rate_limited"
  | "timeout"
  | "store_error"
  | "unavailable"

export interface KeyTestOutcome {
  ok: boolean
  error?: KeyTestErrorCode
  /** User-facing message (no key material). Present whenever ok is false. */
  message?: string
  /** AI only: the configured model was found in the provider's list. */
  modelVerified?: boolean
}

export interface KeySaveOutcome {
  ok: boolean
  /** Short machine code when the save failed. */
  error?: string
  /** User-facing message (no key material). Present whenever ok is false. */
  message?: string
}

/** Masked display: last 4 chars only, never the full key. Short keys
 *  show bullets only — even 4 chars must not leak the whole key. */
export function maskKeyForDisplay(key: string): string {
  const trimmed = (key || "").trim()
  if (!trimmed) return ""
  if (trimmed.length <= 4) return "••••"
  return `••••${trimmed.slice(-4)}`
}

function readSessionFlag(): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false
    return sessionStorage.getItem(KEYS_ONBOARDING_DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

function writeSessionFlag(): void {
  try {
    if (typeof sessionStorage === "undefined") return
    sessionStorage.setItem(KEYS_ONBOARDING_DISMISSED_KEY, "1")
  } catch {
    // Private mode etc.: the prompt simply recurs next time.
  }
}

function clearSessionFlag(): void {
  try {
    if (typeof sessionStorage === "undefined") return
    sessionStorage.removeItem(KEYS_ONBOARDING_DISMISSED_KEY)
  } catch {
    // ignore
  }
}

/** Compose the three statuses into one. Presence only — a stored key
 *  counts as saved even if it would fail validation (see header).
 *  TRI-STATE (0.11.22): when the AI presence check fails, this REJECTS
 *  instead of reporting the AI key missing. A failed check is
 *  indistinguishable from "no key" only if it is swallowed — swallowing
 *  it is the false-missing bug (22 Nov): the gate asked for a saved
 *  key. The rejection propagates through `shouldShowKeysOnboarding`
 *  to `maybeOpenKeysOnboarding`, whose catch resolves it to
 *  "do not show" (fail closed, never blocks the app). */
export async function getKeysOnboardingStatus(
  deps: KeysOnboardingDeps = {},
): Promise<KeysOnboardingStatus> {
  const checkAi = deps.hasAiKey ?? hasAiKey
  // No try/catch here on purpose: hasAiKey() rejects when presence is
  // unknown, and that rejection IS the signal (see doc above).
  const aiSaved = (await checkAi()) === true
  const tmdbKey = getTmdbApiKey()
  const footballKey = getFootballDataApiKey()
  const model = getAiModel().trim()

  let aiSetupNote: string | undefined
  if (aiSaved && !model) {
    aiSetupNote = "Key saved — pick a model to finish AI setup."
  } else if (aiSaved && !getAiEnabled()) {
    aiSetupNote = "Key saved — AI Discovery is off. Turn it on to use it."
  }

  const entries: KeyOnboardingEntry[] = KEY_ONBOARDING_ORDER.map((id) => {
    const def = KEY_ONBOARDING_DEFS[id]
    if (id === "ai") {
      return {
        id,
        ...def,
        saved: aiSaved,
        masked: null,
        ...(aiSetupNote ? { setupNote: aiSetupNote } : {}),
      }
    }
    if (id === "tmdb") {
      return {
        id,
        ...def,
        saved: !!tmdbKey,
        masked: tmdbKey ? maskKeyForDisplay(tmdbKey) : null,
      }
    }
    return {
      id,
      ...def,
      saved: !!footballKey,
      masked: footballKey ? maskKeyForDisplay(footballKey) : null,
    }
  })
  const missing = entries.filter((entry) => !entry.saved).map((entry) => entry.id)
  return {
    entries,
    missing,
    allSaved: missing.length === 0,
    savedCount: entries.length - missing.length,
  }
}

/** True when the current prompt was skipped ("I'll do it later" / B /
 *  Escape). Session-scoped: a fresh launch clears it. */
export function hasDismissedKeysOnboarding(): boolean {
  return readSessionFlag()
}

/** Dismiss the current prompt only. Never permanent — the prompt
 *  recurs on next launch until every key is saved. */
export function dismissKeysOnboarding(): void {
  writeSessionFlag()
}

/** Clear the session dismissal (launch gate / tests / hooks). */
export function clearKeysOnboardingDismissal(): void {
  clearSessionFlag()
}

/**
 * Show the onboarding when any needed key is missing and the current
 * prompt was not skipped. A stored key never triggers this — even a
 * stored key that would fail validation (that is an error state, see
 * `validateSavedKey()`, not a prompt). The legacy AI-only flag is
 * never consulted.
 * FAIL-SAFE (0.11.22): when the AI presence check fails, this REJECTS
 * (via `getKeysOnboardingStatus`) instead of answering "show" — the
 * caller (`maybeOpenKeysOnboarding`) catches that into "do not show",
 * so a store error can never re-prompt for a key that is saved.
 */
export async function shouldShowKeysOnboarding(
  deps: KeysOnboardingDeps = {},
): Promise<boolean> {
  const status = await getKeysOnboardingStatus(deps)
  if (status.allSaved) return false
  return !hasDismissedKeysOnboarding()
}

/** First step for a reason: a key id starts at that key when it is
 *  missing (feature-entry hook); anything else starts at the first
 *  missing key. Null when nothing is missing. */
export function resolveFirstStep(
  reason: KeysOnboardingReason,
  status: KeysOnboardingStatus,
): KeyOnboardingId | null {
  if (status.missing.length === 0) return null
  if (
    (reason === "ai" || reason === "tmdb" || reason === "football-data") &&
    status.missing.includes(reason)
  ) {
    return reason
  }
  return status.missing[0]
}

function invalidKeyOutcome(message: string): KeyTestOutcome {
  return { ok: false, error: "invalid_key", message }
}

function unavailableOutcome(message: string): KeyTestOutcome {
  return { ok: false, error: "unavailable", message }
}

function mapHttpValidation(
  result: { ok: boolean; status?: number },
  invalidMessage: string,
  unreachableMessage: string,
): KeyTestOutcome {
  if (result.ok) return { ok: true }
  if (result.status === 401) return invalidKeyOutcome(invalidMessage)
  if (result.status === 429) {
    return {
      ok: false,
      error: "rate_limited",
      message: "The provider is rate-limiting requests. Wait a little and try again.",
    }
  }
  return unavailableOutcome(unreachableMessage)
}

/**
 * Live-test a typed (not yet saved) key with the existing validators.
 *
 * - TMDB / football-data.org: validates the typed key only; nothing is
 *   saved. Call `saveOnboardingKey()` after a pass.
 * - AI: the Rust test reads the STORED key, so the typed key is saved
 *   first (exactly like Settings' Test button), then endpoint + model
 *   are verified against it. A failed AI test therefore still leaves
 *   the typed key in the store — the step's Save/Continue just moves
 *   on; the key can be replaced from the same step or in Settings.
 */
export async function testOnboardingKey(
  id: KeyOnboardingId,
  key: string,
  opts: { endpoint?: string; model?: string; enableAi?: boolean } = {},
  deps: KeysOnboardingDeps = {},
): Promise<KeyTestOutcome> {
  const typed = (key || "").trim()
  if (!typed) return invalidKeyOutcome("Enter a key first.")
  if (id === "tmdb") {
    const validate = deps.validateTmdbKey ?? validateTmdbKey
    const result = await validate(typed)
    return mapHttpValidation(
      result,
      "That key was rejected. Check the key and try again.",
      "TMDB couldn't be reached. Check your connection and try again.",
    )
  }
  if (id === "football-data") {
    const validate = deps.validateFootballDataKey ?? validateFootballDataKey
    const result = await validate(typed, deps.footballFetchImpl)
    return mapHttpValidation(
      result,
      "That key was rejected. Check the key and try again.",
      "football-data.org couldn't be reached. Check your connection and try again.",
    )
  }
  // AI: apply endpoint/model first, save the typed key, then test the
  // stored key + endpoint + model (status.ts testAiConnection).
  if (opts.endpoint !== undefined) setAiEndpoint(opts.endpoint)
  if (opts.model !== undefined) setAiModel(opts.model)
  if (opts.enableAi) setAiEnabled(true)
  const save = deps.saveAiKey ?? saveAiKey
  try {
    await save(typed)
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? `: ${error.message}` : ""
    return {
      ok: false,
      error: "store_error",
      message: `The key couldn't be saved${detail}`,
    }
  }
  const test = deps.testAiConnection ?? testAiConnectionStatus
  const result = await test()
  if (result.ok) {
    return { ok: true, modelVerified: result.modelVerified }
  }
  const code = (typeof result.error === "string" ? result.error : "unavailable") as KeyTestErrorCode
  return { ok: false, error: code, message: aiStatusMessage(code) }
}

/**
 * Save a key through the SAME storage Settings uses, so Settings and
 * onboarding stay in sync. For AI this also applies the endpoint /
 * model / enable choices from the step.
 */
export async function saveOnboardingKey(
  id: KeyOnboardingId,
  key: string,
  opts: { endpoint?: string; model?: string; enableAi?: boolean } = {},
  deps: KeysOnboardingDeps = {},
): Promise<KeySaveOutcome> {
  const typed = (key || "").trim()
  if (!typed) return { ok: false, error: "invalid_key", message: "Enter a key first." }
  if (id === "tmdb") {
    const ok = setTmdbApiKey(typed)
    return ok
      ? { ok: true }
      : { ok: false, error: "store_error", message: "Could not save the TMDB key." }
  }
  if (id === "football-data") {
    const ok = setFootballDataApiKey(typed)
    return ok
      ? { ok: true }
      : {
          ok: false,
          error: "store_error",
          message: "Could not save the football-data.org key.",
        }
  }
  if (opts.endpoint !== undefined) setAiEndpoint(opts.endpoint)
  if (opts.model !== undefined) setAiModel(opts.model)
  if (opts.enableAi) setAiEnabled(true)
  const save = deps.saveAiKey ?? saveAiKey
  try {
    await save(typed)
    return { ok: true }
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? `: ${error.message}` : ""
    return {
      ok: false,
      error: "store_error",
      message: `The key couldn't be saved${detail}`,
    }
  }
}

/**
 * Validate the STORED key for one id, without changing anything (the
 * AI test records a test result, like Settings' Test button). This is
 * the error-state surface for a saved key: a failure here is shown on
 * the key's row / in Settings — it NEVER re-opens the onboarding
 * prompt for that key.
 */
export async function validateSavedKey(
  id: KeyOnboardingId,
  deps: KeysOnboardingDeps = {},
): Promise<KeyTestOutcome> {
  if (id === "ai") {
    const test = deps.testAiConnection ?? testAiConnectionStatus
    const result = await test()
    if (result.ok) return { ok: true, modelVerified: result.modelVerified }
    const code = (typeof result.error === "string" ? result.error : "unavailable") as KeyTestErrorCode
    return { ok: false, error: code, message: aiStatusMessage(code) }
  }
  if (id === "tmdb") {
    const stored = getTmdbApiKey()
    if (!stored) {
      return { ok: false, error: "no_key", message: "No TMDB key is saved." }
    }
    const validate = deps.validateTmdbKey ?? validateTmdbKey
    const result = await validate(stored)
    return mapHttpValidation(
      result,
      "The saved key was rejected. Check the key in Settings and try again.",
      "TMDB couldn't be reached. Check your connection and try again.",
    )
  }
  const stored = getFootballDataApiKey()
  if (!stored) {
    return {
      ok: false,
      error: "no_key",
      message: "No football-data.org key is saved.",
    }
  }
  const validate = deps.validateFootballDataKey ?? validateFootballDataKey
  const result = await validate(stored, deps.footballFetchImpl)
  return mapHttpValidation(
    result,
    "The saved key was rejected. Check the key in Settings and try again.",
    "football-data.org couldn't be reached. Check your connection and try again.",
  )
}

/** The raw localStorage key for the football-data.org key (re-exported
 *  for tests asserting Settings sync on the raw key). */
export { FOOTBALL_DATA_KEY_STORAGE_KEY }
