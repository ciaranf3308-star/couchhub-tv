import { describe, it, expect, beforeEach, vi } from "vitest"

type BackupSnapshot = { localContent: Record<string, unknown> }

let credsState: any = { entries: [], selectedId: "" }
const restoredCredsState = vi.fn(async (state: any) => {
  credsState = state
})
vi.mock("@/scripts/lib/creds.js", () => ({
  getState: async () => credsState,
  restoreState: (state: any) => restoredCredsState(state),
}))

vi.mock("@/scripts/lib/preferences.js", () => ({
  ensureLoaded: async () => {},
  snapshotPrefs: () => ({}),
  restorePrefs: async () => {},
}))

let settingsState: any = {
  userAgent: "",
  downloadDir: "",
  downloadConcurrency: 2,
  playerBackend: "videojs",
  playerPaths: { mpv: "", vlc: "" },
  playerExtraArgs: { mpv: [] as string[], vlc: [] as string[] },
  playerReuse: { mpv: false, vlc: false },
  ffmpegPath: "",
  livetvResumeLast: false,
  tmdbEnabled: false,
  tvdbEnabled: true,
  perfMode: false,
  density: "cozy",
  hubStripIds: ["continue-watching"],
  uiSounds: true,
  contentLanguage: "",
  languageGrouping: true,
  videoScale: "fit",
  monoAudio: false,
  captionsAuto: false,
  audioTranscodeAuto: false,
  externalPlayerPref: "mpv",
  androidNativePlayer: false,
  writeNfo: false,
  progressRetentionDays: 90,
  networkTimeoutSeconds: 20,
  updateChannel: "stable",
  autoUpdate: true,
  closeToTray: true,
  devMode: false,
  aiEndpoint: "https://api.openai.com/v1",
  aiModel: "",
  aiEnabled: false,
  receiverDeviceName: "",
  receiverMode: false,
  receiverBoot: false,
  receiverEngine: "auto",
}

let aiState = {
  provider: "openai",
  shareTaste: false,
  autoRequests: false,
}

vi.mock("@/scripts/lib/ai/status.ts", () => ({
  getAiProvider: () => aiState.provider,
  setAiProvider: (provider: string) => { aiState.provider = provider },
  getAiShareTaste: () => aiState.shareTaste,
  setAiShareTaste: (share: boolean) => { aiState.shareTaste = share },
  getAiAutoRequests: () => aiState.autoRequests,
  setAiAutoRequests: (auto: boolean) => { aiState.autoRequests = auto },
}))

let followedStoreData: {
  subs: any[]
  notifs: any[]
  meta: Map<string, string>
} = { subs: [], notifs: [], meta: new Map() }
let followedSettings = { enabled: true, interval: 6 }

vi.mock("@/scripts/lib/followed.ts", () => ({
  getFollowedStore: () => ({
    getAllSubscriptions: async () => [...followedStoreData.subs],
    putSubscription: async (sub: any) => {
      const idx = followedStoreData.subs.findIndex((s) => s.key === sub.key)
      if (idx === -1) followedStoreData.subs.push(sub)
      else followedStoreData.subs[idx] = sub
    },
    deleteSubscription: async (key: string) => {
      followedStoreData.subs = followedStoreData.subs.filter((s) => s.key !== key)
    },
    getAllNotifications: async () => [...followedStoreData.notifs],
    putNotification: async (group: any) => {
      const idx = followedStoreData.notifs.findIndex((g) => g.id === group.id)
      if (idx === -1) followedStoreData.notifs.push(group)
      else followedStoreData.notifs[idx] = group
    },
    deleteNotification: async (id: string) => {
      followedStoreData.notifs = followedStoreData.notifs.filter((g) => g.id !== id)
    },
    getMeta: async (key: string) => followedStoreData.meta.get(key) ?? null,
    putMeta: async (key: string, value: string) => {
      followedStoreData.meta.set(key, value)
    },
  }),
  getFollowedCheckEnabled: () => followedSettings.enabled,
  setFollowedCheckEnabled: (enabled: boolean) => { followedSettings.enabled = enabled },
  getFollowedCheckIntervalHours: () => followedSettings.interval,
  setFollowedCheckIntervalHours: (hours: number) => {
    followedSettings.interval = hours
    return true
  },
  getFollowedLastCheckAt: async () => followedStoreData.meta.get("lastCheckAt") ?? null,
  FOLLOWED_LAST_CHECK_META_KEY: "lastCheckAt",
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getUserAgent: () => settingsState.userAgent,
  setUserAgent: (ua: string) => { settingsState.userAgent = ua },
  getDownloadDir: () => settingsState.downloadDir,
  setDownloadDir: (dir: string) => { settingsState.downloadDir = dir },
  downloadDirMatchesPlatform: () => true,
  getDownloadConcurrency: () => settingsState.downloadConcurrency,
  setDownloadConcurrency: (n: number) => { settingsState.downloadConcurrency = n },
  getPlayerBackend: () => settingsState.playerBackend,
  setPlayerBackend: (backend: string) => { settingsState.playerBackend = backend },
  getPlayerPath: (kind: "mpv" | "vlc") => settingsState.playerPaths[kind],
  setPlayerPath: (kind: "mpv" | "vlc", path: string) => { settingsState.playerPaths[kind] = path },
  getPlayerExtraArgs: (kind: "mpv" | "vlc") => settingsState.playerExtraArgs[kind],
  setPlayerExtraArgs: (kind: "mpv" | "vlc", args: string[]) => { settingsState.playerExtraArgs[kind] = args },
  getPlayerReuseInstance: (kind: "mpv" | "vlc") => settingsState.playerReuse[kind],
  setPlayerReuseInstance: (kind: "mpv" | "vlc", on: boolean) => { settingsState.playerReuse[kind] = on },
  getFfmpegPath: () => settingsState.ffmpegPath,
  setFfmpegPath: (path: string) => { settingsState.ffmpegPath = path },
  getLivetvResumeLastChannel: () => settingsState.livetvResumeLast,
  setLivetvResumeLastChannel: (on: boolean) => { settingsState.livetvResumeLast = on },
  getTmdbEnabled: () => settingsState.tmdbEnabled,
  setTmdbEnabled: (enabled: boolean) => { settingsState.tmdbEnabled = enabled },
  getTvdbEnabled: () => settingsState.tvdbEnabled,
  setTvdbEnabled: (enabled: boolean) => { settingsState.tvdbEnabled = enabled },
  getPerfMode: () => settingsState.perfMode,
  setPerfMode: (on: boolean) => { settingsState.perfMode = on },
  getDensity: () => settingsState.density,
  setDensity: (density: string) => { settingsState.density = density },
  DENSITY_PRESETS: { compact: 0.75, cozy: 1, comfortable: 1.3 },
  getHubStripIds: () => settingsState.hubStripIds,
  setHubStripIds: (ids: string[]) => { settingsState.hubStripIds = ids },
  getUiSoundsEnabled: () => settingsState.uiSounds,
  setUiSoundsEnabled: (on: boolean) => { settingsState.uiSounds = on },
  getContentLanguage: () => settingsState.contentLanguage,
  setContentLanguage: (tag: string) => { settingsState.contentLanguage = tag },
  getLanguageGroupingEnabled: () => settingsState.languageGrouping,
  setLanguageGroupingEnabled: (on: boolean) => { settingsState.languageGrouping = on },
  getVideoScale: () => settingsState.videoScale,
  setVideoScale: (mode: string) => { settingsState.videoScale = mode },
  getMonoAudioEnabled: () => settingsState.monoAudio,
  setMonoAudioEnabled: (on: boolean) => { settingsState.monoAudio = on },
  getCaptionsAutoEnabled: () => settingsState.captionsAuto,
  setCaptionsAutoEnabled: (on: boolean) => { settingsState.captionsAuto = on },
  getAudioTranscodeAuto: () => settingsState.audioTranscodeAuto,
  setAudioTranscodeAuto: (on: boolean) => { settingsState.audioTranscodeAuto = on },
  getExternalPlayerPref: () => settingsState.externalPlayerPref,
  setExternalPlayerPref: (pref: string) => { settingsState.externalPlayerPref = pref },
  EXTERNAL_PLAYER_PREF_VALUES: ["mpv", "vlc", "ask"],
  getAndroidNativePlayerEnabled: () => settingsState.androidNativePlayer,
  setAndroidNativePlayerEnabled: (on: boolean) => { settingsState.androidNativePlayer = on },
  getWriteNfoEnabled: () => settingsState.writeNfo,
  setWriteNfoEnabled: (on: boolean) => { settingsState.writeNfo = on },
  getProgressRetentionDays: () => settingsState.progressRetentionDays,
  setProgressRetentionDays: (days: number) => { settingsState.progressRetentionDays = days },
  PROGRESS_RETENTION_VALUES: [30, 90, 180, 0],
  getNetworkTimeoutSeconds: () => settingsState.networkTimeoutSeconds,
  setNetworkTimeoutSeconds: (seconds: number) => { settingsState.networkTimeoutSeconds = seconds },
  NETWORK_TIMEOUT_VALUES: [20, 45, 90, 180],
  getUpdateChannel: () => settingsState.updateChannel,
  setUpdateChannel: (channel: string) => { settingsState.updateChannel = channel },
  UPDATE_CHANNELS: ["stable", "beta"],
  getAutoUpdateEnabled: () => settingsState.autoUpdate,
  setAutoUpdateEnabled: (on: boolean) => { settingsState.autoUpdate = on },
  getCloseToTray: () => settingsState.closeToTray,
  setCloseToTray: (on: boolean) => { settingsState.closeToTray = on },
  getDevModeEnabled: () => settingsState.devMode,
  setDevModeEnabled: (on: boolean) => { settingsState.devMode = on },
  getAiEndpoint: () => settingsState.aiEndpoint,
  setAiEndpoint: (endpoint: string) => { settingsState.aiEndpoint = endpoint },
  getAiModel: () => settingsState.aiModel,
  setAiModel: (model: string) => { settingsState.aiModel = model },
  getAiEnabled: () => settingsState.aiEnabled,
  setAiEnabled: (enabled: boolean) => { settingsState.aiEnabled = enabled },
  getReceiverDeviceName: () => settingsState.receiverDeviceName,
  setReceiverDeviceName: (name: string) => { settingsState.receiverDeviceName = name },
  getReceiverModeEnabled: () => settingsState.receiverMode,
  setReceiverModeEnabled: (on: boolean) => { settingsState.receiverMode = on },
  getReceiverBootEnabled: () => settingsState.receiverBoot,
  setReceiverBootEnabled: (on: boolean) => { settingsState.receiverBoot = on },
  getReceiverEngine: () => settingsState.receiverEngine,
  RECEIVER_ENGINE_VALUES: ["auto", "embedded", "native"],
  PLAYER_BACKENDS: ["videojs", "artplayer", "shaka", "mpv", "vlc"],
  EXTERNAL_PLAYER_BACKENDS: ["mpv", "vlc"],
}))

const localContentStore = new Map<string, string>()
vi.mock("@/scripts/lib/local-content.js", () => ({
  getLocalContent: async (entryId: string) => localContentStore.get(entryId) ?? "",
  setLocalContent: async (entryId: string, text: string) => {
    localContentStore.set(entryId, text)
    return true
  },
}))

const epgOffsets = new Map<string, number>()
vi.mock("@/scripts/lib/epg-data.js", () => ({
  getOffsetSetting: (playlistId: string) => epgOffsets.get(playlistId) ?? "auto",
  setOffsetSetting: (playlistId: string, value: "auto" | number) => {
    if (value === "auto") epgOffsets.delete(playlistId)
    else epgOffsets.set(playlistId, value)
  },
}))

let activeLocale = "en"
const setLocale = vi.fn(async (code: string) => {
  activeLocale = code
})
vi.mock("@/scripts/lib/i18n.js", () => ({
  setLocale: (code: string) => setLocale(code),
  getActiveLocale: () => activeLocale,
}))

let tvDevices: any[] = []
vi.mock("@/scripts/lib/tv-cast.js", () => ({
  listTvDevices: () => tvDevices,
  saveTvDevice: (device: any) => {
    const existingIndex = tvDevices.findIndex((entry) => entry.id === device.id)
    if (existingIndex === -1) tvDevices.push(device)
    else tvDevices[existingIndex] = device
  },
}))

import { exportAll, importAll } from "@/scripts/lib/backup.js"

const customDoc = JSON.stringify({
  version: 1,
  nextId: 2,
  groups: ["News"],
  channels: [
    {
      key: "abc",
      id: 1,
      group: "News",
      sources: [{ kind: "xtream", entryId: "src-1", streamId: 10 }],
      overrides: { name: null, logo: null, chno: null, tvgId: null },
      catchup: null,
    },
  ],
})

const sampleTvDevice = {
  id: "dev-1",
  name: "Living Room TV",
  host: "192.168.1.42",
  port: 8787,
  key: "secret-key",
  createdAt: 1000,
  lastSeenAt: 2000,
}

beforeEach(() => {
  localContentStore.clear()
  restoredCredsState.mockClear()
  setLocale.mockClear()
  epgOffsets.clear()
  tvDevices = []
  activeLocale = "en"
  settingsState = {
    userAgent: "",
    downloadDir: "",
    downloadConcurrency: 2,
    playerBackend: "videojs",
    playerPaths: { mpv: "", vlc: "" },
    playerExtraArgs: { mpv: [], vlc: [] },
    playerReuse: { mpv: false, vlc: false },
    ffmpegPath: "",
    livetvResumeLast: false,
    tmdbEnabled: false,
    tvdbEnabled: true,
    perfMode: false,
    density: "cozy",
    hubStripIds: ["continue-watching"],
    uiSounds: true,
    contentLanguage: "",
    languageGrouping: true,
    videoScale: "fit",
    monoAudio: false,
    captionsAuto: false,
    audioTranscodeAuto: false,
    externalPlayerPref: "mpv",
    androidNativePlayer: false,
    writeNfo: false,
    progressRetentionDays: 90,
    networkTimeoutSeconds: 20,
    updateChannel: "stable",
    autoUpdate: true,
    closeToTray: true,
    devMode: false,
    aiEndpoint: "https://api.openai.com/v1",
    aiModel: "",
    aiEnabled: false,
    receiverDeviceName: "",
    receiverMode: false,
    receiverBoot: false,
    receiverEngine: "auto",
  }
  aiState = { provider: "openai", shareTaste: false, autoRequests: false }
  followedStoreData = { subs: [], notifs: [], meta: new Map() }
  followedSettings = { enabled: true, interval: 6 }
  credsState = {
    entries: [
      { _id: "src-1", type: "xtream", serverUrl: "http://host", username: "u", password: "p" },
      { _id: "loc-1", type: "local-m3u", sourceName: "list.m3u" },
      { _id: "cust-1", type: "custom" },
    ],
    selectedId: "cust-1",
  }
})

describe("exportAll", () => {
  it("includes custom-playlist docs alongside local-m3u text, keyed by entry id", async () => {
    localContentStore.set("loc-1", "#EXTM3U\n")
    localContentStore.set("cust-1", customDoc)

    const snapshot = (await exportAll()) as BackupSnapshot

    expect(Object.keys(snapshot.localContent).sort()).toEqual(["cust-1", "loc-1"])
    expect(snapshot.localContent["cust-1"]).toBe(customDoc)
    expect(snapshot.localContent["loc-1"]).toBe("#EXTM3U\n")
  })

  it("skips entry types that have no stored content", async () => {
    localContentStore.set("src-1", "should not be exported")

    const snapshot = (await exportAll()) as BackupSnapshot

    expect(snapshot.localContent["src-1"]).toBeUndefined()
  })

  it("never exports the TMDb key (0.11.4: no plaintext key in the file), but keeps the enabled flag", async () => {
    settingsState.tmdbEnabled = true

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.tmdbKey).toBeUndefined()
    expect(snapshot.appSettings.tmdbEnabled).toBe(true)
  })

  it("includes the TVDb enabled flag", async () => {
    settingsState.tvdbEnabled = false

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.tvdbEnabled).toBe(false)
  })

  it("includes the display/UX group without dead theme/accent/haptics stores", async () => {
    settingsState.density = "compact"
    settingsState.perfMode = true

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.display.density).toBe("compact")
    expect(snapshot.appSettings.display.perfMode).toBe(true)
    expect(snapshot.appSettings.display.hubStrips).toEqual(["continue-watching"])
    expect(snapshot.appSettings.display.theme).toBeUndefined()
    expect(snapshot.appSettings.display.accent).toBeUndefined()
    expect(snapshot.appSettings.display.haptics).toBeUndefined()
  })

  it("includes only user-set EPG offsets, keyed by entry id", async () => {
    epgOffsets.set("src-1", 120)

    const snapshot = (await exportAll()) as any

    expect(snapshot.epgOffsets).toEqual({ "src-1": 120 })
    expect(snapshot.epgOffsets["loc-1"]).toBeUndefined()
  })

  it("includes the raw paired TV device list", async () => {
    tvDevices = [sampleTvDevice]

    const snapshot = (await exportAll()) as any

    expect(snapshot.tvDevices).toEqual([sampleTvDevice])
  })

  it("does not export the discord block (no UI sets it)", async () => {
    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.discord).toBeUndefined()
  })

  it("includes followed subscriptions, notifications, check settings and last-check time", async () => {
    followedStoreData.subs = [
      {
        key: "src-1::42",
        playlistId: "src-1",
        seriesId: "42",
        seriesTitle: "Example Show",
        posterUrl: null,
        sourceKind: "xtream",
        followedAt: "2026-11-01T00:00:00.000Z",
        baseline: [{ season: 1, episode: 1, episodeId: 7, title: "Pilot" }],
        baselineUpdatedAt: "2026-11-01T00:00:00.000Z",
        lastCheckAt: null,
        lastCheckStatus: "ok",
        consecutiveFailures: 0,
        nextCheckNotBefore: null,
        needsRebaseline: false,
      },
    ]
    followedStoreData.notifs = [
      {
        id: "src-1::42::2026-11-10T00:00:00.000Z",
        seriesId: "42",
        seriesTitle: "Example Show",
        season: 2,
        episode: 1,
        detectedAt: "2026-11-10T00:00:00.000Z",
        posterUrl: null,
        watched: false,
        episodes: [],
      },
    ]
    followedStoreData.meta.set("lastCheckAt", "2026-11-10T12:00:00.000Z")
    followedSettings.enabled = true
    followedSettings.interval = 12

    const snapshot = (await exportAll()) as any

    expect(snapshot.followed.subscriptions).toHaveLength(1)
    expect(snapshot.followed.subscriptions[0].seriesTitle).toBe("Example Show")
    expect(snapshot.followed.notifications).toHaveLength(1)
    expect(snapshot.followed.checkEnabled).toBe(true)
    expect(snapshot.followed.checkIntervalHours).toBe(12)
    expect(snapshot.followed.lastCheckAt).toBe("2026-11-10T12:00:00.000Z")
  })

  it("includes AI config (endpoint/model/provider/share/auto/enabled) and the FFmpeg path", async () => {
    settingsState.aiEndpoint = "https://example.invalid/v1"
    settingsState.aiModel = "gpt-4o-mini"
    settingsState.aiEnabled = true
    settingsState.ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe"
    settingsState.livetvResumeLast = true
    aiState.provider = "other"
    aiState.shareTaste = true
    aiState.autoRequests = true

    const snapshot = (await exportAll()) as any

    expect(snapshot.ai).toEqual({
      endpoint: "https://example.invalid/v1",
      model: "gpt-4o-mini",
      provider: "other",
      shareTaste: true,
      autoRequests: true,
      enabled: true,
    })
    expect(snapshot.appSettings.playback.ffmpegPath).toBe("C:\\ffmpeg\\bin\\ffmpeg.exe")
    expect(snapshot.appSettings.behavior.livetvResumeLast).toBe(true)
  })

  it("includes every nylah_* profiles key from localStorage", async () => {
    class MemoryStorage {
      private store = new Map<string, string>()
      get length() { return [...this.store.keys()].length }
      key(index: number) { return [...this.store.keys()][index] ?? null }
      getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
      setItem(key: string, value: string) { this.store.set(key, String(value)) }
      removeItem(key: string) { this.store.delete(key) }
    }
    const memoryStorage = new MemoryStorage()
    memoryStorage.setItem("nylah_profiles_v1", JSON.stringify({ profiles: [{ id: "shared" }] }))
    memoryStorage.setItem("nylah_profile_active_v1", "shared")
    memoryStorage.setItem("xt_tmdb_enabled", "")
    vi.stubGlobal("localStorage", memoryStorage as unknown as Storage)
    try {
      const snapshot = (await exportAll()) as any
      expect(snapshot.profiles.keys["nylah_profiles_v1"]).toContain("shared")
      expect(snapshot.profiles.keys["nylah_profile_active_v1"]).toBe("shared")
      expect(snapshot.profiles.keys["xt_tmdb_enabled"]).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("importAll", () => {
  it("round-trips a custom playlist's document through export then import", async () => {
    localContentStore.set("cust-1", customDoc)
    const snapshot = await exportAll()
    localContentStore.clear()

    const summary = await importAll(snapshot)

    expect(summary.localContent).toBe(1)
    expect(localContentStore.get("cust-1")).toBe(customDoc)
    expect(restoredCredsState).toHaveBeenCalledWith({
      entries: credsState.entries,
      selectedId: "cust-1",
    })
  })

  it("imports an older backup that carries no local content at all", async () => {
    const summary = await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
    })

    expect(summary.localContent).toBe(0)
    expect(summary.playlists).toBe(1)
  })

  it("rejects a blob without the format marker", async () => {
    await expect(importAll({ version: 1 })).rejects.toThrow(/format marker/)
  })

  it("round-trips the TMDb enabled flag but never restores a key from an old backup", async () => {
    settingsState.tmdbEnabled = true
    const snapshot = await exportAll()
    settingsState.tmdbEnabled = false

    await importAll(snapshot)

    expect(settingsState.tmdbEnabled).toBe(true)
    // An old backup that still carries a plaintext key must not apply it.
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      appSettings: { tmdbKey: "leaked-key", tmdbEnabled: false },
    })
    expect(settingsState.tmdbEnabled).toBe(false)
  })

  it("round-trips the TVDb enabled flag through export then import", async () => {
    settingsState.tvdbEnabled = false
    const snapshot = await exportAll()
    settingsState.tvdbEnabled = true

    await importAll(snapshot)

    expect(settingsState.tvdbEnabled).toBe(false)
  })

  it("leaves the TVDb flag untouched when an old backup lacks it", async () => {
    settingsState.tvdbEnabled = true

    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      appSettings: { tmdbKey: "" },
    })

    expect(settingsState.tvdbEnabled).toBe(true)
  })

  it("clears the TMDb enabled flag when the backup carries false", async () => {
    settingsState.tmdbEnabled = true

    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      appSettings: { tmdbEnabled: false },
    })

    expect(settingsState.tmdbEnabled).toBe(false)
  })

  it("round-trips the display/UX group", async () => {
    settingsState.density = "comfortable"
    settingsState.uiSounds = false
    settingsState.hubStripIds = ["favorites", "watchlist"]
    const snapshot = await exportAll()
    settingsState.density = "cozy"
    settingsState.uiSounds = true
    settingsState.hubStripIds = ["continue-watching"]

    await importAll(snapshot)

    expect(settingsState.density).toBe("comfortable")
    expect(settingsState.uiSounds).toBe(false)
    expect(settingsState.hubStripIds).toEqual(["favorites", "watchlist"])
  })

  it("ignores legacy theme/accent/haptics fields in old backups", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      appSettings: {
        display: { theme: "light", accent: "violet", haptics: false },
      },
    })

    // No throw, no state to assert: the mock has no accent/haptics store
    // because nothing reads them any more. The point is the import still
    // succeeds and leaves the rest of the backup intact.
    expect(settingsState.density).toBe("cozy")
  })

  it("round-trips the language group through the i18n setter", async () => {
    activeLocale = "de"
    const snapshot = await exportAll()
    activeLocale = "en"

    await importAll(snapshot)

    expect(setLocale).toHaveBeenCalledWith("de")
  })

  it("round-trips playback and behavior fields, including FFmpeg path and resume-last", async () => {
    settingsState.videoScale = "zoom"
    settingsState.monoAudio = true
    settingsState.externalPlayerPref = "vlc"
    settingsState.progressRetentionDays = 30
    settingsState.updateChannel = "beta"
    settingsState.ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe"
    settingsState.livetvResumeLast = true
    const snapshot = await exportAll()
    settingsState.videoScale = "fit"
    settingsState.monoAudio = false
    settingsState.externalPlayerPref = "mpv"
    settingsState.progressRetentionDays = 90
    settingsState.updateChannel = "stable"
    settingsState.ffmpegPath = ""
    settingsState.livetvResumeLast = false

    await importAll(snapshot)

    expect(settingsState.videoScale).toBe("zoom")
    expect(settingsState.monoAudio).toBe(true)
    expect(settingsState.externalPlayerPref).toBe("vlc")
    expect(settingsState.progressRetentionDays).toBe(30)
    expect(settingsState.updateChannel).toBe("beta")
    expect(settingsState.ffmpegPath).toBe("C:\\ffmpeg\\bin\\ffmpeg.exe")
    expect(settingsState.livetvResumeLast).toBe(true)
  })

  it("ignores a legacy discord block in old backups", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
      appSettings: { discord: { clientId: "123456", mutedPlaylistIds: ["src-1"] } },
    })

    expect(settingsState.updateChannel).toBe("stable")
  })

  it("round-trips followed series, check settings and last-check time through export then import", async () => {
    followedStoreData.subs = [
      {
        key: "src-1::42",
        playlistId: "src-1",
        seriesId: "42",
        seriesTitle: "Example Show",
        posterUrl: null,
        sourceKind: "xtream",
        followedAt: "2026-11-01T00:00:00.000Z",
        baseline: [{ season: 1, episode: 1, episodeId: 7, title: "Pilot" }],
        baselineUpdatedAt: "2026-11-01T00:00:00.000Z",
        lastCheckAt: null,
        lastCheckStatus: "ok",
        consecutiveFailures: 0,
        nextCheckNotBefore: null,
        needsRebaseline: false,
      },
    ]
    followedStoreData.notifs = [
      {
        id: "src-1::42::2026-11-10T00:00:00.000Z",
        seriesId: "42",
        seriesTitle: "Example Show",
        episodes: [{ seriesId: "42", season: 2, episode: 1 }],
        detectedAt: "2026-11-10T00:00:00.000Z",
        read: false,
        dismissed: false,
      },
    ]
    followedStoreData.meta.set("lastCheckAt", "2026-11-10T12:00:00.000Z")
    followedSettings.enabled = false
    followedSettings.interval = 24
    const snapshot = await exportAll()
    // Simulate a reset: wipe the store and the flags.
    followedStoreData = { subs: [], notifs: [], meta: new Map() }
    followedSettings = { enabled: true, interval: 6 }

    await importAll(snapshot)

    expect(followedStoreData.subs).toHaveLength(1)
    expect(followedStoreData.subs[0].seriesTitle).toBe("Example Show")
    expect(followedStoreData.notifs).toHaveLength(1)
    expect(followedSettings.enabled).toBe(false)
    expect(followedSettings.interval).toBe(24)
    expect(followedStoreData.meta.get("lastCheckAt")).toBe("2026-11-10T12:00:00.000Z")
  })

  it("skips a malformed followed subscription instead of failing the restore", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      followed: {
        subscriptions: [{ key: "broken" }],
        notifications: [{ id: "also-broken" }],
        checkEnabled: true,
        checkIntervalHours: 6,
        lastCheckAt: null,
      },
    })

    expect(followedStoreData.subs).toEqual([])
    expect(followedStoreData.notifs).toEqual([])
    expect(followedSettings.enabled).toBe(true)
  })

  it("round-trips profiles (nylah_* keys) through export then import", async () => {
    class MemoryStorage {
      private store = new Map<string, string>()
      get length() { return [...this.store.keys()].length }
      key(index: number) { return [...this.store.keys()][index] ?? null }
      getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
      setItem(key: string, value: string) { this.store.set(key, String(value)) }
      removeItem(key: string) { this.store.delete(key) }
    }
    const memoryStorage = new MemoryStorage()
    memoryStorage.setItem("nylah_profiles_v1", JSON.stringify({ profiles: [{ id: "ciaran" }] }))
    memoryStorage.setItem("nylah_profile_active_v1", "ciaran")
    memoryStorage.setItem("nylah_profile_data_ciaran_v1", JSON.stringify({ history: [] }))
    vi.stubGlobal("localStorage", memoryStorage as unknown as Storage)
    try {
      const snapshot = await exportAll()
      memoryStorage.removeItem("nylah_profiles_v1")
      memoryStorage.removeItem("nylah_profile_active_v1")
      memoryStorage.removeItem("nylah_profile_data_ciaran_v1")

      await importAll(snapshot)

      expect(memoryStorage.getItem("nylah_profiles_v1")).toContain("ciaran")
      expect(memoryStorage.getItem("nylah_profile_active_v1")).toBe("ciaran")
      expect(memoryStorage.getItem("nylah_profile_data_ciaran_v1")).toContain("history")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("round-trips AI config through export then import", async () => {
    settingsState.aiEndpoint = "https://example.invalid/v1"
    settingsState.aiModel = "gpt-4o-mini"
    settingsState.aiEnabled = true
    aiState.provider = "other"
    aiState.shareTaste = true
    aiState.autoRequests = true
    const snapshot = await exportAll()
    settingsState.aiEndpoint = "https://api.openai.com/v1"
    settingsState.aiModel = ""
    settingsState.aiEnabled = false
    aiState.provider = "openai"
    aiState.shareTaste = false
    aiState.autoRequests = false

    await importAll(snapshot)

    expect(settingsState.aiEndpoint).toBe("https://example.invalid/v1")
    expect(settingsState.aiModel).toBe("gpt-4o-mini")
    expect(settingsState.aiEnabled).toBe(true)
    expect(aiState.provider).toBe("other")
    expect(aiState.shareTaste).toBe(true)
    expect(aiState.autoRequests).toBe(true)
  })

  it("round-trips the receiver device name, mode and boot flag", async () => {
    settingsState.receiverDeviceName = "Bedroom"
    settingsState.receiverMode = true
    settingsState.receiverBoot = true
    const snapshot = await exportAll()
    settingsState.receiverDeviceName = ""
    settingsState.receiverMode = false
    settingsState.receiverBoot = false

    await importAll(snapshot)

    expect(settingsState.receiverDeviceName).toBe("Bedroom")
    expect(settingsState.receiverMode).toBe(true)
    expect(settingsState.receiverBoot).toBe(true)
  })

  // xt_receiver_engine has no app-settings.js setter yet, so backup.js writes
  // localStorage directly; verify against a real-ish Storage stub.
  it("round-trips xt_receiver_engine via a direct localStorage write", async () => {
    class MemoryStorage {
      private store = new Map<string, string>()
      getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
      setItem(key: string, value: string) { this.store.set(key, String(value)) }
      removeItem(key: string) { this.store.delete(key) }
    }
    const memoryStorage = new MemoryStorage()
    vi.stubGlobal("localStorage", memoryStorage as unknown as Storage)
    try {
      settingsState.receiverEngine = "native"
      const snapshot = await exportAll()
      settingsState.receiverEngine = "auto"

      await importAll(snapshot)

      expect(memoryStorage.getItem("xt_receiver_engine")).toBe("native")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("round-trips per-playlist EPG offsets, restoring only entries present in the backup", async () => {
    epgOffsets.set("src-1", -60)
    const snapshot = await exportAll()
    epgOffsets.clear()

    await importAll(snapshot)

    expect(epgOffsets.get("src-1")).toBe(-60)
  })

  it("skips an EPG offset whose entry id is absent from the imported creds", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
      epgOffsets: { "unknown-id": 30 },
    })

    expect(epgOffsets.has("unknown-id")).toBe(false)
  })

  it("round-trips the paired TV device list with a shape sanity check", async () => {
    tvDevices = [sampleTvDevice]
    const snapshot = await exportAll()
    tvDevices = []

    const summary = await importAll(snapshot)

    expect(tvDevices).toEqual([sampleTvDevice])
    expect(summary.appSettings).toBeGreaterThan(0)
  })

  it("rejects a malformed TV device entry", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      tvDevices: [{ id: "dev-1", name: "Missing fields" }],
    })

    expect(tvDevices).toEqual([])
  })
})
