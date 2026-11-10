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

import { log } from "@/scripts/lib/log.js"

export type AiKeystoreErrorKind = "unavailable" | "invalid" | "unsupported" | "store_error"

export class AiKeystoreError extends Error {
  kind: AiKeystoreErrorKind
  constructor(kind: AiKeystoreErrorKind, message: string) {
    super(message)
    this.name = "AiKeystoreError"
    this.kind = kind
  }
}

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

async function invokeAi<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new AiKeystoreError("unavailable", "AI key storage needs the desktop app")
  }
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args ?? {})
}

function classifyInvokeError(error: unknown): AiKeystoreError {
  if (error instanceof AiKeystoreError) return error
  const text = String((error as Error)?.message ?? error ?? "")
  if (text.startsWith("INVALID:")) {
    return new AiKeystoreError("invalid", "That key does not look like a single API key.")
  }
  if (text.startsWith("UNSUPPORTED:")) {
    return new AiKeystoreError("unsupported", "AI key storage is not available on this platform.")
  }
  if (text.startsWith("STORE:")) {
    return new AiKeystoreError("store_error", "The OS credential store could not be reached.")
  }
  return new AiKeystoreError("store_error", "The OS credential store could not be reached.")
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

/** Store (or replace) the API key in the OS credential store. */
export async function saveAiKey(key: string): Promise<void> {
  const trimmed = validateKeyInput(key)
  try {
    await invokeAi<boolean>("ai_key_set", { key: trimmed })
  } catch (error) {
    throw classifyInvokeError(error)
  }
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
