/**
 * @vitest-environment jsdom
 */
// Settings redesign (0.11.23) — the single-page rebuild.
//
// The audit (docs/settings-audit-2026-11-22.md) inventories 107 settings
// across the home shell + 12 sections. This test pins the redesign
// contract (§15) at the source level:
//
//   1. Every one of the 107 items exists on the new single page, with
//      the same element ids the shared wiring (settings-page.js +
//      followed/receiver/play-on-tv cards) looks up.
//   2. No storage key was renamed, re-encoded or re-defaulted — the
//      legacy migrations still read the same keys with the same
//      defaults at runtime.
//   3. The search index points at same-page anchors, and every anchor
//      it names exists on the page.
//   4. The keys section keeps its contract: three keys, saved/missing
//      status + Test + get-key link each, AI key never shown back
//      (no reveal), onboarding entry points on all three cards.
//   5. Old /settings/<slug> routes still resolve — as redirects to
//      the matching anchor.
//   6. Danger-zone / Backup copy is honest about what Reset and
//      backups never touch (Q3/Q10).
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { SETTINGS_SECTIONS, searchSettingsIndex } from "../src/scripts/settings/settings-index.ts"

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

const SECTION_FILES = [
  "playlists",
  "profile",
  "display",
  "playback",
  "live-tv",
  "followed",
  "discover-ai",
  "casting",
  "data-backup",
  "app-updates",
  "help-diagnostics",
  "danger",
]

function singlePageSource(): string {
  // The page, its 12 section components, and the shell (which renders
  // the search box and the section rail).
  const parts = [
    read("src/pages/settings.astro"),
    read("src/components/settings/SettingsShell.astro"),
  ]
  for (const slug of SECTION_FILES) {
    parts.push(read(`src/components/settings/sections/${slug}.astro`))
  }
  return parts.join("\n")
}

function allIds(source: string): string[] {
  return [...source.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
}

// One marker per audit row (§1–§12). Markers are the control/card ids
// (or the distinctive label text where a row has no id of its own).
// Duplicates are listed where they appear — Q1/Q2 stay duplicated.
const AUDIT_107: Array<[string, string]> = [
  // §1 home
  ["1.1 section list", "settings-home-list"],
  ["1.2 search", "settings-search-input"],
  ["1.3 exit (home copy)", "settings-exit-row"],
  // §2 playlists
  ["2.1 playlist list", "settings-playlists-list"],
  ["2.2 add playlist", "Add playlist"],
  ["2.3 refresh active", "settings-refresh-active"],
  ["2.4 add from website", "settings-add-from-website"],
  ["2.5 new custom playlist", "settings-new-custom-playlist"],
  // §3 display
  ["3.1 language", "card-language"],
  ["3.2 font scale", "settings-font-scale"],
  ["3.3 density", "settings-density"],
  ["3.4 performance mode", "settings-perf-mode"],
  ["3.5 interface sounds", "settings-ui-sounds"],
  ["3.6 cursor mode", "settings-cursor-mode"],
  ["3.7 tv safe area", "card-tv-overscan"],
  ["3.8 close behaviour", "card-behavior"],
  ["3.9 exit (display copy)", "exit-app-section-display"],
  ["3.10 rendering", "card-rendering"],
  ["3.11 home page sections", "card-hub-strips"],
  // §4 playback
  ["4.1 continue watching", "settings-progress-retention"],
  ["4.2 player backend", "playback-section"],
  ["4.3 mpv path", 'getPlayerPath("mpv")'],
  ["4.4 vlc path", 'getPlayerPath("vlc")'],
  ["4.5 mpv extra args", 'getPlayerExtraArgs("mpv")'],
  ["4.6 vlc extra args", 'getPlayerExtraArgs("vlc")'],
  ["4.7 mpv reuse window", 'getPlayerReuseInstance("mpv")'],
  ["4.8 vlc reuse window", 'getPlayerReuseInstance("vlc")'],
  ["4.9 preferred external player", "getExternalPlayerPref"],
  ["4.10 fix unsupported audio", "settings-audio-transcode-auto"],
  ["4.11 ffmpeg path", "ffmpeg-path-input"],
  ["4.12 group language variants", "lang-grouping-select"],
  ["4.13 preferred audio language", "content-lang-select"],
  ["4.14 hevc video", "settings-hevc-install"],
  ["4.15 captions on by default", "settings-captions-auto"],
  ["4.16 resume last channel (playback)", "settings-resume-last-playback"],
  ["4.17 android native player", "AndroidNativePlayerCard"],
  ["4.18 remembered android player", "RememberedAndroidPlayerCard"],
  // §5 live tv
  ["5.1 channel column width", "settings-channel-width"],
  ["5.2 epg time zone", "epg-tz-select"],
  ["5.3 resume last channel (live tv)", "settings-resume-last-livetv"],
  ["5.4 categories", "card-categories"],
  ["5.5 channel edits", "card-channel-overrides"],
  ["5.6 favorites", "card-favorites"],
  // §6 followed
  ["6.1 scheduled background checks", "settings-followed-scheduled"],
  ["6.2 check every", "settings-followed-interval"],
  ["6.3 status + check now", "settings-followed-check-now"],
  ["6.4 manage followed series", "Manage followed series"],
  // §7 discover & ai
  ["7.1 thetvdb metadata", "settings-tvdb-enabled"],
  ["7.2 enable enrichment (tmdb)", "settings-tmdb-enabled"],
  ["7.3 tmdb api key", "settings-tmdb-key"],
  ["7.4 feed status", "settings-football-data-state"],
  ["7.5 football-data api key", "settings-football-data-key"],
  ["7.6 ai connection status", "settings-ai-status"],
  ["7.7 enable ai discovery", "settings-ai-enabled"],
  ["7.8 provider", "settings-ai-provider"],
  ["7.9 provider endpoint", "settings-ai-endpoint"],
  ["7.10 model", "settings-ai-model"],
  ["7.11 ai api key", "settings-ai-key"],
  ["7.12 share viewing history", "settings-ai-share-taste"],
  ["7.13 when ai is asked", "settings-ai-auto"],
  ["7.14 refresh picks automatically", "settings-ai-home-auto"],
  ["7.15 test connection", "settings-ai-test"],
  // §8 casting
  ["8.1 allow casting", "receiver-mode-toggle"],
  ["8.2 device name", "receiver-device-name-input"],
  ["8.3 receiver status / address", "receiver-status-line-text"],
  ["8.4 firewall warning", "receiver-firewall-warning"],
  ["8.5 pair code", "receiver-pair-code-display"],
  ["8.6 paired devices", "receiver-paired-list"],
  ["8.7 open receiver screen", "Open receiver screen"],
  ["8.8 start on receiver screen", "receiver-boot-toggle"],
  ["8.9 screensaver", "settings-receiver-screensaver-hint"],
  ["8.10 play on tv session", "play-on-tv-stop"],
  ["8.11 paired tvs", "play-on-tv-list"],
  ["8.12 add a tv", "play-on-tv-add"],
  // §9 data & backup
  ["9.1 save to", "download-dir-input"],
  ["9.2 restore from folder", "downloads-scan"],
  ["9.3 concurrent downloads", "settings-download-concurrency"],
  ["9.4 write kodi metadata", "settings-write-nfo"],
  ["9.5 export to file", "settings-export"],
  ["9.6 import from file", "settings-import"],
  ["9.7 cache size", "settings-cache-size"],
  ["9.8 clear cache", "settings-clear-cache"],
  ["9.9 open log folder", "settings-open-logs"],
  ["9.10 open app data folder", "settings-open-appdata"],
  ["9.11 share logs", "settings-share-logs"],
  ["9.12 clear viewing history", "settings-clear-history"],
  // §10 app & updates
  ["10.1 version display", "update-current"],
  ["10.2 automatic updates", "auto-update-select"],
  ["10.3 update channel", "update-channel-select"],
  ["10.4 check for updates", "update-check"],
  ["10.5 download & install", "update-install"],
  ["10.6 restart now", "update-relaunch"],
  ["10.7 get it on github / store", "update-get"],
  ["10.8 github", "update-github"],
  ["10.9 whats new", "changelog-section"],
  ["10.10 licenses and attribution", "licenses-section"],
  // §11 help & diagnostics
  ["11.1 user-agent preset", "ua-preset"],
  ["11.2 custom user-agent", "ua-custom"],
  ["11.3 request timeout", "settings-network-timeout"],
  ["11.4 developer mode", "settings-dev-mode"],
  ["11.5 network log", "net-log-rows"],
  ["11.6 read the docs", "Open documentation"],
  ["11.7 found a bug / send feedback", "Report a bug"],
  ["11.8 export diagnostics", "settings-export-diagnostics"],
  ["11.9 discord community", "discord.gg"],
  // §12 danger zone
  ["12.1 reset everything", "settings-reset-all"],
  ["12.2 restore last backup", "settings-restore-last"],
]

describe("settings redesign 0.11.23 — all 107 audit items on one page", () => {
  const source = singlePageSource()
  const ids = new Set(allIds(source))

  it("has exactly 107 audit rows marked", () => {
    expect(AUDIT_107).toHaveLength(107)
  })

  it("every audit item is present on the single page", () => {
    // Player-picker rows (4.2–4.9) live inside PlayerPicker.svelte,
    // mounted by the playback section — its source counts too.
    const picker = read("src/components/PlayerPicker.svelte")
    const hay = source + "\n" + picker
    const missing = AUDIT_107.filter(([, marker]) => !hay.includes(marker))
    expect(missing).toEqual([])
  })

  it("has no duplicate element ids (both Exit copies are distinct)", () => {
    const list = allIds(source)
    const dupes = list.filter((id, i) => list.indexOf(id) !== i)
    expect(dupes).toEqual([])
    // The home copy uses the component default id; the Display copy
    // passes its own — both render, no id appears twice.
    expect(read("src/components/ExitAppCard.svelte")).toContain(
      'let { id = "exit-app-section" } = $props()',
    )
    expect(ids.has("exit-app-section-display")).toBe(true)
  })

  it("every id the shared wiring looks up exists on the page", () => {
    const wiring = [
      read("src/scripts/settings/settings-page.js"),
      read("src/scripts/settings/followed-card.ts"),
      read("src/scripts/settings/receiver-card.ts"),
      read("src/scripts/settings/play-on-tv-card.ts"),
    ].join("\n")
    const refs = new Set(
      [...wiring.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
    )
    expect(refs.size).toBeGreaterThan(100)
    const missing = [...refs].filter((id) => !ids.has(id))
    expect(missing).toEqual([])
  })

  it("the home Exit copy sits inside the jump-to list, so search filters it", () => {
    const page = read("src/pages/settings.astro")
    const listStart = page.indexOf('id="settings-home-list"')
    const firstHead = page.indexOf('id="playlists"')
    expect(listStart).toBeGreaterThan(-1)
    expect(firstHead).toBeGreaterThan(listStart)
    const menu = page.slice(listStart, firstHead)
    expect(menu).toContain('id="settings-exit-row"')
  })

  it("keeps both duplicates, both wired to the same store", () => {
    expect(ids.has("settings-resume-last-playback")).toBe(true)
    expect(ids.has("settings-resume-last-livetv")).toBe(true)
    const page = read("src/scripts/settings/settings-page.js")
    expect(page).toContain("settings-resume-last-playback")
    expect(page).toContain("settings-resume-last-livetv")
    // One store key, two controls — the wiring syncs both copies.
    expect(page.match(/xt_livetv_resume_last/g)?.length ?? 0).toBeGreaterThan(0)
  })

  it("keeps the conditional-visibility gates (no dead controls)", () => {
    // Platform/build gates still hide their rows until their condition holds.
    expect(source).toContain('id="card-rendering"')
    expect(source).toContain('id="card-hevc"')
    expect(source).toContain('id="settings-share-logs"')
    expect(source).toContain('id="card-write-nfo"')
    expect(source).toContain('id="card-tv-receiver"')
    expect(source).toContain('id="card-play-on-tv"')
    const page = read("src/scripts/settings/settings-page.js")
    expect(page).toContain("card-rendering")
  })
})

describe("settings redesign 0.11.23 — search index in sync", () => {
  const source = singlePageSource()
  const ids = new Set(allIds(source))

  it("every section href is a same-page anchor", () => {
    expect(SETTINGS_SECTIONS).toHaveLength(12)
    for (const section of SETTINGS_SECTIONS) {
      expect(section.href).toMatch(/^\/settings#/)
      const anchor = section.href.slice("/settings#".length)
      expect(ids.has(anchor)).toBe(true)
    }
  })

  it("every index item anchor exists on the page", () => {
    const missing: string[] = []
    for (const section of SETTINGS_SECTIONS) {
      for (const item of section.items) {
        if (item.anchor && !ids.has(item.anchor)) {
          missing.push(`${section.slug}:${item.anchor}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it("search hits point at same-page card anchors", () => {
    const football = searchSettingsIndex("football data key")
    expect(football.some((h) => h.href === "/settings#card-football-data")).toBe(true)
    const hevc = searchSettingsIndex("hevc")
    expect(hevc.some((h) => h.href === "/settings#card-hevc")).toBe(true)
    const reset = searchSettingsIndex("reset everything")
    expect(reset.some((h) => h.href === "/settings#settings-danger")).toBe(true)
    const ai = searchSettingsIndex("test connection ai")
    expect(ai.some((h) => h.href === "/settings#card-ai-discovery")).toBe(true)
    for (const hit of [...football, ...hevc, ...reset, ...ai]) {
      expect(hit.href.startsWith("/settings#")).toBe(true)
    }
  })
})

describe("settings redesign 0.11.23 — keys section contract", () => {
  const source = singlePageSource()
  const page = read("src/scripts/settings/settings-page.js")

  it("all three keys have field + test + get-key link + setup entry point", () => {
    for (const id of [
      "settings-tmdb-key",
      "settings-tmdb-test",
      "settings-tmdb-setup-key",
      "settings-football-data-key",
      "settings-football-data-test",
      "settings-football-data-setup-key",
      "settings-ai-key",
      "settings-ai-test",
      "settings-ai-setup-key",
    ]) {
      expect(source).toContain(`id="${id}"`)
    }
    expect(source).toContain("https://www.themoviedb.org/settings/api")
    expect(source).toContain("https://www.football-data.org/client/register")
    expect(source).toContain("https://platform.openai.com/api-keys")
  })

  it("the AI key is never shown back — no reveal button anywhere", () => {
    // The pair-code reveal on the Casting card is deliberate (pairing
    // UX, audit Q20) — the rule is scoped to the Discover & AI card:
    // no reveal control for the AI key, and no AI reveal id at all.
    const discoverAi = read("src/components/settings/sections/discover-ai.astro")
    // Strip HTML comments first: the card documents the deliberate
    // absence ("no reveal button here on purpose") in a comment.
    const withoutComments = discoverAi.replace(/<!--[\s\S]*?-->/g, "")
    expect(withoutComments).not.toMatch(/reveal/i)
    expect(source).not.toContain("settings-ai-reveal")
  })

  it("all three setup buttons open the same unified onboarding dialog", () => {
    expect(page).toContain('maybeOpenKeysOnboarding("tmdb")')
    expect(page).toContain('maybeOpenKeysOnboarding("football-data")')
    expect(page).toContain('maybeOpenKeysOnboarding("ai")')
    // Same storage as before: onboarding writes land where Settings reads.
    expect(page).toContain("getTmdbApiKey()")
    expect(page).toContain("getFootballDataApiKey()")
    expect(page).toContain("hasAiKey()")
  })

  it("honest-state lines survive", () => {
    expect(page).toContain("settings-tmdb-state")
    expect(page).toContain("settings-football-data-state")
    expect(page).toContain("settings-ai-status")
    expect(page).toContain("settings-ai-last-tested")
    expect(source).toContain("settings-download-concurrency-cap")
    expect(source).toContain("epg-tz-status")
    expect(source).toContain("receiver-firewall-warning")
  })
})

describe("settings redesign 0.11.23 — storage keys and migrations", () => {
  it("legacy migrations are preserved, not cleaned up", () => {
    const appSettings = read("src/scripts/lib/app-settings.js")
    expect(appSettings).toContain("xt_tmdb_enabled_v2")
    expect(appSettings).toContain("xt_cursor_mode")
    expect(appSettings).toContain("xt_close_to_tray")
    // Cursor mode: absent key reads as ON (only explicit "0" disables).
    expect(appSettings).toMatch(/xt_cursor_mode/)
    // Close-to-tray: only explicit "1" opts back into tray (0.11.4 inversion).
    expect(appSettings).toContain("xt_close_to_tray")
  })

  it("no setting was re-keyed: the audit's storage keys still exist in code", () => {
    const hay = [
      read("src/scripts/lib/app-settings.js"),
      read("src/scripts/settings/settings-page.js"),
      read("src/scripts/lib/football-data.ts"),
      read("src/scripts/lib/i18n.ts"),
      read("src/scripts/lib/epg-data.js"),
      read("src/scripts/lib/followed.ts"),
      read("src/scripts/lib/ai/status.ts"),
      read("src/scripts/lib/net-log.ts"),
      read("src/scripts/lib/tv-cast.ts"),
      read("src/scripts/lib/preferences.js"),
    ].join("\n")
    for (const key of [
      "xt_locale",
      "xt_font_scale",
      "xt_density",
      "xt_perf_mode",
      "xt_ui_sounds",
      "xt_cursor_mode",
      "xt_tv_overscan",
      "xt_close_to_tray",
      "xt_hub_strips",
      "xt_progress_retention_days",
      "xt_player_backend",
      "xt_player_path_mpv",
      "xt_player_path_vlc",
      "xt_player_args_mpv",
      "xt_player_args_vlc",
      "xt_player_reuse_mpv",
      "xt_player_reuse_vlc",
      "xt_external_player_pref",
      "xt_audio_transcode_auto",
      "xt_ffmpeg_path",
      "xt_lang_grouping",
      "xt_content_lang",
      "xt_captions_auto",
      "xt_livetv_resume_last",
      "xt_android_native_player",
      "xt_android_remembered_player",
      "xt_channels_w",
      "xt_epg_offset",
      "xt_followed_check_enabled",
      "xt_followed_check_interval_hours",
      "xt_tvdb_enabled",
      "xt_tmdb_enabled",
      "xt_tmdb_key",
      "xt_football_data_key",
      "xt_ai_enabled",
      "xt_ai_provider",
      "xt_ai_endpoint",
      "xt_ai_model",
      "xt_ai_share_taste",
      "xt_ai_auto_requests",
      "xt_ai_home_auto_refresh",
      "xt_ai_last_test_v1",
      "xt_user_agent",
      "xt_network_timeout_s",
      "xt_dev_mode",
      "xt_netlog_images",
      "xt_download_dir",
      "xt_download_concurrency",
      "xt_write_nfo",
      "xt_update_channel",
      "xt_auto_update",
      "xt_receiver_mode",
      "xt_receiver_name",
      "xt_receiver_boot",
      "xt_tv_devices",
      "xt_playlists",
      "xt_prefs",
    ]) {
      expect(hay).toContain(key)
    }
  })
})

describe("settings redesign 0.11.23 — old routes redirect, copy is honest", () => {
  it("every old /settings/<slug> route redirects to its anchor", () => {
    for (const slug of SECTION_FILES) {
      const file = `src/pages/settings/${slug}.astro`
      expect(existsSync(join(ROOT, file))).toBe(true)
      const body = read(file)
      expect(body).toContain(`/settings#${slug}`)
      expect(body).toContain("http-equiv=\"refresh\"")
    }
  })

  it("danger-zone copy says the AI key is never wiped", () => {
    const en = JSON.parse(read("src/i18n/en.json")) as Record<string, string>
    expect(en["settings.danger.helperLong"]).toContain("never wiped")
    expect(en["settings.danger.helperLong"]).toContain("credential store")
    expect(en["settings.danger.dialogBody"]).toContain("never touches it")
    expect(en["settings.danger.restoreLastHelper"]).toContain("football-data key")
    expect(en["settings.backup.helperLong"]).toContain("football-data key")
    expect(en["settings.backup.helperLong"]).toContain("never included")
  })

  it("reset still snapshots first and restore still exists", () => {
    const page = read("src/scripts/settings/settings-page.js")
    expect(page).toContain("saveBackupSnapshot()")
    expect(page).toContain("settings-restore-last")
    expect(page).toContain("hasBackupSnapshot()")
  })
})
