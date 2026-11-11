/**
 * @vitest-environment jsdom
 */
// AI keystore tests. The Tauri invoke bridge is mocked; no real credential
// store is touched and the key below is synthetic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

async function loadKeystore(tauri = true) {
  if (tauri) {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).__TAURI__
  }
  return import("@/scripts/lib/ai/keystore")
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  invokeMock.mockResolvedValue(true)
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  delete (window as unknown as Record<string, unknown>).__TAURI__
})

describe("AI keystore", () => {
  it("saves a trimmed key through ai_key_set", async () => {
    const { saveAiKey } = await loadKeystore()
    await saveAiKey("  sk-test-key  ")
    expect(invokeMock).toHaveBeenCalledWith("ai_key_set", { key: "sk-test-key" })
  })

  it("rejects an empty key without touching the store", async () => {
    const { saveAiKey } = await loadKeystore()
    await expect(saveAiKey("   ")).rejects.toMatchObject({ kind: "invalid" })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("rejects a key with interior whitespace without touching the store", async () => {
    const { saveAiKey } = await loadKeystore()
    await expect(saveAiKey("sk test key")).rejects.toMatchObject({ kind: "invalid" })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("reports key presence without ever returning the key", async () => {
    const { hasAiKey } = await loadKeystore()
    invokeMock.mockResolvedValueOnce(true)
    await expect(hasAiKey()).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("ai_key_has", {})
    const calls = invokeMock.mock.calls.map((call) => String(call[0]))
    expect(calls).not.toContain("ai_key_get")
  })

  it("hasAiKey is false — never throwing — when the store is unreachable", async () => {
    const { hasAiKey } = await loadKeystore()
    invokeMock.mockRejectedValueOnce(new Error("STORE:locked"))
    await expect(hasAiKey()).resolves.toBe(false)
  })

  it("hasAiKey is false outside the desktop app", async () => {
    const { hasAiKey } = await loadKeystore(false)
    await expect(hasAiKey()).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("deletes through ai_key_delete and reports whether a key was removed", async () => {
    const { deleteAiKey } = await loadKeystore()
    invokeMock.mockResolvedValueOnce(true)
    await expect(deleteAiKey()).resolves.toBe(true)
    invokeMock.mockResolvedValueOnce(false)
    await expect(deleteAiKey()).resolves.toBe(false)
  })

  it("testAiConnection passes the Rust result through, key never in JS", async () => {
    const { testAiConnection } = await loadKeystore()
    invokeMock.mockResolvedValueOnce({ ok: true, status: 200, error: undefined })
    await expect(
      testAiConnection("https://api.openai.com/v1", "gpt-4o-mini")
    ).resolves.toEqual({ ok: true, status: 200, error: undefined })
    const [command, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe("ai_test_connection")
    expect(args).toEqual({ endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" })
    expect(JSON.stringify(args)).not.toContain("sk-")
  })

  it("testAiConnection reports unavailable when invoke fails", async () => {
    const { testAiConnection } = await loadKeystore()
    invokeMock.mockRejectedValueOnce(new Error("boom"))
    await expect(
      testAiConnection("https://api.openai.com/v1", "gpt-4o-mini")
    ).resolves.toEqual({ ok: false, error: "unavailable" })
  })

  it("maps a Rust INVALID error to the invalid kind", async () => {
    const { saveAiKey } = await loadKeystore()
    invokeMock.mockRejectedValueOnce("INVALID:empty key")
    await expect(saveAiKey("sk-test-key")).rejects.toMatchObject({ kind: "invalid" })
  })

  it("verifies a save by reading presence back (set then has)", async () => {
    const { saveAiKey } = await loadKeystore()
    await saveAiKey("sk-test-key")
    expect(invokeMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "ai_key_set",
      "ai_key_has",
    ])
  })

  it("throws store_error when the write reports success but nothing can be read back", async () => {
    const { saveAiKey } = await loadKeystore()
    // ai_key_set resolves true, ai_key_has reports no key stored.
    invokeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    await expect(saveAiKey("sk-test-key")).rejects.toMatchObject({
      kind: "store_error",
      detail: "saved but could not be read back",
    })
  })

  it("preserves the Rust STORE detail on a save failure, without the key", async () => {
    const { saveAiKey } = await loadKeystore()
    invokeMock.mockRejectedValueOnce(new Error("STORE:Access is denied"))
    const thrown = await saveAiKey("sk-test-key").catch((error: unknown) => error)
    expect(thrown).toMatchObject({ kind: "store_error", detail: "Access is denied" })
    expect(String((thrown as { detail?: unknown }).detail ?? "")).not.toContain("sk-test-key")
    expect(String((thrown as { message?: unknown }).message ?? "")).not.toContain("sk-test-key")
  })

  it("serialises concurrent saves so the same credential is never written twice at once", async () => {
    const { saveAiKey } = await loadKeystore()
    const first = saveAiKey("sk-test-key-one")
    const second = saveAiKey("sk-test-key-two")
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    // Without serialisation both ai_key_set calls would land before either
    // ai_key_has; serialised, each save fully completes before the next.
    expect(invokeMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "ai_key_set",
      "ai_key_has",
      "ai_key_set",
      "ai_key_has",
    ])
  })

  it("reports unavailable — not store_error — outside the desktop app", async () => {
    const { saveAiKey } = await loadKeystore(false)
    await expect(saveAiKey("sk-test-key")).rejects.toMatchObject({ kind: "unavailable" })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
