/**
 * @vitest-environment jsdom
 */
// Keys onboarding — launch gate + feature-entry hooks tests.
//
// The shared entry point (keys-feature-entry.ts) is exercised with
// injected fakes for the dialog open, and with the real core for the
// session-dismissal and Settings-sync rules, so no live API is ever
// hit. The Sports Corner "Set up key" buttons are rendered through
// the real hub renderer with no-key feed results. All key values
// below are synthetic, generated at runtime.

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
  modelsFetch: vi.fn(),
}))

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: async () => "<redacted>",
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
  maybeOpenKeysOnboarding,
  runKeysLaunchGate,
} from "@/scripts/lib/keys-feature-entry.ts"
import {
  clearKeysOnboardingDismissal,
  dismissKeysOnboarding,
  getKeysOnboardingStatus,
  saveOnboardingKey,
} from "@/scripts/lib/keys-onboarding.ts"
import {
  getFootballDataApiKey,
  getTmdbApiKey,
  getTmdbEnrichmentState,
  setFootballDataApiKey,
  setTmdbApiKey,
} from "@/scripts/lib/app-settings.js"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  getLeagueTable,
  getNextFixtures,
} from "@/scripts/lib/football-data.ts"
import {
  createMockFetch,
  MOCK_FRIDAY_AFTERNOON_MS,
} from "@/scripts/lib/football-data-mock.ts"
import {
  buildSportsHubModel,
  querySportsHubRoot,
  renderSportsHub,
  type SportsHubCallbacks,
  type SportsHubRoot,
} from "@/scripts/followed-sports-page.ts"

function runtimeKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-x9z4`
}

const FRIDAY = MOCK_FRIDAY_AFTERNOON_MS

function shellHtml(): string {
  return `
  <div data-sports-hub-shell>
    <header>
      <p data-sports-hub-meta></p>
      <p data-sports-hub-stale hidden>Programme guide data may be out of date.</p>
      <button data-sports-hub-follow data-couch-key="sports:unfollow" type="button">Unfollow</button>
    </header>
    <div data-sports-hub-states></div>
    <div data-sports-hub-content></div>
  </div>`
}

function hubRoot(): SportsHubRoot {
  const root = querySportsHubRoot(document)
  if (!root) throw new Error("hub shell missing")
  return root
}

function stubCallbacks(): SportsHubCallbacks & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    onWatch: () => calls.push("watch"),
    onWatchFromStart: () => calls.push("watch-from-start"),
    onReplay: () => calls.push("replay"),
    onOpenGuide: () => calls.push("guide"),
    onToggleFollow: () => calls.push("toggle-follow"),
    onSetupFootballDataKey: () => calls.push("setup-football-data-key"),
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorageMock(lsStore))
  vi.stubGlobal("sessionStorage", makeStorageMock(ssStore))
  lsStore.clear()
  ssStore.clear()
  document.body.innerHTML = ""
  hoisted.aiKeyPresent.value = false
  hoisted.savedAiKeys.length = 0
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
  document.body.innerHTML = ""
})

describe("launch gate (runKeysLaunchGate)", () => {
  it("opens with reason 'launch' when keys are missing", async () => {
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: ["football-data" as const],
      reason: "launch" as const,
    }))
    const result = await runKeysLaunchGate({
      shouldShow: async () => true,
      open,
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0].reason).toBe("launch")
    expect(result?.outcome).toBe("completed")
  })

  it("stays silent when every key is saved", async () => {
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: [],
      reason: "launch" as const,
    }))
    const result = await runKeysLaunchGate({
      shouldShow: async () => false,
      open,
    })
    expect(open).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it("never throws when the status check fails", async () => {
    const open = vi.fn()
    const result = await runKeysLaunchGate({
      shouldShow: async () => {
        throw new Error("store exploded")
      },
      open,
    })
    expect(result).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it("never throws when opening the dialog fails", async () => {
    const result = await runKeysLaunchGate({
      shouldShow: async () => true,
      open: async () => {
        throw new Error("dialog exploded")
      },
    })
    expect(result).toBeNull()
  })

  it("fail-safe is real: a failed AI presence check never prompts for the AI key — and stays silent when the other keys are saved", async () => {
    // Real core (no shouldShow fake): the AI check throws, so the AI
    // key counts as saved (fail closed); TMDB + football are saved
    // too, so there is nothing to ask for.
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd-"))
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: [],
      reason: "launch" as const,
    }))
    const result = await runKeysLaunchGate({
      hasAiKey: async () => {
        throw new Error("STORE:locked")
      },
      open,
    })
    expect(result).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it("a failed AI presence check does not block the prompt for a genuinely missing key (per-key rule, settings-polish-95 w3)", async () => {
    // AI unreadable counts as saved, so the gate never asks for it —
    // but TMDB is genuinely missing, so the gate still opens (at the
    // TMDB step, never at AI). 0.11.22 stayed silent for every key
    // here; one unreadable key must not block the keys that read
    // cleanly.
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: [],
      reason: "launch" as const,
    }))
    const result = await runKeysLaunchGate({
      hasAiKey: async () => {
        throw new Error("STORE:locked")
      },
      open,
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "launch" }),
    )
    expect(result).not.toBeNull()
  })

  it("a failed AI presence check stays silent from a feature entry too when nothing else is missing", async () => {
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd-"))
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: [],
      reason: "ai" as const,
    }))
    const result = await maybeOpenKeysOnboarding("ai", {
      hasAiKey: async () => {
        throw new Error("STORE:locked")
      },
      open,
    })
    expect(result).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})

describe("session skip suppresses every entry (no double-prompt)", () => {
  it("after a launch skip, a feature entry does not open", async () => {
    // Real core: no keys saved, so the gate would show…
    const open = vi.fn(async () => ({
      outcome: "skipped" as const,
      saved: [],
      reason: "ai" as const,
    }))
    const first = await maybeOpenKeysOnboarding("ai", { open })
    expect(open).toHaveBeenCalledTimes(1)
    expect(first?.outcome).toBe("skipped")
    // …but once skipped this session, the next entry stays silent.
    dismissKeysOnboarding()
    const second = await maybeOpenKeysOnboarding("ai", { open })
    expect(second).toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("clearing the dismissal lets the prompt recur (next launch)", async () => {
    dismissKeysOnboarding()
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: [],
      reason: "launch" as const,
    }))
    expect(await runKeysLaunchGate({ open })).toBeNull()
    clearKeysOnboardingDismissal()
    expect(await runKeysLaunchGate({ open })).not.toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe("feature-entry routing", () => {
  it.each([
    ["ai", "ai"],
    ["tmdb", "tmdb"],
    ["football-data", "football-data"],
  ] as const)("reason %s opens the dialog with that reason", async (reason) => {
    const open = vi.fn(async () => ({
      outcome: "completed" as const,
      saved: [],
      reason,
    }))
    const result = await maybeOpenKeysOnboarding(reason, {
      shouldShow: async () => true,
      open,
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0].reason).toBe(reason)
    expect(result?.reason).toBe(reason)
  })
})

describe("Settings sync — onboarding and Settings read/write the same storage", () => {
  it("onboarding save of TMDB is visible in Settings state, and vice versa", async () => {
    expect(getTmdbEnrichmentState()).toBe("on-no-key")
    const key = runtimeKey("tmdb")
    const saved = await saveOnboardingKey("tmdb", key)
    expect(saved.ok).toBe(true)
    expect(getTmdbApiKey()).toBe(key)
    expect(getTmdbEnrichmentState()).toBe("active")
    expect((await getKeysOnboardingStatus()).entries.find((e) => e.id === "tmdb")?.saved).toBe(true)

    // The other direction: a key typed in Settings reads as saved.
    const settingsKey = runtimeKey("tmdb-settings")
    expect(setTmdbApiKey(settingsKey)).toBe(true)
    expect(getTmdbApiKey()).toBe(settingsKey)
    expect((await getKeysOnboardingStatus()).entries.find((e) => e.id === "tmdb")?.saved).toBe(true)
  })

  it("onboarding save of football-data is visible to the feed client, and vice versa", async () => {
    const key = runtimeKey("fd")
    const saved = await saveOnboardingKey("football-data", key)
    expect(saved.ok).toBe(true)
    expect(getFootballDataApiKey()).toBe(key)
    expect(localStorage.getItem(FOOTBALL_DATA_KEY_STORAGE_KEY)).toBe(key)
    expect((await getKeysOnboardingStatus()).entries.find((e) => e.id === "football-data")?.saved).toBe(true)

    const settingsKey = runtimeKey("fd-settings")
    expect(setFootballDataApiKey(settingsKey)).toBe(true)
    expect((await getKeysOnboardingStatus()).entries.find((e) => e.id === "football-data")?.saved).toBe(true)
  })

  it("onboarding save of the AI key goes through Settings' keystore", async () => {
    const key = runtimeKey("sk")
    const saved = await saveOnboardingKey("ai", key)
    expect(saved.ok).toBe(true)
    expect(hoisted.savedAiKeys).toContain(key)
    // …and a stored AI key then reads as saved in onboarding status.
    hoisted.aiKeyPresent.value = true
    expect((await getKeysOnboardingStatus()).entries.find((e) => e.id === "ai")?.saved).toBe(true)
  })
})

describe("Sports Corner 'Set up key' action (no-key table + next matches)", () => {
  async function renderNoKeyHub() {
    document.body.innerHTML = shellHtml()
    const tableResult = await getLeagueTable({
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    const feedResult = await getNextFixtures(5, {
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    expect(tableResult.status).toBe("no-key")
    expect(feedResult.status).toBe("no-key")
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: null,
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: [],
    })
    const callbacks = stubCallbacks()
    renderSportsHub(hubRoot(), model, callbacks, FRIDAY)
    return callbacks
  }

  it("no-key table keeps its honest copy and gains a 'Set up key' button", async () => {
    const callbacks = await renderNoKeyHub()
    const text = document.body.textContent ?? ""
    expect(text).toContain("API key in Settings")
    const button = document.querySelector<HTMLElement>(
      '[data-couch-key="sports:setup-key:table"]',
    )
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe("Set up key")
    button?.click()
    expect(callbacks.calls).toContain("setup-football-data-key")
  })

  it("no-key next matches keeps its honest copy and gains a 'Set up key' button", async () => {
    const callbacks = await renderNoKeyHub()
    const text = document.body.textContent ?? ""
    expect(text).toContain("Next matches need your football-data.org API key")
    const button = document.querySelector<HTMLElement>(
      '[data-couch-key="sports:setup-key:next"]',
    )
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe("Set up key")
    button?.click()
    expect(callbacks.calls).toContain("setup-football-data-key")
  })

  it("no 'Set up key' button appears when the feed has a key", async () => {
    document.body.innerHTML = shellHtml()
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd"))
    const tableResult = await getLeagueTable({
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    const feedResult = await getNextFixtures(5, {
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    expect(tableResult.status).not.toBe("no-key")
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: null,
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(
      document.querySelector('[data-couch-key^="sports:setup-key:"]'),
    ).toBeNull()
  })
})
