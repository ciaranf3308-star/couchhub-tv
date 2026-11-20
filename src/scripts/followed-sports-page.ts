// Sports Corner hub — Followed > Manchester United (0.11.13, plan §5–§7).
//
// The hub is a derived view: every render recomputes from the
// current EPG state through the shared scan module. No fixture data
// is stored, no EPG ingestion changes, no playback changes. Tune-in
// is a deep link into the existing Live TV autoplay path (§7); the
// Back return from a tune is the guarded §7.4 origin fix.
//
// This module has NO side effects on import: the .astro page calls
// mountSportsHubPage() explicitly, so the render/controller helpers
// stay independently testable. The Followed page imports only the
// entry-card renderer from here.

import {
  BACK_PRIORITY,
  registerBackLayer,
} from "@/scripts/lib/back-handler.js"
import {
  RETURN_HOME_HINT,
  setControllerHints,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints.js"
import { setLogicalView } from "@/scripts/lib/couch-focus.js"
import {
  captureFocusKeyWithin,
  initListFocusMemory,
  restoreFocusKeyWithin,
  restoreListFocus,
} from "@/scripts/lib/couch-list-focus.js"
import {
  catchupBadgeLabel,
} from "@/scripts/lib/couch-livetv-epg.js"
import {
  displayedToUtcMs,
  EPG_LOADED_EVENT,
  EPG_SOURCE_STATUS_EVENT,
  getProgrammesSync,
  loadProgrammes,
} from "@/scripts/lib/epg-data.js"
import {
  getActiveEntry,
  loadCreds,
} from "@/scripts/lib/creds.js"
import { hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.js"
import {
  enrichProgramme,
  pickArtworkUrl,
} from "@/scripts/lib/livetv-enrichment.js"
import { log } from "@/scripts/lib/log.js"
import {
  isTitleContextMenuOpen,
  openTitleContextMenu,
  type TitleContextAction,
} from "@/scripts/lib/poster-menu.js"
import { getChannelEpgOverride } from "@/scripts/lib/preferences.js"
import {
  navigateBackWithOrigin,
  recordOriginFromReferrer,
  recordRouteOrigin,
} from "@/scripts/lib/route-origin.js"
import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.js"
import { toast } from "@/scripts/lib/toast.js"
import {
  FOOTBALL_DATA_ATTRIBUTION,
  STATION_TBC,
  getLeagueTable,
  getNextFixtures,
  normaliseTeamName,
  type FeedFixture,
  type FeedFixturesResult,
  type LeagueTableResult,
} from "@/scripts/lib/football-data.js"
import {
  formatFeedFixtureDateTime,
  formatFeedFixtureTitle,
  formatTableAsOf,
  selectTableRows,
  type SportsEntryCardFeed,
} from "@/scripts/lib/sports-corner-v2-hub.js"
import {
  isSportsTeamFollowed,
  followSportsTeam,
  unfollowSportsTeam,
  SPORTS_FOLLOW_CHANGED_EVENT,
  SPORTS_FOLLOWED_TEAM_NAME,
} from "@/scripts/lib/sports-follow.js"
import {
  SPORTS_REMINDERS_CHANGED_EVENT,
  getSportsReminder,
  hasSportsReminder,
  toggleSportsReminder,
} from "@/scripts/lib/sports-reminders.js"
// Reminder firing (banner, checker, Next Matches rows, live tune URL)
// lives in the shared fire module so the app-wide watcher can use it
// without importing this hub page module. Re-exported here so the
// hub's existing import sites (and tests) keep working.
import {
  buildLiveTuneUrl,
  buildNextMatchRows,
  el,
  type NextMatchRow,
  type TuneTarget,
} from "@/scripts/lib/sports-reminder-fire.js"
export {
  buildLiveTuneUrl,
  buildNextMatchRows,
  checkSportsReminders,
  resolveDueReminders,
  showSportsReminderBanner,
  type DueReminderTarget,
  type NextMatchRow,
  type SportsReminderBanner,
  type TuneTarget,
} from "@/scripts/lib/sports-reminder-fire.js"
import {
  fixtureCatchupAction,
  getSportsScan,
  selectNextFixture,
  splitSportsFixtures,
  sportsFixtureState,
  type SportsFixture,
  type SportsScanChannel,
  type SportsScanResult,
  type SplitSportsFixtures,
} from "@/scripts/lib/sports-fixture-scan.js"

export const SPORTS_HUB_ROUTE = "/followed/sports"

// Manchester United crest — the genuine club crest, bundled as a
// repo asset (public/art/sports/man-utd-crest.svg). Source: the
// club's own hospitality guide, via Wikipedia
// File:Manchester_United_FC_crest.svg
// (https://en.wikipedia.org/wiki/File:Manchester_United_FC_crest.svg,
// verified visually 2026-11-20). Registered trademark of Manchester
// United; used here only to identify the club in its own hub. This
// file never comes from the feed — football-data.org terms §9.2
// forbids rendering feed-supplied logos.
export const MAN_UTD_CREST_SRC = "/art/sports/man-utd-crest.svg"
export const MAN_UTD_CREST_ALT = "Manchester United crest"

// ── Controller hints (plan §6.3) ────────────────────────────────
// Mirrors the Followed page's hint shape. LB/RB are unmapped and
// deliberately NOT hinted; Y is unconsumed here so the global
// search handler owns it.

export const SPORTS_HUB_HINTS: HintConfig = {
  id: "followed-sports",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Watch" },
    { glyph: "b", label: "Back" },
    { glyph: "x", label: "Actions" },
    { glyph: "y", label: "Search" },
    { glyph: "menu", label: "Settings" },
    RETURN_HOME_HINT,
  ],
}

// ── View model (pure; plan §2.5 + §5.2) ─────────────────────────

export type SportsHubState =
  | "unfollowed"
  | "no-playlist"
  | "no-channels"
  | "loading"
  | "failed"
  | "no-mapping"
  | "ready"

export interface SportsHubModel {
  state: SportsHubState
  followed: boolean
  /** EPG failed but last-good fixtures are shown (§2.5 keep-last-good). */
  stale: boolean
  hero: SportsFixture | null
  split: SplitSportsFixtures
  /** "Last updated HH:MM" from the EPG revision time, when known. */
  lastUpdatedLabel: string | null
  mappedChannelCount: number
  channelCount: number
  /** Feed table result (v2 Phase 2). Null = not fetched yet — the
   *  table section is omitted, never faked. */
  tableResult: LeagueTableResult | null
  /** Feed fixtures result (v2 Phase 2). Null = not fetched yet. */
  feedResult: FeedFixturesResult | null
  /** Feed fixtures matched to EPG listings, feed order (v2 §4.1). */
  nextMatches: NextMatchRow[]
  /** Mini-table vs full 20 (v2 §4.1). */
  tableExpanded: boolean
}

const EMPTY_SPLIT: SplitSportsFixtures = {
  upcoming: [],
  possible: [],
  otherSquadsUpcoming: [],
  otherSquadsRecent: [],
  recent: [],
}

export interface SportsHubModelInput {
  followed: boolean
  hasPlaylist: boolean
  hasChannels: boolean
  /** "loading" = first load in flight; "failed" = every source
   *  errored on the last attempt; "ready" = a clean load landed. */
  epgStatus: "loading" | "failed" | "ready"
  scanResult: SportsScanResult | null
  nowMs: number
  /** Feed results (v2 Phase 2). Omitted = not fetched yet. */
  tableResult?: LeagueTableResult | null
  feedResult?: FeedFixturesResult | null
  nextMatches?: NextMatchRow[]
  tableExpanded?: boolean
}


/**
 * Fixed state precedence, mirroring the Guide's guideDataState
 * discipline: unfollowed > no-playlist > no-channels > failed >
 * loading > no-mapping > ready. A failed load with last-good data
 * renders ready + stale, never the failure panel.
 */
export function buildSportsHubModel(input: SportsHubModelInput): SportsHubModel {
  const { followed, hasPlaylist, hasChannels, epgStatus, scanResult } = input
  const base: SportsHubModel = {
    state: "loading",
    followed,
    stale: false,
    hero: null,
    split: EMPTY_SPLIT,
    lastUpdatedLabel: null,
    mappedChannelCount: scanResult?.mappedChannelCount ?? 0,
    channelCount: scanResult?.channelCount ?? 0,
    tableResult: input.tableResult ?? null,
    feedResult: input.feedResult ?? null,
    nextMatches: input.nextMatches ?? [],
    tableExpanded: input.tableExpanded ?? false,
  }
  if (!followed) return { ...base, state: "unfollowed" }
  if (!hasPlaylist) return { ...base, state: "no-playlist" }
  if (!hasChannels) return { ...base, state: "no-channels" }
  if (scanResult === null) {
    return {
      ...base,
      state: epgStatus === "failed" ? "failed" : "loading",
    }
  }
  const split = splitSportsFixtures(scanResult.fixtures, input.nowMs)
  const model: SportsHubModel = {
    ...base,
    split,
    hero: selectNextFixture(scanResult.fixtures, input.nowMs),
    lastUpdatedLabel: formatLastUpdated(scanResult),
  }
  if (scanResult.mappedChannelCount === 0) {
    return { ...model, state: "no-mapping" }
  }
  return {
    ...model,
    state: "ready",
    stale: epgStatus === "failed",
  }
}

function formatLastUpdated(scanResult: SportsScanResult): string | null {
  const ms = scanResult.epgFetchedAt ?? Date.parse(scanResult.scannedAt)
  if (!Number.isFinite(ms)) return null
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))
}

// ── Time formatting ─────────────────────────────────────────────

export function formatKickoff(startMs: number, nowMs: number): string {
  const start = new Date(startMs)
  const now = new Date(nowMs)
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(start)
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  if (startDay === today) return `Today ${time}`
  if (startDay === today + dayMs) return `Tomorrow ${time}`
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(start)
  return `${date} ${time}`
}

// ── Tune-in deep links (plan §7, pure + testable) ───────────────
// Live tune (buildLiveTuneUrl + TuneTarget) lives in the shared
// fire module; catch-up tune stays here (it needs the EPG offset).

/**
 * Catch-up tune: the epg.ts navigateToCatchup shape exactly —
 * displayed times converted to UTC, ctitle encoded, NO cid (the
 * player re-resolves the catch-up id from the channel, plan §7.1).
 * Raw (pre-tvg-shift) programme times are the input, as the Guide
 * does. Returns null when the channel id is not numeric.
 */
export function buildCatchupTuneUrl(
  fixture: SportsFixture,
  playlistId: string,
): TuneTarget | null {
  const id = Number(fixture.channelId)
  if (!Number.isFinite(id)) return null
  const startUtc = displayedToUtcMs(
    playlistId,
    fixture.rawStartMs ?? fixture.startMs,
  )
  const stopUtc = displayedToUtcMs(
    playlistId,
    fixture.rawStopMs ?? fixture.stopMs,
  )
  return {
    url:
      `/livetv?channel=${encodeURIComponent(String(fixture.channelId))}` +
      `&cstart=${startUtc}` +
      `&cstop=${stopUtc}` +
      `&ctitle=${encodeURIComponent(fixture.title)}`,
  }
}

export const GUIDE_ROOT_URL = "/livetv?mode=guide"

/**
 * The row's primary (A-button) action. Upcoming/live rows watch
 * live; past rows replay when catch-up allows; a past row with no
 * replay opens the Guide — the only remaining useful action, and
 * the row's action label names it honestly.
 */
export type FixturePrimaryAction = "watch" | "replay" | "guide"

export function fixturePrimaryAction(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): FixturePrimaryAction {
  const state = sportsFixtureState(fixture, nowMs)
  if (state !== "past") return "watch"
  return fixtureCatchupAction(fixture, nowMs) === "replay"
    ? "replay"
    : "guide"
}

export function fixtureActionLabel(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): string {
  const action = fixturePrimaryAction(fixture, nowMs)
  if (action === "replay") return "Replay"
  if (action === "guide") return "Open in Guide"
  return sportsFixtureState(fixture, nowMs) === "now" ? "Watch live" : "Watch"
}

// ── Navigation callbacks ────────────────────────────────────────

export interface SportsHubCallbacks {
  /** Tune the fixture live (§7.1). Records the §7.4 return origin. */
  onWatch: (fixture: SportsFixture) => void
  /** Watch a live fixture from its start (§7.3). */
  onWatchFromStart: (fixture: SportsFixture) => void
  /** Replay a past fixture (§7.3). */
  onReplay: (fixture: SportsFixture) => void
  /** Open the Guide root (§5.3). */
  onOpenGuide: () => void
  /** Toggle the follow record (§5.4). */
  onToggleFollow: () => void
  /** Toggle the reminder for a feed fixture (v2 Phase 3, D2-A).
   *  Optional: test stubs omit it; the bell then no-ops. The
   *  production implementation toggles the store, toasts, and
   *  re-renders — the bell itself never writes the store directly. */
  onToggleReminder?: (fixture: FeedFixture) => void
  /** Toggle the league-table mini/full expansion (v2 §4.1).
   *  Optional: test stubs omit it; the expand button no-ops then. */
  onToggleTableExpanded?: () => void
}

/** Production navigation: record the return origin, then go. The
 *  origin is what §7.4 consults when B is pressed on the landing. */
export function createSportsHubCallbacks(
  playlistId: string,
  returnRoute: string,
): SportsHubCallbacks {
  const tune = (target: TuneTarget | null) => {
    if (!target) {
      toast({
        title: "Couldn't open that channel",
        description: "This channel can't be tuned directly. Opening Live TV instead.",
      })
      window.location.href = "/livetv"
      return
    }
    recordRouteOrigin({ route: returnRoute })
    window.location.href = target.url
  }
  return {
    onWatch: (fixture) => tune(buildLiveTuneUrl(fixture)),
    onWatchFromStart: (fixture) => tune(buildCatchupTuneUrl(fixture, playlistId)),
    onReplay: (fixture) => tune(buildCatchupTuneUrl(fixture, playlistId)),
    onOpenGuide: () => {
      window.location.href = GUIDE_ROOT_URL
    },
    onToggleFollow: () => {
      if (isSportsTeamFollowed()) {
        unfollowSportsTeam()
        toast({ title: `Unfollowed ${SPORTS_FOLLOWED_TEAM_NAME}` })
      } else {
        followSportsTeam()
        toast({ title: `Following ${SPORTS_FOLLOWED_TEAM_NAME}` })
      }
    },
  }
}

// ── DOM helpers ─────────────────────────────────────────────────


function fixtureMetaLine(
  fixture: SportsFixture,
  nowMs: number,
): string {
  const parts = [
    formatKickoff(fixture.startMs, nowMs),
    fixture.channelName,
  ]
  if (fixture.competition) parts.push(fixture.competition)
  return parts.join(" · ")
}

function alsoOnLine(fixture: SportsFixture): string | null {
  if (fixture.alsoOn.length === 0) return null
  return `Also on: ${fixture.alsoOn.map((c) => c.channelName).join(", ")}`
}

// ── Row + section rendering ─────────────────────────────────────

interface RowContext {
  nowMs: number
  callbacks: SportsHubCallbacks
  /** "possible" rows carry the Unconfirmed-team badge. */
  showPossibleBadge: boolean
}

function buildFixtureRow(
  fixture: SportsFixture,
  ctx: RowContext,
): HTMLButtonElement {
  const row = el("button", "rs-sports-row")
  row.type = "button"
  row.setAttribute("data-couch-key", `sports:fixture:${fixture.id}`)
  row.setAttribute("data-fixture-id", fixture.id)
  const state = sportsFixtureState(fixture, ctx.nowMs)

  const main = el("div", "rs-sports-row-main")
  const titleRow = el("div", "rs-sports-row-title-row")
  titleRow.appendChild(el("span", "rs-sports-row-title", fixture.title))
  if (state === "now") {
    titleRow.appendChild(el("span", "rs-sports-badge rs-sports-badge-live", "LIVE"))
  }
  if (ctx.showPossibleBadge) {
    titleRow.appendChild(
      el("span", "rs-sports-badge rs-sports-badge-possible", "Unconfirmed team"),
    )
  }
  main.appendChild(titleRow)
  main.appendChild(el("div", "rs-sports-row-meta", fixtureMetaLine(fixture, ctx.nowMs)))
  const alsoOn = alsoOnLine(fixture)
  if (alsoOn) {
    main.appendChild(el("div", "rs-sports-row-also", alsoOn))
  }
  if (fixture.desc) {
    const desc = el("div", "rs-sports-row-desc", fixture.desc)
    main.appendChild(desc)
  }
  row.appendChild(main)

  const action = el("div", "rs-sports-row-action")
  action.appendChild(
    el("span", "rs-sports-row-action-label", fixtureActionLabel(fixture, ctx.nowMs)),
  )
  if (state === "past") {
    const catchup = fixtureCatchupAction(fixture, ctx.nowMs)
    const badge = catchupBadgeLabel(catchup)
    if (badge) {
      action.appendChild(el("span", "rs-sports-row-catchup", badge))
    }
  }
  row.appendChild(action)

  row.addEventListener("click", () => {
    const primary = fixturePrimaryAction(fixture, Date.now())
    if (primary === "watch") ctx.callbacks.onWatch(fixture)
    else if (primary === "replay") ctx.callbacks.onReplay(fixture)
    else ctx.callbacks.onOpenGuide()
  })
  return row
}

function buildSection(
  heading: string,
  explainer: string | null,
  rows: SportsFixture[],
  ctx: RowContext,
  emptyLine: string | null,
  sectionKey?: string,
): HTMLElement | null {
  if (rows.length === 0 && emptyLine === null) return null
  const section = el("section", "rs-sports-section")
  if (sectionKey) section.setAttribute("data-sports-section", sectionKey)
  section.appendChild(el("h2", "rs-sports-section-title", heading))
  if (explainer) {
    section.appendChild(el("p", "rs-sports-section-note", explainer))
  }
  if (rows.length === 0 && emptyLine !== null) {
    section.appendChild(el("p", "rs-sports-empty-line", emptyLine))
    return section
  }
  const list = el("div", "rs-sports-list")
  for (const fixture of rows) list.appendChild(buildFixtureRow(fixture, ctx))
  section.appendChild(list)
  return section
}

function buildOtherSquadsSection(
  upcoming: SportsFixture[],
  recent: SportsFixture[],
  ctx: RowContext,
): HTMLElement | null {
  if (upcoming.length === 0 && recent.length === 0) return null
  const section = el("section", "rs-sports-section")
  section.setAttribute("data-sports-section", "other-squads")
  section.appendChild(el("h2", "rs-sports-section-title", "Other Squads"))
  section.appendChild(
    el(
      "p",
      "rs-sports-section-note",
      "Women's, youth and academy fixtures, kept separate from the first team.",
    ),
  )
  const upcomingList = el("div", "rs-sports-list")
  for (const fixture of upcoming) {
    upcomingList.appendChild(buildFixtureRow(fixture, ctx))
  }
  section.appendChild(upcomingList)
  if (recent.length > 0) {
    section.appendChild(el("h3", "rs-sports-subhead", "Recent"))
    const recentList = el("div", "rs-sports-list")
    for (const fixture of recent) {
      recentList.appendChild(buildFixtureRow(fixture, ctx))
    }
    section.appendChild(recentList)
  }
  return section
}

// ── League table (v2 §4.1) ─────────────────────────────────────

function formatGoalDifference(gd: number): string {
  if (gd > 0) return `+${gd}`
  if (gd < 0) return `−${-gd}`
  return "0"
}

/**
 * League Table section. Mini-table (United + 3 above + 3 below)
 * by default, full 20 behind one focusable expand action. The
 * United row is highlighted in United red (hub-scoped token, see
 * sports.astro) — hard-coded United visuals, no team picker, no
 * feed-supplied crests (terms §9.2: the parser drops them).
 * Dated + sourced on screen; stale >24h says "may be out of date";
 * feed down / no key shows honest failure copy, never invented data.
 */
function buildTableSection(
  tableResult: LeagueTableResult,
  expanded: boolean,
  callbacks: SportsHubCallbacks,
): HTMLElement {
  const section = el("section", "rs-sports-section rs-sports-table-section")
  section.setAttribute("data-sports-section", "table")
  section.appendChild(el("h2", "rs-sports-section-title", "League Table"))

  const table = tableResult.table
  if (
    (tableResult.status === "ok" || tableResult.status === "stale") &&
    table !== null
  ) {
    section.appendChild(
      el("p", "rs-sports-section-note", table.competition),
    )
    const rows = selectTableRows(table, expanded)
    const tableEl = document.createElement("table")
    tableEl.className = "rs-sports-table"
    const head = document.createElement("tr")
    for (const label of ["Pos", "Team", "P", "W", "D", "L", "GF–GA", "GD", "Pts"]) {
      head.appendChild(el("th", undefined, label))
    }
    tableEl.appendChild(head)
    for (const entry of rows) {
      const rowEl = document.createElement("tr")
      if (normaliseTeamName(entry.team) === "manchester united") {
        rowEl.className = "rs-sports-table-row-united"
      }
      const cells = [
        String(entry.position),
        entry.team,
        String(entry.played),
        String(entry.won),
        String(entry.drawn),
        String(entry.lost),
        `${entry.gf}–${entry.ga}`,
        formatGoalDifference(entry.gd),
        String(entry.points),
      ]
      for (const [index, value] of cells.entries()) {
        const cell = el("td", undefined, value)
        if (index !== 1) cell.className = "rs-sports-table-num"
        rowEl.appendChild(cell)
      }
      tableEl.appendChild(rowEl)
    }
    section.appendChild(tableEl)
    const asOf = formatTableAsOf(table)
    const meta = [asOf, FOOTBALL_DATA_ATTRIBUTION]
      .filter((part): part is string => part !== null)
      .join(" · ")
    section.appendChild(el("p", "rs-sports-table-meta", meta))
    if (tableResult.stale) {
      section.appendChild(
        el(
          "p",
          "rs-sports-table-stale",
          tableResult.mayBeOutOfDate
            ? "This table may be out of date — the feed couldn't be reached."
            : "Showing the last table we have — the feed couldn't be reached.",
        ),
      )
    }
    const miniRows = selectTableRows(table, false)
    if (table.entries.length > miniRows.length) {
      const expand = el(
        "button",
        "rs-sports-table-expand",
        expanded ? "Show fewer teams" : "Show full table",
      )
      expand.type = "button"
      expand.setAttribute("data-couch-key", "sports:table:expand")
      expand.addEventListener("click", () => {
        callbacks.onToggleTableExpanded?.()
      })
      section.appendChild(expand)
    }
    return section
  }

  if (tableResult.status === "no-key") {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "League table unavailable — add your football-data.org API key in Settings to see it.",
      ),
    )
  } else {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "League table unavailable — the feed couldn't be reached. Fixtures below still come from your programme guide.",
      ),
    )
  }
  return section
}

// ── Next Matches (v2 §4.1) ──────────────────────────────────────

/**
 * One feed-driven Next Matches row: fixture, date/time,
 * competition, station from the EPG where known else "Station
 * TBC", Watch only when the EPG listing exists and is tunable.
 *
 * Phase 3 reminder toggle (v2 plan §4.3, D2-A): one focusable
 * bell button lives inside the actions area, BEFORE the Watch
 * button when one exists, with
 * data-couch-key="sports:remind:<feed fixture id>". It reads the
 * `xt_sports_reminders` store at render time and never writes it
 * directly — the click goes through callbacks.onToggleReminder,
 * which toggles, toasts and re-renders. A reminded row shows a
 * filled bell + "Reminder set · 30 min before". The toggle copy
 * states honestly that it "reminds you while the app is open":
 * reminders do NOT fire while the app is closed (D2-B is a later
 * feature, not built here).
 */
function buildNextMatchRow(
  row: NextMatchRow,
  callbacks: SportsHubCallbacks,
  nowMs: number = Date.now(),
): HTMLElement {
  const fixture = row.matched.fixture
  const container = el("div", "rs-sports-next-row")
  container.setAttribute("data-feed-fixture-id", fixture.id)
  const main = el("div", "rs-sports-row-main")
  main.appendChild(
    el("span", "rs-sports-row-title", formatFeedFixtureTitle(fixture)),
  )
  const metaParts = [
    formatFeedFixtureDateTime(fixture.startMs),
    fixture.competition,
    row.matched.station,
  ]
  if (fixture.venue) metaParts.push(fixture.venue)
  main.appendChild(el("div", "rs-sports-row-meta", metaParts.join(" · ")))
  container.appendChild(main)

  const actions = el("div", "rs-sports-next-actions")
  actions.setAttribute("data-reminder-slot", fixture.id)
  const reminder = getSportsReminder(fixture.id, nowMs)
  const reminderSet = reminder !== null
  const bell = el(
    "button",
    `rs-sports-remind${reminderSet ? " rs-sports-remind-set" : ""}`,
    reminderSet
      ? `🔔 Reminder set · ${reminder.leadMinutes} min before`
      : "🔔 Remind me",
  )
  bell.type = "button"
  bell.setAttribute("data-couch-key", `sports:remind:${fixture.id}`)
  bell.setAttribute("data-feed-fixture-id", fixture.id)
  bell.setAttribute(
    "aria-label",
    reminderSet
      ? `Reminder set for ${formatFeedFixtureTitle(fixture)} — turn off. Reminds you while the app is open.`
      : `Remind me about ${formatFeedFixtureTitle(fixture)}. Reminds you while the app is open.`,
  )
  bell.setAttribute("title", "Reminds you while the app is open")
  bell.addEventListener("click", () => {
    callbacks.onToggleReminder?.(fixture)
  })
  actions.appendChild(bell)
  if (row.matched.watchable && row.epgFixture !== null) {
    const epgFixture = row.epgFixture
    const watch = el("button", "rs-sports-next-watch", "Watch")
    watch.type = "button"
    watch.setAttribute("data-couch-key", `sports:next-watch:${fixture.id}`)
    watch.setAttribute("data-fixture-id", epgFixture.id)
    watch.addEventListener("click", () => {
      callbacks.onWatch(epgFixture)
    })
    actions.appendChild(watch)
  }
  container.appendChild(actions)
  return container
}

function buildNextMatchesSection(
  feedResult: FeedFixturesResult,
  nextMatches: NextMatchRow[],
  callbacks: SportsHubCallbacks,
  /** True when the table section did NOT already show the
   *  attribution line — the attribution must be visible in the hub
   *  wherever feed data is shown. */
  showAttribution: boolean,
  nowMs: number = Date.now(),
): HTMLElement {
  const section = el("section", "rs-sports-section rs-sports-next-section")
  section.setAttribute("data-sports-section", "next-matches")
  section.appendChild(el("h2", "rs-sports-section-title", "Next Matches"))
  if (
    (feedResult.status === "ok" || feedResult.status === "stale") &&
    nextMatches.length > 0
  ) {
    const list = el("div", "rs-sports-list")
    for (const row of nextMatches) {
      list.appendChild(buildNextMatchRow(row, callbacks, nowMs))
    }
    section.appendChild(list)
    if (feedResult.stale) {
      section.appendChild(
        el(
          "p",
          "rs-sports-table-stale",
          feedResult.mayBeOutOfDate
            ? "These fixtures may be out of date — the feed couldn't be reached."
            : "Showing the last fixtures we have — the feed couldn't be reached.",
        ),
      )
    }
  } else if (feedResult.status === "ok" || feedResult.status === "stale") {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "No upcoming Manchester United fixtures from the feed right now.",
      ),
    )
  } else if (feedResult.status === "no-key") {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "Next matches need your football-data.org API key — add it in Settings.",
      ),
    )
  } else {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "Next matches unavailable — the feed couldn't be reached. Fixtures below still come from your programme guide.",
      ),
    )
  }
  if (
    showAttribution &&
    (feedResult.status === "ok" || feedResult.status === "stale")
  ) {
    section.appendChild(
      el("p", "rs-sports-attribution", FOOTBALL_DATA_ATTRIBUTION),
    )
  }
  return section
}

// ── Hero ────────────────────────────────────────────────────────

function buildHero(
  fixture: SportsFixture,
  ctx: RowContext,
): HTMLElement {
  const hero = el("section", "rs-sports-hero")
  hero.setAttribute("data-sports-section", "hero")
  hero.setAttribute("data-fixture-id", fixture.id)
  const body = el("div", "rs-sports-hero-body")
  const crest = el("img", "rs-sports-hero-crest")
  crest.src = MAN_UTD_CREST_SRC
  crest.alt = MAN_UTD_CREST_ALT
  crest.decoding = "async"
  body.appendChild(crest)
  body.appendChild(el("p", "rs-sports-hero-eyebrow", "Next match"))
  body.appendChild(el("h2", "rs-sports-hero-title", fixture.title))
  body.appendChild(
    el("p", "rs-sports-hero-meta", fixtureMetaLine(fixture, ctx.nowMs)),
  )
  const alsoOn = alsoOnLine(fixture)
  if (alsoOn) {
    body.appendChild(el("p", "rs-sports-hero-also", alsoOn))
  }
  if (fixture.desc) {
    body.appendChild(el("p", "rs-sports-hero-desc", fixture.desc))
  }
  const watch = el(
    "button",
    "rs-sports-hero-watch",
    fixtureActionLabel(fixture, ctx.nowMs),
  )
  watch.type = "button"
  watch.setAttribute("data-couch-key", "sports:hero:watch")
  watch.setAttribute("data-fixture-id", fixture.id)
  watch.addEventListener("click", () => {
    ctx.callbacks.onWatch(fixture)
  })
  body.appendChild(watch)
  hero.appendChild(body)
  return hero
}

/**
 * Hero artwork only (§10): one enrichment call for the hero
 * fixture, backdrop variant. Rows carry no artwork calls. A null
 * URL leaves the branded gradient fallback untouched — never a
 * stretched logo, never a broken image.
 */
export async function applyHeroArtwork(
  heroElement: HTMLElement,
  fixture: SportsFixture,
): Promise<string | null> {
  try {
    const art = await enrichProgramme({
      title: fixture.title,
      channelName: fixture.channelName,
      startMs: fixture.startMs,
      endMs: fixture.stopMs,
      category: fixture.channelCategory,
      channelLogoUrl: fixture.channelLogo,
    })
    const url = pickArtworkUrl(art, "backdrop")
    if (!url) return null
    if (!heroElement.isConnected) return null
    if (heroElement.getAttribute("data-fixture-id") !== fixture.id) return null
    heroElement.style.setProperty("--rs-sports-hero-art", `url("${url}")`)
    heroElement.classList.add("rs-sports-hero-has-art")
    return url
  } catch {
    return null
  }
}

// ── Hub render ──────────────────────────────────────────────────

export interface SportsHubRoot {
  headerMeta: HTMLElement | null
  staleNote: HTMLElement | null
  followButton: HTMLButtonElement | null
  content: HTMLElement
  states: HTMLElement
}

export function querySportsHubRoot(
  root: ParentNode,
): SportsHubRoot | null {
  const content = root.querySelector<HTMLElement>("[data-sports-hub-content]")
  const states = root.querySelector<HTMLElement>("[data-sports-hub-states]")
  if (!content || !states) return null
  return {
    headerMeta: root.querySelector<HTMLElement>("[data-sports-hub-meta]"),
    staleNote: root.querySelector<HTMLElement>("[data-sports-hub-stale]"),
    followButton: root.querySelector<HTMLButtonElement>(
      "[data-sports-hub-follow]",
    ),
    content,
    states,
  }
}

const HUB_STATE_COPY: Record<
  Exclude<SportsHubState, "ready" | "unfollowed">,
  { title: string; message: string }
> = {
  "no-playlist": {
    title: "No playlist added",
    message: "Add a playlist to see Manchester United fixtures here.",
  },
  "no-channels": {
    title: "Channels haven't loaded yet",
    message:
      "Open Live TV once to load your channels, then come back here.",
  },
  loading: {
    title: "Loading the programme guide…",
    message: "Fixtures from your programme guide will appear here.",
  },
  failed: {
    title: "The programme guide couldn't be loaded",
    message:
      "Check the connection and try again — no listings are shown rather than guessed ones.",
  },
  "no-mapping": {
    title: "No programme data matched",
    message:
      "None of your channels matched programme data, so there is nothing to list here.",
  },
}

function renderStateBlock(
  statesEl: HTMLElement,
  state: Exclude<SportsHubState, "ready" | "unfollowed">,
): void {
  const copy = HUB_STATE_COPY[state]
  const block = el("div", "rs-sports-state")
  block.appendChild(el("h2", "rs-sports-state-title", copy.title))
  block.appendChild(el("p", "rs-sports-state-message", copy.message))
  if (state === "no-playlist") {
    const link = el("a", "rs-sports-state-action", "Add a playlist")
    link.setAttribute("href", "/login")
    block.appendChild(link)
  }
  statesEl.replaceChildren(block)
}

function renderFollowCta(
  statesEl: HTMLElement,
  callbacks: SportsHubCallbacks,
): void {
  const block = el("div", "rs-sports-state")
  block.appendChild(
    el("h2", "rs-sports-state-title", `Follow ${SPORTS_FOLLOWED_TEAM_NAME}`),
  )
  block.appendChild(
    el(
      "p",
      "rs-sports-state-message",
      "Follow Manchester United to see every match in your programme guide — station, kick-off and tune-in, ready when you open this corner.",
    ),
  )
  const button = el("button", "rs-sports-state-action", "Follow")
  button.type = "button"
  button.setAttribute("data-couch-key", "sports:follow")
  button.addEventListener("click", () => callbacks.onToggleFollow())
  block.appendChild(button)
  statesEl.replaceChildren(block)
}

/**
 * Render the hub from a view model. The state blocks live in the
 * static shell; this function owns the dynamic content region and
 * the header meta/follow button. Focus is preserved across
 * re-renders via the focus-key capture/restore pair.
 */
export function renderSportsHub(
  root: SportsHubRoot,
  model: SportsHubModel,
  callbacks: SportsHubCallbacks,
  nowMs: number = Date.now(),
): void {
  const followed = model.followed
  if (root.followButton) {
    root.followButton.textContent = followed ? "Unfollow" : "Follow"
    root.followButton.setAttribute(
      "data-couch-key",
      followed ? "sports:unfollow" : "sports:follow",
    )
  }
  if (root.headerMeta) {
    root.headerMeta.textContent =
      model.lastUpdatedLabel !== null
        ? `Fixtures from your programme guide · Last updated ${model.lastUpdatedLabel}`
        : "Fixtures from your programme guide"
  }
  if (root.staleNote) {
    root.staleNote.hidden = !model.stale
  }

  const focusKey = captureFocusKeyWithin(document, [root.content, root.states])

  if (model.state === "unfollowed") {
    root.content.replaceChildren()
    renderFollowCta(root.states, callbacks)
    restoreFocusKeyWithin(document, focusKey, root.states)
    return
  }
  if (model.state !== "ready") {
    root.content.replaceChildren()
    renderStateBlock(root.states, model.state)
    restoreFocusKeyWithin(document, focusKey, root.states)
    return
  }
  root.states.replaceChildren()

  const ctx: RowContext = { nowMs, callbacks, showPossibleBadge: false }
  const fragment = document.createDocumentFragment()
  // Section order (v2 §4.1, D1-C): Table → Hero → Next Matches →
  // Upcoming (EPG) → Possible → Other Squads → Recent. Recent
  // NEVER leads; when Upcoming is empty the honest empty line
  // names the ~36h guide window and Next Matches carries "what's
  // coming". The hero stays EPG-driven (v2 §4.1) — on a Friday
  // afternoon it is absent and Next Matches leads the fixtures.
  const tableShowsFeedData =
    model.tableResult !== null &&
    (model.tableResult.status === "ok" ||
      model.tableResult.status === "stale")
  if (model.tableResult) {
    fragment.appendChild(
      buildTableSection(
        model.tableResult,
        model.tableExpanded,
        callbacks,
      ),
    )
  }
  if (model.hero) {
    fragment.appendChild(buildHero(model.hero, ctx))
  }
  if (model.feedResult) {
    fragment.appendChild(
      buildNextMatchesSection(
        model.feedResult,
        model.nextMatches,
        callbacks,
        !tableShowsFeedData,
        nowMs,
      ),
    )
  }
  const { upcoming, possible, otherSquadsUpcoming, otherSquadsRecent, recent } =
    model.split
  const hasAnyFixture =
    upcoming.length > 0 ||
    possible.length > 0 ||
    otherSquadsUpcoming.length > 0 ||
    otherSquadsRecent.length > 0 ||
    recent.length > 0
  if (!hasAnyFixture) {
    const empty = el("div", "rs-sports-state")
    empty.appendChild(
      el(
        "h2",
        "rs-sports-state-title",
        "No Manchester United matches in your programme guide right now",
      ),
    )
    empty.appendChild(
      el(
        "p",
        "rs-sports-state-message",
        "The guide covers about the next day and a half — check back closer to matchday.",
      ),
    )
    fragment.appendChild(empty)
  } else {
    const upcomingSection = buildSection(
      "Upcoming Matches",
      null,
      upcoming,
      ctx,
      "No upcoming matches in the guide right now — the guide covers about the next day and a half.",
      "upcoming",
    )
    if (upcomingSection) fragment.appendChild(upcomingSection)
    const possibleSection = buildSection(
      "Possible Matches",
      "These titles say 'United' without naming the club.",
      possible,
      { ...ctx, showPossibleBadge: true },
      null,
      "possible",
    )
    if (possibleSection) fragment.appendChild(possibleSection)
    const squadsSection = buildOtherSquadsSection(
      otherSquadsUpcoming,
      otherSquadsRecent,
      ctx,
    )
    if (squadsSection) fragment.appendChild(squadsSection)
    const recentSection = buildSection(
      "Recent Matches",
      null,
      recent,
      ctx,
      null,
      "recent",
    )
    if (recentSection) fragment.appendChild(recentSection)
  }
  root.content.replaceChildren(fragment)
  restoreFocusKeyWithin(document, focusKey, root.content)
}

// ── Fixture context menu (X, plan §5.3) ─────────────────────────

/**
 * The fixture X menu (plan §7). Menu order: Watch (when tunable)
 * → Remind me → Open in Guide. "Watch from start" sits with Watch
 * as its variant. The Remind item appears only for a feed fixture
 * (a Next Matches row / hero fixture the feed knows) whose
 * kick-off is still ahead — a past fixture cannot be reminded
 * about — and its label is state-aware: "Remind me" vs
 * "Reminder set — turn off". The toggle goes through
 * callbacks.onToggleReminder, which toasts and re-renders.
 */
export function fixtureContextActions(
  fixture: SportsFixture,
  callbacks: SportsHubCallbacks,
  nowMs: number = Date.now(),
  feedFixture: FeedFixture | null = null,
): TitleContextAction[] {
  const actions: TitleContextAction[] = []
  const state = sportsFixtureState(fixture, nowMs)
  const catchup = fixtureCatchupAction(fixture, nowMs)
  if (state !== "past") {
    actions.push({
      id: "watch",
      label: "Watch",
      action: () => callbacks.onWatch(fixture),
    })
    if (catchup === "watch-from-start") {
      actions.push({
        id: "watch-from-start",
        label: "Watch from start",
        action: () => callbacks.onWatchFromStart(fixture),
      })
    }
  }
  if (state === "past" && catchup === "replay") {
    actions.push({
      id: "replay",
      label: "Replay",
      action: () => callbacks.onReplay(fixture),
    })
  }
  if (
    feedFixture !== null &&
    feedFixture.startMs > nowMs &&
    typeof callbacks.onToggleReminder === "function"
  ) {
    const reminderSet = hasSportsReminder(feedFixture.id, nowMs)
    actions.push({
      id: "remind",
      label: reminderSet ? "Reminder set — turn off" : "Remind me",
      action: () => callbacks.onToggleReminder?.(feedFixture),
    })
  }
  actions.push({
    id: "open-guide",
    label: "Open in Guide",
    action: () => callbacks.onOpenGuide(),
  })
  return actions
}

export function openFixtureContextMenu(
  anchor: HTMLElement,
  fixture: SportsFixture,
  callbacks: SportsHubCallbacks,
  feedFixture: FeedFixture | null = null,
): void {
  openTitleContextMenu(
    anchor,
    fixtureContextActions(fixture, callbacks, Date.now(), feedFixture),
  )
}

// ── Controller wiring (plan §6) ─────────────────────────────────

export interface SportsHubController {
  destroy: () => void
}

export function installSportsHubController(
  root: HTMLElement,
  fixtures: () => ReadonlyArray<SportsFixture>,
  callbacks: SportsHubCallbacks,
  /**
   * Resolve an EPG fixture to its feed fixture (v2 Phase 3): the
   * X menu's Remind item needs the feed id. Optional — without it
   * the menu is the v1 shape (no Remind item). The mount passes a
   * resolver over its Next Matches rows.
   */
  resolveFeedFixture?: (epgFixture: SportsFixture) => FeedFixture | null,
): SportsHubController {
  setLogicalView("followed-sports")
  setControllerHints(SPORTS_HUB_HINTS)
  recordOriginFromReferrer()
  const stopFocusMemory = initListFocusMemory(document, SPORTS_HUB_ROUTE)
  const unregisterBack = registerBackLayer({
    id: "sports-hub-root",
    priority: BACK_PRIORITY.ROUTE,
    isActive: () => !findOpenModal() && !isTitleContextMenuOpen(),
    handle: () => {
      navigateBackWithOrigin("/followed")
      return true
    },
  })

  // Controller X reaches here as the "x" key (gamepad.ts maps the
  // button), mirroring the Followed page's handler. Only fixture
  // rows and the hero Watch button open the menu.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "x" && event.key !== "X") return
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (!target || target === document.body) return
    const tag = target.tagName?.toLowerCase()
    if (tag === "input" || tag === "textarea" || tag === "select") return
    if (target.isContentEditable) return
    if (findOpenModal() || isTitleContextMenuOpen()) return
    const anchor = target.closest?.("[data-fixture-id]") as HTMLElement | null
    if (!anchor || !root.contains(anchor)) return
    const fixtureId = anchor.getAttribute("data-fixture-id")
    const fixture = fixtures().find((candidate) => candidate.id === fixtureId)
    if (!fixture) return
    event.preventDefault()
    // A Next Matches Watch button carries the EPG fixture id, so X
    // opens the v1 fixture menu for it — with the feed fixture
    // resolved, the menu gains its Remind item (plan §7).
    const feedFixture = resolveFeedFixture?.(fixture) ?? null
    openFixtureContextMenu(anchor, fixture, callbacks, feedFixture)
  }
  document.addEventListener("keydown", onKeyDown)

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown)
      unregisterBack()
      stopFocusMemory()
    },
  }
}

/**
 * Initial focus (plan §6.4 intent): a returning visitor's recorded
 * focus first, else the hero Watch button, else the first Upcoming
 * row, else the Follow/Unfollow control. The Followed page does
 * not seed nav focus, so the hub sets its own explicitly.
 */
export function focusSportsHubInitial(root: ParentNode): void {
  const restored = restoreListFocus(document, SPORTS_HUB_ROUTE, root)
  if (restored) return
  const heroWatch = root.querySelector<HTMLElement>(
    '[data-couch-key="sports:hero:watch"]',
  )
  if (heroWatch) {
    heroWatch.focus({ preventScroll: true })
    return
  }
  const firstRow = root.querySelector<HTMLElement>(
    '[data-couch-key^="sports:fixture:"]',
  )
  if (firstRow) {
    firstRow.focus({ preventScroll: true })
    return
  }
  // No EPG rows (e.g. Friday afternoon): the feed sections lead,
  // so focus the table expand action, else the first Next Matches
  // Watch button, before falling back to the follow control.
  const tableExpand = root.querySelector<HTMLElement>(
    '[data-couch-key="sports:table:expand"]',
  )
  if (tableExpand) {
    tableExpand.focus({ preventScroll: true })
    return
  }
  const firstNextWatch = root.querySelector<HTMLElement>(
    '[data-couch-key^="sports:next-watch:"]',
  )
  if (firstNextWatch) {
    firstNextWatch.focus({ preventScroll: true })
    return
  }
  const followControl = root.querySelector<HTMLElement>(
    '[data-couch-key="sports:follow"], [data-couch-key="sports:unfollow"]',
  )
  followControl?.focus({ preventScroll: true })
}

// ── Entry card (plan §5.1) ──────────────────────────────────────

export interface SportsEntryCardModel {
  followed: boolean
  hasPlaylist: boolean
  /** "loading" = no EPG state yet; "failed" = last load errored. */
  epgStatus: "loading" | "failed" | "ready"
  nextFixture: SportsFixture | null
  hasFixtures: boolean
  /** "18th · 8 pts" (v2 §4.2), or null when the table is unknown. */
  tableLine: string | null
  /**
   * Next feed fixture (v2 §4.2), shown only when the EPG has no
   * next fixture — the card must never show "no matches" while the
   * feed knows a fixture is coming. Station is always TBC here:
   * beyond the ~36h EPG window there is no listing to tune.
   */
  nextFeedFixture: FeedFixture | null
}

export function buildSportsEntryCardModel(
  followed: boolean,
  hasPlaylist: boolean,
  epgStatus: "loading" | "failed" | "ready",
  scanResult: SportsScanResult | null,
  nowMs: number,
  feed?: SportsEntryCardFeed | null,
): SportsEntryCardModel {
  return {
    followed,
    hasPlaylist,
    epgStatus,
    nextFixture:
      scanResult !== null
        ? selectNextFixture(scanResult.fixtures, nowMs)
        : null,
    hasFixtures: (scanResult?.fixtures.length ?? 0) > 0,
    tableLine: feed?.tableLine ?? null,
    nextFeedFixture: feed?.nextFeedFixture ?? null,
  }
}

export interface SportsEntryCardCallbacks {
  onWatchLive: (fixture: SportsFixture) => void
  onToggleFollow: () => void
}

export function renderSportsEntryCard(
  container: HTMLElement,
  model: SportsEntryCardModel,
  callbacks: SportsEntryCardCallbacks,
  nowMs: number = Date.now(),
): void {
  container.replaceChildren()
  if (!model.hasPlaylist) {
    container.hidden = true
    return
  }
  container.hidden = false
  const card = el("article", "rs-sports-card")
  const art = el("div", "rs-sports-card-art")
  const crest = el("img", "rs-sports-card-crest")
  crest.src = MAN_UTD_CREST_SRC
  crest.alt = MAN_UTD_CREST_ALT
  crest.decoding = "async"
  art.appendChild(crest)
  card.appendChild(art)
  const body = el("div", "rs-sports-card-body")
  body.appendChild(
    el("p", "rs-sports-card-team", SPORTS_FOLLOWED_TEAM_NAME.toUpperCase()),
  )
  if (model.tableLine) {
    body.appendChild(
      el("p", "rs-sports-card-meta", model.tableLine),
    )
  }

  if (!model.followed) {
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        "Follow Manchester United to see every match, station and kick-off here.",
      ),
    )
    const follow = el("button", "rs-sports-card-button", "Follow")
    follow.type = "button"
    follow.setAttribute("data-couch-key", "sports:card:follow")
    follow.addEventListener("click", () => callbacks.onToggleFollow())
    body.appendChild(follow)
    card.appendChild(body)
    container.appendChild(card)
    return
  }

  if (model.nextFixture) {
    const fixture = model.nextFixture
    body.appendChild(
      el("p", "rs-sports-card-line", `Next match: ${fixture.title}`),
    )
    body.appendChild(
      el("p", "rs-sports-card-meta", fixtureMetaLine(fixture, nowMs)),
    )
    const actions = el("div", "rs-sports-card-actions")
    const open = el("a", "rs-sports-card-button", "Open Sports Corner")
    open.setAttribute("href", SPORTS_HUB_ROUTE)
    open.setAttribute("data-couch-key", "sports:card:open")
    actions.appendChild(open)
    if (sportsFixtureState(fixture, nowMs) === "now") {
      const watch = el("button", "rs-sports-card-button", "Watch live")
      watch.type = "button"
      watch.setAttribute("data-couch-key", "sports:card:watch")
      watch.addEventListener("click", () => callbacks.onWatchLive(fixture))
      actions.appendChild(watch)
    }
    body.appendChild(actions)
  } else if (model.nextFeedFixture) {
    // Feed knows a fixture is coming but the EPG window doesn't
    // reach it yet: show it with Station TBC (v2 §4.2). No Watch
    // button — there is no listing to tune.
    const feedFixture = model.nextFeedFixture
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        `Next match: ${formatFeedFixtureTitle(feedFixture)}`,
      ),
    )
    body.appendChild(
      el(
        "p",
        "rs-sports-card-meta",
        [
          formatFeedFixtureDateTime(feedFixture.startMs),
          feedFixture.competition,
          STATION_TBC,
        ].join(" · "),
      ),
    )
    body.appendChild(sportsCardOpenLink())
  } else if (model.epgStatus === "failed") {
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        "The programme guide couldn't be loaded.",
      ),
    )
    body.appendChild(sportsCardOpenLink())
  } else if (model.epgStatus === "loading") {
    body.appendChild(
      el("p", "rs-sports-card-line", "Checking the programme guide…"),
    )
    body.appendChild(sportsCardOpenLink())
  } else {
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        "No Manchester United matches in your programme guide right now.",
      ),
    )
    body.appendChild(sportsCardOpenLink())
  }
  card.appendChild(body)
  container.appendChild(card)

  if (model.nextFixture) {
    void applyEntryCardArtwork(art, model.nextFixture)
  }
}

function sportsCardOpenLink(): HTMLAnchorElement {
  const open = el("a", "rs-sports-card-button", "Open Sports Corner")
  open.setAttribute("href", SPORTS_HUB_ROUTE)
  open.setAttribute("data-couch-key", "sports:card:open")
  return open
}

async function applyEntryCardArtwork(
  artEl: HTMLElement,
  fixture: SportsFixture,
): Promise<void> {
  try {
    const art = await enrichProgramme({
      title: fixture.title,
      channelName: fixture.channelName,
      startMs: fixture.startMs,
      endMs: fixture.stopMs,
      category: fixture.channelCategory,
      channelLogoUrl: fixture.channelLogo,
    })
    const url = pickArtworkUrl(art, "backdrop")
    if (!url || !artEl.isConnected) return
    artEl.style.setProperty("--rs-sports-card-art", `url("${url}")`)
    artEl.classList.add("rs-sports-card-art-has-art")
  } catch {
    // Branded placeholder stays. Artwork is decoration, never data.
  }
}

// ── Hub mount (plan §2.4) ───────────────────────────────────────

interface HubRuntime {
  playlistId: string
  channels: SportsScanChannel[]
  overrides: Record<string, string>
  epgStatus: "loading" | "failed" | "ready"
  scanResult: SportsScanResult | null
  pipelineFailed: boolean
  heroArtworkFor: string | null
  timer: ReturnType<typeof setInterval> | null
  /** First resolution pass done — render() waits for this so the
   *  static shell's loading block is never replaced by a wrong
   *  no-playlist flash. */
  resolved: boolean
  /** Playlist resolution attempted while followed (re-follow path). */
  playlistAttempted: boolean
  /** Feed state (v2 Phase 2). Null until the first fetch lands;
   *  the table / Next Matches sections are omitted until then. */
  tableResult: LeagueTableResult | null
  feedResult: FeedFixturesResult | null
  nextMatches: NextMatchRow[]
  tableExpanded: boolean
  feedInFlight: boolean
}

export function mountSportsHubPage(): void {
  const shell = document.querySelector<HTMLElement>("[data-sports-hub-shell]")
  if (!shell) return
  const root = querySportsHubRoot(shell)
  if (!root) return

  const runtime: HubRuntime = {
    playlistId: "",
    channels: [],
    overrides: {},
    epgStatus: "loading",
    scanResult: null,
    pipelineFailed: false,
    heroArtworkFor: null,
    timer: null,
    resolved: false,
    playlistAttempted: false,
    tableResult: null,
    feedResult: null,
    nextMatches: [],
    tableExpanded: false,
    feedInFlight: false,
  }

  let callbacks: SportsHubCallbacks | null = null
  let controller: SportsHubController | null = null
  let mounted = true
  // Async continuations (playlist resolution, EPG loads) must not
  // render into a page the user has already left.
  window.addEventListener(
    "pagehide",
    () => {
      mounted = false
    },
    { once: true },
  )

  const currentFixtures = (): ReadonlyArray<SportsFixture> =>
    runtime.scanResult?.fixtures ?? []

  function render(): void {
    if (!mounted || !runtime.resolved) return
    const followed = isSportsTeamFollowed()
    const model = buildSportsHubModel({
      followed,
      hasPlaylist: runtime.playlistId !== "",
      hasChannels: runtime.channels.length > 0,
      epgStatus:
        runtime.pipelineFailed && runtime.scanResult === null
          ? "failed"
          : runtime.epgStatus,
      scanResult: followed ? runtime.scanResult : null,
      nowMs: Date.now(),
      tableResult: runtime.tableResult,
      feedResult: runtime.feedResult,
      nextMatches: runtime.nextMatches,
      tableExpanded: runtime.tableExpanded,
    })
    const activeCallbacks =
      callbacks ??
      createSportsHubCallbacks(runtime.playlistId, SPORTS_HUB_ROUTE)
    activeCallbacks.onToggleTableExpanded = () => {
      runtime.tableExpanded = !runtime.tableExpanded
      render()
    }
    // Phase 3 reminder toggle (D2-A): immediate toggle, toast
    // confirms, re-render repaints the bell. No confirmation dialog.
    activeCallbacks.onToggleReminder = (fixture) => {
      const title = formatFeedFixtureTitle(fixture)
      const result = toggleSportsReminder({
        id: fixture.id,
        title,
        startMs: fixture.startMs,
      })
      if (result.set) {
        toast({
          title: `Reminder set — ${title}, ${formatFeedFixtureDateTime(fixture.startMs)}`,
          description: "Reminds you while the app is open.",
        })
      } else {
        toast({ title: `Reminder cleared — ${title}` })
      }
      render()
    }
    renderSportsHub(root!, model, activeCallbacks)
    if (model.hero && model.hero.id !== runtime.heroArtworkFor) {
      runtime.heroArtworkFor = model.hero.id
      const heroEl = shell!.querySelector<HTMLElement>(".rs-sports-hero")
      if (heroEl) void applyHeroArtwork(heroEl, model.hero)
    }
    if (!controller) {
      controller = installSportsHubController(
        shell!,
        currentFixtures,
        activeCallbacks,
        // X-menu Remind item (Phase 3): an EPG fixture maps to its
        // feed fixture through the Next Matches rows.
        (epgFixture) =>
          runtime.nextMatches.find(
            (row) => row.epgFixture?.id === epgFixture.id,
          )?.matched.fixture ?? null,
      )
      focusSportsHubInitial(shell!)
    }
  }

  // Reminder firing is NOT owned here any more (Phase 3 fix): the
  // app-wide watcher (sports-reminder-watcher.ts, started from both
  // layouts) fires on any page, including this hub — the hub's own
  // 60s checker is removed so exactly one checker exists per
  // document. The watcher also checks on start, on reminder change,
  // and when the guide lands, which covers the feed-landing moment
  // this function used to handle.
  function scan(): void {
    if (!mounted || runtime.playlistId === "") return
    // Unfollowed: no scan runs (§2.5). The memoised result from a
    // previous followed session stays cached for instant re-follow.
    if (!isSportsTeamFollowed()) return
    try {
      const state = getProgrammesSync(runtime.playlistId)
      if (!state) {
        runtime.scanResult = null
        return
      }
      runtime.scanResult = getSportsScan(
        runtime.channels,
        state,
        runtime.overrides,
        runtime.playlistId,
      )
      runtime.pipelineFailed = false
    } catch {
      // A corrupt channel entry must not blank the hub: keep the
      // last-good scan and surface the failure signal instead.
      runtime.pipelineFailed = true
    }
  }

  /**
   * Feed refresh (v2 Phase 2): table + next 5 fixtures through the
   * Phase 1 client (1h cache, so repeat calls are cheap). A
   * no-key/error result still lands in the runtime — the table and
   * Next Matches sections render their honest failure copy from
   * it. Never throws: the client returns typed results.
   */
  async function refreshFeed(): Promise<void> {
    if (!mounted || runtime.feedInFlight) return
    runtime.feedInFlight = true
    try {
      const [tableResult, feedResult] = await Promise.all([
        getLeagueTable(),
        getNextFixtures(5),
      ])
      if (!mounted) return
      runtime.tableResult = tableResult
      runtime.feedResult = feedResult
      runtime.nextMatches = buildNextMatchRows(
        feedResult.fixtures ?? [],
        currentFixtures(),
      )
      render()
    } finally {
      runtime.feedInFlight = false
    }
  }

  async function resolvePlaylist(): Promise<void> {
    try {
      // Unfollowed: the CTA needs no playlist, no channels, no EPG
      // load. Resolve nothing; re-follow re-enters here.
      if (!isSportsTeamFollowed()) {
        runtime.resolved = true
        render()
        return
      }
      runtime.playlistAttempted = true
      const entry = await getActiveEntry()
      if (!mounted) return
      runtime.resolved = true
      if (!entry?._id) {
        runtime.playlistId = ""
        render()
        return
      }
      runtime.playlistId = String(entry._id)
      callbacks = createSportsHubCallbacks(
        runtime.playlistId,
        SPORTS_HUB_ROUTE,
      )
      // Warm the channel cache from IndexedDB before reading it:
      // the in-memory cache is per-page-load, so a fresh hub load
      // would otherwise always read zero channels. Same hydration
      // livetv-data.ts / home.ts perform before their reads — a
      // local read, not a fetch, and not an EPG load.
      await Promise.allSettled([
        hydrateCache(runtime.playlistId, "live"),
        hydrateCache(runtime.playlistId, "m3u"),
      ])
      if (!mounted) return
      const rawChannels = readCachedLiveChannels(runtime.playlistId)
      runtime.channels = (Array.isArray(rawChannels) ? rawChannels : []).filter(
        (channel): channel is SportsScanChannel =>
          channel != null && channel.id != null,
      )
      runtime.overrides = {}
      for (const channel of runtime.channels) {
        try {
          const override = getChannelEpgOverride(
            runtime.playlistId,
            channel.id,
          )
          if (override) runtime.overrides[String(channel.id)] = override
        } catch {
          // No override for this channel; resolution falls through.
        }
      }
      if (runtime.channels.length === 0) {
        render()
        return
      }
      const state = getProgrammesSync(runtime.playlistId)
      if (state) {
        runtime.epgStatus = "ready"
        scan()
        render()
        return
      }
      // No state yet: trigger the load (hub only — the Followed
      // entry card never triggers one), render loading, re-render
      // on xt:epg-loaded.
      render()
      try {
        const creds = await loadCreds()
        if (!mounted) return
        await loadProgrammes(runtime.playlistId, creds)
      } catch {
        // The source-status event carries the failure signal; a
        // throw here alone must not fake a failure state.
      }
    } catch {
      runtime.pipelineFailed = true
      runtime.resolved = true
      render()
    }
  }

  document.addEventListener(EPG_LOADED_EVENT, () => {
    if (!mounted) return
    runtime.epgStatus = "ready"
    scan()
    // A fresh EPG revision can bring the station for a feed
    // fixture that was Station TBC — re-match from the cached feed
    // result (no refetch inside the 1h TTL).
    if (runtime.feedResult?.fixtures) {
      runtime.nextMatches = buildNextMatchRows(
        runtime.feedResult.fixtures,
        currentFixtures(),
      )
    }
    render()
  })
  document.addEventListener(EPG_SOURCE_STATUS_EVENT, (event) => {
    if (!mounted) return
    const detail = (event as CustomEvent)?.detail ?? {}
    if (
      detail.playlistId &&
      runtime.playlistId &&
      detail.playlistId !== runtime.playlistId
    ) {
      return
    }
    const sources = Array.isArray(detail.sources) ? detail.sources : []
    if (sources.length === 0) return
    const allFailed = sources.every(
      (source: { status?: unknown }) =>
        source && source.status === "error",
    )
    if (allFailed === (runtime.epgStatus === "failed")) return
    runtime.epgStatus = allFailed ? "failed" : "ready"
    render()
  })
  document.addEventListener(SPORTS_REMINDERS_CHANGED_EVENT, () => {
    if (!mounted) return
    // A reminder changed under the hub (bell, X menu, or an
    // external writer): re-render so the bell state is never stale.
    render()
  })
  document.addEventListener(SPORTS_FOLLOW_CHANGED_EVENT, () => {
    if (!mounted) return
    // Re-follow after an unfollowed mount: the playlist was never
    // resolved, so resolve now. Otherwise the memoised scan is
    // reused — nothing was deleted (§3.1).
    if (isSportsTeamFollowed() && !runtime.playlistAttempted) {
      void resolvePlaylist()
      return
    }
    render()
  })

  // 60-second timer: re-derive row states from the clock without
  // re-scanning (§2.4). Re-render only when a boundary crossed —
  // cheap check on the memoised fixture list. Reminder firing used
  // to ride this heartbeat; it now lives in the app-wide watcher
  // (sports-reminder-watcher.ts), so this timer only re-renders.
  let lastStateSignature = ""
  runtime.timer = setInterval(() => {
    if (!mounted) return
    const nowMs = Date.now()
    const signature = (runtime.scanResult?.fixtures ?? [])
      .map(
        (fixture) =>
          `${fixture.id}:${sportsFixtureState(fixture, nowMs)}:${fixtureCatchupAction(fixture, nowMs)}`,
      )
      .join("|")
    if (signature === lastStateSignature) return
    lastStateSignature = signature
    render()
  }, 60_000)

  const followButton = root.followButton
  followButton?.addEventListener("click", () => {
    const active =
      callbacks ?? createSportsHubCallbacks(runtime.playlistId, SPORTS_HUB_ROUTE)
    active.onToggleFollow()
  })

  void resolvePlaylist()
  void refreshFeed()
}
