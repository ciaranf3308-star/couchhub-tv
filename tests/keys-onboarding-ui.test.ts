/**
 * @vitest-environment jsdom
 */
// Keys onboarding — dialog UI tests. The keystore is mocked (like
// ai-status.test.ts) and every validator runs through injected fakes
// in `deps`, so no live API is hit. Key values below are synthetic,
// generated at runtime.

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
  rustTest: vi.fn(),
  modelsFetch: vi.fn(),
}))

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: async () => "sk-transient-test-key",
  hasAiKey: async () => hoisted.aiKeyPresent.value,
  saveAiKey: async () => {},
  testAiConnection: (...args: unknown[]) => hoisted.rustTest(...args),
  deleteAiKey: async () => false,
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => hoisted.modelsFetch(...args),
}))

import {
  mountKeysOnboarding,
  openKeysOnboarding,
} from "@/scripts/lib/keys-onboarding-ui.ts"
import type { KeysOnboardingDeps } from "@/scripts/lib/keys-onboarding.ts"
import { FOOTBALL_DATA_KEY_STORAGE_KEY } from "@/scripts/lib/football-data.ts"

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function runtimeKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-x9z4`
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

function dialog(): HTMLDialogElement {
  return document.getElementById(
    "xt-keys-onboarding-dialog",
  ) as HTMLDialogElement
}

function stepTitle(): string {
  return dialog().querySelector("h3")?.textContent ?? ""
}

function makeDeps(overrides: Partial<KeysOnboardingDeps> = {}): KeysOnboardingDeps {
  return {
    hasAiKey: async () => hoisted.aiKeyPresent.value,
    saveAiKey: async () => {},
    testAiConnection: async () => ({ ok: true, modelVerified: true }),
    validateTmdbKey: async () => ({ ok: true }),
    validateFootballDataKey: async () => ({ ok: true }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorageMock(lsStore))
  vi.stubGlobal("sessionStorage", makeStorageMock(ssStore))
  lsStore.clear()
  ssStore.clear()
  document.body.innerHTML = ""
  hoisted.aiKeyPresent.value = false
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

describe("mountKeysOnboarding", () => {
  it("opens on the first missing step and skip resolves skipped + sets the session flag", async () => {
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    expect(dialog()).not.toBeNull()
    expect(stepTitle()).toBe("AI key")
    // The dialog is open (showModal, or the open-attribute fallback).
    expect(
      dialog().open || dialog().hasAttribute("open"),
    ).toBe(true)

    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toEqual({
      outcome: "skipped",
      saved: [],
      reason: "launch",
    })
    expect(sessionStorage.getItem("rs-keys-onboarding-dismissed-v1")).toBe("1")
    expect(document.getElementById("xt-keys-onboarding-dialog")).toBeNull()
  })

  it("openKeysOnboarding is the same entry point", async () => {
    expect(openKeysOnboarding).toBe(mountKeysOnboarding)
  })

  it("saved keys show as done rows and are never re-asked", async () => {
    hoisted.aiKeyPresent.value = true
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    // First step is TMDB — the saved AI key is a done row, not a step.
    expect(stepTitle()).toBe("TMDB key")
    const doneRows = dialog().querySelector('[data-role="done-rows"]')
    expect(doneRows?.textContent).toContain("AI key")
    expect(doneRows?.textContent).toContain("OS credential store")
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toMatchObject({ outcome: "skipped" })
  })

  it("TMDB: test-then-save writes the Settings key and advances to football-data", async () => {
    hoisted.aiKeyPresent.value = true
    const key = runtimeKey("tmdb-")
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    expect(stepTitle()).toBe("TMDB key")

    const keyInput = dialog().querySelector<HTMLInputElement>(
      '[data-role="key-input"]',
    )!
    const testBtn = dialog().querySelector<HTMLButtonElement>(
      '[data-role="test"]',
    )!
    const saveBtn = dialog().querySelector<HTMLButtonElement>(
      '[data-role="save"]',
    )!
    expect(saveBtn.disabled).toBe(true)
    typeInto(keyInput, key)
    await flush()
    expect(testBtn.disabled).toBe(false)
    testBtn.click()
    await flush()
    expect(saveBtn.disabled).toBe(false)
    expect(
      dialog().querySelector('[data-role="message"]')?.textContent,
    ).toMatch(/verified/i)
    saveBtn.click()
    await flush()
    expect(localStorage.getItem("xt_tmdb_key")).toBe(key)
    expect(stepTitle()).toBe("football-data.org key")
    // The just-saved TMDB key shows as a done row, masked.
    const doneRows = dialog().querySelector('[data-role="done-rows"]')
    expect(doneRows?.textContent).toContain(`••••${key.slice(-4)}`)
    expect(doneRows?.textContent).not.toContain(key)

    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toEqual({
      outcome: "skipped",
      saved: ["tmdb"],
      reason: "launch",
    })
  })

  it("TMDB: a rejected key shows a clear error and Save stays disabled", async () => {
    hoisted.aiKeyPresent.value = true
    const promise = mountKeysOnboarding({
      deps: makeDeps({
        validateTmdbKey: async () => ({ ok: false, status: 401 }),
      }),
    })
    await flush()
    const keyInput = dialog().querySelector<HTMLInputElement>(
      '[data-role="key-input"]',
    )!
    const saveBtn = dialog().querySelector<HTMLButtonElement>(
      '[data-role="save"]',
    )!
    typeInto(keyInput, runtimeKey("bad-"))
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="test"]')!
      .click()
    await flush()
    expect(
      dialog().querySelector('[data-role="message"]')?.textContent,
    ).toMatch(/rejected/i)
    expect(saveBtn.disabled).toBe(true)
    expect(localStorage.getItem("xt_tmdb_key")).toBeNull()
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toMatchObject({ outcome: "skipped" })
  })

  it("reason starts at that key when it is missing", async () => {
    hoisted.aiKeyPresent.value = true
    const promise = mountKeysOnboarding({
      reason: "football-data",
      deps: makeDeps(),
    })
    await flush()
    expect(stepTitle()).toBe("football-data.org key")
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toMatchObject({
      outcome: "skipped",
      reason: "football-data",
    })
  })

  it("all saved: completion panel with masked rows, Done resolves completed without skipping", async () => {    hoisted.aiKeyPresent.value = true
    const tmdbKey = runtimeKey("tmdb-")
    const footballKey = runtimeKey("fd-")
    localStorage.setItem("xt_tmdb_key", tmdbKey)
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, footballKey)
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    expect(dialog().querySelector("h3")?.textContent).toBe("All set")
    const text = dialog().textContent ?? ""
    expect(text).toContain(`••••${tmdbKey.slice(-4)}`)
    expect(text).toContain(`••••${footballKey.slice(-4)}`)
    expect(text).not.toContain(tmdbKey)
    expect(text).not.toContain(footballKey)
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="done"]')!
      .click()
    await expect(promise).resolves.toEqual({
      outcome: "completed",
      saved: [],
      reason: "launch",
    })
    expect(sessionStorage.getItem("rs-keys-onboarding-dismissed-v1")).toBeNull()
  })
})

describe("AI step model pre-fill (0.11.22)", () => {
  function modelSelect(): HTMLSelectElement {
    return dialog().querySelector<HTMLSelectElement>(
      '[data-role="model-select"]',
    )!
  }

  function modelCustomInput(): HTMLInputElement {
    return dialog().querySelector<HTMLInputElement>(
      '[data-role="model-custom-input"]',
    )!
  }

  it("no saved model pre-fills gpt-4o-mini — never 'Custom…' with an empty box", async () => {
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    expect(stepTitle()).toBe("AI key")
    // The key test requires a model (empty fails as invalid_model),
    // so the step must open in a testable state.
    expect(modelSelect().value).toBe("gpt-4o-mini")
    expect(modelCustomInput().classList.contains("hidden")).toBe(true)
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toMatchObject({ outcome: "skipped" })
  })

  it("a saved model is kept, not overwritten by the default", async () => {
    localStorage.setItem("xt_ai_model", "gpt-4o")
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    expect(stepTitle()).toBe("AI key")
    expect(modelSelect().value).toBe("gpt-4o")
    expect(modelCustomInput().classList.contains("hidden")).toBe(true)
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toMatchObject({ outcome: "skipped" })
  })

  it("Test with the pre-filled model applies it, so the step is completable with a valid key", async () => {
    const promise = mountKeysOnboarding({ deps: makeDeps() })
    await flush()
    expect(stepTitle()).toBe("AI key")
    const keyInput = dialog().querySelector<HTMLInputElement>(
      '[data-role="key-input"]',
    )!
    const testBtn = dialog().querySelector<HTMLButtonElement>(
      '[data-role="test"]',
    )!
    const saveBtn = dialog().querySelector<HTMLButtonElement>(
      '[data-role="save"]',
    )!
    typeInto(keyInput, runtimeKey("sk-"))
    testBtn.click()
    await flush()
    expect(
      dialog().querySelector('[data-role="message"]')?.textContent,
    ).toMatch(/verified/i)
    expect(saveBtn.disabled).toBe(false)
    // The pre-filled model, not an empty string, is what the test ran with.
    expect(localStorage.getItem("xt_ai_model")).toBe("gpt-4o-mini")
    dialog()
      .querySelector<HTMLButtonElement>('[data-role="skip"]')!
      .click()
    await expect(promise).resolves.toMatchObject({ outcome: "skipped" })
  })
})
