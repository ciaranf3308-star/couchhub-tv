/**
 * @vitest-environment jsdom
 */
// Keys onboarding — core tests. No live API is ever hit: the AI keystore
// is mocked (like ai-status.test.ts), TMDB validation runs against a
// stubbed global fetch, and football-data.org validation runs against
// an injected fetch. All key values below are synthetic, generated at
// runtime — no real key is written in this file.
//
// The trigger under test is presence-only: a stored key counts as
// saved even if it would fail validation, and the prompt never
// re-appears for it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

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

const lsStore = new Map<string, string>()
const ssStore = new Map<string, string>()

const hoisted = vi.hoisted(() => ({
  aiKeyPresent: { value: false },
  savedAiKeys: [] as string[],
  rustTest: vi.fn(),
  aiKeyValue: { value: null as string | null },
  modelsFetch: vi.fn(),
}))

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: async () => hoisted.aiKeyValue.value,
  hasAiKey: async () => hoisted.aiKeyPresent.value,
  saveAiKey: async (key: string) => {
    hoisted.savedAiKeys.push(key)
  },
  testAiConnection: (...args: unknown[]) => hoisted.rustTest(...args),
  deleteAiKey: async () => false,
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => hoisted.modelsFetch(...args),
}))

import {
  KEYS_ONBOARDING_DISMISSED_KEY,
  LEGACY_AI_ONBOARDING_DISMISSED_KEY,
  clearKeysOnboardingDismissal,
  dismissKeysOnboarding,
  getKeysOnboardingStatus,
  hasDismissedKeysOnboarding,
  maskKeyForDisplay,
  resolveFirstStep,
  saveOnboardingKey,
  shouldShowKeysOnboarding,
  testOnboardingKey,
  validateSavedKey,
} from "@/scripts/lib/keys-onboarding.ts"
import {
  getAiModel,
  getFootballDataApiKey,
  getTmdbApiKey,
} from "@/scripts/lib/app-settings.js"
import { FOOTBALL_DATA_KEY_STORAGE_KEY } from "@/scripts/lib/football-data.ts"

function runtimeKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-x9z4`
}

function tmdbFetchStub(status: number) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
  }))
}

function footballFetchStub(status: number) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ standings: [] }),
  })
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorageMock(lsStore))
  vi.stubGlobal("sessionStorage", makeStorageMock(ssStore))
  lsStore.clear()
  ssStore.clear()
  hoisted.aiKeyPresent.value = false
  hoisted.savedAiKeys.length = 0
  // Transient key for status.ts testAiConnection's /models check
  // (step 2 only runs when getAiKey returns a key). Synthetic.
  hoisted.aiKeyValue.value = "sk-transient-test-key"
  hoisted.rustTest.mockReset()
  hoisted.rustTest.mockResolvedValue({ ok: true })
  hoisted.modelsFetch.mockReset()
  hoisted.modelsFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: "gpt-4o-mini" }] }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("maskKeyForDisplay", () => {
  it("shows only the last 4 chars", () => {
    expect(maskKeyForDisplay(runtimeKey("tmdb-"))).toMatch(/^••••[A-Za-z0-9]{4}$/)
  })

  it("never reveals a short key in full", () => {
    expect(maskKeyForDisplay("ab12")).toBe("••••")
    expect(maskKeyForDisplay("")).toBe("")
  })
})

describe("getKeysOnboardingStatus", () => {
  it("reports all three missing on a fresh install", async () => {
    const status = await getKeysOnboardingStatus()
    expect(status.missing).toEqual(["ai", "tmdb", "football-data"])
    expect(status.allSaved).toBe(false)
    expect(status.savedCount).toBe(0)
  })

  it("detects already-saved TMDB + football keys, masked, never re-asked", async () => {
    const tmdbKey = runtimeKey("tmdb-")
    const footballKey = runtimeKey("fd-")
    localStorage.setItem("xt_tmdb_key", tmdbKey)
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, footballKey)
    const status = await getKeysOnboardingStatus()
    expect(status.missing).toEqual(["ai"])
    const tmdb = status.entries.find((entry) => entry.id === "tmdb")!
    const football = status.entries.find(
      (entry) => entry.id === "football-data",
    )!
    expect(tmdb.saved).toBe(true)
    expect(tmdb.masked).toBe(`••••${tmdbKey.slice(-4)}`)
    expect(tmdb.masked).not.toContain(tmdbKey)
    expect(football.saved).toBe(true)
    expect(football.masked).toBe(`••••${footballKey.slice(-4)}`)
    expect(football.masked).not.toContain(footballKey)
  })

  it("detects a saved AI key by presence only — masked is null, never read back", async () => {
    hoisted.aiKeyPresent.value = true
    const status = await getKeysOnboardingStatus()
    const ai = status.entries.find((entry) => entry.id === "ai")!
    expect(ai.saved).toBe(true)
    expect(ai.masked).toBeNull()
    expect(status.missing).toEqual(["tmdb", "football-data"])
  })

  it("notes a saved AI key that still needs a model picked", async () => {
    hoisted.aiKeyPresent.value = true
    const status = await getKeysOnboardingStatus()
    const ai = status.entries.find((entry) => entry.id === "ai")!
    expect(ai.setupNote).toMatch(/model/)
  })

  it("counts a stored key as saved even when it would fail validation", async () => {
    // Presence is the trigger, never validity: an invalid-but-stored
    // key must not re-open the prompt (validateSavedKey reports it
    // as an error state instead).
    localStorage.setItem("xt_tmdb_key", runtimeKey("bad-"))
    vi.stubGlobal("fetch", tmdbFetchStub(401))
    const status = await getKeysOnboardingStatus()
    expect(status.entries.find((e) => e.id === "tmdb")!.saved).toBe(true)
    // …and the TMDB key is not in the missing list: the prompt never
    // re-appears for it (AI + football-data are still missing, so the
    // prompt itself still shows for those).
    expect(status.missing).not.toContain("tmdb")
    expect(status.missing).toEqual(["ai", "football-data"])
    await expect(validateSavedKey("tmdb")).resolves.toMatchObject({
      ok: false,
      error: "invalid_key",
    })
  })
})

describe("AI presence-check failure is fail-closed, never missing (0.11.22)", () => {
  const storeFailure = async () => {
    throw new Error("STORE:locked")
  }

  it("getKeysOnboardingStatus REJECTS when the AI check fails — it never reports the key missing", async () => {
    await expect(
      getKeysOnboardingStatus({ hasAiKey: storeFailure }),
    ).rejects.toThrow("STORE:locked")
    // The old code swallowed this into aiSaved=false, so the gate
    // re-prompted for a saved key (false-missing, 22 Nov).
  })

  it("shouldShowKeysOnboarding propagates the AI-check failure so the gate fail-safe engages", async () => {
    await expect(
      shouldShowKeysOnboarding({ hasAiKey: storeFailure }),
    ).rejects.toThrow("STORE:locked")
  })

  it("a transient AI-check failure still rejects at this layer — the retry lives inside hasAiKey itself", async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("STORE:locked"))
      .mockResolvedValue(true)
    // A deps-level check is called once and its failure propagates;
    // the real hasAiKey retries internally before it ever gets here.
    await expect(
      getKeysOnboardingStatus({ hasAiKey: flaky }),
    ).rejects.toThrow("STORE:locked")
    expect(flaky).toHaveBeenCalledTimes(1)
  })
})

describe("shouldShowKeysOnboarding / skip", () => {
  it("shows when a key is missing", async () => {
    await expect(shouldShowKeysOnboarding()).resolves.toBe(true)
  })

  it("never shows when every key is saved", async () => {
    hoisted.aiKeyPresent.value = true
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd-"))
    await expect(shouldShowKeysOnboarding()).resolves.toBe(false)
  })

  it("skip dismisses the current prompt only, session-scoped", async () => {
    await expect(shouldShowKeysOnboarding()).resolves.toBe(true)
    dismissKeysOnboarding()
    expect(hasDismissedKeysOnboarding()).toBe(true)
    // The flag lives in sessionStorage, never localStorage.
    expect(localStorage.getItem(KEYS_ONBOARDING_DISMISSED_KEY)).toBeNull()
    expect(sessionStorage.getItem(KEYS_ONBOARDING_DISMISSED_KEY)).toBe("1")
    await expect(shouldShowKeysOnboarding()).resolves.toBe(false)
    // Next launch: a fresh session has no dismissal, so it recurs.
    sessionStorage.clear()
    await expect(shouldShowKeysOnboarding()).resolves.toBe(true)
  })

  it("clearKeysOnboardingDismissal restores the prompt in-session", async () => {
    dismissKeysOnboarding()
    clearKeysOnboardingDismissal()
    expect(hasDismissedKeysOnboarding()).toBe(false)
    await expect(shouldShowKeysOnboarding()).resolves.toBe(true)
  })

  it("the legacy AI-only dismissal flag NEVER suppresses this onboarding", async () => {
    localStorage.setItem(LEGACY_AI_ONBOARDING_DISMISSED_KEY, "1")
    await expect(shouldShowKeysOnboarding()).resolves.toBe(true)
  })
})

describe("resolveFirstStep", () => {
  it("starts at the reason's key when it is missing", async () => {
    const status = await getKeysOnboardingStatus()
    expect(resolveFirstStep("football-data", status)).toBe("football-data")
    expect(resolveFirstStep("launch", status)).toBe("ai")
  })

  it("falls back to the first missing key when the reason's key is saved", async () => {
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    const status = await getKeysOnboardingStatus()
    expect(resolveFirstStep("tmdb", status)).toBe("ai")
  })

  it("returns null when nothing is missing", async () => {
    hoisted.aiKeyPresent.value = true
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd-"))
    const status = await getKeysOnboardingStatus()
    expect(resolveFirstStep("launch", status)).toBeNull()
  })
})

describe("saveOnboardingKey — Settings sync", () => {
  it("saving TMDB writes the raw localStorage key Settings reads", async () => {
    const key = runtimeKey("tmdb-")
    await expect(saveOnboardingKey("tmdb", key)).resolves.toEqual({ ok: true })
    expect(localStorage.getItem("xt_tmdb_key")).toBe(key)
    expect(getTmdbApiKey()).toBe(key)
  })

  it("saving football-data writes the raw localStorage key Settings reads", async () => {
    const key = runtimeKey("fd-")
    await expect(saveOnboardingKey("football-data", key)).resolves.toEqual({
      ok: true,
    })
    expect(localStorage.getItem(FOOTBALL_DATA_KEY_STORAGE_KEY)).toBe(key)
    expect(getFootballDataApiKey()).toBe(key)
  })

  it("saving AI goes through the keystore and applies endpoint + model + enable", async () => {
    const key = runtimeKey("sk-")
    await expect(
      saveOnboardingKey("ai", key, {
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        enableAi: true,
      }),
    ).resolves.toEqual({ ok: true })
    expect(hoisted.savedAiKeys).toEqual([key])
    expect(getAiModel()).toBe("gpt-4o-mini")
    expect(localStorage.getItem("xt_ai_endpoint")).toBe(
      "https://api.openai.com/v1",
    )
    expect(localStorage.getItem("xt_ai_enabled")).toBe("1")
  })

  it("rejects an empty key without touching storage", async () => {
    await expect(saveOnboardingKey("tmdb", "   ")).resolves.toMatchObject({
      ok: false,
    })
    expect(localStorage.getItem("xt_tmdb_key")).toBeNull()
  })
})

describe("testOnboardingKey — live validation with fakes", () => {
  it("TMDB: ok on 2xx, invalid_key on 401, unavailable on network failure", async () => {
    const key = runtimeKey("tmdb-")
    vi.stubGlobal("fetch", tmdbFetchStub(200))
    await expect(testOnboardingKey("tmdb", key)).resolves.toMatchObject({
      ok: true,
    })
    vi.stubGlobal("fetch", tmdbFetchStub(401))
    await expect(testOnboardingKey("tmdb", key)).resolves.toMatchObject({
      ok: false,
      error: "invalid_key",
    })
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down")
    }))
    await expect(testOnboardingKey("tmdb", key)).resolves.toMatchObject({
      ok: false,
      error: "unavailable",
    })
    // Validation alone never saves.
    expect(localStorage.getItem("xt_tmdb_key")).toBeNull()
  })

  it("football-data: ok on 2xx, invalid_key on 401, via the injectable fetch", async () => {
    const key = runtimeKey("fd-")
    await expect(
      testOnboardingKey("football-data", key, {}, {
        footballFetchImpl: footballFetchStub(200),
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      testOnboardingKey("football-data", key, {}, {
        footballFetchImpl: footballFetchStub(401),
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_key" })
    expect(localStorage.getItem(FOOTBALL_DATA_KEY_STORAGE_KEY)).toBeNull()
  })

  it("AI: saves first (Rust test reads the stored key), then verifies endpoint + model", async () => {
    const key = runtimeKey("sk-")
    await expect(
      testOnboardingKey("ai", key, { model: "gpt-4o-mini" }),
    ).resolves.toMatchObject({ ok: true, modelVerified: true })
    expect(hoisted.savedAiKeys).toEqual([key])
    expect(getAiModel()).toBe("gpt-4o-mini")
    expect(hoisted.rustTest).toHaveBeenCalled()
  })

  it("AI: a failing provider test maps the error code to a message, no key in it", async () => {
    hoisted.rustTest.mockResolvedValueOnce({ ok: false, error: "invalid_key" })
    const result = await testOnboardingKey("ai", runtimeKey("sk-"), {
      model: "gpt-4o-mini",
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("invalid_key")
    expect(result.message).toMatch(/key/i)
    expect(result.message).not.toContain("sk-")
  })

  it("AI: model missing from the provider list fails as invalid_model", async () => {
    hoisted.modelsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    })
    await expect(
      testOnboardingKey("ai", runtimeKey("sk-"), { model: "gpt-4o-mini" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_model" })
  })

  it("empty key fails before any validator runs", async () => {
    await expect(testOnboardingKey("tmdb", "  ")).resolves.toMatchObject({
      ok: false,
      error: "invalid_key",
    })
    expect(hoisted.rustTest).not.toHaveBeenCalled()
  })
})

describe("validateSavedKey — error state, never a re-prompt", () => {
  it("TMDB: ok when the stored key validates, invalid_key when rejected", async () => {
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    vi.stubGlobal("fetch", tmdbFetchStub(200))
    await expect(validateSavedKey("tmdb")).resolves.toMatchObject({ ok: true })
    vi.stubGlobal("fetch", tmdbFetchStub(401))
    await expect(validateSavedKey("tmdb")).resolves.toMatchObject({
      ok: false,
      error: "invalid_key",
    })
    // …and the prompt still stays away for TMDB: the key is stored,
    // so it is not in the missing list (AI + football-data still are).
    const status = await getKeysOnboardingStatus()
    expect(status.missing).not.toContain("tmdb")
    expect(status.missing).toEqual(["ai", "football-data"])
  })

  it("reports no_key when nothing is stored", async () => {
    await expect(validateSavedKey("football-data")).resolves.toMatchObject({
      ok: false,
      error: "no_key",
    })
  })

  it("football-data: validates the stored key through the injectable fetch", async () => {
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd-"))
    await expect(
      validateSavedKey("football-data", {
        footballFetchImpl: footballFetchStub(401),
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_key" })
  })
})
