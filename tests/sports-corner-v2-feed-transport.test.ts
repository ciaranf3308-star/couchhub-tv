// Sports Corner fix-3 (w1) — football-data.org transport tests.
//
// Root cause (2026-11-22): a plain webview fetch() can never reach
// api.football-data.org — its GET responses never carry
// Access-Control-Allow-Origin and its preflight always answers the
// fixed value `http://localhost`, so every call died with a CORS
// TypeError ("couldn't be reached") while the API was up. The fix
// routes the feed through providerFetch (plugin-http, Rust-side
// reqwest, no CORS) inside the Tauri webview.
//
// These tests NEVER hit the live API: the providerFetch module is
// mocked and the global fetch is stubbed. Live reachability through
// the real client path is proven by
// tests/e2e/football-data-live.spec.ts (gated behind
// FOOTBALL_DATA_LIVE_TEST=1). Dummy tokens only — no real key
// value, real or fake, is written in this file.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  clearFootballDataCache,
  getLeagueTable,
  validateFootballDataKey,
} from "@/scripts/lib/football-data.ts"
import { MOCK_STANDINGS_RESPONSE } from "@/scripts/lib/football-data-mock.ts"
import { testOnboardingKey } from "@/scripts/lib/keys-onboarding.ts"

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: vi.fn(),
}))

import { providerFetch } from "@/scripts/lib/provider-fetch.js"

const mockProviderFetch = vi.mocked(providerFetch)

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
}

function mockResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: (_name: string) => null },
  }
}

function stubTauri(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
}

function stubGlobalFetch(impl: (...args: unknown[]) => unknown): void {
  vi.stubGlobal("fetch", impl)
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage())
  clearFootballDataCache()
  mockProviderFetch.mockReset()
  localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, "dummy-test-token")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("transport selection — Tauri webview uses providerFetch", () => {
  it("validateFootballDataKey calls providerFetch, not webview fetch", async () => {
    stubTauri()
    const globalFetch = vi.fn(async () => mockResponse({}, 500))
    stubGlobalFetch(globalFetch)
    mockProviderFetch.mockResolvedValue(mockResponse({}, 200))
    const result = await validateFootballDataKey("dummy-test-token")
    expect(result).toEqual({ ok: true })
    expect(mockProviderFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockProviderFetch.mock.calls[0] as [
      string,
      { headers?: Record<string, string> },
    ]
    expect(url).toBe(
      "https://api.football-data.org/v4/competitions/PL/standings",
    )
    expect(init.headers?.["X-Auth-Token"]).toBe("dummy-test-token")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("getLeagueTable parses a real standings payload via providerFetch", async () => {
    stubTauri()
    mockProviderFetch.mockResolvedValue(
      mockResponse(MOCK_STANDINGS_RESPONSE, 200),
    )
    const result = await getLeagueTable({ forceRefresh: true })
    expect(result.status).toBe("ok")
    expect(result.table).not.toBeNull()
    expect(result.table?.entries.length).toBeGreaterThan(0)
    expect(
      result.table?.entries.some((entry) =>
        entry.team.includes("Manchester United"),
      ),
    ).toBe(true)
    expect(mockProviderFetch).toHaveBeenCalledTimes(1)
  })

  it("outside Tauri the transport stays plain webview fetch()", async () => {
    // No window stub: node env has no window, so isTauriEnvironment()
    // is false and providerFetch must never be consulted.
    const globalFetch = vi.fn(async () =>
      mockResponse(MOCK_STANDINGS_RESPONSE, 200),
    )
    stubGlobalFetch(globalFetch)
    const result = await getLeagueTable({ forceRefresh: true })
    expect(result.status).toBe("ok")
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(mockProviderFetch).not.toHaveBeenCalled()
  })

  it("a providerFetch failure still surfaces as error, never a fake table", async () => {
    stubTauri()
    mockProviderFetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const result = await getLeagueTable({ forceRefresh: true })
    expect(result.status).toBe("error")
    expect(result.table).toBeNull()
    expect(result.error).toContain("Failed to fetch")
    const validate = await validateFootballDataKey("dummy-test-token")
    expect(validate).toEqual({ ok: false, status: undefined })
  })
})

describe("bad-token taxonomy — a rejected key is never 'unreachable'", () => {
  it("400 with the provider's invalid-token body reads as a key rejection", async () => {
    stubTauri()
    mockProviderFetch.mockResolvedValue(
      mockResponse(
        { message: "Your API token is invalid.", errorCode: 400 },
        400,
      ),
    )
    const validate = await validateFootballDataKey("dummy-test-token")
    expect(validate).toEqual({ ok: false, status: 400 })
    const table = await getLeagueTable({ forceRefresh: true })
    expect(table.status).toBe("error")
    expect(table.error).toContain("rejected the API key")
  })

  it("401 still reads as a key rejection", async () => {
    stubTauri()
    mockProviderFetch.mockResolvedValue(mockResponse({}, 401))
    const validate = await validateFootballDataKey("dummy-test-token")
    expect(validate).toEqual({ ok: false, status: 401 })
  })

  it("500 with a non-token body stays a generic feed failure", async () => {
    stubTauri()
    mockProviderFetch.mockResolvedValue(
      mockResponse({ error: "mock feed down" }, 500),
    )
    const table = await getLeagueTable({ forceRefresh: true })
    expect(table.status).toBe("error")
    expect(table.error).toContain("request failed (500)")
    expect(table.error).not.toContain("rejected the API key")
  })
})

describe("onboarding key-test mapping — football-data vs TMDB", () => {
  it("football-data 400/401/403 map to invalid_key, never unreachable", async () => {
    for (const status of [400, 401, 403]) {
      const outcome = await testOnboardingKey(
        "football-data",
        "dummy-test-token",
        {},
        {
          validateFootballDataKey: async () => ({ ok: false, status }),
        },
      )
      expect(outcome).toEqual({
        ok: false,
        error: "invalid_key",
        message: "That key was rejected. Check the key and try again.",
      })
    }
  })

  it("football-data 500 / no status map to unreachable", async () => {
    for (const result of [
      { ok: false, status: 500 },
      { ok: false, status: undefined },
    ]) {
      const outcome = await testOnboardingKey(
        "football-data",
        "dummy-test-token",
        {},
        {
          validateFootballDataKey: async () => result,
        },
      )
      expect(outcome).toEqual({
        ok: false,
        error: "unavailable",
        message:
          "football-data.org couldn't be reached. Check your connection and try again.",
      })
    }
  })

  it("TMDB keeps its own mapping: 400 is not an invalid key", async () => {
    const outcome = await testOnboardingKey(
      "tmdb",
      "dummy-test-token",
      {},
      {
        validateTmdbKey: async () => ({ ok: false, status: 400 }),
      },
    )
    expect(outcome.error).toBe("unavailable")
    expect(outcome.message).toContain("TMDB couldn't be reached")
  })
})

describe("fallback — providerFetch import failure falls back to webview fetch", () => {
  it("falls back to global fetch when the provider-fetch import rejects", async () => {
    // Isolated: reset the module registry so this test's doMock
    // applies to a fresh import of the feed module only.
    vi.resetModules()
    vi.doMock("@/scripts/lib/provider-fetch.js", () => {
      throw new Error("mock: provider-fetch unavailable")
    })
    stubTauri()
    const globalFetch = vi.fn(async () =>
      mockResponse(MOCK_STANDINGS_RESPONSE, 200),
    )
    stubGlobalFetch(globalFetch)
    const fresh = await import("@/scripts/lib/football-data.ts")
    const result = await fresh.validateFootballDataKey("dummy-test-token")
    expect(result).toEqual({ ok: true })
    expect(globalFetch).toHaveBeenCalledTimes(1)
    vi.doUnmock("@/scripts/lib/provider-fetch.js")
  })
})
