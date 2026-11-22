// Sports Corner v2 — reminder firing, shared by every page (Phase 3 fix).
//
// The firing primitive lives here, NOT in the hub page module, so the
// app-wide watcher (sports-reminder-watcher.ts, started from both
// layouts) can fire reminders on any page — Live TV, playback, Home —
// without importing the whole hub. The hub re-exports these symbols
// (followed-sports-page.ts) so existing imports keep working.
//
// This module has NO side effects on import and no dependency on any
// hub DOM: the banner appends to document.body by default, never
// steals focus, B-dismisses through a Back layer, and auto-dismisses
// after 60s (plan §7).
//
// Honesty contract (plan §4.3, D2-A): the store alone never fires
// anything — dueSportsReminders() is a pure query, and firing happens
// ONLY when a caller runs checkSportsReminders(). Nothing here can
// fire while the app is closed; D2-B (closed-app nudge) is a separate
// feature and is NOT built here.

import {
  BACK_PRIORITY,
  registerBackLayer,
} from "@/scripts/lib/back-handler.js"
import {
  STATION_TBC,
  matchFixtureStations,
  normaliseTeamName,
  type EpgStationListing,
  type FeedFixture,
  type MatchedFixture,
} from "@/scripts/lib/football-data.js"
import { log } from "@/scripts/lib/log.js"
import { epgListingMatchesKickoff } from "@/scripts/lib/sports-corner-v2-hub.js"
import { sportsChannelPreferenceTier } from "@/scripts/lib/sports-fixture-scan.js"
import {
  SPORTS_REMINDER_BANNER_DISMISS_MS,
  clearSportsReminder,
  dueSportsReminders,
  markReminderDelivered,
  type SportsReminder,
} from "@/scripts/lib/sports-reminders.js"
import type { SportsFixture } from "@/scripts/lib/sports-fixture-scan.js"

// ── DOM helper ───────────────────────────────────────────────────

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ── Tune-in deep link (plan §7, pure + testable) ─────────────────

/** Live tune: /livetv?channel=<numeric id>. The Live TV autoplay
 *  path parses the id with Number() and silently ignores a
 *  non-finite value, so a non-numeric provider id must never reach
 *  it — the caller navigates to the landing + toast instead (§7.1). */
export interface TuneTarget {
  url: string
}

export function buildLiveTuneUrl(fixture: SportsFixture): TuneTarget | null {
  const id = Number(fixture.channelId)
  if (!Number.isFinite(id)) return null
  return { url: `/livetv?channel=${encodeURIComponent(String(fixture.channelId))}` }
}

// ── Next Matches: feed fixtures × EPG listings (v2 §4.1) ────────

export interface NextMatchRow {
  matched: MatchedFixture
  /**
   * The EPG fixture carrying this match's listing, for Watch
   * tune-in. Null when the EPG has no listing yet (Station TBC) —
   * the row then has no Watch button, by design.
   */
  epgFixture: SportsFixture | null
}

/**
 * Match feed fixtures to EPG listings for stations, and keep the
 * EPG fixture alongside each match so Watch can tune the real
 * listing. The station match is matchFixtureStations() (normalised
 * teams, start within the same minute); the EPG fixture is found
 * with the same rule, so the two can never disagree about which
 * listing a match belongs to.
 *
 * Feed-first (0.11.26): recorded programmes (tier "recorded" —
 * replays, classics, highlights, build-ups) NEVER supply a station
 * or a Watch target. A replay listing names a channel showing an
 * old match at that time, not the channel carrying this live
 * broadcast — matching it would tune the user into a replay while
 * the real match plays elsewhere. Only a listing of the live
 * broadcast carries the station; when the guide has none, the row
 * is honestly Station TBC. (The live listing itself starts at
 * kick-off, so it is always in the window when the guide has it —
 * filtering recorded listings loses no station in practice.)
 */
export function buildNextMatchRows(
  feedFixtures: ReadonlyArray<FeedFixture>,
  epgFixtures: ReadonlyArray<SportsFixture>,
): NextMatchRow[] {
  // A recorded programme is not a listing of this broadcast.
  const liveFixtures = epgFixtures.filter(
    (fixture) => fixture.tier !== "recorded",
  )
  const listings: EpgStationListing[] = liveFixtures.map((fixture) => ({
    home: fixture.teams[0],
    away: fixture.teams[1],
    startMs: fixture.startMs,
    channelName: fixture.channelName,
    alsoOn: fixture.alsoOn.map((channel) => channel.channelName),
  }))
  // Rank listings before matching (fix-3): matchFixtureStation()
  // takes the FIRST listing matching teams + kick-off window, so
  // scan order (earliest start first) used to hand the station
  // string to an earlier-starting international feed while Sky
  // carried the same match. Best-ranked carrier first, earliest
  // start as the tie-break — the same order the Watch-target pick
  // below uses, so station and Watch can never disagree.
  const byStationRank = (
    a: { channelName: string; startMs: number },
    b: { channelName: string; startMs: number },
  ): number =>
    sportsChannelPreferenceTier(a.channelName) -
      sportsChannelPreferenceTier(b.channelName) ||
    a.startMs - b.startMs
  listings.sort(byStationRank)
  const matched = matchFixtureStations(feedFixtures, listings)
  return matched.map((row, index) => {
    if (!row.stationKnown) return { matched: row, epgFixture: null }
    const fixture = feedFixtures[index]
    const home = normaliseTeamName(fixture.home)
    const away = normaliseTeamName(fixture.away)
    // Several EPG rows can list the same match (a build-up slot on
    // one channel, kick-off on another). The Watch target is the
    // best-ranked carrier among them (fix-3): the first row in
    // scan order used to win, which is how an earlier-starting
    // international feed could become the tune-in target while
    // Sky carried the same match. Earliest start is the tie-break
    // only. The station string (from matchFixtureStation) and this
    // target therefore always agree on the primary.
    const candidates = liveFixtures.filter((candidate) => {
      if (!epgListingMatchesKickoff(candidate.startMs, fixture.startMs)) {
        return false
      }
      const candidateHome = normaliseTeamName(candidate.teams[0])
      const candidateAway = normaliseTeamName(candidate.teams[1])
      return (
        (candidateHome === home && candidateAway === away) ||
        (candidateHome === away && candidateAway === home)
      )
    })
    const epgFixture = candidates.sort(byStationRank)[0] ?? null
    return { matched: row, epgFixture }
  })
}

// ── Reminder firing (v2 §4.3, D2-A) ─────────────────────────────

export interface DueReminderTarget {
  reminder: SportsReminder
  /** "Sky Sports Main Event · Sky Sports Premier League", or
   *  STATION_TBC when the EPG has no listing for this fixture yet. */
  station: string
  /** True only when the EPG actually lists this fixture. */
  stationKnown: boolean
  /** The EPG fixture carrying this match's listing, for Watch
   *  tune-in. Null when the station is TBC — no Watch action. */
  epgFixture: SportsFixture | null
}

/**
 * Resolve due reminders to their station + tune-in target. Pure:
 * takes the reminders as input, reads nothing, changes nothing.
 * A reminder whose fixture has left the feed still resolves — with
 * station TBC and no Watch — so a feed change never silently
 * swallows a reminder the user asked for.
 */
export function resolveDueReminders(
  reminders: ReadonlyArray<SportsReminder>,
  nextMatches: ReadonlyArray<NextMatchRow>,
  nowMs: number,
): DueReminderTarget[] {
  return reminders
    .filter(
      (reminder) =>
        !reminder.delivered &&
        nowMs >= reminder.startMs - reminder.leadMinutes * 60_000 &&
        nowMs <= reminder.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs)
    .map((reminder) => {
      const row = nextMatches.find(
        (candidate) => candidate.matched.fixture.id === reminder.fixtureId,
      )
      return {
        reminder,
        station: row?.matched.station ?? STATION_TBC,
        stationKnown: row?.matched.stationKnown ?? false,
        epgFixture: row?.epgFixture ?? null,
      }
    })
}

/**
 * The firing pass. Reads due reminders from the store (pruning past
 * fixtures on the way), resolves each to its station/Watch target,
 * marks it delivered, clears it (plan §4.3, default clear), then
 * shows it. Returns the fired targets. A throwing `show` never
 * blocks the remaining reminders — the record is already consumed,
 * so a banner failure cannot re-fire it on the next tick. Calling
 * this twice for the same due window fires once: the second pass
 * finds no due reminders.
 */
export function checkSportsReminders(
  nextMatches: ReadonlyArray<NextMatchRow>,
  show: (target: DueReminderTarget) => void,
  nowMs: number = Date.now(),
): DueReminderTarget[] {
  const due = dueSportsReminders(nowMs)
  if (due.length === 0) return []
  const targets = resolveDueReminders(due, nextMatches, nowMs)
  for (const target of targets) {
    markReminderDelivered(target.reminder.fixtureId)
    clearSportsReminder(target.reminder.fixtureId)
    try {
      show(target)
    } catch (error) {
      log.warn("[xt:sports] reminder banner failed:", error)
    }
  }
  return targets
}

export interface SportsReminderBanner {
  dismiss: () => void
}

/**
 * The only callback the firing banner needs: tune the fixture
 * live. The hub passes its full SportsHubCallbacks (a structural
 * superset); the app-wide watcher passes its own tune-live
 * callback. Keeping this minimal is what lets the banner live
 * outside the hub module.
 */
export interface ReminderBannerCallbacks {
  onWatch: (fixture: SportsFixture) => void
}

/**
 * The firing banner for one due reminder: fixture, station (when
 * known), and a focusable Watch action when tunable. B dismisses
 * (a Back layer owns the press while the banner is up, above the
 * route layer); auto-dismiss after 60s. Never steals focus — the
 * banner is appended without focusing anything, so playback (or
 * whatever the user is doing) is not interrupted. Works on any
 * page: it appends to document.body (or the given host) and needs
 * no hub DOM. Its styles live in sports.astro for Couch pages and
 * in tv.css for /tv/* pages — the two copies are the same rules,
 * kept in step (see the comment at the tv.css copy).
 */
export function showSportsReminderBanner(
  target: DueReminderTarget,
  callbacks: ReminderBannerCallbacks,
  options: { host?: ParentNode; durationMs?: number } = {},
): SportsReminderBanner | null {
  if (typeof document === "undefined") return null
  const host = options.host ?? document.body
  const durationMs =
    options.durationMs ?? SPORTS_REMINDER_BANNER_DISMISS_MS

  const banner = document.createElement("div")
  banner.className = "rs-sports-reminder-banner"
  banner.setAttribute("role", "status")
  banner.setAttribute(
    "data-sports-reminder-banner",
    target.reminder.fixtureId,
  )
  banner.appendChild(
    el(
      "p",
      "rs-sports-reminder-title",
      `Kick-off in ${target.reminder.leadMinutes} minutes — ${target.reminder.title}`,
    ),
  )
  banner.appendChild(
    el(
      "p",
      "rs-sports-reminder-meta",
      target.stationKnown
        ? target.station
        : `${STATION_TBC} — check the guide closer to kick-off`,
    ),
  )
  const actions = el("div", "rs-sports-reminder-actions")
  if (target.epgFixture !== null) {
    const epgFixture = target.epgFixture
    const watch = el("button", "rs-sports-reminder-watch", "Watch")
    watch.type = "button"
    watch.setAttribute("data-couch-key", "sports:reminder:watch")
    watch.addEventListener("click", () => {
      callbacks.onWatch(epgFixture)
      dismiss()
    })
    actions.appendChild(watch)
  }
  const dismissButton = el(
    "button",
    "rs-sports-reminder-dismiss",
    "Dismiss",
  )
  dismissButton.type = "button"
  dismissButton.setAttribute("data-couch-key", "sports:reminder:dismiss")
  dismissButton.addEventListener("click", () => dismiss())
  actions.appendChild(dismissButton)
  banner.appendChild(actions)
  host.appendChild(banner)

  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let unregister: (() => void) | null = null
  function dismiss(): void {
    if (closed) return
    closed = true
    if (timer !== null) clearTimeout(timer)
    unregister?.()
    banner.remove()
  }
  unregister = registerBackLayer({
    id: "sports-reminder-banner",
    priority: BACK_PRIORITY.PAGE_STATE,
    isActive: () => !closed,
    handle: () => {
      dismiss()
      return true
    },
  })
  if (durationMs > 0) {
    timer = setTimeout(dismiss, durationMs)
  }
  return { dismiss }
}
