// Sports Corner v2 — Phase 2 hub helpers (pure; plan §4.1 + §4.2).
//
// Table + Next Matches presentation logic for the hub and the
// Followed entry card. No DOM, no fetch, no storage — the feed
// client (football-data.ts) owns fetching/caching, and the page
// modules own rendering. Every value here traces to the feed or the
// EPG; nothing is invented.
//
// Team logos/crests are NEVER rendered from the feed (provider
// terms §9.2) — the parsers already drop them, and nothing in this
// module carries one. Short display names below are plain text.

import {
  normaliseTeamName,
  type FeedFixture,
  type FeedFixturesResult,
  type LeagueTable,
  type LeagueTableEntry,
  type LeagueTableResult,
} from "./football-data.ts"

/** "18th · 8 pts" — the entry-card table line (plan §4.2). */
export function ordinal(position: number): string {
  const mod100 = position % 100
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`
  switch (position % 10) {
    case 1:
      return `${position}st`
    case 2:
      return `${position}nd`
    case 3:
      return `${position}rd`
    default:
      return `${position}th`
  }
}

/** The Manchester United row of a league table, or null. */
export function findUnitedTableEntry(
  table: LeagueTable,
): LeagueTableEntry | null {
  return (
    table.entries.find(
      (entry) => normaliseTeamName(entry.team) === "manchester united",
    ) ?? null
  )
}

/**
 * Mini-table rows (default): United + 3 above + 3 below, by
 * position. `expanded` returns the full table, position-sorted.
 * When United has no row (defensive — the feed always carries one),
 * the full table is returned so the section never renders empty.
 */
export function selectTableRows(
  table: LeagueTable,
  expanded: boolean,
): LeagueTableEntry[] {
  const sorted = [...table.entries].sort((a, b) => a.position - b.position)
  if (expanded) return sorted
  const united = findUnitedTableEntry(table)
  if (!united) return sorted
  return sorted.filter(
    (entry) =>
      entry.position >= united.position - 3 &&
      entry.position <= united.position + 3,
  )
}

/** "Table as of 16 Nov 2026" — from the table's fetch timestamp. */
export function formatTableAsOf(table: LeagueTable): string | null {
  const ms = Date.parse(table.asOf)
  if (!Number.isFinite(ms)) return null
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Dublin",
  }).format(new Date(ms))
  return `Table as of ${date}`
}

/** "18th · 8 pts" — position + points for the entry card. */
export function formatPositionPoints(entry: LeagueTableEntry): string {
  return `${ordinal(entry.position)} · ${entry.points} pts`
}

/**
 * Short display names for feed team names ("Manchester United FC"
 * → "Man Utd", "Sporting Clube de Portugal" → "Sporting CP").
 * Keyed on the normalised name; anything unknown keeps its written
 * name minus a trailing FC/AFC — never a guessed nickname.
 */
const SHORT_TEAM_NAMES: Record<string, string> = {
  "manchester united": "Man Utd",
  "sporting cp": "Sporting CP",
  liverpool: "Liverpool",
  brentford: "Brentford",
  "newcastle united": "Newcastle",
  "coventry city": "Coventry",
}

export function shortTeamName(name: string): string {
  const key = normaliseTeamName(name)
  if (SHORT_TEAM_NAMES[key]) return SHORT_TEAM_NAMES[key]
  return (name || "").trim().replace(/\s+(fc|afc)$/i, "")
}

/** "Liverpool v Man Utd" — home v away, short names. */
export function formatFeedFixtureTitle(fixture: FeedFixture): string {
  return `${shortTeamName(fixture.home)} v ${shortTeamName(fixture.away)}`
}

/**
 * "Sun 22 Nov 16:30" — Europe/Dublin, 24-hour clock. The feed
 * carries absolute UTC times, so the zone is fixed here (not the
 * viewer's locale default) and the output is deterministic.
 */
export function formatFeedFixtureDateTime(startMs: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Dublin",
  }).formatToParts(new Date(startMs))
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`
}

// ── EPG ↔ feed kick-off matching: the pre-match window (bug 4b, 2026-11-21) ──

/**
 * How early an EPG listing may start and still be the broadcast of
 * a feed fixture: 60 minutes before kick-off.
 *
 * Why 60: UK pre-match build-up slots run 30–60 minutes (Sky
 * Sports' standard build-up is 30 minutes, Super Sunday / big
 * matches run a full hour; TNT Sports is the same shape), so 60
 * covers the longest standard build-up. A listing starting more
 * than an hour before kick-off is a different programme — an
 * earlier match, a magazine show, the news — and matching it would
 * tune the user into the wrong programme. A listing starting after
 * kick-off never matches here: the broadcast has already begun
 * elsewhere, and the exact-minute rule never matched those either.
 *
 * This is the shared rule for the two call sites that still match
 * on the exact kick-off minute — matchFixtureStation() in
 * football-data.ts (station) and buildNextMatchRows() in
 * sports-reminder-fire.ts (Watch target) — which must both use it
 * so station and Watch can never disagree about which listing a
 * match belongs to. (Neither file is owned by this change; the
 * helper + tests land here so the swap is a one-line call each.)
 */
export const SPORTS_PREMATCH_WINDOW_MS = 60 * 60_000

/** True when an EPG listing starting at `listingStartMs` is the
 *  broadcast of a fixture kicking off at `kickoffMs`: it starts at
 *  kick-off, or up to SPORTS_PREMATCH_WINDOW_MS before it. */
export function epgListingMatchesKickoff(
  listingStartMs: number,
  kickoffMs: number,
): boolean {
  if (!Number.isFinite(listingStartMs) || !Number.isFinite(kickoffMs)) {
    return false
  }
  const leadMs = kickoffMs - listingStartMs
  return leadMs >= 0 && leadMs <= SPORTS_PREMATCH_WINDOW_MS
}

// ── Entry-card feed data (plan §4.2) ────────────────────────────

export interface SportsEntryCardFeed {
  /** "18th · 8 pts", or null when the table is unavailable. */
  tableLine: string | null
  /** Next upcoming feed fixture, or null when the feed has none. */
  nextFeedFixture: FeedFixture | null
}

/**
 * Reduce the two feed results to what the entry card shows. Only
 * ok/stale results with data contribute — a no-key/error result
 * yields nulls, never invented lines, and the card falls back to
 * its EPG-only copy.
 */
export function buildSportsEntryCardFeed(
  tableResult: LeagueTableResult | null,
  fixturesResult: FeedFixturesResult | null,
  nowMs: number,
): SportsEntryCardFeed {
  let tableLine: string | null = null
  if (
    tableResult?.table &&
    (tableResult.status === "ok" || tableResult.status === "stale")
  ) {
    const united = findUnitedTableEntry(tableResult.table)
    if (united) tableLine = formatPositionPoints(united)
  }
  let nextFeedFixture: FeedFixture | null = null
  if (
    fixturesResult?.fixtures &&
    (fixturesResult.status === "ok" || fixturesResult.status === "stale")
  ) {
    nextFeedFixture =
      fixturesResult.fixtures.find((fixture) => fixture.startMs > nowMs) ??
      null
  }
  return { tableLine, nextFeedFixture }
}
