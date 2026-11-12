// Followed Series — subscriptions, episode-change detection, in-app
// notifications, background checks, and the launcher notifications.json
// contract.
//
// Design notes (read before touching the guards):
// - A follow records the CURRENTLY available episodes as the baseline.
//   The back catalogue never alerts.
// - Detection is key-set comparison on a normalised snapshot. Ordering
//   changes, renames (same provider id), duplicates and reordered seasons
//   are invisible to it by construction.
// - An incomplete provider response NEVER erases the baseline: a sane,
//   non-empty response is required before the stored snapshot is replaced.
//   On error the old baseline is kept and the next check is backed off.
// - If a provider remaps a whole series to new ids, the bulk-change guard
//   (most old episodes gone AND most new episodes "new" at once) keeps the
//   old baseline, raises no alerts, and flags the show for manual
//   re-baseline in the management view.
// - No IPTV passwords are ever stored in follow records. Records hold only
//   the playlist entry id (opaque), the provider series id, titles, poster
//   URLs, and episode identity (provider episode id / S/E numbers / title).
// - This module is import-safe in Node (vitest): no top-level access to
//   window/document/localStorage/indexedDB, and the real Xtream client is
//   dynamically imported only when a live check actually runs. Tests inject
//   a fake fetcher and an in-memory store.

import { log } from "@/scripts/lib/log.js"
import { createTimedIdbOpener } from "@/scripts/lib/idb-open.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FollowedEpisodeKey {
  season: number
  episode: number
  /** Provider episode id (get_series_info `id`), when the provider supplies one. */
  episodeId: number | null
  title: string
}

/** Discover seam shape — field names are the contract, do not rename. */
export interface FollowedEpisode {
  seriesId: string
  seriesTitle: string
  season: number
  episode: number
  episodeTitle?: string
  detectedAt: string
  posterUrl?: string
  watched: boolean
}

export type FollowedCheckStatus =
  | "never"
  | "ok"
  | "error"
  | "incomplete"
  | "unsupported-m3u"
  | "playlist-missing"
  | "bulk-remap-suspected"

export interface FollowedSubscription {
  /** `${playlistId}::${seriesId}` — stable across restarts and updates. */
  key: string
  playlistId: string
  seriesId: string
  seriesTitle: string
  posterUrl: string | null
  /** 'xtream' when get_series_info works; 'm3u' when the source has no reliable series metadata. */
  sourceKind: "xtream" | "m3u"
  followedAt: string
  /** Normalised snapshot of every episode available when followed (or last re-baselined). Sorted by season, episode. */
  baseline: FollowedEpisodeKey[]
  baselineUpdatedAt: string
  lastCheckAt: string | null
  lastCheckStatus: FollowedCheckStatus
  consecutiveFailures: number
  /** ISO timestamp before which the next check must not run (error backoff). Null when no backoff applies. */
  nextCheckNotBefore: string | null
  /** True when the bulk-remap guard fired: no alerts until the user re-baselines. */
  needsRebaseline: boolean
}

export interface FollowedNotificationEpisode extends FollowedEpisode {
  episodeId: number | null
}

export interface FollowedNotificationGroup {
  /** `${subscriptionKey}::${detectedAt}` */
  id: string
  playlistId: string
  seriesId: string
  seriesTitle: string
  posterUrl: string | null
  episodes: FollowedNotificationEpisode[]
  detectedAt: string
  read: boolean
  dismissed: boolean
}

export interface FollowedCheckSummary {
  startedAt: string
  finishedAt: string
  checked: number
  skipped: number
  newEpisodes: number
  groupsCreated: number
  errors: number
  /** Series ids flagged for manual re-baseline by the bulk-remap guard. */
  remapSuspects: string[]
  alreadyRunning: boolean
}

// ---------------------------------------------------------------------------
// Pure detection engine (no I/O — fully unit-testable)
// ---------------------------------------------------------------------------

export const BULK_REMAP_REMOVED_RATIO = 0.5
export const BULK_REMAP_NEW_RATIO = 0.5
/** A fresh snapshot smaller than half the baseline is treated as truncated, not as episodes vanishing. */
export const TRUNCATED_SNAPSHOT_RATIO = 0.5

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeTitle(title: unknown): string {
  return String(title ?? "").trim().replace(/\s+/g, " ")
}

/** Stable identity for one episode. Provider episode id wins; S/E numbers are the fallback; a normalised title is the last resort. */
export function episodeKey(ep: FollowedEpisodeKey): string {
  if (ep.episodeId != null && Number.isFinite(ep.episodeId)) return `id:${ep.episodeId}`
  if (ep.episode > 0) return `se:${ep.season}:${ep.episode}`
  const title = normalizeTitle(ep.title).toLowerCase()
  return title ? `t:${ep.season}:${title}` : `se:${ep.season}:${ep.episode}`
}

function compareEpisodes(a: FollowedEpisodeKey, b: FollowedEpisodeKey): number {
  return a.season - b.season || a.episode - b.episode || (a.episodeId ?? 0) - (b.episodeId ?? 0)
}

/**
 * Flatten a get_series_info payload into a sorted, deduplicated episode list.
 * Accepts both shapes the provider returns: `episodes` as an object keyed by
 * season ("1": [...]) and as a flat array with `season` on each entry.
 * Entries with no usable identity (no id, no episode number, no title) are
 * dropped — they can never be told apart from each other, so counting them
 * would only manufacture false positives.
 */
export function normalizeSnapshot(info: unknown): FollowedEpisodeKey[] {
  if (!info || typeof info !== "object") return []
  const episodes = (info as Record<string, unknown>).episodes
  const out: FollowedEpisodeKey[] = []
  const push = (seasonRaw: unknown, ep: unknown) => {
    if (!ep || typeof ep !== "object") return
    const rec = ep as Record<string, unknown>
    const infoRec =
      rec.info && typeof rec.info === "object" ? (rec.info as Record<string, unknown>) : null
    const season = toFiniteNumber(rec.season ?? seasonRaw) ?? 1
    const episode = toFiniteNumber(rec.episode_num) ?? 0
    const episodeId = toFiniteNumber(rec.id)
    const title = normalizeTitle(rec.title ?? infoRec?.title ?? "")
    if (episodeId == null && episode <= 0 && !title) return
    out.push({ season, episode, episodeId, title })
  }
  if (episodes && typeof episodes === "object" && !Array.isArray(episodes)) {
    for (const [seasonKey, list] of Object.entries(episodes as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      for (const ep of list) push(seasonKey, ep)
    }
  } else if (Array.isArray(episodes)) {
    for (const ep of episodes) push(undefined, ep)
  }
  const seen = new Map<string, FollowedEpisodeKey>()
  for (const ep of out) {
    const key = episodeKey(ep)
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, ep)
      continue
    }
    // Same identity twice (provider duplicate): keep the entry with a title.
    if (!prev.title && ep.title) seen.set(key, ep)
  }
  return [...seen.values()].sort(compareEpisodes)
}

/**
 * Is this payload sane enough to replace a baseline? A response with no
 * `episodes` member at all, or an empty episode list while a baseline
 * already exists, is incomplete — the provider hiccuped, episodes did not
 * vanish. A genuinely empty series (no baseline yet) is sane-but-empty.
 */
export function isSaneSnapshot(info: unknown, baselineLength: number): boolean {
  if (!info || typeof info !== "object") return false
  const episodes = (info as Record<string, unknown>).episodes
  if (episodes == null) return false
  const snapshot = normalizeSnapshot(info)
  if (snapshot.length === 0 && baselineLength > 0) return false
  return true
}

export interface SnapshotDiff {
  newEpisodes: FollowedEpisodeKey[]
  removedCount: number
  /** True when the change looks like a provider-side id remap, not new episodes. */
  bulkRemapSuspected: boolean
  /** True when the fresh snapshot is implausibly small next to the baseline (truncated response). */
  truncated: boolean
}

/**
 * Compare a stored baseline against a fresh normalised snapshot.
 * Renames, reorders and duplicates produce no diff by construction (see
 * episodeKey / normalizeSnapshot). A bulk remap — most old episodes gone
 * AND most fresh episodes "new" — is flagged, never alerted on.
 */
export function diffSnapshots(
  baseline: FollowedEpisodeKey[],
  snapshot: FollowedEpisodeKey[]
): SnapshotDiff {
  const oldKeys = new Map(baseline.map((ep) => [episodeKey(ep), ep]))
  const newKeys = new Map(snapshot.map((ep) => [episodeKey(ep), ep]))
  const newEpisodes = snapshot.filter((ep) => !oldKeys.has(episodeKey(ep)))
  let removedCount = 0
  for (const key of oldKeys.keys()) if (!newKeys.has(key)) removedCount++
  const truncated =
    baseline.length > 0 && snapshot.length < baseline.length * TRUNCATED_SNAPSHOT_RATIO
  const bulkRemapSuspected =
    !truncated &&
    baseline.length > 0 &&
    newEpisodes.length > 0 &&
    removedCount / baseline.length > BULK_REMAP_REMOVED_RATIO &&
    newEpisodes.length / Math.max(snapshot.length, 1) > BULK_REMAP_NEW_RATIO
  return { newEpisodes, removedCount, bulkRemapSuspected, truncated }
}

// ---------------------------------------------------------------------------
// notifications.json — launcher contract (schema v1)
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_SCHEMA_VERSION = 1
export const NOTIFICATIONS_FILE_MAX_EPISODES = 10

export interface LauncherNotification {
  seriesId: string
  seriesTitle: string
  season: number
  episode: number
  episodeTitle: string
  detectedAt: string
  posterUrl?: string
}

export interface LauncherNotificationsFile {
  schemaVersion: 1
  lastCheck: string
  unreadCount: number
  notifications: LauncherNotification[]
}

/** Only local/cache poster URLs may leave the app (contract: no provider URLs). */
export function isLocalPosterUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const u = url.trim()
  return (
    u.startsWith("file://") ||
    u.startsWith("asset://") ||
    u.startsWith("app://") ||
    u.startsWith("/") ||
    u.startsWith("data:image/")
  )
}

/**
 * Serialise the unread set for `%LOCALAPPDATA%\\RedSilk\\integration\\notifications.json`.
 * One entry per episode, newest first, bounded to the latest ~10. No
 * passwords, no streaming URLs, no provider URLs — ever.
 */
export function serializeNotificationsFile(input: {
  lastCheck: string | null
  groups: FollowedNotificationGroup[]
}): string {
  const flat: LauncherNotification[] = []
  const unread = input.groups
    .filter((g) => !g.read && !g.dismissed)
    .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
  for (const group of unread) {
    for (const ep of group.episodes) {
      flat.push({
        seriesId: group.seriesId,
        seriesTitle: group.seriesTitle,
        season: ep.season,
        episode: ep.episode,
        episodeTitle: ep.episodeTitle ?? "",
        detectedAt: group.detectedAt,
        ...(isLocalPosterUrl(group.posterUrl ?? ep.posterUrl)
          ? { posterUrl: (group.posterUrl ?? ep.posterUrl) as string }
          : {}),
      })
    }
  }
  flat.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
  const notifications = flat.slice(0, NOTIFICATIONS_FILE_MAX_EPISODES)
  const file: LauncherNotificationsFile = {
    schemaVersion: NOTIFICATIONS_SCHEMA_VERSION,
    lastCheck: input.lastCheck ?? new Date(0).toISOString(),
    unreadCount: notifications.length,
    notifications,
  }
  return JSON.stringify(file)
}

/**
 * Parse a notifications.json payload tolerantly: malformed JSON, a wrong
 * schema version, or junk entries never throw — they yield null (whole file
 * unusable) or a file with the bad entries dropped.
 */
export function parseNotificationsFile(text: string): LauncherNotificationsFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  if (rec.schemaVersion !== NOTIFICATIONS_SCHEMA_VERSION) return null
  const notifications: LauncherNotification[] = []
  if (Array.isArray(rec.notifications)) {
    for (const entry of rec.notifications) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      if (typeof e.seriesId !== "string" || !e.seriesId) continue
      const season = toFiniteNumber(e.season)
      const episode = toFiniteNumber(e.episode)
      if (season == null || episode == null) continue
      notifications.push({
        seriesId: e.seriesId,
        seriesTitle: typeof e.seriesTitle === "string" ? e.seriesTitle : "",
        season,
        episode,
        episodeTitle: typeof e.episodeTitle === "string" ? e.episodeTitle : "",
        detectedAt: typeof e.detectedAt === "string" ? e.detectedAt : new Date(0).toISOString(),
        ...(typeof e.posterUrl === "string" && e.posterUrl ? { posterUrl: e.posterUrl } : {}),
      })
    }
  }
  return {
    schemaVersion: 1,
    lastCheck: typeof rec.lastCheck === "string" ? rec.lastCheck : new Date(0).toISOString(),
    unreadCount: notifications.length,
    notifications: notifications.slice(0, NOTIFICATIONS_FILE_MAX_EPISODES),
  }
}

// ---------------------------------------------------------------------------
// Storage (IndexedDB with an in-memory fallback; injectable for tests)
// ---------------------------------------------------------------------------

export interface FollowedStore {
  getAllSubscriptions(): Promise<FollowedSubscription[]>
  putSubscription(sub: FollowedSubscription): Promise<void>
  deleteSubscription(key: string): Promise<void>
  getAllNotifications(): Promise<FollowedNotificationGroup[]>
  putNotification(group: FollowedNotificationGroup): Promise<void>
  deleteNotification(id: string): Promise<void>
  getMeta(key: string): Promise<string | null>
  putMeta(key: string, value: string): Promise<void>
}

const FOLLOWED_DB_NAME = "nylah_followed"
const FOLLOWED_DB_VERSION = 1
const SUB_STORE = "subscriptions"
const NOTIF_STORE = "notifications"
const META_STORE = "meta"
const META_LAST_CHECK = "lastCheckAt"
const META_CHECK_LOCK = "checkLock"

/** IndexedDB meta key for the last followed-check timestamp (shared with backup.js). */
export const FOLLOWED_LAST_CHECK_META_KEY = META_LAST_CHECK

export function createMemoryFollowedStore(): FollowedStore {
  const subs = new Map<string, FollowedSubscription>()
  const notifs = new Map<string, FollowedNotificationGroup>()
  const meta = new Map<string, string>()
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
  return {
    async getAllSubscriptions() {
      return [...subs.values()].map(clone)
    },
    async putSubscription(sub) {
      subs.set(sub.key, clone(sub))
    },
    async deleteSubscription(key) {
      subs.delete(key)
    },
    async getAllNotifications() {
      return [...notifs.values()].map(clone)
    },
    async putNotification(group) {
      notifs.set(group.id, clone(group))
    },
    async deleteNotification(id) {
      notifs.delete(id)
    },
    async getMeta(key) {
      return meta.get(key) ?? null
    },
    async putMeta(key, value) {
      meta.set(key, value)
    },
  }
}

function createIdbFollowedStore(): FollowedStore {
  const opener = createTimedIdbOpener({
    name: FOLLOWED_DB_NAME,
    version: FOLLOWED_DB_VERSION,
    logTag: "xt:followed",
    upgrade(db) {
      if (!db.objectStoreNames.contains(SUB_STORE)) {
        db.createObjectStore(SUB_STORE, { keyPath: "key" })
      }
      if (!db.objectStoreNames.contains(NOTIF_STORE)) {
        db.createObjectStore(NOTIF_STORE, { keyPath: "id" })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" })
      }
    },
  })
  const memory = createMemoryFollowedStore()
  let idbFailed = false

  async function db(): Promise<IDBDatabase | null> {
    if (idbFailed) return null
    try {
      const opened = await opener.open()
      if (!opened) idbFailed = true
      return opened
    } catch {
      idbFailed = true
      return null
    }
  }

  function tx<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    return (async () => {
      const database = await db()
      if (!database) throw new Error("IndexedDB unavailable")
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(store, mode)
        const req = run(transaction.objectStore(store))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      })
    })()
  }

  async function getAll<T>(store: string): Promise<T[]> {
    const database = await db()
    if (!database) throw new Error("IndexedDB unavailable")
    return await new Promise<T[]>((resolve, reject) => {
      const transaction = database.transaction(store, "readonly")
      const req = transaction.objectStore(store).getAll()
      req.onsuccess = () => resolve((req.result as T[]) || [])
      req.onerror = () => reject(req.error)
    })
  }

  // Every method falls back to the in-memory store when IndexedDB is
  // unavailable (private mode, blocked open, non-browser env), so follows
  // still work for the session instead of failing outright.
  const withFallback = <T,>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> =>
    fn().catch(() => fallback())

  return {
    getAllSubscriptions: () => withFallback(() => getAll(SUB_STORE), () => memory.getAllSubscriptions()),
    putSubscription: (sub) =>
      withFallback(() => tx(SUB_STORE, "readwrite", (s) => s.put(sub)).then(() => {}), () => memory.putSubscription(sub)),
    deleteSubscription: (key) =>
      withFallback(() => tx(SUB_STORE, "readwrite", (s) => s.delete(key)).then(() => {}), () => memory.deleteSubscription(key)),
    getAllNotifications: () => withFallback(() => getAll(NOTIF_STORE), () => memory.getAllNotifications()),
    putNotification: (group) =>
      withFallback(() => tx(NOTIF_STORE, "readwrite", (s) => s.put(group)).then(() => {}), () => memory.putNotification(group)),
    deleteNotification: (id) =>
      withFallback(() => tx(NOTIF_STORE, "readwrite", (s) => s.delete(id)).then(() => {}), () => memory.deleteNotification(id)),
    getMeta: (key) =>
      withFallback(
        () =>
          tx(META_STORE, "readonly", (s) => s.get(key)).then(
            (row) => ((row as { value?: string } | undefined)?.value ?? null) as string | null
          ),
        () => memory.getMeta(key)
      ),
    putMeta: (key, value) =>
      withFallback(
        () => tx(META_STORE, "readwrite", (s) => s.put({ key, value })).then(() => {}),
        () => memory.putMeta(key, value)
      ),
  }
}

let activeStore: FollowedStore | null = null
export function getFollowedStore(): FollowedStore {
  if (!activeStore) activeStore = createIdbFollowedStore()
  return activeStore
}
/** Test hook: swap the backing store (e.g. a fresh in-memory store per test). */
export function setFollowedStore(store: FollowedStore | null): void {
  activeStore = store
}

// ---------------------------------------------------------------------------
// Settings (localStorage, same guarded pattern as app-settings.js)
// ---------------------------------------------------------------------------

export const FOLLOWED_CHECK_INTERVALS = [3, 6, 12, 24] as const
export const DEFAULT_FOLLOWED_CHECK_INTERVAL_HOURS = 6
export const DEFAULT_FOLLOWED_CHECK_ENABLED = true
const LS_ENABLED_KEY = "xt_followed_check_enabled"
const LS_INTERVAL_KEY = "xt_followed_check_interval_hours"
export const FOLLOWED_CHANGED_EVENT = "xt:followed-changed"
export const FOLLOWED_NOTIFICATIONS_EVENT = "xt:followed-notifications-changed"

function lsGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(key, value)
  } catch (err) {
    log.warn("[xt:followed] localStorage write failed for", key, err)
  }
}

function emitFollowedChanged(): void {
  try {
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent(FOLLOWED_CHANGED_EVENT))
    }
  } catch {}
}

function emitNotificationsChanged(): void {
  try {
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent(FOLLOWED_NOTIFICATIONS_EVENT))
    }
  } catch {}
}

export function getFollowedCheckEnabled(): boolean {
  const raw = lsGet(LS_ENABLED_KEY)
  if (raw == null) return DEFAULT_FOLLOWED_CHECK_ENABLED
  return raw !== "0" && raw !== "false"
}

export function setFollowedCheckEnabled(enabled: boolean): void {
  lsSet(LS_ENABLED_KEY, enabled ? "1" : "0")
}

export function getFollowedCheckIntervalHours(): number {
  const raw = Number(lsGet(LS_INTERVAL_KEY))
  if ((FOLLOWED_CHECK_INTERVALS as readonly number[]).includes(raw)) return raw
  return DEFAULT_FOLLOWED_CHECK_INTERVAL_HOURS
}

export function setFollowedCheckIntervalHours(hours: number): boolean {
  if (!(FOLLOWED_CHECK_INTERVALS as readonly number[]).includes(Number(hours))) return false
  lsSet(LS_INTERVAL_KEY, String(hours))
  return true
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export function subscriptionKey(playlistId: string, seriesId: string): string {
  return `${playlistId}::${seriesId}`
}

export interface FollowResult {
  ok: boolean
  reason?: "no-episodes" | "already-followed" | "store-unavailable"
  subscription?: FollowedSubscription
}

/**
 * Follow a series, baselining the episodes available RIGHT NOW from a
 * get_series_info payload (the detail page already holds one). No alerts
 * are ever raised for this back catalogue.
 */
export async function followSeries(
  input: {
    playlistId: string
    seriesId: string
    seriesTitle: string
    posterUrl?: string | null
    sourceKind?: "xtream" | "m3u"
    seriesInfo: unknown
  },
  store: FollowedStore = getFollowedStore()
): Promise<FollowResult> {
  const snapshot = normalizeSnapshot(input.seriesInfo)
  if (snapshot.length === 0) {
    // Nothing reliable to baseline against: following now would alert on
    // the whole back catalogue at the first check. Refuse, let the UI retry
    // once the provider answers.
    return { ok: false, reason: "no-episodes" }
  }
  const key = subscriptionKey(input.playlistId, input.seriesId)
  const now = new Date().toISOString()
  const sub: FollowedSubscription = {
    key,
    playlistId: input.playlistId,
    seriesId: input.seriesId,
    seriesTitle: input.seriesTitle,
    posterUrl: input.posterUrl ?? null,
    sourceKind: input.sourceKind ?? "xtream",
    followedAt: now,
    baseline: snapshot,
    baselineUpdatedAt: now,
    lastCheckAt: null,
    lastCheckStatus: "never",
    consecutiveFailures: 0,
    nextCheckNotBefore: null,
    needsRebaseline: false,
  }
  try {
    await store.putSubscription(sub)
  } catch (err) {
    log.warn("[xt:followed] follow put failed:", err)
    return { ok: false, reason: "store-unavailable" }
  }
  emitFollowedChanged()
  return { ok: true, subscription: sub }
}

export async function unfollowSeries(
  playlistId: string,
  seriesId: string,
  store: FollowedStore = getFollowedStore()
): Promise<void> {
  const key = subscriptionKey(playlistId, seriesId)
  await store.deleteSubscription(key).catch(() => {})
  // Drop unread notifications for the show — it is no longer followed, so
  // nothing new can arrive for it. Read history is kept.
  const groups = await store.getAllNotifications().catch(() => [])
  for (const group of groups) {
    if (group.playlistId === playlistId && group.seriesId === seriesId && !group.read) {
      await store.deleteNotification(group.id).catch(() => {})
    }
  }
  emitFollowedChanged()
  emitNotificationsChanged()
  await publishNotificationsFile(store).catch(() => {})
}

export async function isFollowing(
  playlistId: string,
  seriesId: string,
  store: FollowedStore = getFollowedStore()
): Promise<boolean> {
  const subs = await store.getAllSubscriptions().catch(() => [])
  return subs.some((s) => s.key === subscriptionKey(playlistId, seriesId))
}

export async function listSubscriptions(
  store: FollowedStore = getFollowedStore()
): Promise<FollowedSubscription[]> {
  const subs = await store.getAllSubscriptions().catch(() => [])
  return subs.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle))
}

export interface RebaselineResult {
  ok: boolean
  reason?: "not-followed" | "no-episodes" | "fetch-failed"
  subscription?: FollowedSubscription
}

/** Replace a subscription's baseline with the current provider snapshot, silently (no alerts). Used after the bulk-remap guard fires. */
export async function rebaselineSeries(
  playlistId: string,
  seriesId: string,
  seriesInfo: unknown,
  store: FollowedStore = getFollowedStore()
): Promise<RebaselineResult> {
  const subs = await store.getAllSubscriptions().catch(() => [])
  const sub = subs.find((s) => s.key === subscriptionKey(playlistId, seriesId))
  if (!sub) return { ok: false, reason: "not-followed" }
  const snapshot = normalizeSnapshot(seriesInfo)
  if (snapshot.length === 0) return { ok: false, reason: "no-episodes" }
  const now = new Date().toISOString()
  const updated: FollowedSubscription = {
    ...sub,
    baseline: snapshot,
    baselineUpdatedAt: now,
    lastCheckAt: now,
    lastCheckStatus: "ok",
    consecutiveFailures: 0,
    nextCheckNotBefore: null,
    needsRebaseline: false,
  }
  await store.putSubscription(updated)
  emitFollowedChanged()
  return { ok: true, subscription: updated }
}

// ---------------------------------------------------------------------------
// Notifications (in-app history)
// ---------------------------------------------------------------------------

export const MAX_STORED_NOTIFICATION_GROUPS = 50

export async function listNotificationGroups(
  opts: { includeDismissed?: boolean } = {},
  store: FollowedStore = getFollowedStore()
): Promise<FollowedNotificationGroup[]> {
  const groups = await store.getAllNotifications().catch(() => [])
  return groups
    .filter((g) => opts.includeDismissed || !g.dismissed)
    .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
}

export async function getUnreadCount(store: FollowedStore = getFollowedStore()): Promise<number> {
  const groups = await store.getAllNotifications().catch(() => [])
  return groups.filter((g) => !g.read && !g.dismissed).reduce((n, g) => n + g.episodes.length, 0)
}

export async function getUnreadEpisodes(
  store: FollowedStore = getFollowedStore()
): Promise<FollowedNotificationEpisode[]> {
  const groups = await listNotificationGroups({}, store)
  const out: FollowedNotificationEpisode[] = []
  for (const group of groups) {
    if (group.read || group.dismissed) continue
    for (const ep of group.episodes) out.push({ ...ep, watched: isEpisodeWatched(group, ep) })
  }
  return out.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
}

export async function markNotificationRead(
  id: string,
  store: FollowedStore = getFollowedStore()
): Promise<void> {
  const groups = await store.getAllNotifications().catch(() => [])
  const group = groups.find((g) => g.id === id)
  if (!group) return
  await store.putNotification({ ...group, read: true })
  emitNotificationsChanged()
  await publishNotificationsFile(store).catch(() => {})
}

export async function dismissNotification(
  id: string,
  store: FollowedStore = getFollowedStore()
): Promise<void> {
  const groups = await store.getAllNotifications().catch(() => [])
  const group = groups.find((g) => g.id === id)
  if (!group) return
  await store.putNotification({ ...group, dismissed: true, read: true })
  emitNotificationsChanged()
  await publishNotificationsFile(store).catch(() => {})
}

export async function markAllNotificationsRead(
  store: FollowedStore = getFollowedStore()
): Promise<void> {
  const groups = await store.getAllNotifications().catch(() => [])
  for (const group of groups) {
    if (!group.read || !group.dismissed) {
      // Dismissed groups stay dismissed; unread ones become read.
      if (!group.dismissed) await store.putNotification({ ...group, read: true })
    }
  }
  emitNotificationsChanged()
  await publishNotificationsFile(store).catch(() => {})
}

/**
 * Clear the unread notification for one episode — called when the episode
 * is marked watched or playback finishes. If its group empties, the group
 * is removed (nothing left to act on).
 */
export async function clearUnreadForEpisode(
  playlistId: string,
  seriesId: string,
  episode: { season: number; episode: number; episodeId?: number | null },
  store: FollowedStore = getFollowedStore()
): Promise<boolean> {
  const groups = await store.getAllNotifications().catch(() => [])
  let changed = false
  for (const group of groups) {
    if (group.playlistId !== playlistId || group.seriesId !== seriesId) continue
    if (group.read || group.dismissed) continue
    const remaining = group.episodes.filter((ep) => {
      if (episode.episodeId != null && ep.episodeId != null) return ep.episodeId !== episode.episodeId
      return !(ep.season === episode.season && ep.episode === episode.episode)
    })
    if (remaining.length === group.episodes.length) continue
    changed = true
    if (remaining.length === 0) {
      await store.deleteNotification(group.id).catch(() => {})
    } else {
      await store.putNotification({ ...group, episodes: remaining })
    }
  }
  if (changed) {
    emitNotificationsChanged()
    await publishNotificationsFile(store).catch(() => {})
  }
  return changed
}

// ---------------------------------------------------------------------------
// Watched state (pluggable so the core stays Node-safe; the app wires the
// real preferences-backed checker at startup)
// ---------------------------------------------------------------------------

export type WatchedChecker = (
  playlistId: string,
  seriesId: string,
  episode: { season: number; episode: number; episodeId: number | null }
) => boolean

let watchedChecker: WatchedChecker | null = null
export function setFollowedWatchedChecker(checker: WatchedChecker | null): void {
  watchedChecker = checker
}

function isEpisodeWatched(
  group: FollowedNotificationGroup,
  ep: FollowedNotificationEpisode
): boolean {
  try {
    return !!watchedChecker?.(group.playlistId, group.seriesId, {
      season: ep.season,
      episode: ep.episode,
      episodeId: ep.episodeId,
    })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Launcher notifications.json publishing
// ---------------------------------------------------------------------------

function isTauriRuntime(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      (!!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
        !!(window as unknown as Record<string, unknown>).__TAURI__)
    )
  } catch {
    return false
  }
}

export async function getFollowedLastCheckAt(
  store: FollowedStore = getFollowedStore()
): Promise<string | null> {
  return await store.getMeta(META_LAST_CHECK).catch(() => null)
}

/**
 * Atomically publish the unread set to
 * %LOCALAPPDATA%\\RedSilk\\integration\\notifications.json via the Rust
 * command (temp file + rename, folder created if missing). No-op outside
 * the Tauri desktop runtime — publishing must never break a check.
 */
export async function publishNotificationsFile(
  store: FollowedStore = getFollowedStore()
): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    const groups = await store.getAllNotifications().catch(() => [])
    const lastCheck = await store.getMeta(META_LAST_CHECK).catch(() => null)
    const json = serializeNotificationsFile({ lastCheck, groups })
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("followed_publish_notifications", { json })
    return true
  } catch (err) {
    log.warn("[xt:followed] notifications.json publish failed:", err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

export type SeriesInfoFetcher = (
  playlistId: string,
  seriesId: string
) => Promise<unknown>

export interface PlaylistEntryInfo {
  entryId: string
  /** 'xtream' | 'm3u' | 'unknown' — 'unknown' is treated as xtream (fetch decides). */
  kind: "xtream" | "m3u" | "unknown"
}

export interface CheckRunnerDeps {
  /** Resolve a playlist entry (for source-kind detection). Defaults to the real creds module. */
  resolveEntry?: (playlistId: string) => Promise<PlaylistEntryInfo | null>
  /** Fetch a raw get_series_info payload. Defaults to the real Xtream client. */
  fetchSeriesInfo?: SeriesInfoFetcher
}

const BACKOFF_BASE_MS = 15 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
const CHECK_LOCK_TTL_MS = 15 * 60 * 1000

let checkInFlight: Promise<FollowedCheckSummary> | null = null

function backoffUntil(failures: number): string {
  const ms = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0), BACKOFF_MAX_MS)
  return new Date(Date.now() + ms).toISOString()
}

async function defaultResolveEntry(playlistId: string): Promise<PlaylistEntryInfo | null> {
  try {
    const creds = await import("@/scripts/lib/creds.js")
    const entries = await creds.getEntries()
    const entry = entries.find((e: { _id?: string }) => e._id === playlistId)
    if (!entry) return null
    const host = String(entry.host ?? "")
    const user = String(entry.user ?? entry.username ?? "")
    const pass = String(entry.pass ?? entry.password ?? "")
    const isM3u =
      creds.isLikelyM3USource(host, user, pass) ||
      creds.isLocalM3UHost(host) ||
      creds.isCustomHost(host)
    return { entryId: playlistId, kind: isM3u ? "m3u" : "xtream" }
  } catch (err) {
    log.warn("[xt:followed] resolveEntry failed:", err)
    return { entryId: playlistId, kind: "unknown" }
  }
}

async function defaultFetchSeriesInfo(playlistId: string, seriesId: string): Promise<unknown> {
  const { xtreamApiFetch } = await import("@/scripts/lib/xtream-api.js")
  const entry = await defaultResolveEntry(playlistId)
  const response = await xtreamApiFetch(
    "get_series_info",
    { series_id: String(seriesId), series: String(seriesId) },
    { entryId: entry?.entryId ?? playlistId }
  )
  if (!response.ok) throw new Error(`get_series_info HTTP ${response.status}`)
  const data = await response.json()
  // Refresh the shared series-info cache so detail pages benefit from the
  // check's fetch instead of re-requesting the same payload.
  try {
    const { setCached } = await import("@/scripts/lib/cache.js")
    setCached(playlistId, `series_info_${seriesId}`, data, 7 * 24 * 60 * 60 * 1000)
  } catch {}
  return data
}

/**
 * Run one check across every followed series (all playlists). Metadata
 * only — never opens a stream or consumes a streaming connection.
 * Concurrent invocations collapse into one run (in-process mutex plus a
 * stored lock with a TTL, so two windows cannot scan at once either).
 */
export function runFollowedCheck(
  opts: { manual?: boolean; store?: FollowedStore; deps?: CheckRunnerDeps } = {}
): Promise<FollowedCheckSummary> {
  if (checkInFlight) return checkInFlight
  const run = runFollowedCheckInner(opts)
  checkInFlight = run
  run.finally(() => {
    if (checkInFlight === run) checkInFlight = null
  })
  return checkInFlight
}

async function runFollowedCheckInner(opts: {
  manual?: boolean
  store?: FollowedStore
  deps?: CheckRunnerDeps
}): Promise<FollowedCheckSummary> {
  const store = opts.store ?? getFollowedStore()
  const deps = opts.deps ?? {}
  const startedAt = new Date().toISOString()
  const summary: FollowedCheckSummary = {
    startedAt,
    finishedAt: startedAt,
    checked: 0,
    skipped: 0,
    newEpisodes: 0,
    groupsCreated: 0,
    errors: 0,
    remapSuspects: [],
    alreadyRunning: false,
  }
  const finish = (): FollowedCheckSummary => {
    summary.finishedAt = new Date().toISOString()
    return summary
  }

  // Cross-window lock: a stale lock (older than the TTL) is treated as abandoned.
  try {
    const rawLock = await store.getMeta(META_CHECK_LOCK).catch(() => null)
    if (rawLock) {
      const lock = JSON.parse(rawLock) as { at: string }
      if (lock?.at && Date.now() - new Date(lock.at).getTime() < CHECK_LOCK_TTL_MS && !opts.manual) {
        summary.alreadyRunning = true
        return finish()
      }
    }
    await store.putMeta(META_CHECK_LOCK, JSON.stringify({ at: startedAt })).catch(() => {})
  } catch {}

  const resolveEntry = deps.resolveEntry ?? defaultResolveEntry
  const fetchSeriesInfo = deps.fetchSeriesInfo ?? defaultFetchSeriesInfo

  try {
    const subs = await store.getAllSubscriptions().catch(() => [])
    const now = new Date()
    for (const sub of subs) {
      // Error backoff: skip shows that failed recently (manual runs override it).
      if (
        !opts.manual &&
        sub.nextCheckNotBefore &&
        new Date(sub.nextCheckNotBefore).getTime() > now.getTime()
      ) {
        summary.skipped++
        continue
      }
      const entry = await resolveEntry(sub.playlistId)
      if (!entry) {
        summary.skipped++
        await store.putSubscription({ ...sub, lastCheckStatus: "playlist-missing" })
        continue
      }
      if (entry.kind === "m3u" || sub.sourceKind === "m3u") {
        summary.skipped++
        if (sub.lastCheckStatus !== "unsupported-m3u") {
          await store.putSubscription({ ...sub, lastCheckStatus: "unsupported-m3u" })
        }
        continue
      }
      let info: unknown
      try {
        info = await fetchSeriesInfo(sub.playlistId, sub.seriesId)
      } catch (err) {
        log.warn(`[xt:followed] check failed for ${sub.seriesTitle}:`, err)
        summary.errors++
        const failures = sub.consecutiveFailures + 1
        await store.putSubscription({
          ...sub,
          lastCheckAt: now.toISOString(),
          lastCheckStatus: "error",
          consecutiveFailures: failures,
          nextCheckNotBefore: backoffUntil(failures),
        })
        continue
      }
      summary.checked++
      const checkedAt = new Date().toISOString()
      if (!isSaneSnapshot(info, sub.baseline.length)) {
        // Incomplete response: NEVER touch the baseline.
        summary.errors++
        const failures = sub.consecutiveFailures + 1
        await store.putSubscription({
          ...sub,
          lastCheckAt: checkedAt,
          lastCheckStatus: "incomplete",
          consecutiveFailures: failures,
          nextCheckNotBefore: backoffUntil(failures),
        })
        continue
      }
      const snapshot = normalizeSnapshot(info)
      const diff = diffSnapshots(sub.baseline, snapshot)
      if (diff.truncated) {
        // Implausibly small snapshot: treat as truncated, keep the baseline.
        summary.errors++
        const failures = sub.consecutiveFailures + 1
        await store.putSubscription({
          ...sub,
          lastCheckAt: checkedAt,
          lastCheckStatus: "incomplete",
          consecutiveFailures: failures,
          nextCheckNotBefore: backoffUntil(failures),
        })
        continue
      }
      if (diff.bulkRemapSuspected) {
        // Provider remapped ids wholesale: keep the old baseline, flag for
        // manual re-baseline, raise NO notifications.
        summary.remapSuspects.push(sub.seriesId)
        await store.putSubscription({
          ...sub,
          lastCheckAt: checkedAt,
          lastCheckStatus: "bulk-remap-suspected",
          needsRebaseline: true,
          consecutiveFailures: 0,
          nextCheckNotBefore: null,
        })
        continue
      }
      const updated: FollowedSubscription = {
        ...sub,
        baseline: snapshot,
        baselineUpdatedAt: checkedAt,
        lastCheckAt: checkedAt,
        lastCheckStatus: "ok",
        consecutiveFailures: 0,
        nextCheckNotBefore: null,
        needsRebaseline: false,
      }
      await store.putSubscription(updated)
      if (diff.newEpisodes.length > 0) {
        // One grouped notification per series per check, episodes inside.
        const group: FollowedNotificationGroup = {
          id: `${sub.key}::${checkedAt}`,
          playlistId: sub.playlistId,
          seriesId: sub.seriesId,
          seriesTitle: sub.seriesTitle,
          posterUrl: sub.posterUrl,
          episodes: diff.newEpisodes.map((ep) => ({
            seriesId: sub.seriesId,
            seriesTitle: sub.seriesTitle,
            season: ep.season,
            episode: ep.episode,
            episodeTitle: ep.title || undefined,
            episodeId: ep.episodeId,
            detectedAt: checkedAt,
            posterUrl: sub.posterUrl ?? undefined,
            watched: false,
          })),
          detectedAt: checkedAt,
          read: false,
          dismissed: false,
        }
        // Defensive dedupe: never create a second unread group with the
        // same episode set for this show.
        const existing = await store.getAllNotifications().catch(() => [])
        const duplicate = existing.some(
          (g) =>
            !g.read &&
            !g.dismissed &&
            g.seriesId === sub.seriesId &&
            g.playlistId === sub.playlistId &&
            g.episodes.length === group.episodes.length &&
            g.episodes.every((e) =>
              group.episodes.some(
                (n) => n.season === e.season && n.episode === e.episode && n.episodeId === e.episodeId
              )
            )
        )
        if (!duplicate) {
          await store.putNotification(group)
          summary.groupsCreated++
          summary.newEpisodes += diff.newEpisodes.length
        }
      }
    }
  } finally {
    await store.putMeta(META_LAST_CHECK, new Date().toISOString()).catch(() => {})
    await store.putMeta(META_CHECK_LOCK, JSON.stringify({ at: new Date(0).toISOString() })).catch(() => {})
  }

  // Prune notification history (keep the latest 50 groups).
  try {
    const groups = await store.getAllNotifications().catch(() => [])
    if (groups.length > MAX_STORED_NOTIFICATION_GROUPS) {
      const sorted = groups.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
      for (const stale of sorted.slice(0, groups.length - MAX_STORED_NOTIFICATION_GROUPS)) {
        await store.deleteNotification(stale.id).catch(() => {})
      }
    }
  } catch {}

  emitFollowedChanged()
  emitNotificationsChanged()
  await publishNotificationsFile(store).catch(() => {})
  await refreshFollowedCache(store).catch(() => {})
  return finish()
}

/** True when the stored last-check is older than the configured interval (or never ran). */
export async function isFollowedCheckStale(
  store: FollowedStore = getFollowedStore()
): Promise<boolean> {
  const last = await getFollowedLastCheckAt(store)
  if (!last) return true
  const ageMs = Date.now() - new Date(last).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0) return true
  return ageMs > getFollowedCheckIntervalHours() * 60 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Discover seam — the export the coordinator wires to the Discover module.
// Do NOT import the Discover module here; it does not exist in this tree.
// ---------------------------------------------------------------------------

/** In-memory cache of unread episodes, hydrated by ensureFollowedLoaded(). */
let cachedNewEpisodes: FollowedEpisode[] = []

export async function ensureFollowedLoaded(
  store: FollowedStore = getFollowedStore()
): Promise<void> {
  await refreshFollowedCache(store)
}

export async function refreshFollowedCache(
  store: FollowedStore = getFollowedStore()
): Promise<FollowedEpisode[]> {
  const groups = await listNotificationGroups({}, store)
  const out: FollowedEpisode[] = []
  for (const group of groups) {
    if (group.read || group.dismissed) continue
    for (const ep of group.episodes) {
      out.push({
        seriesId: group.seriesId,
        seriesTitle: group.seriesTitle,
        season: ep.season,
        episode: ep.episode,
        episodeTitle: ep.episodeTitle,
        detectedAt: group.detectedAt,
        posterUrl: group.posterUrl ?? undefined,
        watched: isEpisodeWatched(group, ep),
      })
    }
  }
  out.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0))
  cachedNewEpisodes = out
  return out
}

/**
 * Discover seam: the newest unread episodes, newest first. Callers should
 * await ensureFollowedLoaded() once after boot; this getter itself is
 * synchronous by contract and returns the last-loaded snapshot.
 */
export const followedProvider = {
  getNewEpisodes(): FollowedEpisode[] {
    return [...cachedNewEpisodes]
  },
}

// ---------------------------------------------------------------------------
// Deep-link helpers (shared by the startup handler and the detail page)
// ---------------------------------------------------------------------------

export interface DeepLinkTarget {
  seriesId: string
  season?: number
  episode?: number
}

/** Validate a deep-link payload (Tauri event or CLI args) — bad values are dropped, never navigated to. */
export function parseDeepLinkTarget(input: unknown): DeepLinkTarget | null {
  if (!input || typeof input !== "object") return null
  const rec = input as Record<string, unknown>
  const seriesId = String(rec.seriesId ?? rec.id ?? "").trim()
  if (!seriesId) return null
  const season = toFiniteNumber(rec.season)
  const episode = toFiniteNumber(rec.episode)
  const target: DeepLinkTarget = { seriesId }
  if (season != null && season > 0) target.season = season
  if (episode != null && episode > 0) target.episode = episode
  return target
}

/** Detail URL for a deep link. An episode always autoplays (Watch Now semantics). */
export function buildSeriesDetailUrl(target: DeepLinkTarget): string {
  const params = new URLSearchParams({ id: target.seriesId })
  if (target.season != null) params.set("season", String(target.season))
  if (target.episode != null) {
    params.set("epnum", String(target.episode))
    params.set("autoplay", "1")
  }
  return `/series/detail?${params.toString()}`
}
