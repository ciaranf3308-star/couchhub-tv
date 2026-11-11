// Frontend side of the AI key store. The key itself lives in the OS
// credential store (Windows Credential Manager on the desktop build) behind
// the `ai_key_*` Rust commands in src-tauri/src/ai_keyring.rs.
//
// Rules for everything in this file:
// - The key is NEVER written to localStorage, plugin-store, cookies or any
//   file, and NEVER logged — not even its length or prefix.
// - `getAiKey()` hands the key to JS memory for one request's Authorization
//   header only. Callers must use it immediately and never retain it.
// - `hasAiKey()` / `deleteAiKey()` never throw for a missing store —
//   presence checks must not break the page on web/Android, where the
//   commands are unsupported and AI simply stays off.
//
// Save-failure contract (0.11.1): a failed save MUST surface its cause.
// Earlier code collapsed every failure into one generic "Could not save
// the key." and the Settings blur handler dropped the error entirely, so
// a save-time failure was undiagnosable from the UI or the log file.
// `AiKeystoreError.detail` now carries the safe underlying reason (the
// Rust error's code/message — keyring errors never contain the secret),
// scrubbed of any key material, capped in length. Callers show it and
// log it; they never swallow it.

import { log } from "@/scripts/lib/log.js"

export type AiKeystoreErrorKind = "unavailable" | "invalid" | "unsupported" | "store_error"

export class AiKeystoreError extends Error {
  kind: AiKeystoreErrorKind
  /** Safe underlying reason (Rust error code/message). Never key material. */
  detail?: string
  constructor(kind: AiKeystoreErrorKind, message: string, detail?: string) {
    super(message)
    this.name = "AiKeystoreError"
    this.kind = kind
    if (detail) this.detail = detail
  }
}

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

/** Max chars of a Rust error message kept in `detail`. Long enough for a
 *  Win32 message, short enough to show under a settings field. */
const MAX_DETAIL_CHARS = 200

function scrubDetail(detail: string, secret?: string): string {
  let cleaned = detail.slice(0, MAX_DETAIL_CHARS).trim()
  // The key itself must never appear in a surfaced/logged detail, even if
  // some future platform error were to echo an argument back.
  if (secret && cleaned.includes(secret)) cleaned = cleaned.split(secret).join("***")
  return cleaned
}

async function invokeAi<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new AiKeystoreError("unavailable", "AI key storage needs the desktop app")
  }
  let invoke: (command: string, args?: Record<string, unknown>) => Promise<T>
  try {
    ;({ invoke } = await import("@tauri-apps/api/core"))
  } catch {
    throw new AiKeystoreError(
      "store_error",
      "The OS credential store could not be reached.",
      "Tauri bridge import failed"
    )
  }
  return invoke(command, args ?? {})
}

function classifyInvokeError(error: unknown, secret?: string): AiKeystoreError {
  if (error instanceof AiKeystoreError) return error
  const text = String((error as Error)?.message ?? error ?? "")
  // Rust commands prefix their failures: INVALID: / UNSUPPORTED: / STORE:.
  // Keep the suffix as the diagnosable detail — keyring error text is a
  // platform message (e.g. a Win32 error) and never contains the secret.
  const prefixMatch = /^(INVALID|UNSUPPORTED|STORE):\s*(.*)$/s.exec(text)
  if (prefixMatch) {
    const [, prefix, rest] = prefixMatch
    const detail = scrubDetail(rest || prefix, secret)
    if (prefix === "INVALID") {
      return new AiKeystoreError("invalid", "That key does not look like a single API key.", detail)
    }
    if (prefix === "UNSUPPORTED") {
      return new AiKeystoreError(
        "unsupported",
        "AI key storage is not available on this platform.",
        detail
      )
    }
    return new AiKeystoreError(
      "store_error",
      "The OS credential store could not be reached.",
      detail
    )
  }
  return new AiKeystoreError(
    "store_error",
    "The OS credential store could not be reached.",
    scrubDetail(text, secret)
  )
}

function validateKeyInput(key: string): string {
  const trimmed = (key || "").trim()
  if (!trimmed) {
    throw new AiKeystoreError("invalid", "Enter an API key first.")
  }
  if (trimmed.length > 512 || /\s/.test(trimmed)) {
    throw new AiKeystoreError("invalid", "That key does not look like a single API key.")
  }
  return trimmed
}

// Serialise concurrent saves: the Settings page can trigger a save from
// both the field's blur handler and the Test button for the same keystroke,
// and keyring warns that concurrent writes to the same credential entry
// are not serialised by the Windows Credential Manager — the outcome is
// nondeterministic. A module-level chain makes saves run one at a time.
let saveQueue: Promise<void> = Promise.resolve()

/**
 * Store (or replace) the API key in the OS credential store. Verifies the
 * write by reading presence back: a save that reports success while the
 * store still holds nothing throws `store_error` instead of letting the
 * UI claim the key is saved.
 */
export async function saveAiKey(key: string): Promise<void> {
  const trimmed = validateKeyInput(key)
  const run = saveQueue.then(async () => {
    try {
      await invokeAi<boolean>("ai_key_set", { key: trimmed })
    } catch (error) {
      throw classifyInvokeError(error, trimmed)
    }
    let present = false
    try {
      present = (await invokeAi<boolean>("ai_key_has")) === true
    } catch (error) {
      throw classifyInvokeError(error, trimmed)
    }
    if (!present) {
      throw new AiKeystoreError(
        "store_error",
        "The OS credential store could not be reached.",
        "saved but could not be read back"
      )
    }
  })
  // Keep the chain alive for the next caller even when this save fails;
  // the caller's own await still sees the rejection.
  saveQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * Transient read of the stored key, for one request's Authorization header.
 * Returns null when no key is stored. Never persist, cache-to-disk or log
 * the returned value.
 */
export async function getAiKey(): Promise<string | null> {
  try {
    const key = await invokeAi<string | null>("ai_key_get")
    return typeof key === "string" && key ? key : null
  } catch (error) {
    throw classifyInvokeError(error)
  }
}

/** Whether a key is stored. Never throws for a missing/unsupported store. */
export async function hasAiKey(): Promise<boolean> {
  try {
    return (await invokeAi<boolean>("ai_key_has")) === true
  } catch (error) {
    log.warn("[xt:ai] key presence check failed:", error)
    return false
  }
}

/** Delete the stored key. True when a key was removed, false otherwise. */
export async function deleteAiKey(): Promise<boolean> {
  try {
    return (await invokeAi<boolean>("ai_key_delete")) === true
  } catch (error) {
    log.warn("[xt:ai] key delete failed:", error)
    return false
  }
}

export interface AiTestResult {
  ok: boolean
  status?: number
  /** Short code from the Rust side: no_key | invalid_endpoint | invalid_model | invalid_key | rate_limited | unavailable | timeout | store_error. */
  error?: string
}

/**
 * Validate endpoint + stored key against the provider (GET {endpoint}/models
 * on the Rust side). The key never crosses into JS for this call.
 */
export async function testAiConnection(endpoint: string, model: string): Promise<AiTestResult> {
  try {
    const result = await invokeAi<AiTestResult>("ai_test_connection", { endpoint, model })
    return {
      ok: result?.ok === true,
      status: typeof result?.status === "number" ? result.status : undefined,
      error: typeof result?.error === "string" ? result.error : undefined,
    }
  } catch (error) {
    log.warn("[xt:ai] connection test failed:", error)
    return { ok: false, error: "unavailable" }
  }
}
