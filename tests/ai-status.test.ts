/**
 * @vitest-environment jsdom
 */
// AI status model (C4) tests — no key, no network, no live provider.
// The Rust keystore test + the /models fetch are both mocked; the
// status model itself is exercised for real.
import { describe, it, expect, beforeEach, vi } from "vitest"

// Node 24+ ships an experimental native `localStorage` (undefined without
// --localstorage-file) that shadows jsdom's; stub it with a real in-memory Storage.
function makeStorageMock(store: Map<string, string>): Storage {
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
}
vi.stubGlobal("localStorage", makeStorageMock(new Map<string, string>()))
vi.stubGlobal("sessionStorage", makeStorageMock(new Map<string, string>()))


const hoisted = vi.hoisted(() => ({
  enabled: { value: false },
  endpoint: { value: "https://api.openai.com/v1" },
  model: { value: "gpt-4o-mini" },
  keyPresent: { value: false },
  rustTest: vi.fn(),
  keyValue: { value: null as string | null },
  fetchMock: vi.fn(),
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getAiEnabled: () => hoisted.enabled.value,
  getAiEndpoint: () => hoisted.endpoint.value,
  getAiModel: () => hoisted.model.value,
}))

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: async () => hoisted.keyValue.value,
  hasAiKey: async () => hoisted.keyPresent.value,
  testAiConnection: (...args: unknown[]) => hoisted.rustTest(...args),
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => hoisted.fetchMock(...args),
}))

import {
  getAiStatus,
  testAiConnection,
  aiStatusMessage,
  recordAiTestResult,
  clearAiTestRecord,
  getAiShareTaste,
  setAiShareTaste,
  getAiAutoRequests,
  setAiAutoRequests,
  getAiProvider,
  setAiProvider,
  hasDismissedAiOnboarding,
  dismissAiOnboarding,
  AI_MODE_LABELS,
} from "@/scripts/lib/ai/status"

const LS_KEY = "xt_ai_last_test_v1"

function seedLastTest(record: Record<string, unknown>) {
  localStorage.setItem(LS_KEY, JSON.stringify(record))
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  hoisted.enabled.value = false
  hoisted.endpoint.value = "https://api.openai.com/v1"
  hoisted.model.value = "gpt-4o-mini"
  hoisted.keyPresent.value = false
  hoisted.keyValue.value = null
  hoisted.rustTest.mockResolvedValue({ ok: true, status: 200 })
  hoisted.fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }),
  })
})

describe("getAiStatus", () => {
  it("is not-configured when AI is off", async () => {
    const status = await getAiStatus()
    expect(status.mode).toBe("not-configured")
    expect(status.lastTestedAt).toBeNull()
  })

  it("is local with a key-saved detail when AI is off but a key is saved", async () => {
    // 0.11.4: a saved key with the toggle off is NOT "not set up" — the
    // key is saved, AI is just off. Discover reads the same mode, so
    // Settings and Discover agree.
    hoisted.keyPresent.value = true
    const status = await getAiStatus()
    expect(status.mode).toBe("local")
    expect(status.detail).toBe("Key saved. Turn on AI Discovery to use it.")
  })

  it("is not-configured when enabled but no key is saved", async () => {
    hoisted.enabled.value = true
    const status = await getAiStatus()
    expect(status.mode).toBe("not-configured")
    expect(status.detail).toMatch(/API key/)
  })

  it("is not-configured when enabled but no model is set", async () => {
    hoisted.enabled.value = true
    hoisted.keyPresent.value = true
    hoisted.model.value = ""
    const status = await getAiStatus()
    expect(status.mode).toBe("not-configured")
  })

  it("is local when configured but never tested", async () => {
    hoisted.enabled.value = true
    hoisted.keyPresent.value = true
    const status = await getAiStatus()
    expect(status.mode).toBe("local")
    expect(status.detail).toMatch(/Not tested yet/)
  })

  it("is connected after a passing test against the current config", async () => {
    hoisted.enabled.value = true
    hoisted.keyPresent.value = true
    seedLastTest({
      ok: true,
      at: 1700000000000,
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      modelVerified: true,
    })
    const status = await getAiStatus()
    expect(status.mode).toBe("connected")
    expect(status.lastTestedAt).toBe(1700000000000)
    expect(status.detail).toMatch(/verified/)
  })

  it("is unavailable after a failing test against the current config", async () => {
    hoisted.enabled.value = true
    hoisted.keyPresent.value = true
    seedLastTest({
      ok: false,
      at: 1700000000000,
      error: "invalid_key",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    })
    const status = await getAiStatus()
    expect(status.mode).toBe("unavailable")
    expect(status.detail).toMatch(/rejected the API key/)
  })

  it("does not trust a passing test recorded for different config", async () => {
    hoisted.enabled.value = true
    hoisted.keyPresent.value = true
    seedLastTest({
      ok: true,
      at: 1700000000000,
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
    })
    const status = await getAiStatus()
    expect(status.mode).toBe("local")
  })

  it("makes no network request", async () => {
    hoisted.enabled.value = true
    hoisted.keyPresent.value = true
    await getAiStatus()
    expect(hoisted.rustTest).not.toHaveBeenCalled()
    expect(hoisted.fetchMock).not.toHaveBeenCalled()
  })
})

describe("testAiConnection", () => {
  it("tests against the stored key even when AI is off", async () => {
    // 0.11.4: the toggle gates whether Discover USES AI, never whether
    // the connection can be verified. The old code refused here and
    // returned "not_configured", so Test connection answered "AI
    // Discovery isn't set up yet." on a device with a saved key, a set
    // endpoint and a picked model — the test never actually tested.
    hoisted.keyValue.value = "sk-test"
    const result = await testAiConnection()
    expect(result.ok).toBe(true)
    expect(result.modelVerified).toBe(true)
    expect(hoisted.rustTest).toHaveBeenCalledWith(
      "https://api.openai.com/v1",
      "gpt-4o-mini"
    )
    expect(hoisted.fetchMock).toHaveBeenCalled()
  })

  it("reports no_key, never not_configured, when AI is off and no key is saved", async () => {
    hoisted.rustTest.mockResolvedValue({ ok: false, status: 401, error: "no_key" })
    const result = await testAiConnection()
    expect(result).toEqual({ ok: false, error: "no_key" })
    expect(aiStatusMessage(result.error)).toMatch(/API key is saved/)
  })

  it("returns ok and records the test when endpoint, key and model verify", async () => {
    hoisted.enabled.value = true
    hoisted.keyValue.value = "sk-test"
    const result = await testAiConnection()
    expect(result.ok).toBe(true)
    expect(result.modelVerified).toBe(true)
    expect(hoisted.rustTest).toHaveBeenCalledWith(
      "https://api.openai.com/v1",
      "gpt-4o-mini"
    )
    expect(hoisted.fetchMock).toHaveBeenCalled()
    const stored = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}")
    expect(stored.ok).toBe(true)
    expect(stored.model).toBe("gpt-4o-mini")
    // The key itself is never persisted by the status model.
    expect(JSON.stringify(stored)).not.toContain("sk-test")
  })

  it("fails invalid_model when the model is not in the provider list", async () => {
    hoisted.enabled.value = true
    hoisted.keyValue.value = "sk-test"
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    })
    const result = await testAiConnection()
    expect(result).toEqual({ ok: false, error: "invalid_model", modelVerified: false })
  })

  it("still passes when the model list cannot be read but auth verified", async () => {
    hoisted.enabled.value = true
    hoisted.keyValue.value = "sk-test"
    hoisted.fetchMock.mockRejectedValue(new Error("network down"))
    const result = await testAiConnection()
    expect(result.ok).toBe(true)
    expect(result.modelVerified).toBeUndefined()
  })

  it("surfaces the Rust-side auth failure without leaking anything", async () => {
    hoisted.enabled.value = true
    hoisted.rustTest.mockResolvedValue({ ok: false, status: 401, error: "invalid_key" })
    const result = await testAiConnection()
    expect(result).toEqual({ ok: false, error: "invalid_key" })
    expect(aiStatusMessage(result.error)).toMatch(/rejected the API key/)
    expect(aiStatusMessage(result.error)).not.toContain("sk-")
  })

  it("record + clear round-trips the last-test record", () => {
    recordAiTestResult({ ok: true }, "https://api.openai.com/v1", "gpt-4o-mini")
    expect(localStorage.getItem(LS_KEY)).toContain("gpt-4o-mini")
    clearAiTestRecord()
    expect(localStorage.getItem(LS_KEY)).toBeNull()
  })
})

describe("privacy / cost preferences (AI05)", () => {
  it("taste sharing defaults off and toggles", () => {
    expect(getAiShareTaste()).toBe(false)
    setAiShareTaste(true)
    expect(getAiShareTaste()).toBe(true)
    setAiShareTaste(false)
    expect(getAiShareTaste()).toBe(false)
  })

  it("automatic requests default off (manual Ask AI) and toggle", () => {
    expect(getAiAutoRequests()).toBe(false)
    setAiAutoRequests(true)
    expect(getAiAutoRequests()).toBe(true)
  })

  it("provider defaults to OpenAI and toggles", () => {
    expect(getAiProvider()).toBe("openai")
    setAiProvider("other")
    expect(getAiProvider()).toBe("other")
  })

  it("onboarding dismissal persists", () => {
    expect(hasDismissedAiOnboarding()).toBe(false)
    dismissAiOnboarding()
    expect(hasDismissedAiOnboarding()).toBe(true)
  })

  it("every mode has a label", () => {
    for (const mode of ["not-configured", "connected", "unavailable", "local"] as const) {
      expect(AI_MODE_LABELS[mode]).toBeTruthy()
    }
    expect(AI_MODE_LABELS.local).toBe("Local recommendations")
  })
})
