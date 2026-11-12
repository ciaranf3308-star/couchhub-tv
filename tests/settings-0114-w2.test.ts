/**
 * @vitest-environment jsdom
 */
// Settings rebuild 0.11.4 (W2 — the 14 fix items): regression tests for the
// testable units + static guards on Settings copy/structure.
// Backup round-trip behaviour lives in tests/backup.test.ts; the
// diagnostics-export leg of the display-diagnostics move lives in
// tests/diagnostic-snapshot.test.ts.
// 0.11.4 integration: Settings is split (W1) — one short page per section
// under src/pages/settings/*.astro, shared behaviour in
// src/scripts/settings/settings-page.js. The `settings` source below is
// the home + every section page + the shared script, so the static
// guards keep checking the same controls in their new homes.
import { describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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
const localStorageStore = new Map<string, string>()
vi.stubGlobal("localStorage", makeStorageMock(localStorageStore))
vi.stubGlobal("sessionStorage", makeStorageMock(new Map<string, string>()))

import {
  getTmdbEnrichmentState,
  setTmdbEnabled,
  setTmdbApiKey,
  getTmdbApiKey,
  resolveUserAgentSelection,
} from "@/scripts/lib/app-settings.js"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")
const read = (rel: string) => readFileSync(join(repo, rel), "utf8")
const settings = [
  read("src/pages/settings.astro"),
  ...readdirSync(join(repo, "src/pages/settings"))
    .filter((f) => f.endsWith(".astro"))
    .map((f) => read(`src/pages/settings/${f}`)),
  read("src/scripts/settings/settings-page.js"),
].join("\n")
const backupJs = read("src/scripts/lib/backup.js")
const followedCard = read("src/scripts/settings/followed-card.ts")
const aiStatusTs = read("src/scripts/lib/ai/status.ts")
const discoverView = read("src/components/DiscoverView.svelte")
const discoverTs = read("src/scripts/lib/discover.ts")
const enJson = JSON.parse(read("src/i18n/en.json")) as Record<string, string>

beforeEach(() => {
  localStorageStore.clear()
})

describe("TMDb toggle honest state (fix #4)", () => {
  it("is 'off' when the toggle is off, regardless of key", () => {
    setTmdbEnabled(false)
    setTmdbApiKey("abc123")
    expect(getTmdbEnrichmentState()).toBe("off")
  })

  it("is 'on-no-key' when on with no key — On must not pretend to be active", () => {
    setTmdbEnabled(true)
    setTmdbApiKey("")
    expect(getTmdbApiKey()).toBe("")
    expect(getTmdbEnrichmentState()).toBe("on-no-key")
  })

  it("is 'active' only when on AND a key is saved", () => {
    setTmdbEnabled(true)
    setTmdbApiKey("abc123")
    expect(getTmdbEnrichmentState()).toBe("active")
  })

  it("renders the honest state line in the card", () => {
    expect(settings).toContain('id="settings-tmdb-state"')
    expect(settings).toContain("On, no key — enrichment inactive. Add a key below.")
    expect(settings).toContain("Enrichment active.")
    // The TMDB disclaimer stays a footnote, not a row.
    expect(settings).toContain(
      "This product uses the TMDB API but is not endorsed or certified by TMDB."
    )
  })
})

describe("User-Agent preset applies on selection (fix #3)", () => {
  it("picking a preset resolves to the preset value", () => {
    const resolved = resolveUserAgentSelection("vlc", "")
    expect(resolved.value).toBe("VLC/3.0.20 LibVLC/3.0.20")
    expect(resolved.overriddenByCustom).toBe(false)
  })

  it("a non-empty custom override wins — and says so", () => {
    const resolved = resolveUserAgentSelection("vlc", "  MyAgent/1.0  ")
    expect(resolved.value).toBe("MyAgent/1.0")
    expect(resolved.overriddenByCustom).toBe(true)
  })

  it("Custom with an empty field resolves to the default (empty) value", () => {
    expect(resolveUserAgentSelection("custom", "")).toEqual({
      value: "",
      overriddenByCustom: false,
    })
    expect(resolveUserAgentSelection("default", "")).toEqual({
      value: "",
      overriddenByCustom: false,
    })
  })

  it("wires a change listener on the preset and a visible override note", () => {
    expect(settings).toContain('uaPresetEl?.addEventListener("change"')
    expect(settings).toContain('id="ua-override-note"')
    expect(settings).toContain("Custom override is active")
    expect(settings).toContain("resolveUserAgentSelection")
    // Helper copy no longer implies the preset waits for Save.
    expect(enJson["settings.network.helperLong"]).toContain(
      "Picking a preset applies it straight away."
    )
    expect(enJson["settings.network.helperLong"]).toContain(
      "A custom string below overrides the preset."
    )
  })
})

describe("Mono audio removed from Settings (fix #1)", () => {
  it("has no Mono row or wiring left on the Settings page", () => {
    expect(settings).not.toContain('id="card-mono-audio"')
    expect(settings).not.toContain('id="settings-mono-audio"')
    expect(settings).not.toContain("getMonoAudioEnabled")
    expect(settings).not.toContain("setMonoAudioEnabled")
  })

  it("keeps the player More-menu copy (mono still lives there)", () => {
    const stream = read("src/scripts/stream/stream.ts")
    expect(stream).toContain('t("settings.monoAudio.title")')
    expect(stream).toContain("getMonoAudioEnabled")
  })
})

describe("Followed scheduled checks show failure (fix #2)", () => {
  it("has a persistent inline error line next to the toggle", () => {
    expect(settings).toContain('id="settings-followed-task-error"')
    expect(followedCard).toContain("setTaskError")
    expect(followedCard).toContain("settings-followed-task-error")
    // The sync reports success/failure instead of swallowing it.
    expect(followedCard).toContain("async function syncScheduledTask(): Promise<boolean>")
  })

  it("does not promise a Windows task off Windows", () => {
    expect(enJson["settings.followed.scheduledHintNonWindows"]).toContain(
      "Checking while the app is closed needs the Windows desktop app"
    )
    expect(followedCard).toContain("scheduledHintNonWindows")
    expect(followedCard).toContain("settings-followed-task-note")
  })
})

describe("AI card copy cut (fix #5)", () => {
  it("header is one privacy sentence + one billing sentence", () => {
    expect(settings).toContain(
      "Only your question and a short list of candidate titles go to your provider — never your watch history, credentials or stream links, unless you switch sharing on below."
    )
    expect(settings).toContain(
      "Billed separately by your provider; a ChatGPT subscription does not cover API use."
    )
  })

  it("Cost row and four-steps block are gone", () => {
    expect(settings).not.toContain("Set up in four steps")
    expect(settings).not.toContain("AI questions are billed separately by your provider")
    expect(settings).not.toContain("A ChatGPT subscription does not include API usage")
    expect(enJson["settings.ai.enableHelper"]).not.toContain("Off by default")
  })
})

describe("Model single control (fix #6)", () => {
  it("select + custom field + label share one bordered control group", () => {
    const groupIdx = settings.indexOf('id="settings-ai-model-control"')
    const selectIdx = settings.indexOf('id="settings-ai-model"')
    const customIdx = settings.indexOf('id="settings-ai-model-custom"')
    const labelIdx = settings.indexOf('id="settings-ai-model-custom-label"')
    expect(groupIdx).toBeGreaterThan(-1)
    expect(selectIdx).toBeGreaterThan(groupIdx)
    expect(customIdx).toBeGreaterThan(selectIdx)
    expect(labelIdx).toBeGreaterThan(groupIdx)
    expect(labelIdx).toBeLessThan(customIdx)
    expect(settings).toContain("resolveAiModelControl")
  })
})

describe("Fork links (fix #9)", () => {
  it("Report a bug + Send feedback point at the fork, not upstream", () => {
    expect(settings).toContain(
      "https://github.com/ciaranf3308-star/couchhub-tv/issues/new/choose"
    )
    expect(settings).toContain(
      "https://github.com/ciaranf3308-star/couchhub-tv/discussions/new/choose"
    )
    expect(settings).not.toContain("infinitel8p/Extreme-InfiniTV/issues")
    expect(settings).not.toContain("infinitel8p/Extreme-InfiniTV/discussions")
  })
})

describe("Display diagnostics off the About surface (fix #8)", () => {
  it("has no diagnostics line element on the page", () => {
    expect(settings).not.toContain('id="update-display-diag"')
    expect(settings).toContain("window.__xtDisplayDiagnostics")
  })
})

describe("Resume last channel control (fix #11)", () => {
  it("exists in both the Live TV and Playback surfaces, wired to one store", () => {
    expect(settings).toContain('id="settings-resume-last-livetv"')
    expect(settings).toContain('id="settings-resume-last-playback"')
    expect(settings).toContain("getLivetvResumeLastChannel")
    expect(settings).toContain("setLivetvResumeLastChannel")
    expect(enJson["settings.livetv.resumeLastHelper"]).toContain(
      "opening Live TV jumps straight back to the last channel you watched"
    )
  })
})

describe("Backup copy is honest (fixes #7, #10)", () => {
  it("says the TMDb + AI keys are never included", () => {
    expect(enJson["settings.backup.helperLong"]).toContain(
      "The TMDb key and the AI key are never included"
    )
    expect(enJson["settings.backup.helperLong"]).toContain("followed series")
    expect(enJson["settings.backup.helperLong"]).toContain("profiles")
  })

  it("no longer exports the TMDb key, theme/accent, haptics or discord", () => {
    expect(backupJs).not.toContain("tmdbKey: getTmdbApiKey()")
    expect(backupJs).not.toContain("getDiscordClientId()")
    expect(backupJs).not.toContain("setDiscordClientId")
    expect(backupJs).not.toContain("getAccent()")
    expect(backupJs).not.toContain("setAccent(")
    expect(backupJs).not.toContain("getHapticsEnabled()")
  })

  it("reset dialog says what the snapshot restores — and what it does not", () => {
    expect(enJson["settings.danger.dialogBody"]).toContain("Restore last backup brings back")
    expect(enJson["settings.danger.dialogBody"]).toContain("TMDb key (never stored in a backup")
    expect(enJson["settings.danger.dialogBody"]).toContain("cached lists (they rebuild")
    expect(enJson["settings.danger.dialogBody"]).not.toContain("This can't be undone")
    expect(enJson["settings.danger.restoreLastHelper"]).toContain(
      "It does not restore the TMDb key or cached lists."
    )
  })
})

describe("AI status / Test connection defect (0.11.4)", () => {
  it("testAiConnection no longer gates on the Enable toggle", () => {
    const fn = aiStatusTs.slice(
      aiStatusTs.indexOf("export async function testAiConnection")
    )
    expect(fn).not.toContain("getAiEnabled()")
    expect(fn).toContain("testAiConnectionRust(endpoint, model)")
  })

  it("getAiStatus tells the truth when a key is saved but AI is off", () => {
    expect(aiStatusTs).toContain("Key saved. Turn on AI Discovery to use it.")
  })

  it("the Test handler names what is actually missing instead of the generic line", () => {
    expect(settings).toContain("Not set up yet: ")
    expect(settings).toContain("turn on AI Discovery")
    expect(settings).toContain("save an API key")
  })

  it("the key field shows an unmistakable saved state", () => {
    expect(settings).toContain('id="settings-ai-key-saved-badge"')
    expect(settings).toContain("settings.ai.keySavedBadge")
    expect(settings).toContain("settings.ai.keySavedPlaceholder")
    expect(enJson["settings.ai.keySavedBadge"]).toBe("Key saved")
    expect(enJson["settings.ai.keySavedPlaceholder"]).toMatch(/Key saved/)
  })

  it("paste-masking: both key fields are password type with no reveal path", () => {
    // Video evidence (0.11.2): a pasted key rendered in clear text on
    // the projector. The only flip path was the reveal button, which
    // is gone; nothing in the page may flip a key field to text, on
    // paste or otherwise. A secret must never render in clear text
    // on a living-room screen.
    expect(settings).not.toContain('id="settings-ai-reveal"')
    expect(settings).not.toContain('id="settings-tmdb-reveal"')
    expect(settings).not.toContain("aiRevealBtn")
    expect(settings).not.toContain("tmdbRevealBtn")
    const tmdbInput = settings.slice(
      settings.indexOf('id="settings-tmdb-key"'),
      settings.indexOf('id="settings-tmdb-key"') + 400
    )
    const aiInput = settings.slice(
      settings.indexOf('id="settings-ai-key"'),
      settings.indexOf('id="settings-ai-key"') + 400
    )
    expect(tmdbInput).toContain('type="password"')
    expect(aiInput).toContain('type="password"')
    // No code anywhere in the Settings page assigns an input type.
    expect(settings).not.toMatch(/\.type\s*=\s*["']text["']/)
    expect(settings).not.toContain("KeyInput.type")
  })
})

describe("Discover agrees with Settings (0.11.4)", () => {
  it("rankDiscover takes an explicit forceAi for Ask AI taps", () => {
    expect(discoverTs).toContain("forceAi")
    expect(discoverTs).toContain("opts.forceAi || isNaturalLanguageQuery(query)")
  })

  it("Discover fires AI for a typed query or a quick pick when asked", () => {
    expect(discoverView).toContain("forceAi: true")
    // askAi is mood-aware: a quick pick asks about its label.
    expect(discoverView).toContain(
      "MOOD_PRESETS.find((p) => p.id === activeMood)?.label"
    )
  })

  it("Ask AI is visible at the results in Manual AND Automatic, for queries and moods", () => {
    expect(discoverView).not.toContain("!aiAuto && !activeMood")
    expect(discoverView).toContain("Ask AI about")
    expect(discoverView).toContain("askAiLabel")
  })

  it("a local rail with connected AI says why it is local", () => {
    expect(discoverView).toContain("data-local-note")
    expect(discoverView).toContain("Quick picks are filtered locally")
    expect(discoverView).toContain("Local results so far")
  })
})
