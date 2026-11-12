/**
 * @vitest-environment jsdom
 */
// W5 — Couch Search + Settings + Library + Login.
//
// Guards the rebuild: search categorisation / suggestions / debounce,
// settings preservation (every baseline control id still present, every
// app-settings storage key still read + written), library rendering
// (CouchLayout + couch cards, stores untouched), login reskin (auth
// field ids untouched).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  categorizeSearchResults,
  suggestionsFor,
  COUCH_SEARCH_CATEGORIES,
} from "@/scripts/lib/couch-search";
import { debounce } from "@/scripts/lib/debounce";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
function pageSource(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// Node 24+ ships an experimental native `localStorage` that shadows
// jsdom's; stub it with a real in-memory Storage (same pattern as
// tests/app-settings.test.ts).
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}
const localStorageMock = makeStorage();
const sessionStorageMock = makeStorage();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", localStorageMock);
  vi.stubGlobal("sessionStorage", sessionStorageMock);
  localStorageMock.clear();
  sessionStorageMock.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});


describe("couch-search: categorizeSearchResults", () => {
  const items = [
    { kind: "live", id: 1, name: "RTE One" },
    { kind: "vod", id: 2, name: "Dune" },
    { kind: "series", id: 3, name: "Severance" },
    { kind: "epg", id: "1:2", name: "Six One News" },
    { kind: "person", id: 99, name: "Saoirse Ronan" },
    { kind: "vod", id: 4, name: "Dune: Part Two" },
  ] as const;

  it("splits scored results into Channels / Films / Series / Programmes / People", () => {
    const out = categorizeSearchResults(items as never);
    expect(out.channels.map((i) => i.name)).toEqual(["RTE One"]);
    expect(out.films.map((i) => i.name)).toEqual(["Dune", "Dune: Part Two"]);
    expect(out.series.map((i) => i.name)).toEqual(["Severance"]);
    expect(out.programmes.map((i) => i.name)).toEqual(["Six One News"]);
    expect(out.people.map((i) => i.name)).toEqual(["Saoirse Ronan"]);
  });

  it("drops unknown kinds and handles an empty list", () => {
    const out = categorizeSearchResults([
      { kind: "mystery", id: 7, name: "??? " },
    ] as never);
    expect(Object.values(out).flat()).toEqual([]);
    expect(categorizeSearchResults([])).toEqual({
      channels: [],
      films: [],
      series: [],
      programmes: [],
      people: [],
    });
  });

  it("lists the categories in Couch display order", () => {
    expect(COUCH_SEARCH_CATEGORIES.map((c) => c.id)).toEqual([
      "channels",
      "films",
      "series",
      "programmes",
      "people",
    ]);
  });
});

describe("couch-search: suggestionsFor", () => {
  it("prefers matching recent searches, then top result names", () => {
    expect(
      suggestionsFor("du", ["Dune", "Dublin", "Severance"], ["Dune: Part Two", "Dunkirk"]),
    ).toEqual(["Dune", "Dublin", "Dune: Part Two", "Dunkirk"]);
  });

  it("never echoes the query itself and de-duplicates case-insensitively", () => {
    expect(suggestionsFor("dune", ["Dune", "dune", "DUNE"], ["Dune"])).toEqual([]);
    expect(suggestionsFor("du", ["Dune"], ["dune", "Dunkirk"])).toEqual(["Dune", "Dunkirk"]);
  });

  it("returns nothing for a blank query and caps the list", () => {
    expect(suggestionsFor("  ", ["Dune"], ["Dune"])).toEqual([]);
    expect(
      suggestionsFor("s", ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"], []),
    ).toHaveLength(6);
  });
});

describe("couch-search: debounce (shared helper)", () => {
  it("fires once, trailing-edge, with the last arguments", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn, 150);
      debounced("a");
      debounced("b");
      debounced("c");
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(149);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("c");
    } finally {
      vi.useRealTimers();
    }
  });
});

const BASELINE_SETTINGS_IDS: string[] = [
  "audio-transcode-helper", "audio-transcode-section", "auto-update-hint", "auto-update-row", "auto-update-select", "card-ai-discovery",
  "card-backup", "card-behavior", "card-captions-auto", "card-casting", "card-categories", "card-channel-overrides",
  "card-content-language", "card-display", "card-docs", "card-favorites", "card-feedback", "card-followed",
  "card-hevc", "card-hub-strips", "card-lang-grouping", "card-language", "card-livetv",
  "card-livetv-layout", "card-net-log", "card-network", "card-perf-mode", "card-play-on-tv",
  "card-progress-retention", "card-rendering", "card-resume-last-channel", "card-resume-last-channel-livetv", "card-storage", "card-tmdb", "card-tv-overscan", "card-tv-receiver",
  "card-ui-sounds", "card-write-nfo", "changelog-body", "changelog-section", "changelog-status", "content-lang-select",
  "download-dir-clear",
  "download-dir-input", "download-dir-pick", "downloads-availability", "downloads-folder-section", "downloads-scan", "downloads-scan-msg",
  "epg-tz-section", "epg-tz-select", "epg-tz-status", "ffmpeg-browse-btn", "ffmpeg-path-helper", "ffmpeg-path-input",
  "ffmpeg-status", "ffmpeg-test-btn", "lang-grouping-select", "licenses-section", "linux-appimage-notice", "net-log-clear",
  "net-log-copy", "net-log-count", "net-log-include-images", "net-log-kind-filter", "net-log-msg", "net-log-rows",
  "play-on-tv-add", "play-on-tv-empty", "play-on-tv-list", "play-on-tv-live-badge", "play-on-tv-session", "play-on-tv-session-line",
  "play-on-tv-session-title", "play-on-tv-stop", "play-on-tv-summary-helper", "play-on-tv-summary-status", "playback-section", "receiver-addresses-list",
  "receiver-boot-toggle", "receiver-code-reveal", "receiver-device-name-input", "receiver-discoverable-line", "receiver-firewall-allow-btn", "receiver-firewall-warning",
  "receiver-firewall-warning-body", "receiver-firewall-warning-title", "receiver-live-badge", "receiver-mode-toggle", "receiver-no-devices", "receiver-open-screen",
  "receiver-pair-code-display", "receiver-paired-list", "receiver-regenerate-btn", "receiver-status-block", "receiver-status-line", "receiver-status-line-text",
  "receiver-summary-helper", "receiver-summary-status", "rendering-env-override-note", "rendering-hint", "rendering-restart", "rendering-restart-note",
  "rendering-select", "rendering-status", "settings-about", "settings-add-from-website",
  "settings-ai-clear", "settings-ai-enabled", "settings-ai-endpoint", "settings-ai-key", "settings-ai-key-status", "settings-ai-model",
  "settings-ai-model-control", "settings-ai-model-custom", "settings-ai-model-custom-label", "settings-ai-key-saved-badge",
  "settings-ai-msg", "settings-ai-test", "settings-appearance", "settings-audio-transcode-auto", "settings-backup-msg",
  "settings-cache-msg", "settings-cache-newest", "settings-cache-size", "settings-captions-auto", "settings-channel-width", "settings-clear-cache",
  "settings-clear-history", "settings-danger", "settings-data", "settings-density", "settings-dev-mode", "settings-dev-mode-helper",
  "settings-download-concurrency", "settings-download-concurrency-cap", "settings-export", "settings-export-diagnostics", "settings-export-diagnostics-msg",
  "settings-followed", "settings-followed-check-now", "settings-followed-interval", "settings-followed-scheduled", "settings-followed-scheduled-hint", "settings-followed-status", "settings-followed-task-error", "settings-followed-task-note", "settings-font-scale",
  "settings-help", "settings-hevc-install", "settings-hevc-status", "settings-import", "settings-import-cancel",
  "settings-import-confirm", "settings-import-desc", "settings-import-dialog", "settings-import-input", "settings-import-title", "settings-library",
  "settings-network", "settings-network-timeout", "settings-network-timeout-helper", "settings-new-custom-playlist", "settings-new-custom-playlist-dialog",
  "settings-new-custom-playlist-name", "settings-new-custom-playlist-title", "settings-open-appdata", "settings-open-downloads", "settings-open-logs", "settings-perf-mode",
  "settings-playlists", "settings-playlists-list", "settings-profile", "settings-progress-retention", "settings-receiver-screensaver-hint", "settings-receiver-screensaver-open",
  "settings-refresh-active", "settings-reset-all", "settings-reset-cancel", "settings-reset-confirm", "settings-reset-desc", "settings-reset-dialog",
  "settings-reset-msg", "settings-reset-title", "settings-restore-last", "settings-restore-last-helper", "settings-resume-last-livetv", "settings-resume-last-playback", "settings-search-clear", "settings-search-empty",
  "settings-search-input", "settings-share-logs", "settings-tmdb-enabled", "settings-tmdb-key",
  "settings-tmdb-msg", "settings-tmdb-state", "settings-tmdb-test", "settings-tvdb-enabled", "settings-ui-sounds", "settings-watching",
  "settings-write-nfo", "ua-custom", "ua-msg", "ua-override-note", "ua-preset", "ua-save", "update-channel-hint",
  "update-channel-row", "update-channel-select", "update-check", "update-current", "update-degraded", "update-get",
  "update-get-label", "update-github", "update-install", "update-install-label", "update-latest", "update-manual-only",
  "update-msg", "update-notes", "update-pill", "update-progress-bar", "update-progress-text", "update-progress-track",
  "update-progress-wrap", "update-relaunch", "update-section",
];

const BASELINE_LOGIN_IDS: string[] = [
  "addFromWebsiteBtn", "diagnostic-affordance", "diagnostic-result", "diagnostic-run-btn", "epg-sources", "epgAddBtn",
  "epgAdditionalList", "epgDisableProvider", "epgDisableProviderRow", "epgPrimary", "epgPrimaryStatus", "epgTestBtn",
  "epgTestStatus", "liveContainer", "local-fields", "localFileInput", "localFileName", "localPickBtn",
  "m3u-fields", "m3uUrl", "mirrors-section", "mirrorsAddBtn", "mirrorsList", "page-subtitle",
  "page-title", "password", "playlist-form", "playlistAccent", "playlistEmoji", "saveBtn",
  "serverUrl", "status", "tab-local", "tab-m3u", "tab-xtream", "testBtn",
  "title", "username", "xtream-advanced", "xtream-fields",
];

describe("couch-settings: preservation", () => {
  it("settings.astro still contains every baseline control id", () => {
    const src = pageSource("src/pages/settings.astro");
    const missing = BASELINE_SETTINGS_IDS.filter((id) => !src.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it("0.11.1 settings cull: removed controls stay removed", () => {
    const src = pageSource("src/pages/settings.astro");
    // Themes (picker + accent), the dead "Show EPG by default" toggle (its
    // xt_epg_open_default key was never read), the TV-irrelevant haptics
    // row, the Discord Rich Presence section, and the action-less support
    // card. None of these may come back as a control on the Settings page.
    // 0.11.4: the Mono audio row joins them — it lives in the player
    // "More" menu, where it belongs. The AI + TMDb key reveal buttons
    // join them too — video evidence showed a pasted key rendering in
    // clear text on the projector, and a secret must never render in
    // clear text on a living-room screen.
    const removedIds = [
      "settings-theme",
      "settings-accent",
      "settings-accent-override-hint",
      "settings-epg-default",
      "card-haptics",
      "settings-haptics",
      "discord-rpc-section",
      "discord-client-id",
      "discord-playlists",
      "settings-support",
      "card-mono-audio",
      "settings-mono-audio",
      "settings-ai-reveal",
      "settings-tmdb-reveal",
    ];
    for (const id of removedIds) {
      expect(src, `culled control ${id} is back`).not.toContain(`id="${id}"`);
    }
    expect(src).not.toContain("xt_epg_open_default");
    expect(src).not.toContain("setAccent(");
    expect(src).not.toContain("commitTheme(");
  });

  it("settings.astro is a Couch page with Quick + Advanced groups", () => {
    const src = pageSource("src/pages/settings.astro");
    expect(src).toContain('import CouchLayout from "@/layouts/CouchLayout.astro"');
    expect(src).toContain("TvSettingsGroup");
    expect(src).toContain('id="settings-quick"');
    expect(src).toContain('id="settings-advanced"');
    expect(src).toContain('variant="advanced"');
    expect(src).toContain("<CouchLayout");
    expect(src).not.toContain('import Layout from "@/layouts/Layout.astro"');
  });

  it("every app-settings storage key is still referenced by app-settings.js", async () => {
    const src = pageSource("src/scripts/lib/app-settings.js");
    const keys = [
      "xt_user_agent", "xt_download_dir", "xt_download_concurrency", "xt_write_nfo",
      "xt_perf_mode", "xt_accent", "xt_density", "xt_progress_retention_days",
      "xt_network_timeout_s", "xt_player_backend", "xt_player_path_mpv", "xt_player_path_vlc",
      "xt_player_args_mpv", "xt_player_args_vlc", "xt_player_reuse_mpv", "xt_player_reuse_vlc",
      "xt_ffmpeg_path", "xt_external_player_pref", "xt_close_to_tray", "xt_hub_strips",
      "xt_tv_overscan", "xt_android_native_player", "xt_android_remembered_player",
      "xt_video_scale", "xt_update_channel", "xt_auto_update", "xt_ui_sounds", "xt_haptics",
      "xt_mono_audio", "xt_captions_auto", "xt_tmdb_key", "xt_tmdb_enabled", "xt_tvdb_enabled",
      "xt_ai_endpoint", "xt_ai_model", "xt_ai_enabled", "xt_dev_mode", "xt_receiver_mode",
      "xt_receiver_boot", "xt_receiver_name", "xt_receiver_engine", "xt_receiver_id",
      "xt_content_lang", "xt_lang_grouping", "xt_discord_client_id", "xt_discord_muted",
      "xt_audio_transcode_auto",
    ];
    for (const key of keys) {
      expect(src, `missing storage key ${key}`).toContain(`"${key}"`);
    }
  });

  it("settings still round-trip through app-settings (same keys, same values)", async () => {
    const settings = await import("@/scripts/lib/app-settings.js");
    interface SettingCase {
      get: () => unknown;
      set: (value: never) => void;
      value: unknown;
      expected: unknown;
      key: string;
    }
    const cases: SettingCase[] = [
      { get: settings.getAccent, set: settings.setAccent, value: "rose", expected: "rose", key: "xt_accent" },
      { get: settings.getDensity, set: settings.setDensity, value: "compact", expected: "compact", key: "xt_density" },
      { get: settings.getPerfMode, set: settings.setPerfMode, value: true, expected: true, key: "xt_perf_mode" },
      { get: settings.getTvOverscan, set: settings.setTvOverscan, value: 4, expected: 4, key: "xt_tv_overscan" },
      { get: settings.getProgressRetentionDays, set: settings.setProgressRetentionDays, value: 30, expected: 30, key: "xt_progress_retention_days" },
      { get: settings.getNetworkTimeoutSeconds, set: settings.setNetworkTimeoutSeconds, value: 45, expected: 45, key: "xt_network_timeout_s" },
      { get: settings.getAiEndpoint, set: settings.setAiEndpoint, value: "https://example.invalid/v1", expected: "https://example.invalid/v1", key: "xt_ai_endpoint" },
      { get: settings.getAiModel, set: settings.setAiModel, value: "gpt-test", expected: "gpt-test", key: "xt_ai_model" },
      { get: settings.getAiEnabled, set: settings.setAiEnabled, value: true, expected: true, key: "xt_ai_enabled" },
      { get: settings.getTmdbApiKey, set: settings.setTmdbApiKey, value: "tmdb-test-key", expected: "tmdb-test-key", key: "xt_tmdb_key" },
      { get: settings.getTmdbEnabled, set: settings.setTmdbEnabled, value: false, expected: false, key: "xt_tmdb_enabled" },
      { get: settings.getUpdateChannel, set: settings.setUpdateChannel, value: "beta", expected: "beta", key: "xt_update_channel" },
      { get: settings.getAutoUpdateEnabled, set: settings.setAutoUpdateEnabled, value: false, expected: false, key: "xt_auto_update" },
      { get: settings.getUiSoundsEnabled, set: settings.setUiSoundsEnabled, value: false, expected: false, key: "xt_ui_sounds" },
      { get: settings.getHapticsEnabled, set: settings.setHapticsEnabled, value: false, expected: false, key: "xt_haptics" },
      { get: settings.getMonoAudioEnabled, set: settings.setMonoAudioEnabled, value: true, expected: true, key: "xt_mono_audio" },
      { get: settings.getCaptionsAutoEnabled, set: settings.setCaptionsAutoEnabled, value: true, expected: true, key: "xt_captions_auto" },
      { get: settings.getDevModeEnabled, set: settings.setDevModeEnabled, value: true, expected: true, key: "xt_dev_mode" },
      { get: settings.getLanguageGroupingEnabled, set: settings.setLanguageGroupingEnabled, value: false, expected: false, key: "xt_lang_grouping" },
      { get: settings.getPlayerBackend, set: settings.setPlayerBackend, value: "vlc", expected: "vlc", key: "xt_player_backend" },
      { get: settings.getExternalPlayerPref, set: settings.setExternalPlayerPref, value: "ask", expected: "ask", key: "xt_external_player_pref" },
      { get: settings.getVideoScale, set: settings.setVideoScale, value: "fill", expected: "fill", key: "xt_video_scale" },
      { get: settings.getDownloadConcurrency, set: settings.setDownloadConcurrency, value: 3, expected: 3, key: "xt_download_concurrency" },
      { get: settings.getWriteNfoEnabled, set: settings.setWriteNfoEnabled, value: true, expected: true, key: "xt_write_nfo" },
      { get: settings.getCloseToTray, set: settings.setCloseToTray, value: true, expected: true, key: "xt_close_to_tray" },
      { get: settings.getContentLanguage, set: settings.setContentLanguage, value: "en", expected: "EN", key: "xt_content_lang" },
      { get: settings.getDiscordClientId, set: settings.setDiscordClientId, value: "123", expected: "123", key: "xt_discord_client_id" },
      { get: settings.getFfmpegPath, set: settings.setFfmpegPath, value: "/usr/bin/ffmpeg", expected: "/usr/bin/ffmpeg", key: "xt_ffmpeg_path" },
      { get: settings.getAudioTranscodeAuto, set: settings.setAudioTranscodeAuto, value: true, expected: true, key: "xt_audio_transcode_auto" },
    ];
    for (const { get, set, value, expected, key } of cases) {
      const setSpy = vi.spyOn(localStorageMock, "setItem");
      const removeSpy = vi.spyOn(localStorageMock, "removeItem");
      set(value as never);
      expect(get(), `round-trip for ${key}`).toBe(expected);
      // The setter must touch that exact storage key — either writing a
      // value or removing it (several settings encode their default as
      // key-absence, e.g. setTmdbEnabled(true) / setExternalPlayerPref("mpv")).
      const touched =
        setSpy.mock.calls.some((call) => call[0] === key) ||
        removeSpy.mock.calls.some((call) => call[0] === key);
      expect(touched, `stored key ${key}`).toBe(true);
      setSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

describe("couch-search page: SearchView wiring", () => {
  it("search.astro is a Couch page mounting SearchView", () => {
    const src = pageSource("src/pages/search.astro");
    expect(src).toContain('import CouchLayout from "@/layouts/CouchLayout.astro"');
    expect(src).toContain("<SearchView client:load");
    expect(src).not.toContain('import Layout from "@/layouts/Layout.astro"');
  });

  it("SearchView uses TvKeyboard + the shared debounce helper, not the raw OSK", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain('import TvKeyboard from "@/components/couch/TvKeyboard.svelte"');
    expect(src).toContain("<TvKeyboard");
    expect(src).toContain('from "@/scripts/lib/debounce.ts"');
    expect(src).not.toContain("OnScreenKeyboard");
  });

  it("SearchView renders grouped category rails and suggestions, and goes back", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("categorizeSearchResults");
    expect(src).toContain("suggestionsFor");
    expect(src).toContain('data-nylah-rail={"search-"');
    expect(src).toContain("groupedSections");
    expect(src).toContain("goBack()");
    expect(src).toContain("history.back()");
    expect(src).toContain('data-nylah-item');
  });
});

describe("couch-library: favourites + watch later", () => {
  it("both library pages are Couch pages mounting their views", () => {
    for (const [page, view] of [
      ["src/pages/favorites.astro", "AllFavoritesView"],
      ["src/pages/watchlist.astro", "AllWatchlistView"],
    ] as const) {
      const src = pageSource(page);
      expect(src, page).toContain('import CouchLayout from "@/layouts/CouchLayout.astro"');
      expect(src, page).toContain(`<${view} client:load`);
      expect(src, page).not.toContain('import Layout from "@/layouts/Layout.astro"');
    }
  });

  it("library views render couch cards and keep their stores + cross-playlist open", () => {
    const fav = pageSource("src/components/AllFavoritesView.svelte");
    expect(fav).toContain("rs-grid");
    expect(fav).toContain("rs-card");
    expect(fav).toContain("data-nylah-item");
    expect(fav).toContain("data-couch-key");
    expect(fav).toContain("getAllGlobalFavorites");
    expect(fav).toContain("selectEntry");
    const watch = pageSource("src/components/AllWatchlistView.svelte");
    expect(watch).toContain("rs-grid");
    expect(watch).toContain("rs-card");
    expect(watch).toContain("data-nylah-item");
    expect(watch).toContain("data-couch-key");
    expect(watch).toContain("getAllGlobalWatchlist");
    expect(watch).toContain("selectEntry");
  });
});

describe("couch-login: reskin only", () => {
  it("login.astro is a Couch page with every baseline auth field id intact", () => {
    const src = pageSource("src/pages/login.astro");
    expect(src).toContain('import CouchLayout from "@/layouts/CouchLayout.astro"');
    expect(src).not.toContain('import Layout from "@/layouts/Layout.astro"');
    const missing = BASELINE_LOGIN_IDS.filter((id) => !src.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});

describe("couch-brand: NylahBox Studios", () => {
  const BRAND_KEYS = [
    "settings.about.title",
    "settings.support.intro",
    "settings.followed.taskNote",
    "settings.discord.helperLong",
    "settings.receiver.helperLong",
    "settings.receiver.screensaver.helper",
  ];

  it("the Settings About brand mark is NylahBox Studios in every locale", () => {
    const files = readdirSync(resolve(root, "src/i18n")).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const messages = JSON.parse(
        readFileSync(resolve(root, "src/i18n", file), "utf8"),
      );
      expect(messages["settings.about.title"], file).toBe("NylahBox Studios");
    }
  });

  it("the brand-mention keys on the settings screen use the new brand (en)", () => {
    const messages = JSON.parse(pageSource("src/i18n/en.json"));
    for (const key of BRAND_KEYS) {
      expect(messages[key], key).toContain("NylahBox Studios");
      expect(messages[key], key).not.toContain("Nylah Studios");
    }
  });

  it("settings.astro / login.astro carry no old brand name; upstream attribution stays", () => {
    for (const page of ["src/pages/settings.astro", "src/pages/login.astro"]) {
      const src = pageSource(page);
      expect(src, page).not.toContain("Nylah Studios");
    }
    const settings = pageSource("src/pages/settings.astro");
    expect(settings).toContain("NylahBox Studios");
    // Deliberate exceptions, not rebrand misses: the upstream fork
    // attribution and real github.com/infinitel8p URLs must stay factual.
    expect(settings).toContain("A fork of");
    expect(settings).toContain("github.com/infinitel8p/Extreme-InfiniTV");
  });
});
