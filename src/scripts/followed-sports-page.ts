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
  FOOTBALL_DATA_LIVE_FIXTURE_MAX_AGE_MS,
  STATION_TBC,
  getLeagueTable,
  getLiveFixtures,
  getNextFixtures,
  getRecentForm,
  normaliseTeamName,
  type FeedFixture,
  type FeedFixturesResult,
  type FeedFormResult,
  type FormMark,
  type LeagueTableResult,
} from "@/scripts/lib/football-data.js"
import {
  SPORTS_PREMATCH_WINDOW_MS,
  findUnitedTableEntry,
  formatFeedFixtureDateTime,
  formatFeedFixtureTitle,
  formatTableAsOf,
  ordinal,
  selectTableRows,
  shortTeamName,
  type SportsEntryCardFeed,
} from "@/scripts/lib/sports-corner-v2-hub.js"
import {
  isSportsTeamFollowed,
  followSportsTeam,
  unfollowSportsTeam,
  SPORTS_FOLLOW_CHANGED_EVENT,
  SPORTS_FOLLOWED_TEAM_NAME,
} from "@/scripts/lib/sports-follow.js"
import { maybeOpenKeysOnboarding } from "@/scripts/lib/keys-feature-entry.ts"
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
  sportsFixtureLiveBadge,
  sportsFixtureState,
  type SportsFixture,
  type SportsScanChannel,
  type SportsScanResult,
  type SplitSportsFixtures,
} from "@/scripts/lib/sports-fixture-scan.js"

export const SPORTS_HUB_ROUTE = "/followed/sports"

// Manchester United crest — the genuine club crest, bundled as a
// repo brand asset (public/brand/man-utd-crest.svg — brand assets,
// NOT the governed sports-photo library in public/art/sports/, whose
// manifest only covers licence-verified Commons JPEGs). Source: the
// club's own hospitality guide, via Wikipedia
// File:Manchester_United_FC_crest.svg
// (https://en.wikipedia.org/wiki/File:Manchester_United_FC_crest.svg,
// verified visually 2026-11-20). Registered trademark of Manchester
// United; used here only to identify the club in its own hub. This
// file never comes from the feed — football-data.org terms §9.2
// forbids rendering feed-supplied logos.
export const MAN_UTD_CREST_SRC = "/brand/man-utd-crest.svg"
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
  /** No playlist / no channels yet — the EPG half is empty, but the
   *  feed sections still render (bug 2). */
  hasPlaylist: boolean
  hasChannels: boolean
  /** EPG failed but last-good fixtures are shown (§2.5 keep-last-good). */
  stale: boolean
  /** The next live EPG fixture (guide view) — selectNextFixture
   *  over the scanned programmes. This is NOT the hub hero: the
   *  hero is the feed's next match (nextMatches[0]) or the honest
   *  feed-state hero when the feed has none. The field survives
   *  for the Followed entry card's next-fixture parity (T24) —
   *  the card and the hub's guide view agree on the next live
   *  listing — and for tests. The render never presents it as the
   *  hub's next match: feed-first (0.11.26), an EPG listing must
   *  never stand in for the feed's next match, however live it
   *  looks. */
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
  /** Recent-form result (Last five, mockup rebuild 0.11.17).
   *  Null = not fetched yet — the chips row is omitted, never faked. */
  formResult: FeedFormResult | null
  /** Feed fixtures matched to EPG listings, feed order (v2 §4.1). */
  nextMatches: NextMatchRow[]
  /** Live feed fixtures matched to EPG listings (feed-first,
   *  0.11.26) — the live half of on-TV-now. Null = not fetched
   *  yet; [] = the feed says nothing is live. */
  liveMatches: NextMatchRow[]
  /** Mini-table vs full 20 (v2 §4.1). */
  tableExpanded: boolean
  /** Feed fixtures on TV now (mockup "United on TV now" cards):
   *  live feed fixtures + upcoming feed fixtures inside the
   *  pre-match window, each with its station from the EPG. Empty
   *  when the feed has none on now — never faked, and never an EPG
   *  programme standing in for a fixture: no feed fixture, no
   *  on-TV-now entry. */
  onTvNow: NextMatchRow[]
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
  formResult?: FeedFormResult | null
  nextMatches?: NextMatchRow[]
  /** Live feed fixtures matched to EPG listings (feed-first,
   *  0.11.26). Omitted = not fetched yet. */
  liveMatches?: NextMatchRow[]
  tableExpanded?: boolean
}

/**
 * The on-TV-now rows, feed-first (0.11.26): a feed fixture that is
 * live (from getLiveFixtures) or inside the 60-minute pre-match
 * window (from getNextFixtures), with its station from the EPG. No
 * feed fixture, no on-TV-now entry — an EPG programme on now (a
 * classic, a replay, a magazine show) is a TV programme, not a
 * fixture, and it never appears here.
 *
 * Live rows: the feed says the fixture is being played and
 * kick-off was within the last 3 hours (a match cannot run
 * longer — the same bound getLiveFixtures applies, so a stale
 * live row can never linger here). A live row shows with Station
 * TBC when the EPG has no listing for it — the match IS live,
 * the station is just unknown.
 * Pre-match rows: kick-off within the pre-match window AND
 * stationKnown — without a listing the fixture is not "on TV"
 * yet, it is just upcoming (and it already appears in Next
 * fixtures). Live rows first, then pre-match, each earliest
 * first; capped at three cards (the mockup's three).
 */
export function selectOnTvNowRows(
  liveMatches: ReadonlyArray<NextMatchRow>,
  nextMatches: ReadonlyArray<NextMatchRow>,
  nowMs: number = Date.now(),
): NextMatchRow[] {
  const live = liveMatches
    .filter((row) => {
      const startMs = row.matched.fixture.startMs
      return (
        startMs <= nowMs &&
        nowMs - startMs <= FOOTBALL_DATA_LIVE_FIXTURE_MAX_AGE_MS
      )
    })
    .sort((a, b) => a.matched.fixture.startMs - b.matched.fixture.startMs)
  const prematch = nextMatches
    .filter((row) => {
      const startMs = row.matched.fixture.startMs
      return (
        row.matched.stationKnown &&
        startMs > nowMs &&
        startMs - nowMs <= SPORTS_PREMATCH_WINDOW_MS
      )
    })
    .sort((a, b) => a.matched.fixture.startMs - b.matched.fixture.startMs)
  return [...live, ...prematch].slice(0, 3)
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
    hasPlaylist,
    hasChannels,
    stale: false,
    hero: null,
    split: EMPTY_SPLIT,
    lastUpdatedLabel: null,
    mappedChannelCount: scanResult?.mappedChannelCount ?? 0,
    channelCount: scanResult?.channelCount ?? 0,
    tableResult: input.tableResult ?? null,
    feedResult: input.feedResult ?? null,
    formResult: input.formResult ?? null,
    nextMatches: input.nextMatches ?? [],
    liveMatches: input.liveMatches ?? [],
    tableExpanded: input.tableExpanded ?? false,
    onTvNow: [],
  }
  if (!followed) return { ...base, state: "unfollowed" }
  // BUG 2 — the feed-backed sections must NOT wait for the TV guide:
  // the table and fixtures use a separate data source, so when feed
  // data has arrived the hub is ready even though the guide hasn't
  // (no scan yet, no playlist, no channels, zero mapped channels).
  // The guide gate survives only for the parts that need the guide
  // (on-TV-now cards and their tune-in, which read the EPG scan).
  // Without feed data the old gates stand exactly as before.
  const hasFeed = input.tableResult != null || input.feedResult != null
  if (!hasFeed) {
    if (!hasPlaylist) return { ...base, state: "no-playlist" }
    if (!hasChannels) return { ...base, state: "no-channels" }
    if (scanResult === null) {
      return {
        ...base,
        state: epgStatus === "failed" ? "failed" : "loading",
      }
    }
  }
  if (scanResult === null) {
    return {
      ...base,
      state: "ready",
      stale: epgStatus === "failed",
      onTvNow: selectOnTvNowRows(
        input.liveMatches ?? [],
        input.nextMatches ?? [],
        input.nowMs,
      ),
    }
  }
  const split = splitSportsFixtures(scanResult.fixtures, input.nowMs)
  // Feed-first (0.11.26): on-TV-now comes from the feed's live +
  // pre-match fixtures (selectOnTvNowRows), never from the EPG scan
  // alone — an EPG programme on now (classic, replay, magazine
  // show) is not a fixture and never appears here.
  const onTvNow = selectOnTvNowRows(
    input.liveMatches ?? [],
    input.nextMatches ?? [],
    input.nowMs,
  )
  const model: SportsHubModel = {
    ...base,
    split,
    onTvNow,
    hero: selectNextFixture(scanResult.fixtures, input.nowMs),
    lastUpdatedLabel: formatLastUpdated(scanResult),
  }
  if (scanResult.mappedChannelCount === 0 && !hasFeed) {
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

/**
 * "Sunday · 16:30" — the mockup hero's day/time line (long weekday,
 * 24-hour clock, Europe/Dublin). Feed times are absolute UTC, so the
 * zone is fixed here, matching formatFeedFixtureDateTime.
 */
export function formatFeedHeroDateTime(startMs: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Dublin",
  }).formatToParts(new Date(startMs))
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${get("weekday")} · ${get("hour")}:${get("minute")}`
}

/**
 * "Sun · 16:30" — the mockup Next-fixtures column's day/time line.
 */
export function formatFixtureDayTime(startMs: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Dublin",
  }).formatToParts(new Date(startMs))
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${get("weekday")} · ${get("hour")}:${get("minute")}`
}

/** The non-United side of a feed fixture, short display name. */
export function feedFixtureOpponent(fixture: FeedFixture): string {
  const united = normaliseTeamName(fixture.home) === "manchester united"
  return shortTeamName(united ? fixture.away : fixture.home)
}

/** "HOME" when United host, else "AWAY". */
export function feedFixtureHomeAway(fixture: FeedFixture): string {
  return normaliseTeamName(fixture.home) === "manchester united"
    ? "HOME"
    : "AWAY"
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
  /** Open the unified keys onboarding at the football-data.org step
   *  (0.11.19 keys onboarding). Optional: test stubs omit it; the
   *  "Set up key" buttons then no-op. The production implementation
   *  opens the dialog and refreshes the feed when a key is saved. */
  onSetupFootballDataKey?: () => void
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
    // Keys onboarding (0.11.19): the no-key "Set up key" buttons
    // open the dialog at the football-data.org step. No feed refresh
    // here — the mount assigns the refresh-aware version below.
    onSetupFootballDataKey: () => {
      void maybeOpenKeysOnboarding("football-data")
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
  /** Card treatment: upcoming = full colour, possible = dashed
   *  outline, recent/other = muted thumb. Defaults to "upcoming". */
  variant?: "upcoming" | "possible" | "recent" | "other"
}

// ── Next-fixture card art (visual rebuild, fix-3) ───────────────
// Opponent stadium photography from the bundled, licence-verified
// sports library (public/art/sports/, manifest
// sports-artwork-manifest.ts) — the same photos the enrichment
// hierarchy already serves. Home fixtures get Old Trafford; an
// away ground with no bundled photo gets the branded red gradient
// + crest fallback, never a guessed stadium photo. Venues are only
// named where the bundle actually has the ground: Anfield
// (Liverpool), Gtech (Brentford), St James' Park (Newcastle).
export const OLD_TRAFFORD_ART = "/art/sports/football-man-utd-old-trafford.jpg"
const OPPONENT_STADIUM_ART: ReadonlyArray<{
  match: RegExp
  art: string
}> = [
  { match: /liverpool/i, art: "/art/sports/football-liverpool-anfield-kop.jpg" },
  { match: /brentford/i, art: "/art/sports/football-brentford-gtech-lineup.jpg" },
  { match: /newcastle/i, art: "/art/sports/football-newcastle-st-james.jpg" },
]

/**
 * Card art for one Next-fixtures column: the opponent's ground
 * when the bundle has it, Old Trafford when United host, null
 * when neither is known (the card renders the branded gradient).
 */
export function nextFixtureArt(
  fixture: FeedFixture,
): string | null {
  const opponent = feedFixtureOpponent(fixture)
  for (const entry of OPPONENT_STADIUM_ART) {
    if (entry.match.test(opponent)) return entry.art
  }
  return feedFixtureHomeAway(fixture) === "HOME" ? OLD_TRAFFORD_ART : null
}

/** "22" + "NOV" — the date badge on a Next-fixtures card thumb. */
export function formatFixtureDayBadge(startMs: number): {
  day: string
  month: string
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/Dublin",
  }).formatToParts(new Date(startMs))
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return { day: get("day"), month: get("month").toUpperCase() }
}

/**
 * One EPG fixture as a horizontal card (visual rebuild, fix-3):
 * artwork thumb left (programme art via applyFixtureCardArtwork,
 * branded red gradient + crest watermark until it lands), title +
 * meta + description right, action pill at the end. The whole card
 * stays one focusable button with the same data-couch-key and
 * data-fixture-id as the old list row — controller nav and the X
 * menu are untouched. Variants: "possible" gets a dashed outline
 * and keeps the Unconfirmed-team badge; "recent" gets a muted
 * thumb (the match is over); "other" is the Other Squads card.
 */
function buildFixtureRow(
  fixture: SportsFixture,
  ctx: RowContext,
): HTMLButtonElement {
  const variant = ctx.variant ?? "upcoming"
  const row = el(
    "button",
    `rs-sports-row rs-sports-row--${variant}`,
  )
  row.type = "button"
  row.setAttribute("data-couch-key", `sports:fixture:${fixture.id}`)
  row.setAttribute("data-fixture-id", fixture.id)
  const state = sportsFixtureState(fixture, ctx.nowMs)

  // Artwork thumb. The art itself is applied after render by
  // applyFixtureCardArtwork (one enrichment call per card); the
  // CSS fallback is the branded gradient + crest watermark, so a
  // card never shows a broken or empty thumb.
  const thumb = el("div", "rs-sports-row-thumb")
  thumb.setAttribute("aria-hidden", "true")
  const nowLabel = sportsFixtureLiveBadge(fixture, ctx.nowMs)
  if (nowLabel) {
    thumb.appendChild(el("span", "rs-sports-badge rs-sports-badge-live", nowLabel))
  }
  row.appendChild(thumb)

  const body = el("div", "rs-sports-row-body")
  const main = el("div", "rs-sports-row-main")
  const titleRow = el("div", "rs-sports-row-title-row")
  titleRow.appendChild(el("span", "rs-sports-row-title", fixture.title))
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
  body.appendChild(main)

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
  body.appendChild(action)
  row.appendChild(body)

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
  // Section header: title + count pill (the pill is a span inside
  // the h2, so the heading text still reads exactly as before).
  const title = el("h2", "rs-sports-section-title", heading)
  if (rows.length > 0) {
    title.appendChild(
      el("span", "rs-sports-section-count", String(rows.length)),
    )
  }
  section.appendChild(title)
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
  const title = el("h2", "rs-sports-section-title", "Other Squads")
  title.appendChild(
    el(
      "span",
      "rs-sports-section-count",
      String(upcoming.length + recent.length),
    ),
  )
  section.appendChild(title)
  section.appendChild(
    el(
      "p",
      "rs-sports-section-note",
      "Women's, youth and academy fixtures, kept separate from the first team.",
    ),
  )
  const otherCtx: RowContext = { ...ctx, variant: "other" }
  const upcomingList = el("div", "rs-sports-list")
  for (const fixture of upcoming) {
    upcomingList.appendChild(buildFixtureRow(fixture, otherCtx))
  }
  section.appendChild(upcomingList)
  if (recent.length > 0) {
    const subhead = el("h3", "rs-sports-subhead", "Recent")
    subhead.appendChild(
      el("span", "rs-sports-section-count", String(recent.length)),
    )
    section.appendChild(subhead)
    const recentList = el("div", "rs-sports-list")
    for (const fixture of recent) {
      recentList.appendChild(
        buildFixtureRow(fixture, { ...otherCtx, variant: "recent" }),
      )
    }
    section.appendChild(recentList)
  }
  return section
}

// ── League table (v2 §4.1) ─────────────────────────────────────

/**
 * League position panel (mockup right panel, 0.11.17). Compact
 * 4-column mini-table (# Club P Pts, United row highlighted in
 * United red) with the big position + points above it — the panel
 * is ~280px wide, so the old 9-column table cannot fit here.
 * Mini (United ±3) by default, full 20 behind one focusable action
 * ("View full table ›"). The United row is hard-coded United
 * visuals, no team picker, no feed-supplied crests (terms §9.2).
 * Dated + sourced on screen; stale >24h says "may be out of date";
 * feed down / no key shows honest failure copy, never invented data.
 *
 * "Last five" chips (mockup rebuild, 0.11.17): the `form` marks
 * come from getRecentForm — W/D/L derived from FINISHED Premier
 * League results with feed scores, most recent first. The
 * standings endpoint carries no form, so the chips live on that
 * call, not on the table; when form is null or empty the row is
 * omitted rather than guessed (the mockup's W W D L W chips are
 * sample data — the real marks are D L L D D as of 21 Nov 2026).
 */
function buildTableSection(
  tableResult: LeagueTableResult,
  expanded: boolean,
  callbacks: SportsHubCallbacks,
  form: ReadonlyArray<FormMark> | null = null,
): HTMLElement {
  const section = el("section", "rs-sports-section rs-sports-table-section")
  section.setAttribute("data-sports-section", "table")
  // Panel head (visual rebuild, fix-3): mini crest + competition
  // name, so the panel reads as a designed card rather than bare
  // text above a table. The crest is the genuine bundled asset.
  const panelHead = el("div", "rs-sports-table-panel-head")
  const panelCrest = el("img", "rs-sports-table-panel-crest")
  panelCrest.src = MAN_UTD_CREST_SRC
  panelCrest.alt = ""
  panelCrest.decoding = "async"
  panelHead.appendChild(panelCrest)
  panelHead.appendChild(
    el("span", "rs-sports-table-panel-comp", "Premier League"),
  )
  section.appendChild(panelHead)
  section.appendChild(el("h2", "rs-sports-table-heading", "League position"))

  const table = tableResult.table
  if (
    (tableResult.status === "ok" || tableResult.status === "stale") &&
    table !== null
  ) {
    const united = findUnitedTableEntry(table)
    if (united) {
      const position = el("div", "rs-sports-table-position")
      position.appendChild(
        el("span", "rs-sports-table-big", ordinal(united.position)),
      )
      position.appendChild(el("span", "rs-sports-table-points-rule"))
      position.appendChild(
        el(
          "span",
          "rs-sports-table-points",
          `${united.points} point${united.points === 1 ? "" : "s"}`,
        ),
      )
      section.appendChild(position)
    }
    const rows = selectTableRows(table, expanded)
    const tableEl = document.createElement("table")
    tableEl.className = "rs-sports-table"
    const head = document.createElement("tr")
    for (const label of ["#", "Club", "P", "Pts"]) {
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
        shortTeamName(entry.team),
        String(entry.played),
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
    // Last five (mockup right panel): W green, D grey, L red.
    // Rendered only when the feed derived real marks; null/empty
    // omits the row — the panel never guesses form.
    if (form !== null && form.length > 0) {
      const formRow = el("p", "rs-sports-form-row")
      formRow.appendChild(el("span", "rs-sports-form-label", "Last five"))
      for (const mark of form) {
        const chip = el(
          "span",
          `rs-sports-form-chip rs-sports-form-chip--${mark.toLowerCase()}`,
          mark,
        )
        chip.setAttribute(
          "aria-label",
          mark === "W" ? "Win" : mark === "D" ? "Draw" : "Loss",
        )
        formRow.appendChild(chip)
      }
      section.appendChild(formRow)
    }
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
        expanded ? "Show fewer teams" : "View full table ›",
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
    // Keys onboarding (0.11.19): the no-key line keeps its honest
    // copy and gains an action — the dialog starts at the
    // football-data.org step and refreshes the feed on save.
    const setup = el("button", "rs-sports-setup-key", "Set up key")
    setup.type = "button"
    setup.setAttribute("data-couch-key", "sports:setup-key:table")
    setup.addEventListener("click", () => {
      callbacks.onSetupFootballDataKey?.()
    })
    section.appendChild(setup)
  } else {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "League table unavailable — the feed couldn't be reached. Next fixtures below still come from the feed.",
      ),
    )
  }
  return section
}

// ── Next Matches (v2 §4.1) ──────────────────────────────────────

/**
 * One feed-driven Next Fixtures card (visual rebuild, fix-3):
 * stadium-photo thumb with a red-to-black fade and a date badge
 * (day + month), then opponent, HOME/AWAY · competition, station
 * line, then the Phase 3 reminder slot (bell, then Watch when the
 * EPG listing exists and is tunable). The slot's children are
 * exactly the bell and optionally Watch — the reminders tests pin
 * that shape. The card keeps its .rs-sports-next-row class,
 * data-feed-fixture-id, .rs-sports-next-when / -opponent /
 * .rs-sports-row-meta / .rs-sports-next-station children.
 *
 * Phase 3 reminder toggle (v2 plan §4.3, D2-A): one focusable
 * bell button lives inside the actions area, BEFORE the Watch
 * button when one exists, with
 * data-couch-key="sports:remind:<feed fixture id>". It reads the
 * `xt_sports_reminders` store at render time and never writes it
 * directly — the click goes through callbacks.onToggleReminder,
 * which toggles, toasts and re-renders. A reminded column shows a
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
  const column = el("div", "rs-sports-next-row")
  column.setAttribute("data-feed-fixture-id", fixture.id)

  // Stadium thumb: bundled ground photo when known (see
  // nextFixtureArt), branded red gradient + crest watermark
  // otherwise. The date badge sits on the thumb, over the fade.
  const art = nextFixtureArt(fixture)
  const thumb = el(
    "div",
    `rs-sports-next-thumb${art ? " rs-sports-next-thumb-has-art" : ""}`,
  )
  thumb.setAttribute("aria-hidden", "true")
  if (art) thumb.style.setProperty("--rs-sports-next-art", `url("${art}")`)
  const badge = formatFixtureDayBadge(fixture.startMs)
  const dateBadge = el("div", "rs-sports-next-date")
  dateBadge.appendChild(el("span", "rs-sports-next-date-day", badge.day))
  dateBadge.appendChild(el("span", "rs-sports-next-date-mon", badge.month))
  thumb.appendChild(dateBadge)
  // Venue label only where the ground is actually known: Old
  // Trafford for home fixtures, Anfield for Liverpool away (plan
  // §2). Other away grounds are omitted, never guessed.
  const venue =
    feedFixtureHomeAway(fixture) === "HOME"
      ? "Old Trafford"
      : /liverpool/i.test(feedFixtureOpponent(fixture))
        ? "Anfield"
        : null
  if (venue) {
    thumb.appendChild(el("span", "rs-sports-next-venue", venue))
  }
  column.appendChild(thumb)

  const body = el("div", "rs-sports-next-body")
  body.appendChild(
    el("div", "rs-sports-next-when", formatFixtureDayTime(fixture.startMs)),
  )
  body.appendChild(
    el("div", "rs-sports-next-opponent", feedFixtureOpponent(fixture)),
  )
  body.appendChild(
    el(
      "div",
      "rs-sports-row-meta",
      `${feedFixtureHomeAway(fixture)} · ${fixture.competition}`,
    ),
  )
  // Station, honestly: the listing's channels when the EPG knows
  // this fixture, else Station TBC (mockup has no station line
  // here, but the hub never hides a TBC behind a missing Watch).
  body.appendChild(
    el(
      "div",
      "rs-sports-next-station",
      row.matched.stationKnown ? row.matched.station : STATION_TBC,
    ),
  )

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
  body.appendChild(actions)
  column.appendChild(body)
  return column
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
  section.appendChild(el("h2", "rs-sports-section-title", "Next fixtures"))
  if (
    (feedResult.status === "ok" || feedResult.status === "stale") &&
    nextMatches.length > 0
  ) {
    const grid = el("div", "rs-sports-next-grid")
    for (const row of nextMatches) {
      grid.appendChild(buildNextMatchRow(row, callbacks, nowMs))
    }
    section.appendChild(grid)
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
    // Keys onboarding (0.11.19): same "Set up key" action as the
    // table's no-key line — dialog starts at football-data.org.
    const setup = el("button", "rs-sports-setup-key", "Set up key")
    setup.type = "button"
    setup.setAttribute("data-couch-key", "sports:setup-key:next")
    setup.addEventListener("click", () => {
      callbacks.onSetupFootballDataKey?.()
    })
    section.appendChild(setup)
  } else {
    section.appendChild(
      el(
        "p",
        "rs-sports-empty-line",
        "Next matches unavailable — the feed couldn't be reached.",
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

// ── Feed hero (mockup top block, 0.11.17) ───────────────────────

/**
 * The mockup hero: crest + UNITED CORNER, NEXT MATCH, the next
 * feed fixture's title and day/time, a Remind me button and the
 * station line ("TV listing to be confirmed" while the EPG has no
 * listing for it). The hero is feed-driven — the next match is
 * known days ahead, long before the ~36h EPG window reaches it —
 * so it renders as soon as the feed lands (bug 2). The Old
 * Trafford dusk photo is the bundled art, via CSS (no enrichment
 * call: the photo is the venue, not programme art). The EPG hero
 * below stays as the fallback when the feed has no next match.
 *
 * DOM order keeps the crest first in .rs-sports-hero-body (the
 * crest test pins it); the grid in sports.astro puts the crest
 * beside the title visually.
 */
function buildFeedHero(
  row: NextMatchRow,
  callbacks: SportsHubCallbacks,
  nowMs: number = Date.now(),
): HTMLElement {
  const fixture = row.matched.fixture
  const hero = el("section", "rs-sports-hero rs-sports-hero-feed")
  hero.setAttribute("data-sports-section", "hero")
  hero.setAttribute("data-feed-fixture-id", fixture.id)
  const body = el("div", "rs-sports-hero-body")
  const crest = el("img", "rs-sports-hero-crest")
  crest.src = MAN_UTD_CREST_SRC
  crest.alt = MAN_UTD_CREST_ALT
  crest.decoding = "async"
  body.appendChild(crest)
  body.appendChild(el("h2", "rs-sports-hero-title", "UNITED CORNER"))
  body.appendChild(el("p", "rs-sports-hero-eyebrow", "Next match"))
  body.appendChild(
    el("p", "rs-sports-hero-match", formatFeedFixtureTitle(fixture)),
  )
  body.appendChild(
    el(
      "p",
      "rs-sports-hero-meta",
      `${formatFeedHeroDateTime(fixture.startMs)}  /  ${fixture.competition}`,
    ),
  )
  const actions = el("div", "rs-sports-hero-actions")
  const reminder = getSportsReminder(fixture.id, nowMs)
  const reminderSet = reminder !== null
  const remind = el(
    "button",
    `rs-sports-remind rs-sports-hero-remind${reminderSet ? " rs-sports-remind-set" : ""}`,
    reminderSet
      ? `🔔 Reminder set · ${reminder.leadMinutes} min before`
      : "🔔 Remind me",
  )
  remind.type = "button"
  remind.setAttribute("data-couch-key", "sports:hero:remind")
  remind.setAttribute("data-feed-fixture-id", fixture.id)
  remind.setAttribute(
    "aria-label",
    reminderSet
      ? `Reminder set for ${formatFeedFixtureTitle(fixture)} — turn off. Reminds you while the app is open.`
      : `Remind me about ${formatFeedFixtureTitle(fixture)}. Reminds you while the app is open.`,
  )
  remind.setAttribute("title", "Reminds you while the app is open")
  remind.addEventListener("click", () => {
    callbacks.onToggleReminder?.(fixture)
  })
  actions.appendChild(remind)
  actions.appendChild(
    el(
      "span",
      "rs-sports-hero-station",
      row.matched.stationKnown
        ? row.matched.station
        : "TV listing to be confirmed",
    ),
  )
  body.appendChild(actions)
  hero.appendChild(body)
  return hero
}

// ── United on TV now (mockup cards, 0.11.17) ────────────────────

/**
 * "United on TV now" — up to three cards, feed-first (0.11.26):
 * each card is a feed fixture that is live or kicking off within
 * the hour, with its station from the EPG (Station TBC when the
 * guide has no listing). The feed is the truth about live: a live
 * feed fixture is LIVE even when the EPG has no listing for it,
 * and an EPG programme on now with no feed fixture behind it
 * (a classic, a replay, a magazine show) is never a card here.
 * A pre-match card's badge comes from the EPG listing (ON NOW
 * when build-up coverage is airing); the Watch pill tunes the
 * EPG listing, so a card with no listing has no pill. When the
 * feed has nothing on now the section renders its honest empty
 * line — never invented cards.
 */
function buildOnTvNowSection(
  rows: NextMatchRow[],
  feedResult: FeedFixturesResult | null,
  ctx: RowContext,
  nowMs: number = Date.now(),
): HTMLElement {
  const section = el("section", "rs-sports-section rs-sports-onnow-section")
  section.setAttribute("data-sports-section", "on-tv-now")
  section.appendChild(el("h2", "rs-sports-section-title", "United on TV now"))
  section.appendChild(
    el(
      "p",
      "rs-sports-section-note",
      "Live now or kicking off within the hour",
    ),
  )
  if (rows.length === 0) {
    const empty =
      feedResult?.status === "no-key"
        ? "United on TV now needs your football-data.org API key — add it in Settings."
        : feedResult?.status === "error"
          ? "Can't tell what's on TV right now — the feed couldn't be reached."
          : "No Manchester United programmes on TV right now — check back closer to matchday."
    section.appendChild(el("p", "rs-sports-empty-line", empty))
    return section
  }
  const grid = el("div", "rs-sports-onnow-grid")
  for (const row of rows.slice(0, 3)) {
    const fixture = row.matched.fixture
    const epgFixture = row.epgFixture
    const live = fixture.startMs <= nowMs
    const card = el("article", "rs-sports-onnow-card")
    card.setAttribute("data-fixture-id", epgFixture?.id ?? fixture.id)
    const thumb = el("div", "rs-sports-onnow-thumb")
    // Badge: the feed is the truth about live — a live feed
    // fixture is LIVE; a pre-match fixture gets the EPG badge
    // (ON NOW when build-up coverage is airing). The badge must
    // NEVER claim LIVE before kick-off: the EPG badge reads the
    // listing on air, so a build-up listing carrying the plain
    // match title would read LIVE while the meta says "Starts in
    // 30 min" — the same LIVE-mislabel the user called out in
    // 0.11.17. A pre-match LIVE is capped to ON NOW.
    const badge = live
      ? "LIVE"
      : epgFixture
        ? (() => {
            const epgBadge = sportsFixtureLiveBadge(epgFixture, nowMs)
            return epgBadge === "LIVE" ? "ON NOW" : epgBadge
          })()
        : null
    if (badge) {
      thumb.appendChild(
        el("span", "rs-sports-badge rs-sports-badge-live", badge),
      )
    }
    if (epgFixture) {
      const watch = el("button", "rs-sports-onnow-watch", "Ⓐ Watch")
      watch.type = "button"
      watch.setAttribute(
        "data-couch-key",
        `sports:onnow:watch:${epgFixture.id}`,
      )
      watch.setAttribute("data-fixture-id", epgFixture.id)
      watch.addEventListener("click", () => {
        ctx.callbacks.onWatch(epgFixture)
      })
      thumb.appendChild(watch)
    }
    card.appendChild(thumb)
    card.appendChild(
      el(
        "div",
        "rs-sports-onnow-title",
        formatFeedFixtureTitle(fixture),
      ),
    )
    // Station is the listing's primary channel (the old card
    // shape) — Station TBC when the guide has no listing for it.
    const station = epgFixture?.channelName ?? STATION_TBC
    const meta = live
      ? epgFixture && epgFixture.stopMs > nowMs
        ? `${station} · ${fixture.competition} · ${Math.max(0, Math.ceil((epgFixture.stopMs - nowMs) / 60_000))} min left`
        : `${station} · ${fixture.competition} · Live now`
      : `${station} · ${fixture.competition} · Starts in ${Math.max(1, Math.ceil((fixture.startMs - nowMs) / 60_000))} min`
    card.appendChild(el("div", "rs-sports-onnow-meta", meta))
    grid.appendChild(card)
  }
  section.appendChild(grid)
  return section
}

/**
 * Card artwork only: one enrichment call per on-now card, backdrop
 * variant — same shape as the fixture-row artwork below. A null
 * URL leaves the branded gradient fallback untouched.
 */
export async function applyOnTvNowArtwork(
  cardElement: HTMLElement,
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
    const thumb = cardElement.querySelector<HTMLElement>(
      ".rs-sports-onnow-thumb",
    )
    if (!thumb || !cardElement.isConnected) return null
    if (cardElement.getAttribute("data-fixture-id") !== fixture.id) {
      return null
    }
    thumb.style.setProperty("--rs-sports-onnow-art", `url("${url}")`)
    thumb.classList.add("rs-sports-onnow-thumb-has-art")
    return url
  } catch {
    return null
  }
}

/**
 * Fixture-card artwork (visual rebuild, fix-3): the same
 * enrichment call as the on-TV-now cards, applied to an EPG
 * fixture row's thumb (`.rs-sports-row-thumb`). A null URL leaves
 * the branded gradient + crest watermark untouched — never a
 * stretched logo, never a broken image.
 */
export async function applyFixtureCardArtwork(
  cardElement: HTMLElement,
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
    const thumb = cardElement.querySelector<HTMLElement>(
      ".rs-sports-row-thumb",
    )
    if (!thumb || !cardElement.isConnected) return null
    if (cardElement.getAttribute("data-fixture-id") !== fixture.id) {
      return null
    }
    thumb.style.setProperty("--rs-sports-row-art", `url("${url}")`)
    thumb.classList.add("rs-sports-row-thumb-has-art")
    return url
  } catch {
    return null
  }
}

// ── Hero ────────────────────────────────────────────────────────

/**
 * The feed-state hero (feed-first, 0.11.26): when the feed has no
 * next match, the hero says so honestly instead of silently
 * substituting an EPG fixture — an EPG listing is a TV programme,
 * never the hub's next match. Same crest-first body and Old
 * Trafford photo as the feed hero (`.rs-sports-hero-feed`), so
 * the corner keeps its identity in every feed state:
 *  - no-key: the key is missing — a Set up key button (the same
 *    `sports:setup-key:hero` hook the Next fixtures section uses)
 *    takes the user to Settings.
 *  - error: the feed could not be reached.
 *  - ok/stale with no rows: the feed has no upcoming United
 *    fixtures right now.
 *  - null (not fetched yet): the feed hero is simply not shown —
 *    the hub renders without a hero rather than a wrong one.
 */
function buildFeedStateHero(
  feedResult: FeedFixturesResult,
  callbacks: SportsHubCallbacks,
): HTMLElement {
  const hero = el("section", "rs-sports-hero rs-sports-hero-feed")
  hero.setAttribute("data-sports-section", "hero")
  const body = el("div", "rs-sports-hero-body")
  const crest = el("img", "rs-sports-hero-crest")
  crest.src = MAN_UTD_CREST_SRC
  crest.alt = MAN_UTD_CREST_ALT
  crest.decoding = "async"
  body.appendChild(crest)
  body.appendChild(el("h2", "rs-sports-hero-title", "UNITED CORNER"))
  body.appendChild(el("p", "rs-sports-hero-eyebrow", "Next match"))
  const message =
    feedResult.status === "no-key"
      ? "Next matches need your football-data.org API key in Settings."
      : feedResult.status === "error"
        ? "Next matches unavailable — the feed couldn't be reached."
        : "No upcoming Manchester United fixtures from the feed right now."
  body.appendChild(el("p", "rs-sports-hero-match", message))
  if (feedResult.status === "no-key") {
    const actions = el("div", "rs-sports-hero-actions")
    const setup = el("button", "rs-sports-setup-key", "Set up key")
    setup.type = "button"
    setup.setAttribute("data-couch-key", "sports:setup-key:hero")
    setup.addEventListener("click", () => {
      callbacks.onSetupFootballDataKey?.()
    })
    actions.appendChild(setup)
    body.appendChild(actions)
  }
  hero.appendChild(body)
  return hero
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
    message: "United fixtures will appear here.",
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
        ? `Fixtures from football-data.org · Guide last updated ${model.lastUpdatedLabel}`
        : "Fixtures from football-data.org"
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
  // Section order (mockup, 0.11.17): top block (League position
  // panel + feed hero / feed-state hero, side by side) → United on
  // TV now → Next fixtures → United on TV soon (EPG) → Possible →
  // Other Squads → Recent. Recent NEVER leads; when the EPG
  // Upcoming is empty the honest empty line names the ~36h guide
  // window and Next fixtures carries "what's coming". The feed
  // hero leads the fixtures: on a Friday afternoon the EPG has no
  // next match and the feed hero is what the user sees. The table
  // and fixtures render as soon as their own (feed) data arrives
  // — they never wait for the guide (bug 2); only the on-TV-now
  // cards and their tune-in need the guide, and they render an
  // honest empty line without it.
  const tableShowsFeedData =
    model.tableResult !== null &&
    (model.tableResult.status === "ok" ||
      model.tableResult.status === "stale")
  const top = el("div", "rs-sports-top")
  if (model.tableResult) {
    top.appendChild(
      buildTableSection(
        model.tableResult,
        model.tableExpanded,
        callbacks,
        model.formResult?.form ?? null,
      ),
    )
  }
  const feedHeroRow = model.nextMatches[0] ?? null
  if (feedHeroRow) {
    top.appendChild(buildFeedHero(feedHeroRow, callbacks, nowMs))
  } else if (model.feedResult) {
    // Feed-first (0.11.26): no feed next match, no hero fixture —
    // the honest feed-state hero, never an EPG listing standing in
    // for the next match. model.hero is the guide view only.
    top.appendChild(buildFeedStateHero(model.feedResult, callbacks))
  }
  if (top.childElementCount > 0) fragment.appendChild(top)
  fragment.appendChild(
    buildOnTvNowSection(model.onTvNow, model.feedResult, ctx, nowMs),
  )
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
  const { possible, otherSquadsUpcoming, otherSquadsRecent, recent } =
    model.split
  // A feed fixture featured in the on-TV-now cards above does NOT
  // repeat in Upcoming — it is featured once. An EPG fixture the
  // feed does NOT back (feed down, or a match the feed cannot see)
  // still renders here with its LIVE badge instead of vanishing:
  // Upcoming is the guide's view, and the feed's Next fixtures
  // above are the upcoming matches.
  const onTvNowFixtureIds = new Set(
    model.onTvNow
      .map((row) => row.epgFixture?.id)
      .filter((id): id is string => id != null),
  )
  const upcoming = model.split.upcoming.filter(
    (fixture) => !onTvNowFixtureIds.has(fixture.id),
  )
  const hasAnyFixture =
    upcoming.length > 0 ||
    model.onTvNow.length > 0 ||
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
    // Bug 2: with feed data but no playlist, the hub still renders
    // — the way in is the same Add-a-playlist link the old
    // no-playlist state showed.
    if (!model.hasPlaylist) {
      const link = el("a", "rs-sports-state-action", "Add a playlist")
      link.setAttribute("href", "/login")
      empty.appendChild(link)
    }
    fragment.appendChild(empty)
  } else {
    const upcomingSection = buildSection(
      "United on TV soon",
      "TV listings from your programme guide — the feed's Next fixtures above are the upcoming matches.",
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
      { ...ctx, showPossibleBadge: true, variant: "possible" },
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
      { ...ctx, variant: "recent" },
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
 * focus first, else the hero Remind button (feed hero), else the
 * first on-TV-now Watch, else the table expand action, else the
 * first Next Fixtures Watch button, before falling back to the
 * follow control. The EPG hero is gone (feed-first, 0.11.26), so
 * there is no hero Watch step any more. The Followed page does not
 * seed nav focus, so the hub sets its own explicitly.
 */
export function focusSportsHubInitial(root: ParentNode): void {
  const restored = restoreListFocus(document, SPORTS_HUB_ROUTE, root)
  if (restored) return
  const heroRemind = root.querySelector<HTMLElement>(
    '[data-couch-key="sports:hero:remind"]',
  )
  if (heroRemind) {
    heroRemind.focus({ preventScroll: true })
    return
  }
  const firstOnNowWatch = root.querySelector<HTMLElement>(
    '[data-couch-key^="sports:onnow:watch:"]',
  )
  if (firstOnNowWatch) {
    firstOnNowWatch.focus({ preventScroll: true })
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
  // so focus the table expand action, else the first Next Fixtures
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
  formResult: FeedFormResult | null
  nextMatches: NextMatchRow[]
  /** Live feed fixtures, matched to EPG listings (feed-first,
   *  0.11.26) — the live half of on-TV-now. Null until fetched. */
  liveResult: FeedFixturesResult | null
  liveMatches: NextMatchRow[]
  tableExpanded: boolean
  feedInFlight: boolean
  /** Wall-clock ms of the last feed fetch — the 60s timer uses it
   *  to tell a kick-off boundary (a next-match row whose kick-off
   *  has passed since the last fetch) from a row that was already
   *  live when fetched. */
  feedFetchedAt: number
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
    timer: null,
    resolved: false,
    playlistAttempted: false,
    tableResult: null,
    feedResult: null,
    formResult: null,
    nextMatches: [],
    liveResult: null,
    liveMatches: [],
    tableExpanded: false,
    feedInFlight: false,
    feedFetchedAt: 0,
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
      formResult: runtime.formResult,
      nextMatches: runtime.nextMatches,
      liveMatches: runtime.liveMatches,
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
    // Keys onboarding (0.11.19): the no-key "Set up key" buttons
    // open the dialog at the football-data.org step; a completed
    // save refetches the feed so the table + fixtures appear without
    // a page reload. A skip leaves the honest no-key copy in place.
    activeCallbacks.onSetupFootballDataKey = async () => {
      const result = await maybeOpenKeysOnboarding("football-data")
      if (result?.outcome === "completed") await refreshFeed()
    }
    renderSportsHub(root!, model, activeCallbacks)
    // On-TV-now card artwork: one enrichment call per card, only
    // for cards that have not had art applied yet. A card whose
    // data-fixture-id is a feed fixture id (live, no EPG listing)
    // finds no EPG fixture and keeps its branded gradient — art
    // is decoration, never data.
    for (const card of shell!.querySelectorAll<HTMLElement>(
      ".rs-sports-onnow-card:not([data-art-applied])",
    )) {
      const fixtureId = card.getAttribute("data-fixture-id")
      const fixture = currentFixtures().find(
        (candidate) => candidate.id === fixtureId,
      )
      if (!fixture) continue
      card.setAttribute("data-art-applied", "1")
      void applyOnTvNowArtwork(card, fixture)
    }
    // Fixture-row card artwork (visual rebuild, fix-3): same
    // one-call-per-card shape, for the Upcoming / Possible /
    // Other Squads / Recent card thumbs.
    for (const card of shell!.querySelectorAll<HTMLElement>(
      ".rs-sports-row:not([data-art-applied])",
    )) {
      const fixtureId = card.getAttribute("data-fixture-id")
      const fixture = currentFixtures().find(
        (candidate) => candidate.id === fixtureId,
      )
      if (!fixture) continue
      card.setAttribute("data-art-applied", "1")
      void applyFixtureCardArtwork(card, fixture)
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
   * Feed refresh (v2 Phase 2, feed-first 0.11.26): table + next 5
   * fixtures + last-five form through the Phase 1 client (1h
   * cache, so repeat calls are cheap), plus the live fixtures
   * (5-min cache) that drive on-TV-now. A no-key/error result
   * still lands in the runtime — the table and Next Matches
   * sections render their honest failure copy from it. Never
   * throws: the client returns typed results.
   */
  async function refreshFeed(): Promise<void> {
    if (!mounted || runtime.feedInFlight) return
    runtime.feedInFlight = true
    try {
      const [tableResult, feedResult, formResult, liveResult] =
        await Promise.all([
          getLeagueTable(),
          getNextFixtures(5),
          getRecentForm(5),
          getLiveFixtures(),
        ])
      if (!mounted) return
      runtime.tableResult = tableResult
      runtime.feedResult = feedResult
      runtime.formResult = formResult
      runtime.liveResult = liveResult
      runtime.feedFetchedAt = Date.now()
      runtime.nextMatches = buildNextMatchRows(
        feedResult.fixtures ?? [],
        currentFixtures(),
      )
      runtime.liveMatches = buildNextMatchRows(
        liveResult.fixtures ?? [],
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
    // fixture that was Station TBC — re-match BOTH the next and
    // the live fixtures from the cached feed results (no refetch
    // inside the TTLs).
    if (runtime.feedResult?.fixtures) {
      runtime.nextMatches = buildNextMatchRows(
        runtime.feedResult.fixtures,
        currentFixtures(),
      )
    }
    if (runtime.liveResult?.fixtures) {
      runtime.liveMatches = buildNextMatchRows(
        runtime.liveResult.fixtures,
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
    // Feed-first (0.11.26): a kick-off boundary is a feed event,
    // not an EPG state change — when a next-match row kicked off
    // since the last fetch, or a live row ended, the feed slices
    // are stale (the kicked-off fixture leaves getNextFixtures,
    // the ended fixture leaves getLiveFixtures) and only a
    // refresh re-derives them. refreshFeed is guarded by
    // feedInFlight, so a slow fetch never stacks.
    const kickoffCrossed = runtime.nextMatches.some(
      (row) =>
        row.matched.fixture.startMs <= nowMs &&
        row.matched.fixture.startMs > runtime.feedFetchedAt,
    )
    const liveEnded = runtime.liveMatches.some((row) => {
      const endMs = row.epgFixture
        ? row.epgFixture.stopMs
        : row.matched.fixture.startMs +
          FOOTBALL_DATA_LIVE_FIXTURE_MAX_AGE_MS
      return endMs <= nowMs
    })
    if (kickoffCrossed || liveEnded) void refreshFeed()
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
