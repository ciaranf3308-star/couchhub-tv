// Sports Corner v2 — app-wide reminder watcher (Phase 3 fix).
//
// The problem it fixes: the reminder checker used to live in the hub
// mount's 60-second interval, so a reminder only fired while
// /followed/sports was open — the plan (§4.3, T-v2-4) requires firing
// whenever the app is open, on any page including Live TV / playback.
// The toggle copy ("Reminds you while the app is open") is only true
// with this watcher running.
//
// How it is wired: ONE watcher per document, started from both app
// shells — bootTvShell() (TvLayout, /tv/*) and CouchLayout's boot
// script (Couch pages: Home, /livetv playback, the hub itself). Both
// start it with a dynamic import so the shell bundles stay lean; the
// watcher chunk loads once after boot. A module flag + a window flag
// make a double start a no-op, so a script re-run can never stack
// intervals. The hub's own checker is gone: the watcher covers the
// hub page too (CouchLayout boots there), so there is exactly one
// checker in any document. Double-fire is still impossible even if
// two passes ever ran: checkSportsReminders() marks delivered then
// clears before showing, so the second pass finds nothing due.
//
// What drives it: a single 60-second interval owned by this watcher.
// No existing tick could carry the check — bootTvShell has no
// recurring timer (its only timed work is a one-shot 60s ambient
// handoff and an idle warmup), and CouchLayout has no timer at all —
// so a new interval is the honest option, not a second scheduler:
// the store stays timer-free and the watcher is the only scheduler.
//
// What a tick costs: almost nothing. The tick first reads due
// reminders from localStorage (pure, sync). Only when one is due
// does it do the async station resolution below; most ticks do no
// I/O at all, and a check already in flight is never overlapped.
//
// Station resolution at fire time (NOT snapshotted at set time):
// the station is resolved fresh on every firing pass from the same
// cached data the hub uses — the feed's next fixtures (getNextFixtures,
// 1h cache) matched to the EPG listings in memory
// (getProgrammesSync + the memoised getSportsScan) through the
// existing matcher (buildNextMatchRows). Snapshotting at set time was
// rejected: a reminder is usually set days before kick-off, outside
// the ~36h EPG window, so the station is TBC at set time and only
// becomes known as matchday approaches — a snapshot would freeze the
// banner at "Station TBC" with no Watch even though the guide knows
// the station by fire time. Fire-time resolution keeps T-v2-4's
// "banner fires with Watch" true in the real flow.
//
// What the watcher deliberately does NOT do:
// - It never triggers an EPG load. If no EPG state is cached in this
//   page session (e.g. the user has been on Home all afternoon and
//   never opened Live TV or the guide), the station is unknown and
//   the reminder fires honestly as "Station TBC" with no Watch —
//   never an invented station. Pages that need the guide (Live TV,
//   the hub) load it themselves on mount, so on the Sunday-afternoon
//   flow the state is there and Watch works.
// - It never fires while the app is closed. D2-B (closed-app nudge)
//   is a separate feature and is NOT built here.
// - It never fetches the feed on a tick with nothing due (see above).
//
// Extra firing moments, both cheap (they no-op when nothing is due):
// - Once at start, so a reminder already due fires on app open
//   instead of waiting for the next 60s tick.
// - On SPORTS_REMINDERS_CHANGED_EVENT, so a reminder set while
//   already inside its lead window fires immediately instead of
//   waiting for the next tick (nice-to-have #4).
// - On EPG_LOADED_EVENT, so a station the guide has just learned
//   about is picked up for a reminder that is already due.

import { getActiveEntry } from "@/scripts/lib/creds.js"
import { EPG_LOADED_EVENT, getProgrammesSync } from "@/scripts/lib/epg-data.js"
import {
  getNextFixtures,
  type FeedFixture,
} from "@/scripts/lib/football-data.js"
import { log } from "@/scripts/lib/log.js"
import { hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.js"
import { getChannelEpgOverride } from "@/scripts/lib/preferences.js"
import { recordRouteOrigin } from "@/scripts/lib/route-origin.js"
import {
  SPORTS_REMINDERS_CHANGED_EVENT,
  dueSportsReminders,
} from "@/scripts/lib/sports-reminders.js"
import {
  getSportsScan,
  type SportsFixture,
  type SportsScanChannel,
} from "@/scripts/lib/sports-fixture-scan.js"
import { toast } from "@/scripts/lib/toast.js"
import {
  buildLiveTuneUrl,
  buildNextMatchRows,
  checkSportsReminders,
  showSportsReminderBanner,
  type DueReminderTarget,
  type NextMatchRow,
} from "@/scripts/lib/sports-reminder-fire.js"

/** The watcher's heartbeat: same 60s cadence the hub used to own. */
export const SPORTS_REMINDER_CHECK_INTERVAL_MS = 60_000

const WATCHER_STARTED_FLAG = "__xtSportsReminderWatcherStarted"

/** EPG fixtures for the active playlist, from cached data only.
// Returns [] when there is no playlist, no EPG state cached in this
// page session, or no channels — the caller then fires TBC, never
// an invented station. Mirrors the hub's resolvePlaylist pipeline
// minus the EPG load: this watcher never fetches the guide. */
async function resolveEpgFixtures(): Promise<SportsFixture[]> {
  try {
    const entry = await getActiveEntry()
    const playlistId = entry?._id ? String(entry._id) : ""
    if (!playlistId) return []
    const state = getProgrammesSync(playlistId)
    if (!state) return []
    // Warm the channel cache from IndexedDB before reading it: the
    // in-memory cache is per-page-load, so a fresh page would
    // otherwise always read zero channels. Same hydration the hub
    // performs before its reads — a local read, not a fetch.
    await Promise.allSettled([
      hydrateCache(playlistId, "live"),
      hydrateCache(playlistId, "m3u"),
    ])
    const rawChannels = readCachedLiveChannels(playlistId)
    const channels = (Array.isArray(rawChannels) ? rawChannels : []).filter(
      (channel): channel is SportsScanChannel =>
        channel != null && channel.id != null,
    )
    if (channels.length === 0) return []
    const overrides: Record<string, string> = {}
    for (const channel of channels) {
      try {
        const override = getChannelEpgOverride(playlistId, channel.id)
        if (override) overrides[String(channel.id)] = override
      } catch {
        // No override for this channel; resolution falls through.
      }
    }
    // Memoised by playlist + EPG revision (getSportsScan): repeat
    // calls in a session are cheap.
    return getSportsScan(channels, state, overrides, playlistId).fixtures ?? []
  } catch (error) {
    log.warn("[xt:sports] reminder EPG resolution failed:", error)
    return []
  }
}

/**
 * Next Matches rows for the firing pass: feed fixtures (1h cache,
 * so repeat calls are cheap) matched to the cached EPG listings.
 * A feed failure / missing key yields no fixtures, so every due
 * reminder resolves to Station TBC — the feed is never retried
 * here and no station is ever invented.
 */
async function resolveReminderRows(): Promise<NextMatchRow[]> {
  let feedFixtures: FeedFixture[] = []
  try {
    const feedResult = await getNextFixtures(5)
    feedFixtures = feedResult.fixtures ?? []
  } catch (error) {
    log.warn("[xt:sports] reminder feed resolution failed:", error)
    feedFixtures = []
  }
  const epgFixtures = await resolveEpgFixtures()
  return buildNextMatchRows(feedFixtures, epgFixtures)
}

/** Tune a fixture live, mirroring the hub's tune (plan §7.1):
 *  record the return origin (this page), then go. A non-numeric
 *  channel id never reaches the autoplay path — Live TV opens
 *  instead, with the same toast the hub shows. */
function tuneLive(fixture: SportsFixture): void {
  const target = buildLiveTuneUrl(fixture)
  if (!target) {
    toast({
      title: "Couldn't open that channel",
      description:
        "This channel can't be tuned directly. Opening Live TV instead.",
    })
    window.location.href = "/livetv"
    return
  }
  recordRouteOrigin({ route: location.pathname })
  window.location.href = target.url
}

export interface SportsReminderWatcherDeps {
  /** Clock override (tests inject a fixed clock). Default Date.now. */
  nowMs?: () => number
  /** Row-resolution override (tests inject rows; production uses
   *  the cached feed + EPG path above). */
  resolveRows?: () => Promise<ReadonlyArray<NextMatchRow>> | ReadonlyArray<NextMatchRow>
  /** Show override (tests capture targets; production shows the
   *  banner). */
  show?: (target: DueReminderTarget) => void
  /** Watch-action override (tests capture the tune target). */
  onWatch?: (fixture: SportsFixture) => void
  /** Banner options passed through to showSportsReminderBanner. */
  bannerOptions?: { host?: ParentNode; durationMs?: number }
}

/**
 * One firing pass, app-wide. Pure cheap path first: when nothing is
 * due, no feed/EPG work happens at all. When something is due, rows
 * are resolved (cached data only — see resolveReminderRows) and the
 * shared firing primitive consumes + shows each due reminder.
 * Returns the fired targets (same contract as checkSportsReminders).
 */
export async function checkSportsRemindersAppWide(
  deps: SportsReminderWatcherDeps = {},
  nowMs: number | undefined = undefined,
): Promise<DueReminderTarget[]> {
  const now = nowMs ?? deps.nowMs?.() ?? Date.now()
  if (dueSportsReminders(now).length === 0) return []
  const rows = deps.resolveRows
    ? await deps.resolveRows()
    : await resolveReminderRows()
  const show =
    deps.show ??
    ((target: DueReminderTarget) => {
      showSportsReminderBanner(
        target,
        { onWatch: deps.onWatch ?? tuneLive },
        deps.bannerOptions ?? {},
      )
    })
  return checkSportsReminders(rows, show, now)
}

export interface SportsReminderWatcherHandle {
  /** Run one firing pass now (resolves only when due). */
  checkNow: () => Promise<DueReminderTarget[]>
  /** Stop the interval + listeners. Idempotent; safe to call twice. */
  stop: () => void
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let listeners: Array<{
  type: string
  handler: () => void
}> = []

function isStarted(): boolean {
  if (started) return true
  try {
    return (window as unknown as Record<string, unknown>)[WATCHER_STARTED_FLAG] === true
  } catch {
    return false
  }
}

function markStarted(value: boolean): void {
  started = value
  try {
    ;(window as unknown as Record<string, unknown>)[WATCHER_STARTED_FLAG] = value
  } catch {
    // No window (SSR/tests without one): the module flag is enough.
  }
}

let currentHandle: SportsReminderWatcherHandle | null = null

/**
 * Start the app-wide watcher. A second start in the same document
 * is a no-op returning the existing handle — the shells guard
 * against double boot, and this guard covers script re-runs too.
 * Returns null outside a browser document.
 */
export function startSportsReminderWatcher(
  deps: SportsReminderWatcherDeps = {},
): SportsReminderWatcherHandle | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null
  }
  if (isStarted()) return currentHandle
  markStarted(true)

  let inFlight = false
  async function checkOnce(): Promise<DueReminderTarget[]> {
    if (inFlight) return []
    inFlight = true
    try {
      return await checkSportsRemindersAppWide(deps)
    } catch (error) {
      log.warn("[xt:sports] reminder check failed:", error)
      return []
    } finally {
      inFlight = false
    }
  }

  // Fire promptly on app open, not up to a tick later.
  void checkOnce()
  timer = setInterval(() => {
    void checkOnce()
  }, SPORTS_REMINDER_CHECK_INTERVAL_MS)

  // A reminder set while already inside its lead window, or the
  // guide landing with a station for a due reminder: check now
  // instead of waiting for the next tick. Both no-op when nothing
  // is due.
  const onChanged = (): void => {
    void checkOnce()
  }
  listeners = [
    { type: SPORTS_REMINDERS_CHANGED_EVENT, handler: onChanged },
    { type: EPG_LOADED_EVENT, handler: onChanged },
  ]
  for (const { type, handler } of listeners) {
    document.addEventListener(type, handler)
  }

  currentHandle = {
    checkNow: () => checkOnce(),
    stop: () => stopSportsReminderWatcher(),
  }
  return currentHandle
}

/** Stop the watcher started by startSportsReminderWatcher (tests +
 *  teardown). Clears the interval, removes the listeners, and
 *  resets the started flags so a later start works again. */
export function stopSportsReminderWatcher(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  for (const { type, handler } of listeners) {
    try {
      document.removeEventListener(type, handler)
    } catch {
      // Listener already gone; stopping is still complete.
    }
  }
  listeners = []
  currentHandle = null
  markStarted(false)
}
