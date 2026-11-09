// Per-person "who is watching" profiles for Nylah Studios.
//
// The household shares one Xtream playlist, and the app's existing store
// (preferences.js: xt_prefs, keyed by playlistId) stays the single source of
// truth for playback, favorites and Continue Watching. This module adds a
// separate, namespaced layer on top of it so Ciaran's and Aisling's taste
// can diverge over time:
//
//   - The registry + active profile live in localStorage (`nylah_*` keys).
//   - Each profile gets its own namespaced data bucket: watch history,
//     favorites and Continue Watching snapshots. The shared store is never
//     rewritten by this module; the "shared" (household) profile reads the
//     shared store directly, exactly as before.
//   - First pick: the profile CLAIMS a one-time copy of the household's
//     existing history (see claimSharedHistory). That is the only way the
//     two profiles start with anything to learn from — the copy is a
//     snapshot, not a live link, so later viewing only lands in the profile
//     that was active at the time (see observeSharedActivity).
//   - There is no LLM here. Suggestions are similarity matches computed
//     from the profile's own history + favorites (see suggestions.ts).
//
// This module never touches the Xtream auth flow, playback or EPG.

import {
  getWatchedSignals,
  getContinueWatching,
  getFavorites,
  getFavoriteMeta,
} from "@/scripts/lib/preferences.js"
import { log } from "@/scripts/lib/log.js"

export const PROFILE_CHANGED_EVENT = "nylah:profile-changed"
export const SHOW_PROFILE_PICKER_EVENT = "nylah:show-profile-picker"

const REGISTRY_KEY = "nylah_profiles_v1"
const ACTIVE_KEY = "nylah_profile_active_v1"
const DATA_KEY_PREFIX = "nylah_profile_data_"
const DATA_KEY_SUFFIX = "_v1"

const HISTORY_CAP = 200
const FAVORITES_CAP = 500
const CONTINUE_CAP = 12

export type ProfileKind = "vod" | "series"

export interface NylahProfile {
  id: string
  name: string
  /** Short label for the picker button, e.g. "C". */
  initial: string
  /** Accent used for the profile's picker tile. Any valid CSS color. */
  color: string
  createdAt: number
}

export interface ProfileWatchedSignal {
  kind: "vod" | "episode"
  id: string | number
  name?: string | null
  seriesId?: string | number | null
  seriesName?: string | null
  updatedAt: number
  completed: boolean
}

export interface ProfileFavorite {
  kind: ProfileKind
  id: number
  name: string
  logo: string | null
  addedAt: number
}

export interface ProfileProgressRow {
  kind: "vod" | "episode"
  id: string | number
  name?: string | null
  seriesId?: string | number | null
  seriesName?: string | null
  updatedAt: number
}

export interface ProfileData {
  history: ProfileWatchedSignal[]
  favorites: ProfileFavorite[]
  continueWatching: ProfileProgressRow[]
  /** Epoch ms of the one-time shared-history claim, or null if never claimed. */
  claimedAt: number | null
  /** Watermark for observeSharedActivity: shared signals at/before this were merged. */
  lastMirroredAt: number
  updatedAt: number
}

export const SHARED_PROFILE_ID = "shared"

export const PRESEEDED_PROFILES: NylahProfile[] = [
  {
    id: "ciaran",
    name: "Ciaran",
    initial: "C",
    color: "oklch(0.45 0.19 350)",
    createdAt: 0,
  },
  {
    id: "aisling",
    name: "Aisling",
    initial: "A",
    color: "oklch(0.55 0.12 75)",
    createdAt: 0,
  },
]

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    log.warn("[nylah:profiles] localStorage write failed:", key, error)
  }
}

function dataKey(profileId: string): string {
  return `${DATA_KEY_PREFIX}${profileId}${DATA_KEY_SUFFIX}`
}

function emptyData(): ProfileData {
  return {
    history: [],
    favorites: [],
    continueWatching: [],
    claimedAt: null,
    lastMirroredAt: 0,
    updatedAt: Date.now(),
  }
}

function normalizeData(raw: unknown): ProfileData {
  const base = emptyData()
  if (!raw || typeof raw !== "object") return base
  const data = raw as Partial<ProfileData>
  return {
    history: Array.isArray(data.history) ? data.history : [],
    favorites: Array.isArray(data.favorites) ? data.favorites : [],
    continueWatching: Array.isArray(data.continueWatching)
      ? data.continueWatching
      : [],
    claimedAt: typeof data.claimedAt === "number" ? data.claimedAt : null,
    lastMirroredAt:
      typeof data.lastMirroredAt === "number" ? data.lastMirroredAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
  }
}

/** The pre-seeded household profiles. The list is fixed for v1 (Ciaran + Aisling). */
export function listProfiles(): NylahProfile[] {
  const stored = readJson<{ profiles?: NylahProfile[] }>(REGISTRY_KEY, {})
  const storedProfiles = Array.isArray(stored.profiles) ? stored.profiles : []
  const byId = new Map<string, NylahProfile>()
  for (const profile of PRESEEDED_PROFILES) byId.set(profile.id, profile)
  for (const profile of storedProfiles) {
    if (profile?.id && typeof profile.name === "string") byId.set(profile.id, profile)
  }
  return [...byId.values()]
}

export function getProfile(profileId: string): NylahProfile | null {
  if (profileId === SHARED_PROFILE_ID) {
    return {
      id: SHARED_PROFILE_ID,
      name: "Household",
      initial: "H",
      color: "var(--color-fg-3)",
      createdAt: 0,
    }
  }
  return listProfiles().find((profile) => profile.id === profileId) || null
}

/**
 * Active profile id, or null when nobody has picked yet (the picker shows).
 * "shared" means the household explicitly chose the shared store.
 */
export function getActiveProfileId(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    if (raw === SHARED_PROFILE_ID) return SHARED_PROFILE_ID
    return getProfile(raw) ? raw : null
  } catch {
    return null
  }
}

export function getActiveProfile(): NylahProfile | null {
  const id = getActiveProfileId()
  if (!id) return null
  return getProfile(id)
}

export function isSharedProfileActive(): boolean {
  return getActiveProfileId() === SHARED_PROFILE_ID
}

function dispatchProfileChanged(profileId: string | null): void {
  document.dispatchEvent(
    new CustomEvent(PROFILE_CHANGED_EVENT, { detail: { profileId } })
  )
}

export function setActiveProfile(profileId: string | null): void {
  try {
    if (!profileId) localStorage.removeItem(ACTIVE_KEY)
    else localStorage.setItem(ACTIVE_KEY, profileId)
  } catch (error) {
    log.warn("[nylah:profiles] could not persist active profile:", error)
  }
  dispatchProfileChanged(profileId)
}

export function requestProfilePicker(): void {
  document.dispatchEvent(new CustomEvent(SHOW_PROFILE_PICKER_EVENT))
}

// ---------------------------------------------------------------------------
// Per-profile data buckets (namespaced localStorage; shared store untouched)
// ---------------------------------------------------------------------------

export function getProfileData(profileId: string): ProfileData {
  if (profileId === SHARED_PROFILE_ID) return emptyData()
  return normalizeData(readJson(dataKey(profileId), null))
}

function saveProfileData(profileId: string, data: ProfileData): void {
  if (profileId === SHARED_PROFILE_ID) return
  writeJson(dataKey(profileId), { ...data, updatedAt: Date.now() })
}

export function getProfileHistory(profileId: string): ProfileWatchedSignal[] {
  return getProfileData(profileId).history
}

export function getProfileFavorites(profileId: string): ProfileFavorite[] {
  return getProfileData(profileId).favorites
}

export function getProfileContinueWatching(profileId: string): ProfileProgressRow[] {
  return getProfileData(profileId).continueWatching
}

function signalKey(signal: { kind: string; id: string | number }): string {
  return `${signal.kind}:${String(signal.id)}`
}

/** Append (or refresh) one watched signal in the profile's history. */
export function recordWatch(
  profileId: string,
  signal: ProfileWatchedSignal
): void {
  if (profileId === SHARED_PROFILE_ID) return
  const data = getProfileData(profileId)
  const key = signalKey(signal)
  data.history = data.history.filter((row) => signalKey(row) !== key)
  data.history.unshift({ ...signal })
  data.history.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  if (data.history.length > HISTORY_CAP) data.history.length = HISTORY_CAP
  saveProfileData(profileId, data)
}

export function isProfileFavorite(
  profileId: string,
  kind: ProfileKind,
  id: number
): boolean {
  return getProfileData(profileId).favorites.some(
    (fav) => fav.kind === kind && Number(fav.id) === Number(id)
  )
}

/** Toggle one favorite inside the profile's own namespace. Returns the new state. */
export function toggleProfileFavorite(
  profileId: string,
  kind: ProfileKind,
  id: number,
  meta?: { name?: string; logo?: string | null }
): boolean {
  if (profileId === SHARED_PROFILE_ID) return false
  const data = getProfileData(profileId)
  const idx = data.favorites.findIndex(
    (fav) => fav.kind === kind && Number(fav.id) === Number(id)
  )
  if (idx >= 0) {
    data.favorites.splice(idx, 1)
    saveProfileData(profileId, data)
    return false
  }
  data.favorites.unshift({
    kind,
    id: Number(id),
    name: meta?.name || "",
    logo: meta?.logo ?? null,
    addedAt: Date.now(),
  })
  if (data.favorites.length > FAVORITES_CAP) {
    data.favorites.length = FAVORITES_CAP
  }
  saveProfileData(profileId, data)
  return true
}

export function snapshotContinueWatching(
  profileId: string,
  rows: ProfileProgressRow[]
): void {
  if (profileId === SHARED_PROFILE_ID) return
  const data = getProfileData(profileId)
  data.continueWatching = rows.slice(0, CONTINUE_CAP)
  saveProfileData(profileId, data)
}

// ---------------------------------------------------------------------------
// One-time claim of the existing shared history (first pick only)
// ---------------------------------------------------------------------------

export interface ClaimResult {
  claimed: boolean
  history: number
  favorites: number
  continueWatching: number
}

/**
 * Copy the household's existing history into a fresh profile, once.
 * Runs only when the profile has never claimed before; later calls are a
 * no-op returning { claimed: false }. The shared store is only read, never
 * modified. A profile with no shared history to claim keeps claimedAt set
 * (so we don't re-copy on every load) and its rails show the honest
 * cold-start state instead.
 */
export function claimSharedHistory(
  playlistId: string,
  profileId: string
): ClaimResult {
  const empty: ClaimResult = {
    claimed: false,
    history: 0,
    favorites: 0,
    continueWatching: 0,
  }
  if (!playlistId || !profileId || profileId === SHARED_PROFILE_ID) return empty
  const data = getProfileData(profileId)
  if (data.claimedAt) return empty

  const signals = getWatchedSignals(playlistId, HISTORY_CAP) || []
  data.history = signals.map((signal) => ({
    kind: signal.kind,
    id: signal.id,
    name: signal.name ?? null,
    seriesId: signal.seriesId ?? null,
    seriesName: signal.seriesName ?? null,
    updatedAt: signal.updatedAt || 0,
    completed: !!signal.completed,
  }))
  data.history.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

  const continueRows = (getContinueWatching(
    playlistId,
    CONTINUE_CAP
  ) || []) as any[]
  data.continueWatching = continueRows.map((row) => ({
    kind: row.kind,
    id: row.id,
    name: row.name ?? null,
    seriesId: row.seriesId ?? null,
    seriesName: row.seriesName ?? null,
    updatedAt: row.updatedAt || 0,
  }))

  const favorites: ProfileFavorite[] = []
  for (const kind of ["vod", "series"] as const) {
    const ids = (getFavorites(playlistId, kind as any) || new Set<number>()) as Set<number>
    for (const id of ids) {
      const meta = getFavoriteMeta(playlistId, kind, id)
      favorites.push({
        kind,
        id: Number(id),
        name: meta?.name || "",
        logo: meta?.logo ?? null,
        addedAt: Date.now(),
      })
    }
  }
  data.favorites = favorites

  const newestSignalAt = data.history.reduce(
    (max, row) => Math.max(max, row.updatedAt || 0),
    0
  )
  data.lastMirroredAt = newestSignalAt
  data.claimedAt = Date.now()
  saveProfileData(profileId, data)
  return {
    claimed: true,
    history: data.history.length,
    favorites: data.favorites.length,
    continueWatching: data.continueWatching.length,
  }
}

/** Idempotent: claim only when the profile has never claimed. */
export function ensureProfileClaimed(
  playlistId: string,
  profileId: string
): ClaimResult {
  return claimSharedHistory(playlistId, profileId)
}

// ---------------------------------------------------------------------------
// Keep learning: mirror new household playback into the active profile
// ---------------------------------------------------------------------------

const observedPlaylists = new Set<string>()

/**
 * Watch the existing `xt:progress-changed` event (fired by the playback
 * engine's own progress writes — this module never writes progress itself)
 * and mirror any shared watched signals newer than the profile's watermark
 * into the ACTIVE profile's history. Favorites are deliberately NOT mirrored:
 * they stay explicitly per-profile.
 *
 * Interim mechanism: until playback/favorite writes are routed per-profile,
 * both profiles learn from whatever is watched while they are active. The
 * one-time claim gives them a common starting point; they diverge from
 * there as each person watches while their profile is active.
 */
export function observeSharedActivity(playlistId: string): void {
  if (!playlistId || typeof document === "undefined") return
  if (observedPlaylists.has(playlistId)) return
  observedPlaylists.add(playlistId)

  document.addEventListener("xt:progress-changed", () => {
    try {
      const activeId = getActiveProfileId()
      if (!activeId || activeId === SHARED_PROFILE_ID) return
      const data = getProfileData(activeId)
      const signals = getWatchedSignals(playlistId, 60) || []
      let changed = false
      for (const signal of signals) {
        if ((signal.updatedAt || 0) <= data.lastMirroredAt) continue
        recordWatch(activeId, {
          kind: signal.kind,
          id: signal.id,
          name: signal.name ?? null,
          seriesId: signal.seriesId ?? null,
          seriesName: signal.seriesName ?? null,
          updatedAt: signal.updatedAt || 0,
          completed: !!signal.completed,
        })
        changed = true
      }
      if (changed) {
        const refreshed = getProfileData(activeId)
        refreshed.lastMirroredAt = Math.max(
          refreshed.lastMirroredAt,
          ...signals.map((signal) => signal.updatedAt || 0),
          Date.now()
        )
        saveProfileData(activeId, refreshed)
      }
    } catch (error) {
      log.warn("[nylah:profiles] mirror failed:", error)
    }
  })
}

/**
 * Activate a profile (and claim the shared history on first activation).
 * `playlistId` is the active Xtream playlist id; when absent the profile is
 * still activated but no claim runs.
 */
export function activateProfile(
  playlistId: string | null,
  profileId: string
): ClaimResult {
  setActiveProfile(profileId)
  if (playlistId && profileId !== SHARED_PROFILE_ID) {
    return claimSharedHistory(playlistId, profileId)
  }
  return { claimed: false, history: 0, favorites: 0, continueWatching: 0 }
}
