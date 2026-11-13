// Sports Corner — followed-team record (0.11.13, plan §3.2).
//
// One persisted record: whether the user follows Manchester United.
// Deliberately separate from Followed Series (followed.ts): no
// IndexedDB, no object store, no DB version bump, no check runner,
// no notifications. The follow record is the ONLY persisted sports
// state — fixtures are derived from the EPG on every render and
// never stored (plan §3.1), so a stale or cancelled listing can
// never be shown as fact.
//
// Default: FOLLOWED. v1 has no picker and the feature is the user's
// own United corner; requiring a setup tap to see his own team's
// matches would be pure friction. The first read with no stored
// record writes the default. Unfollow is the escape hatch (§5.4).

import { log } from "@/scripts/lib/log.js"

/** The only team v1 can follow. */
export const SPORTS_FOLLOWED_TEAM_ID = "manchester-united" as const
export const SPORTS_FOLLOWED_TEAM_NAME = "Manchester United" as const

/** localStorage key. No collision with the `xt_followed_*` series keys. */
export const SPORTS_FOLLOW_STORAGE_KEY = "xt_sports_followed_team"

/** Dispatched on follow/unfollow. Series code never emits this event. */
export const SPORTS_FOLLOW_CHANGED_EVENT = "xt:sports-follow-changed"

export interface SportsFollowState {
  /** Fixed in v1. The only team the app can follow. */
  teamId: typeof SPORTS_FOLLOWED_TEAM_ID
  /** Display name, shown verbatim on the hub and entry card. */
  displayName: typeof SPORTS_FOLLOWED_TEAM_NAME
  /** ISO timestamp of the follow action (or of first read when defaulted). */
  followedAt: string
  /** False only after an explicit Unfollow. */
  followed: boolean
}

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
    log.warn("[xt:sports] localStorage write failed for", key, err)
  }
}

function emitSportsFollowChanged(): void {
  try {
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent(SPORTS_FOLLOW_CHANGED_EVENT))
    }
  } catch {
    // No document (tests/SSR): listeners simply never fire.
  }
}

/** The default record: followed, stamped now. */
export function defaultSportsFollowState(nowMs: number = Date.now()): SportsFollowState {
  return {
    teamId: SPORTS_FOLLOWED_TEAM_ID,
    displayName: SPORTS_FOLLOWED_TEAM_NAME,
    followedAt: new Date(nowMs).toISOString(),
    followed: true,
  }
}

/**
 * Validate an unknown value as a follow record. Anything malformed —
 * wrong team, wrong shapes, unparseable JSON — is rejected, never
 * coerced into a follow: a corrupt record must not silently flip the
 * user's explicit unfollow back on, nor invent a follow for a team
 * v1 cannot follow.
 */
export function parseSportsFollowState(value: unknown): SportsFollowState | null {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<SportsFollowState>
  if (record.teamId !== SPORTS_FOLLOWED_TEAM_ID) return null
  if (typeof record.followed !== "boolean") return null
  if (typeof record.followedAt !== "string" || !record.followedAt) return null
  if (Number.isNaN(new Date(record.followedAt).getTime())) return null
  return {
    teamId: SPORTS_FOLLOWED_TEAM_ID,
    displayName: SPORTS_FOLLOWED_TEAM_NAME,
    followedAt: record.followedAt,
    followed: record.followed,
  }
}

/**
 * Read the stored record WITHOUT creating one. Used by backup export
 * (an untouched install exports null, and restore skips it — the
 * default-followed behaviour on next read is unchanged).
 */
export function readSportsFollowRecord(): SportsFollowState | null {
  const raw = lsGet(SPORTS_FOLLOW_STORAGE_KEY)
  if (!raw) return null
  try {
    return parseSportsFollowState(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * The follow state, creating + persisting the default (followed) when
 * no valid record exists. This is the read the hub and entry card
 * use: first render with no stored record treats the team as
 * followed and writes the record, per plan §3.2.
 */
export function getSportsFollowState(nowMs: number = Date.now()): SportsFollowState {
  const stored = readSportsFollowRecord()
  if (stored) return stored
  const created = defaultSportsFollowState(nowMs)
  lsSet(SPORTS_FOLLOW_STORAGE_KEY, JSON.stringify(created))
  return created
}

/** True when the team is followed (default: true — see getSportsFollowState). */
export function isSportsTeamFollowed(): boolean {
  return getSportsFollowState().followed
}

function writeSportsFollowState(state: SportsFollowState): void {
  lsSet(SPORTS_FOLLOW_STORAGE_KEY, JSON.stringify(state))
}

/**
 * Write a record from an external source (backup restore). The record
 * is validated first; an invalid record is ignored, never written.
 * Returns true when the record was written. No event is emitted —
 * restore re-renders through its own flow.
 */
export function restoreSportsFollowState(value: unknown): boolean {
  const parsed = parseSportsFollowState(value)
  if (!parsed) return false
  writeSportsFollowState(parsed)
  return true
}

function setSportsFollowed(followed: boolean): SportsFollowState {
  const current = getSportsFollowState()
  const next: SportsFollowState = {
    ...current,
    followed,
    // A re-follow re-stamps the follow time; an unfollow keeps the
    // original stamp (it records when the user followed, not when
    // they left).
    followedAt: followed ? new Date().toISOString() : current.followedAt,
  }
  writeSportsFollowState(next)
  emitSportsFollowChanged()
  return next
}

/** Follow Manchester United. Immediate, no confirm (one-press reversible). */
export function followSportsTeam(): SportsFollowState {
  return setSportsFollowed(true)
}

/** Unfollow Manchester United. Immediate, no confirm (one-press reversible). */
export function unfollowSportsTeam(): SportsFollowState {
  return setSportsFollowed(false)
}
