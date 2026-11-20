// Sports Corner v2 — in-app match reminders (Phase 3, plan §5.2, D2-A).
//
// One persisted record per reminded fixture, keyed by feed fixture id
// (`fd-<football-data match id>`). Same guarded localStorage pattern
// as the v1 follow record (sports-follow.ts): validated parse, no
// IndexedDB, no DB version bump, no new object store, no background
// machinery.
//
// Honesty contract (plan §4.3, D2-A):
// - A reminder fires ONLY while the app is open: the store itself has
//   no timer, no scheduler, no DOM side effect — firing happens only
//   when the app-wide watcher (sports-reminder-watcher.ts, started
//   from both layouts) runs its 60-second check. Nothing here can
//   fire while the app is closed. D2-B (closed-app nudge) is a
//   separate feature and is NOT built here.
// - Past fixtures' reminders are pruned on load: a reminder for a
//   fixture whose start is >2h past is deleted silently — it can never
//   fire (plan §5.2).
// - Firing marks a reminder delivered so it does not re-fire, then
//   clears it (plan §4.3, default clear).

import { log } from "@/scripts/lib/log.js"

/** localStorage key. No collision with the `xt_sports_followed_team` follow record. */
export const SPORTS_REMINDERS_STORAGE_KEY = "xt_sports_reminders"

/** Dispatched on set/clear/deliver/prune. The hub re-renders on it. */
export const SPORTS_REMINDERS_CHANGED_EVENT = "xt:sports-reminders-changed"

/** Default lead time: 30 minutes before kick-off (plan §2, D2). */
export const DEFAULT_REMINDER_LEAD_MINUTES = 30

/**
 * Prune horizon (plan §5.2): a reminder for a fixture whose start is
 * more than this far past is deleted silently on load.
 */
export const SPORTS_REMINDER_PRUNE_AFTER_MS = 2 * 60 * 60 * 1000

/** Auto-dismiss for the firing banner (plan §7): 60 seconds. */
export const SPORTS_REMINDER_BANNER_DISMISS_MS = 60_000

export interface SportsReminder {
  /** Feed-stable id (`fd-<football-data match id>`). */
  fixtureId: string
  /** "Liverpool v Man Utd" — display title, captured at set time. */
  title: string
  /** Kick-off, ms epoch. */
  startMs: number
  /** Minutes before kick-off the reminder fires. 30 default. */
  leadMinutes: number
  /** ISO timestamp of the set action. */
  createdAt: string
  /** True once the reminder has fired (plan §4.3). */
  delivered: boolean
}

/** The fixture facts a reminder needs. FeedFixture satisfies this. */
export interface ReminderFixture {
  id: string
  title: string
  startMs: number
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

function lsRemove(key: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(key)
  } catch {
    // Removal failing leaves a stale entry; reads validate + prune.
  }
}

function emitSportsRemindersChanged(): void {
  try {
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent(SPORTS_REMINDERS_CHANGED_EVENT))
    }
  } catch {
    // No document (tests/SSR): listeners simply never fire.
  }
}

/** ms epoch at which this reminder fires (kick-off minus lead time). */
export function reminderFireAtMs(reminder: SportsReminder): number {
  return reminder.startMs - reminder.leadMinutes * 60_000
}

/**
 * Validate an unknown value as one reminder record. Anything
 * malformed — wrong shapes, unparseable dates, non-positive lead —
 * is rejected, never coerced: a corrupt record must not invent a
 * reminder for a fixture the user never asked about.
 */
export function parseSportsReminder(value: unknown): SportsReminder | null {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<SportsReminder>
  if (typeof record.fixtureId !== "string" || !record.fixtureId) return null
  if (typeof record.title !== "string" || !record.title) return null
  if (typeof record.startMs !== "number" || !Number.isFinite(record.startMs)) {
    return null
  }
  if (
    typeof record.leadMinutes !== "number" ||
    !Number.isFinite(record.leadMinutes) ||
    record.leadMinutes <= 0
  ) {
    return null
  }
  if (typeof record.createdAt !== "string" || !record.createdAt) return null
  if (Number.isNaN(new Date(record.createdAt).getTime())) return null
  if (typeof record.delivered !== "boolean") return null
  return {
    fixtureId: record.fixtureId,
    title: record.title,
    startMs: record.startMs,
    leadMinutes: record.leadMinutes,
    createdAt: record.createdAt,
    delivered: record.delivered,
  }
}

/**
 * Validate an unknown value as the whole reminders map (fixtureId ->
 * record). Invalid entries are dropped, never fatal: one corrupt
 * record must not wipe the user's other reminders.
 */
export function parseSportsReminders(
  value: unknown,
): Record<string, SportsReminder> {
  const out: Record<string, SportsReminder> = {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const parsed = parseSportsReminder(entry)
    if (!parsed || parsed.fixtureId !== key) continue
    out[key] = parsed
  }
  return out
}

function writeReminders(map: Record<string, SportsReminder>): void {
  const keys = Object.keys(map)
  if (keys.length === 0) {
    lsRemove(SPORTS_REMINDERS_STORAGE_KEY)
    return
  }
  lsSet(SPORTS_REMINDERS_STORAGE_KEY, JSON.stringify(map))
}

/**
 * Read the stored map WITHOUT pruning or creating anything. Used by
 * backup export (an untouched install exports an empty map, and
 * restore skips it).
 */
export function readSportsRemindersRaw(): Record<string, SportsReminder> {
  const raw = lsGet(SPORTS_REMINDERS_STORAGE_KEY)
  if (!raw) return {}
  try {
    return parseSportsReminders(JSON.parse(raw))
  } catch {
    return {}
  }
}

/**
 * Prune reminders for fixtures whose start is >2h past (plan §5.2).
 * Returns the pruned map and whether anything was removed.
 */
export function pruneRemindersMap(
  map: Record<string, SportsReminder>,
  nowMs: number = Date.now(),
): { map: Record<string, SportsReminder>; pruned: number } {
  const kept: Record<string, SportsReminder> = {}
  let pruned = 0
  for (const [key, reminder] of Object.entries(map)) {
    if (nowMs - reminder.startMs > SPORTS_REMINDER_PRUNE_AFTER_MS) {
      pruned++
      continue
    }
    kept[key] = reminder
  }
  return { map: kept, pruned }
}

/**
 * The reminders, pruning past fixtures on load (plan §5.2). A prune
 * persists the trimmed map so a stale reminder never comes back.
 * This is the read the hub uses: every hub render re-reads through
 * here, so a past fixture's reminder disappears on its own.
 */
export function readSportsReminders(
  nowMs: number = Date.now(),
): Record<string, SportsReminder> {
  const stored = readSportsRemindersRaw()
  const { map, pruned } = pruneRemindersMap(stored, nowMs)
  if (pruned > 0) writeReminders(map)
  return map
}

/** Prune past-fixture reminders now. Returns how many were removed. */
export function pruneSportsReminders(nowMs: number = Date.now()): number {
  const stored = readSportsRemindersRaw()
  const { map, pruned } = pruneRemindersMap(stored, nowMs)
  if (pruned > 0) {
    writeReminders(map)
    emitSportsRemindersChanged()
  }
  return pruned
}

/** One reminder by feed fixture id, or null. Prunes on the way through. */
export function getSportsReminder(
  fixtureId: string,
  nowMs: number = Date.now(),
): SportsReminder | null {
  return readSportsReminders(nowMs)[fixtureId] ?? null
}

/** True when a live (unpruned) reminder exists for this fixture. */
export function hasSportsReminder(
  fixtureId: string,
  nowMs: number = Date.now(),
): boolean {
  return getSportsReminder(fixtureId, nowMs) !== null
}

/**
 * Set (or re-set) a reminder for a fixture. Immediate, no confirm
 * (same precedent as follow/unfollow). Re-setting refreshes the
 * created stamp and resets `delivered` — a re-set reminder can fire
 * again. Returns the stored record.
 */
export function setSportsReminder(
  fixture: ReminderFixture,
  options: { leadMinutes?: number; nowMs?: number } = {},
): SportsReminder {
  const leadMinutes = options.leadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES
  const nowMs = options.nowMs ?? Date.now()
  const map = readSportsReminders(nowMs)
  const reminder: SportsReminder = {
    fixtureId: fixture.id,
    title: fixture.title,
    startMs: fixture.startMs,
    leadMinutes,
    createdAt: new Date(nowMs).toISOString(),
    delivered: false,
  }
  map[fixture.id] = reminder
  writeReminders(map)
  emitSportsRemindersChanged()
  return reminder
}

/**
 * Clear the reminder for a fixture. Returns true when one existed.
 * No-op (false) when there was nothing to clear.
 */
export function clearSportsReminder(fixtureId: string): boolean {
  const map = readSportsRemindersRaw()
  if (!(fixtureId in map)) return false
  delete map[fixtureId]
  writeReminders(map)
  emitSportsRemindersChanged()
  return true
}

/**
 * Toggle a fixture's reminder. Returns whether it is now set and the
 * record (null when cleared). The hub's toggle handler toasts from
 * this result and re-renders.
 */
export function toggleSportsReminder(
  fixture: ReminderFixture,
  options: { leadMinutes?: number; nowMs?: number } = {},
): { set: boolean; reminder: SportsReminder | null } {
  if (hasSportsReminder(fixture.id, options.nowMs)) {
    clearSportsReminder(fixture.id)
    return { set: false, reminder: null }
  }
  return { set: true, reminder: setSportsReminder(fixture, options) }
}

/**
 * Mark a reminder delivered (plan §4.3: firing marks it delivered so
 * it does not re-fire). Returns the updated record, or null when no
 * live reminder exists. The firing path then clears the record
 * (default clear) — the delivered flag is the guard inside a single
 * firing pass, the clear is the persistence.
 */
export function markReminderDelivered(
  fixtureId: string,
): SportsReminder | null {
  const map = readSportsRemindersRaw()
  const reminder = map[fixtureId]
  if (!reminder) return null
  const delivered: SportsReminder = { ...reminder, delivered: true }
  map[fixtureId] = delivered
  writeReminders(map)
  return delivered
}

/**
 * Reminders due at `nowMs`: not delivered, lead time reached, and
 * kick-off not yet passed. The fire window closes at kick-off — a
 * reminder for a match already underway does not fire late; the row
 * itself still offers Watch. Pure query: calling this never fires
 * anything, shows nothing, and changes no state — the app-wide
 * watcher owns firing (see sports-reminder-watcher.ts
 * checkSportsRemindersAppWide, via the shared firing primitive in
 * sports-reminder-fire.ts).
 * Sorted earliest kick-off first.
 */
export function dueSportsReminders(
  nowMs: number = Date.now(),
): SportsReminder[] {
  return Object.values(readSportsReminders(nowMs))
    .filter(
      (reminder) =>
        !reminder.delivered &&
        nowMs >= reminderFireAtMs(reminder) &&
        nowMs <= reminder.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs)
}

/**
 * Write reminders from an external source (backup restore). The map
 * is validated first; invalid entries are dropped, never written.
 * Past fixtures (>2h) are pruned on the way in — a restored reminder
 * for a match already played can never fire. Returns how many
 * reminders were restored. No event is emitted — restore re-renders
 * through its own flow.
 */
export function restoreSportsReminders(value: unknown): number {
  const parsed = parseSportsReminders(value)
  const { map } = pruneRemindersMap(parsed, Date.now())
  const count = Object.keys(map).length
  if (count === 0) return 0
  const current = readSportsRemindersRaw()
  writeReminders({ ...current, ...map })
  return count
}
