/**
 * @vitest-environment jsdom
 */
// Settings polish 95, worker 3: locales + keys-card refresh + fail-closed
// presence.
//
// - GAP 4 (locales): the 6 keys reworded by the 0.11.23 rebuild must carry
//   the NEW wording in every locale (they shipped English-only / stale),
//   and the 12 section descriptions + 3 fail-closed strings must exist
//   translated in every locale — no English left in place where the
//   locale differs from en.
// - Keys-card refresh: no Settings refresh handler may gate on
//   outcome === "completed" only (save-then-skip left the card stale).
// - Fail-closed presence: every saved-credential check is tri-state
//   (present / absent / unreadable), per key, with one retry.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const LOCALES = [
  "ar", "de", "es", "fr", "hi", "id", "it", "ja",
  "nl", "pl", "pt-BR", "ru", "tr", "ur", "zh",
] as const

type Messages = Record<string, string>

function loadLocale(code: string): Messages {
  return JSON.parse(
    readFileSync(resolve(__dirname, `../src/i18n/${code}.json`), "utf8"),
  ) as Messages
}

const en = loadLocale("en")
const locales = Object.fromEntries(
  LOCALES.map((code) => [code, loadLocale(code)]),
) as Record<(typeof LOCALES)[number], Messages>

/** Keys whose English wording changed in the 0.11.23 rebuild. */
const CHANGED_KEYS = [
  "settings.danger.helper",
  "page.settings.sub",
  "settings.backup.helperLong",
  "settings.danger.helperLong",
  "settings.danger.dialogBody",
  "settings.danger.restoreLastHelper",
] as const

const SECTION_SLUGS = [
  "playlists", "profile", "display", "playback", "live-tv", "followed",
  "discover-ai", "casting", "data-backup", "app-updates",
  "help-diagnostics", "danger",
] as const

/** New keys added by this polish (section descs + fail-closed strings). */
const NEW_KEYS = [
  ...SECTION_SLUGS.map((slug) => `settings.sectionDesc.${slug}`),
  "settings.keys.checkFailed",
  "settings.keys.recheck",
  "settings.ai.keyUnknown",
] as const

/** Old (pre-0.11.23) English for the page sub — no locale may still carry it. */
const OLD_SUB_EN = "Playlists, preferences, cache, and the app itself."

/** Per-locale "scroll" word: the new page sub tells the user to scroll;
 *  the old one never mentioned it, so this is the stale-copy tripwire. */
const SCROLL_WORD: Record<(typeof LOCALES)[number], string> = {
  ar: "مرّر",
  de: "scrolle",
  es: "desplázate",
  fr: "défiler",
  hi: "स्क्रॉल",
  id: "gulir",
  it: "scorri",
  ja: "スクロール",
  nl: "scrol",
  pl: "przewiń",
  "pt-BR": "role",
  ru: "прокрутите",
  tr: "kaydırın",
  ur: "اسکرول",
  zh: "滚动",
}

describe("GAP 4 — locales carry the 0.11.23 friendly copy", () => {
  it("every locale has every changed key", () => {
    for (const code of LOCALES) {
      for (const key of CHANGED_KEYS) {
        expect(locales[code][key], `${code} missing ${key}`).toBeTruthy()
      }
    }
  })

  it("no locale still carries the old wording for a changed key", () => {
    for (const code of LOCALES) {
      const d = locales[code]
      // The honest danger/backup copy names the football-data key,
      // which no pre-0.11.23 translation mentioned.
      for (const key of [
        "settings.backup.helperLong",
        "settings.danger.helperLong",
        "settings.danger.dialogBody",
        "settings.danger.restoreLastHelper",
      ] as const) {
        expect(d[key], `${code} ${key} is stale (no football-data key)`).toContain(
          "football-data",
        )
      }
      // The danger helper names the never-wiped AI key; the old text did not.
      // (es/fr/pt-BR write "IA", ar writes it out — hence the marker.)
      const aiMarker: string =
        code === "ar"
          ? "الذكاء الاصطناعي"
          : code === "es"
            ? "clave de IA"
            : code === "pt-BR"
              ? "chave de IA"
              : code === "fr"
                ? "clé IA"
                : "AI"
      expect(
        d["settings.danger.helper"].includes(aiMarker),
        `${code} settings.danger.helper is stale (no AI key)`,
      ).toBe(true)
      // The page sub is the new friendly line, not the old one-liner.
      expect(d["page.settings.sub"]).not.toBe(OLD_SUB_EN)
      expect(d["page.settings.sub"]).not.toBe(en["page.settings.sub"])
      expect(d["page.settings.sub"]).toContain(SCROLL_WORD[code])
    }
  })

  it("the reworded HTML strings keep their emphasis span in every locale", () => {
    for (const code of LOCALES) {
      for (const key of ["settings.danger.helperLong", "settings.danger.dialogBody"] as const) {
        expect(locales[code][key]).toContain('<span class="text-fg font-medium">')
        expect(locales[code][key]).toContain("</span>")
      }
    }
  })

  it("every locale has every new key, translated (no English left in place)", () => {
    for (const code of LOCALES) {
      for (const key of NEW_KEYS) {
        const value = locales[code][key]
        expect(value, `${code} missing ${key}`).toBeTruthy()
        expect(value, `${code} ${key} left in English`).not.toBe(en[key])
      }
    }
  })

  it("settings-index descKey matches the locale keys and the English fallback", async () => {
    const { SETTINGS_SECTIONS } = await import("@/scripts/settings/settings-index.ts")
    expect(SETTINGS_SECTIONS).toHaveLength(12)
    for (const section of SETTINGS_SECTIONS) {
      expect(section.descKey).toBe(`settings.sectionDesc.${section.slug}`)
      // English fallback stays in sync with the keyed value.
      expect(en[section.descKey]).toBe(section.desc)
      for (const code of LOCALES) {
        expect(locales[code][section.descKey], `${code} missing ${section.descKey}`).toBeTruthy()
        expect(locales[code][section.descKey]).not.toBe(en[section.descKey])
      }
    }
  })
})

describe("keys-card refresh is not gated on completed-only (static pin)", () => {
  it("no Settings refresh handler gates on outcome === 'completed'", () => {
    const page = readFileSync(
      resolve(__dirname, "../src/scripts/settings/settings-page.js"),
      "utf8",
    )
    expect(page).not.toContain('outcome === "completed"')
    // One shared refresh, called from all three setup-button handlers.
    expect(page.match(/await refreshKeysCardsAfterOnboarding\(result\)/g)).toHaveLength(3)
    expect(page).toContain("saved.length === 0")
  })

  it("both recheck buttons exist and are keyed", () => {
    const section = readFileSync(
      resolve(__dirname, "../src/components/settings/sections/discover-ai.astro"),
      "utf8",
    )
    expect(section).toContain('id="settings-tmdb-recheck"')
    expect(section).toContain('id="settings-football-data-recheck"')
    expect(section.match(/data-i18n="settings\.keys\.recheck"/g)).toHaveLength(2)
  })
})

// --- Tri-state presence (jsdom) -------------------------------------------

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

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: async () => null,
  hasAiKey: async () => false,
  saveAiKey: async () => undefined,
  testAiConnection: async () => ({ ok: true }),
  deleteAiKey: async () => false,
}))

import {
  getFootballDataApiKeyPresence,
  getFootballDataEnrichmentState,
  getTmdbApiKeyPresence,
  getTmdbEnrichmentState,
} from "@/scripts/lib/app-settings.js"
import {
  getKeysOnboardingStatus,
  shouldShowKeysOnboarding,
  validateSavedKey,
} from "@/scripts/lib/keys-onboarding.ts"
import { FOOTBALL_DATA_KEY_STORAGE_KEY } from "@/scripts/lib/football-data.ts"

function runtimeKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-x9z4`
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorageMock(lsStore))
  vi.stubGlobal("sessionStorage", makeStorageMock(ssStore))
  lsStore.clear()
  ssStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("tri-state presence for localStorage keys", () => {
  it("present / absent read cleanly", () => {
    expect(getTmdbApiKeyPresence()).toBe("absent")
    expect(getFootballDataApiKeyPresence()).toBe("absent")
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeKey("fd-"))
    expect(getTmdbApiKeyPresence()).toBe("present")
    expect(getFootballDataApiKeyPresence()).toBe("present")
    expect(getTmdbEnrichmentState()).toBe("active")
    expect(getFootballDataEnrichmentState()).toBe("active")
  })

  it("a failed read is 'unreadable', never 'absent' — and retried once", () => {
    const throwing = {
      ...makeStorageMock(lsStore),
      getItem: vi.fn(() => {
        throw new Error("storage locked")
      }),
    }
    vi.stubGlobal("localStorage", throwing)
    expect(getTmdbApiKeyPresence()).toBe("unreadable")
    expect(getFootballDataApiKeyPresence()).toBe("unreadable")
    // One retry per check: two calls per key.
    expect(throwing.getItem).toHaveBeenCalledTimes(4)
    expect(getTmdbEnrichmentState()).toBe("unknown")
    expect(getFootballDataEnrichmentState()).toBe("unknown")
  })

  it("a read that fails once then succeeds is not 'unreadable'", () => {
    localStorage.setItem("xt_tmdb_key", runtimeKey("tmdb-"))
    const flaky = {
      ...makeStorageMock(lsStore),
      getItem: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("transient")
        })
        .mockImplementation((key: string) =>
          lsStore.has(key) ? lsStore.get(key)! : null,
        ),
    }
    vi.stubGlobal("localStorage", flaky)
    expect(getTmdbApiKeyPresence()).toBe("present")
  })
})

describe("onboarding status is tri-state per key", () => {
  it("an unreadable TMDB / football-data key counts as saved, never missing", async () => {
    const throwing = {
      ...makeStorageMock(lsStore),
      getItem: vi.fn((key: string) => {
        if (key === "xt_tmdb_key" || key === FOOTBALL_DATA_KEY_STORAGE_KEY) {
          throw new Error("storage locked")
        }
        return lsStore.has(key) ? lsStore.get(key)! : null
      }),
    }
    vi.stubGlobal("localStorage", throwing)
    const status = await getKeysOnboardingStatus({ hasAiKey: async () => true })
    expect(status.missing).toEqual([])
    expect(status.allSaved).toBe(true)
    expect(status.unreadable).toEqual(["tmdb", "football-data"])
    expect(status.entries.find((e) => e.id === "tmdb")!.saved).toBe(true)
    expect(status.entries.find((e) => e.id === "tmdb")!.unreadable).toBe(true)
    await expect(shouldShowKeysOnboarding({ hasAiKey: async () => true })).resolves.toBe(false)
  })

  it("one unreadable key never blocks the prompt for a genuinely missing key", async () => {
    const throwing = {
      ...makeStorageMock(lsStore),
      getItem: vi.fn((key: string) => {
        if (key === "xt_tmdb_key") throw new Error("storage locked")
        return lsStore.has(key) ? lsStore.get(key)! : null
      }),
    }
    vi.stubGlobal("localStorage", throwing)
    // TMDB unreadable (counts saved); football-data genuinely missing.
    const status = await getKeysOnboardingStatus({ hasAiKey: async () => true })
    expect(status.missing).toEqual(["football-data"])
    expect(status.unreadable).toEqual(["tmdb"])
    await expect(shouldShowKeysOnboarding({ hasAiKey: async () => true })).resolves.toBe(true)
  })

  it("validateSavedKey reports 'unavailable', never 'no_key', for an unreadable stored key", async () => {
    const throwing = {
      ...makeStorageMock(lsStore),
      getItem: vi.fn((key: string) => {
        if (key === "xt_tmdb_key" || key === FOOTBALL_DATA_KEY_STORAGE_KEY) {
          throw new Error("storage locked")
        }
        return lsStore.has(key) ? lsStore.get(key)! : null
      }),
    }
    vi.stubGlobal("localStorage", throwing)
    await expect(validateSavedKey("tmdb")).resolves.toMatchObject({
      ok: false,
      error: "unavailable",
    })
    await expect(validateSavedKey("football-data")).resolves.toMatchObject({
      ok: false,
      error: "unavailable",
    })
  })
})
