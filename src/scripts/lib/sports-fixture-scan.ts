// Sports Corner — EPG fixture scan (0.11.13, plan §4 + §8).
//
// Pure scan: given the cached channel list and the already-loaded EPG
// state, find every Manchester United fixture in the guide window and
// group simulcasts into one row per fixture. Fixtures are DERIVED,
// never persisted — every render recomputes from the current EPG
// state, so a stale, moved or cancelled listing is never shown as
// fact (plan §3.1).
//
// PERFORMANCE (plan §8): the scan runs the Guide's own batch loader,
// which resolves every channel through ONE pre-built name index with
// per-channel isolation. It must never resolve channels one by one
// through a per-channel index rebuild — that is the exact call shape
// that froze the Guide for ~6.5s at 15,319 channels before 0.11.11,
// and a scan that reintroduced it would freeze the Followed page.
// Test T14 asserts the batch loader is the only resolution path used
// here. A cheap substring pre-filter runs before the classifier, so
// only titles that could possibly be United fixtures pay for
// classification.

import {
  classifySportsProgramme,
  hasSportsChannelSupport,
  normaliseSideForAlias,
  teamAliasSportForSide,
  type SportsClassification,
} from "./livetv-sports-classifier.ts"
import {
  loadGuideProgrammes,
  type GuideChannelLike,
  type GuideEpgStateLike,
} from "./livetv-guide-data.ts"
import type { GuideProgramme } from "./livetv-guide.ts"
import {
  catchupActionForProgramme,
  type CatchupAction,
} from "./couch-livetv-epg.ts"
import type { CatchupCapableChannel } from "./catchup.ts"

export type FixtureTier = "confirmed" | "possible"
export type FixtureState = "upcoming" | "now" | "past"

/**
 * Squad split (user decision Q4, refined 2026-11-13): the main hub
 * list is the men's first team; women's / youth / academy fixtures
 * live in their own section. Detection is a matcher-owned marker
 * test over the fixture sides + title (§4.7 refinement); titles
 * stay verbatim either way, so a mis-routed row is visible in the
 * other section, never hidden.
 */
export type FixtureSquad = "first-team" | "other-squad"

export interface SportsFixture {
  /** Stable identity: primary channel + start + normalised title.
   *  Used for focus-memory keys and render diffing. Never shown. */
  id: string
  /** EPG title, verbatim. Never rewritten, never expanded. */
  title: string
  /** Fixture sides exactly as written in the title (classifier output). */
  teams: [string, string]
  /** Competition only when the classifier matched an indicator in
   *  the title. Absent far more often than present. */
  competition?: string
  /** Display-shifted start/stop (GuideProgramme clock — the clock the UI shows). */
  startMs: number
  stopMs: number
  /** Raw XMLTV start/stop (pre-tvg-shift) for catch-up deep links. */
  rawStartMs?: number
  rawStopMs?: number
  /** Programme description, verbatim, when the EPG carries one. Display only. */
  desc?: string
  /** The channel this listing belongs to (the scan iterates channels). */
  channelId: string | number
  channelName: string
  channelLogo?: string | null
  /** Provider category, verbatim, for display context only. */
  channelCategory?: string
  /** Simulcast grouping: other channels carrying the same fixture at
   *  the same start time. Empty when the fixture airs on one station. */
  alsoOn: Array<{ channelId: string | number; channelName: string }>
  tier: FixtureTier
  squad: FixtureSquad
  /** Catch-up action at scan time. The render layer re-derives it
   *  with the current clock via fixtureCatchupAction() so a row
   *  flips restart → replay as time passes without a re-scan. */
  catchupAction: CatchupAction
  /** The primary channel's catch-up capability, for render-time
   *  catch-up re-derivation. Provider data, carried verbatim. */
  channelCatchup: CatchupCapableChannel
}

export interface SportsScanResult {
  fixtures: SportsFixture[]
  scannedAt: string
  epgFetchedAt: number | null
  playlistId: string
  mappedChannelCount: number
  channelCount: number
}

/** Channel shape the scan needs: the loader's minimal shape plus the
 *  catch-up capability fields the cached rows already carry. */
export interface SportsScanChannel extends GuideChannelLike {
  tvArchive?: number
  tvArchiveDuration?: number
  catchup?: string | null
  catchupDays?: number | null
  catchupSource?: string | null
  url?: string
}

// ── United alias set (plan §4.2) ────────────────────────────────
// Matched AFTER classifier normalisation (lowercase, punctuation to
// spaces, trailing fc/afc/cf, age-group and `women` suffixes
// stripped). Bare "united" is deliberately NOT in this set.

const UNITED_ALIASES: ReadonlySet<string> = new Set([
  "manchester united",
  "man utd",
  "manchester utd",
  "man united",
  "manu",
  "mufc",
])

// ── Corroboration data (plan §4.4) ──────────────────────────────

/** Competitions Manchester United plays in, as the classifier names
 *  them. Only a matched indicator counts — never an inference. */
const UNITED_COMPETITIONS: ReadonlySet<string> = new Set([
  "Premier League",
  "FA Cup",
  "League Cup",
  "Carabao Cup",
  "Champions League",
  "Europa League",
  "Conference League",
])

/**
 * Premier League 2025–26 clubs, normalised keys (the same 20 clubs
 * the 0.11.12 artwork manifest covers — data the app already ships).
 * Used ONLY for the ambiguous-side corroboration rule: the other
 * side naming a known club is evidence the bare "United" is a
 * football fixture worth flagging, never proof of which United.
 */
const PREMIER_LEAGUE_CLUBS: ReadonlySet<string> = new Set([
  "arsenal",
  "aston villa",
  "bournemouth",
  "brentford",
  "brighton",
  "brighton and hove albion",
  "burnley",
  "chelsea",
  "crystal palace",
  "everton",
  "fulham",
  "leeds",
  "leeds united",
  "liverpool",
  "manchester city",
  "man city",
  "newcastle",
  "newcastle united",
  "nottingham forest",
  "sunderland",
  "tottenham",
  "tottenham hotspur",
  "west ham",
  "west ham united",
  "wolverhampton wanderers",
  "wolves",
])

// ── Squad markers (Q4 refinement) ───────────────────────────────
// A fixture is an "other squad" fixture when either side — or the
// title segment the fixture carries — names a squad. Word-boundary
// matching keeps "youth" out of "youthful" and "u21" out of
// longer tokens; the check runs on the raw written text, BEFORE
// the alias normaliser strips these same suffixes.

const SQUAD_MARKER_PATTERN =
  /\b(women'?s?|woman|ladies|wsl|u\d{2}s?|academy|youth|reserves?)\b/i

function detectSquad(teams: [string, string], title: string): FixtureSquad {
  if (
    SQUAD_MARKER_PATTERN.test(teams[0]) ||
    SQUAD_MARKER_PATTERN.test(teams[1]) ||
    SQUAD_MARKER_PATTERN.test(title)
  ) {
    return "other-squad"
  }
  return "first-team"
}

// ── Pre-filter (plan §4.3 step 1) ───────────────────────────────
// Substring tests only — no regex, no allocation beyond the
// lowercased title. Deliberately BROAD: a false positive costs one
// classifier call, a false negative would hide a real fixture. The
// alias set (§4.2) is the precise gate; this only skips titles that
// cannot possibly be United fixtures.

const FIXTURE_SEPARATORS = [" v ", " vs ", " v. ", " vs. ", " versus ", " @ "]
const UNITED_INDICATORS = ["united", "utd", "manu", "mufc"]

function passesPrefilter(lowerTitle: string): boolean {
  let hasSeparator = false
  for (const separator of FIXTURE_SEPARATORS) {
    if (lowerTitle.includes(separator)) {
      hasSeparator = true
      break
    }
  }
  if (!hasSeparator) return false
  for (const indicator of UNITED_INDICATORS) {
    if (lowerTitle.includes(indicator)) return true
  }
  return false
}

// ── Match algorithm (plan §4.3) ─────────────────────────────────

export interface UnitedMatch {
  tier: FixtureTier
  squad: FixtureSquad
  classification: SportsClassification
}

/**
 * Squad suffixes the classifier's alias normaliser does not strip.
 * The matcher strips them for the ALIAS CHECK ONLY (the classifier
 * itself is untouched): "Man Utd Academy" is the academy side of
 * Manchester United, and the squad split (§4.7) routes it to Other
 * Squads — but only if the alias check recognises the club first.
 * Trailing-only, word-based: "Academy" inside a longer name is
 * never stripped.
 */
function normaliseSideForUnited(side: string): string {
  return normaliseSideForAlias(side).replace(
    /\s+(academy|youth|reserves?|ladies)$/,
    "",
  )
}

/**
 * The classifier's "Super League" alias is the rugby competition,
 * so a Women's Super League title ("Man Utd v Chelsea: Women's
 * Super League") classifies as rugby. The WSL is unambiguously
 * women's football: when the title itself names it, the sport
 * guard reads football. Narrow on purpose — only the WSL marker,
 * never a general rugby override.
 */
const WOMENS_FOOTBALL_PATTERN = /\bwsl\b|women'?s?\s+super\s+league/i

function sportForGuard(
  classification: SportsClassification,
  rawTitle: string,
): SportsClassification["sport"] {
  if (
    classification.sport === "rugby" &&
    WOMENS_FOOTBALL_PATTERN.test(rawTitle)
  ) {
    return "football"
  }
  return classification.sport
}

function isKnownFootballClub(normalisedSide: string): boolean {
  if (PREMIER_LEAGUE_CLUBS.has(normalisedSide)) return true
  return teamAliasSportForSide(normalisedSide) === "football"
}

/**
 * Apply the corroboration rule for a bare-"United" side (plan §4.4).
 * ALL must hold: the other side is a known football club, AND either
 * a United competition indicator matched or the channel/category
 * carries sports evidence. Otherwise the title is excluded — an
 * uncorroborated bare "United" could be any United club.
 */
function isCorroboratedAmbiguous(
  otherSideNormalised: string,
  classification: SportsClassification,
  channelName: string,
  category: string,
): boolean {
  if (!isKnownFootballClub(otherSideNormalised)) return false
  if (
    classification.competition != null &&
    UNITED_COMPETITIONS.has(classification.competition)
  ) {
    return true
  }
  return hasSportsChannelSupport({ channelName, category })
}

/**
 * Classify a title for matching, handling the leading-prefix form
 * (plan Appendix B: "Premier League: Man Utd v Chelsea"). The
 * classifier parses side A verbatim, so a leading "Competition: "
 * segment poisons the first side. The matcher retries on the text
 * after each leading colon segment (bounded: 3 attempts) and keeps
 * the competition from the FULL-title classification — the
 * indicator genuinely matched in the title — while the fixture
 * sides come from the retry that parsed cleanly. The displayed
 * title is always the verbatim EPG title; only matching sees the
 * stripped form. The WSL collision (§4.3 note) also drops a
 * "Super League" competition inherited from the full title: the
 * rugby competition name must never label a women's fixture.
 */
function classifyForMatch(
  rawTitle: string,
  channelName: string,
  category: string,
): SportsClassification {
  const full = classifySportsProgramme(rawTitle, { channelName, category })
  const sidesOf = (classification: SportsClassification) =>
    (classification.teams ?? []).map((side) => normaliseSideForUnited(side))
  const hasUnitedSide = (classification: SportsClassification) =>
    sidesOf(classification).some(
      (side) => UNITED_ALIASES.has(side) || side === "united",
    )
  if (full.kind === "fixture" && hasUnitedSide(full)) return full
  let candidate = rawTitle
  for (let attempt = 0; attempt < 3; attempt++) {
    const colon = candidate.indexOf(":")
    if (colon < 0) break
    candidate = candidate.slice(colon + 1).trim()
    if (!candidate || candidate === rawTitle) break
    const stripped = classifySportsProgramme(candidate, {
      channelName,
      category,
    })
    if (stripped.kind === "fixture" && hasUnitedSide(stripped)) {
      let competition = full.competition ?? stripped.competition
      if (
        competition === "Super League" &&
        WOMENS_FOOTBALL_PATTERN.test(rawTitle)
      ) {
        competition = stripped.competition
      }
      return { ...stripped, competition }
    }
  }
  return full
}

/**
 * Match one programme title against Manchester United. Returns the
 * tier + squad + classification, or null when the title is not a
 * United fixture. Title-only matching (the classifier never reads
 * `desc`); channel/category are supporting evidence only and can
 * never create a match on their own.
 */
export function matchUnitedFixture(
  title: string,
  channelName: string,
  category: string,
): UnitedMatch | null {
  const rawTitle = (title || "").trim()
  if (!rawTitle) return null
  // Step 1: cheap pre-filter.
  if (!passesPrefilter(rawTitle.toLowerCase())) return null
  // Step 2: classify (prefix-tolerant, see classifyForMatch).
  const rawClassification = classifyForMatch(rawTitle, channelName, category)
  // The WSL collision can also arrive on the direct path: drop a
  // rugby "Super League" competition from a women's title, whatever
  // path classified it. The verbatim title still names the league.
  const classification =
    rawClassification.competition === "Super League" &&
    WOMENS_FOOTBALL_PATTERN.test(rawTitle)
      ? { ...rawClassification, competition: undefined }
      : rawClassification
  // Step 3: kind gate — fixture rows only.
  if (classification.kind !== "fixture" || !classification.teams) return null
  // Step 4: sport guard — football or unknown; any other sport excludes.
  const sport = sportForGuard(classification, rawTitle)
  if (sport !== null && sport !== "football") return null
  // Step 5: side match against the alias set.
  const sides = classification.teams.map((side) =>
    normaliseSideForUnited(side),
  ) as [string, string]
  const squad = detectSquad(classification.teams, rawTitle)
  if (UNITED_ALIASES.has(sides[0]) || UNITED_ALIASES.has(sides[1])) {
    return { tier: "confirmed", squad, classification }
  }
  // Step 6: ambiguous bare-"United" side → corroboration rule.
  const ambiguousIndex = sides[0] === "united" ? 0 : sides[1] === "united" ? 1 : -1
  if (ambiguousIndex === -1) return null
  const otherSide = sides[1 - ambiguousIndex] as string
  if (
    isCorroboratedAmbiguous(otherSide, classification, channelName, category)
  ) {
    return { tier: "possible", squad, classification }
  }
  return null
}

// ── Scan ────────────────────────────────────────────────────────

/**
 * The EPG revision time, when the state carries one. The loader
 * type does not declare `fetchedAt` (it is a runtime field of the
 * real store), so the read goes through `unknown` and validates.
 */
function epgFetchedAtOf(
  state: GuideEpgStateLike | null | undefined,
): number | null {
  if (state == null) return null
  const fetchedAt = (state as unknown as { fetchedAt?: unknown }).fetchedAt
  return typeof fetchedAt === "number" ? fetchedAt : null
}

function normaliseTitleForId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function channelDisplayName(channel: SportsScanChannel): string {
  const name = channel.displayName || channel.name || ""
  return typeof name === "string" ? name : String(name ?? "")
}

function channelLogoOf(channel: SportsScanChannel): string | null {
  if (channel.logo == null) return null
  const logo = String(channel.logo)
  return logo ? logo : null
}

function channelCategoryOf(channel: SportsScanChannel): string {
  if (typeof channel.category === "string") return channel.category
  return ""
}

function catchupSliceOf(channel: SportsScanChannel): CatchupCapableChannel {
  return {
    tvArchive: channel.tvArchive,
    tvArchiveDuration: channel.tvArchiveDuration,
    catchup: channel.catchup,
    catchupDays: channel.catchupDays,
    catchupSource: channel.catchupSource,
    url: channel.url,
  }
}

/**
 * Group key for one listing: normalised sides (order-insensitive),
 * exact start, squad. United-alias sides canonicalise to one key so
 * the same broadcast listed as "Man Utd v …" on one channel and
 * "Manchester United v …" on another groups into one row. A bare
 * "united" side does NOT canonicalise — an ambiguous listing never
 * merges into a confirmed row; it stays flagged in its own group.
 */
function groupKeyFor(
  teams: [string, string],
  startMs: number,
  squad: FixtureSquad,
): string {
  const sides = teams
    .map((side) => {
      const normalised = normaliseSideForUnited(side)
      return UNITED_ALIASES.has(normalised)
        ? "manchester united"
        : normalised
    })
    .sort()
    .join(" / ")
  return `${sides}|${startMs}|${squad}`
}

function buildFixture(
  programme: GuideProgramme,
  channel: SportsScanChannel,
  match: UnitedMatch,
  nowMs: number,
): SportsFixture {
  const channelName = channelDisplayName(channel)
  const channelCatchup = catchupSliceOf(channel)
  // Catch-up gating uses the RAW (pre-tvg-shift) times, exactly as
  // the Guide's own replay path does.
  const catchupStartMs = programme.rawStartMs ?? programme.startMs
  const catchupStopMs = programme.rawStopMs ?? programme.stopMs
  return {
    id: `${String(channel.id)}:${programme.startMs}:${normaliseTitleForId(programme.title)}`,
    title: programme.title,
    teams: match.classification.teams as [string, string],
    competition: match.classification.competition,
    startMs: programme.startMs,
    stopMs: programme.stopMs,
    rawStartMs: programme.rawStartMs,
    rawStopMs: programme.rawStopMs,
    desc: programme.desc,
    channelId: channel.id,
    channelName,
    channelLogo: channelLogoOf(channel),
    channelCategory: channelCategoryOf(channel),
    alsoOn: [],
    tier: match.tier,
    squad: match.squad,
    catchupAction: catchupActionForProgramme({
      channel: channelCatchup,
      startMs: catchupStartMs,
      stopMs: catchupStopMs,
      nowMs,
    }),
    channelCatchup,
  }
}

/**
 * Re-derive a fixture's catch-up action at the current clock (the
 * render layer calls this on its minute timer so rows flip
 * restart → replay without a re-scan). Same gating, same raw
 * times, fresh `nowMs`.
 */
export function fixtureCatchupAction(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): CatchupAction {
  return catchupActionForProgramme({
    channel: fixture.channelCatchup,
    startMs: fixture.rawStartMs ?? fixture.startMs,
    stopMs: fixture.rawStopMs ?? fixture.stopMs,
    nowMs,
  })
}

// ── Section split + hero selection (plan §5.2) ───────────────────

export interface SplitSportsFixtures {
  /** Confirmed first-team fixtures live now or upcoming, earliest first. */
  upcoming: SportsFixture[]
  /** Possible-tier fixtures live now or upcoming, earliest first.
   *  Possible-tier PAST fixtures appear in no section (§5.2.5). */
  possible: SportsFixture[]
  /** Confirmed other-squad fixtures live now or upcoming, earliest first. */
  otherSquadsUpcoming: SportsFixture[]
  /** Confirmed other-squad fixtures already ended, newest first. */
  otherSquadsRecent: SportsFixture[]
  /** Confirmed first-team fixtures already ended, newest first. */
  recent: SportsFixture[]
}

function fixtureStateOf(
  fixture: SportsFixture,
  nowMs: number,
): FixtureState {
  if (fixture.stopMs <= nowMs) return "past"
  if (fixture.startMs <= nowMs) return "now"
  return "upcoming"
}

/** Row state at the current clock (same rule as programmeState). */
export function sportsFixtureState(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): FixtureState {
  return fixtureStateOf(fixture, nowMs)
}

/**
 * Split fixtures into the hub's sections. The hero fixture ALSO
 * appears in `upcoming` — the hero is a featured presentation, not
 * a replacement, so the list stays the complete record.
 */
export function splitSportsFixtures(
  fixtures: ReadonlyArray<SportsFixture>,
  nowMs: number = Date.now(),
): SplitSportsFixtures {
  const upcoming: SportsFixture[] = []
  const possible: SportsFixture[] = []
  const otherSquadsUpcoming: SportsFixture[] = []
  const otherSquadsRecent: SportsFixture[] = []
  const recent: SportsFixture[] = []
  for (const fixture of fixtures) {
    const state = fixtureStateOf(fixture, nowMs)
    if (fixture.tier === "possible") {
      // Possible fixtures matter for upcoming tune-in, not history.
      if (state !== "past") possible.push(fixture)
      continue
    }
    if (fixture.squad === "other-squad") {
      if (state === "past") otherSquadsRecent.push(fixture)
      else otherSquadsUpcoming.push(fixture)
      continue
    }
    if (state === "past") recent.push(fixture)
    else upcoming.push(fixture)
  }
  const byStartAsc = (a: SportsFixture, b: SportsFixture) =>
    a.startMs - b.startMs || a.title.localeCompare(b.title)
  const byStartDesc = (a: SportsFixture, b: SportsFixture) =>
    b.startMs - a.startMs || a.title.localeCompare(b.title)
  upcoming.sort(byStartAsc)
  possible.sort(byStartAsc)
  otherSquadsUpcoming.sort(byStartAsc)
  otherSquadsRecent.sort(byStartDesc)
  recent.sort(byStartDesc)
  return { upcoming, possible, otherSquadsUpcoming, otherSquadsRecent, recent }
}

/**
 * The next-match hero fixture: the earliest CONFIRMED first-team
 * fixture live now or upcoming. A live fixture beats an upcoming
 * one — the live match is what the user wants to watch. Possible
 * fixtures and other-squad fixtures NEVER feed the hero.
 */
export function selectNextFixture(
  fixtures: ReadonlyArray<SportsFixture>,
  nowMs: number = Date.now(),
): SportsFixture | null {
  let best: SportsFixture | null = null
  for (const fixture of fixtures) {
    if (fixture.tier !== "confirmed" || fixture.squad !== "first-team") {
      continue
    }
    const state = fixtureStateOf(fixture, nowMs)
    if (state === "past") continue
    if (best === null) {
      best = fixture
      continue
    }
    const bestState = fixtureStateOf(best, nowMs)
    // Live beats upcoming regardless of start order; otherwise earliest wins.
    if (state === "now" && bestState !== "now") best = fixture
    else if (state === bestState && fixture.startMs < best.startMs) {
      best = fixture
    }
  }
  return best
}

/**
 * Scan the EPG state for United fixtures. Single pass over the
 * batch loader's output; simulcasts group by (canonicalised sides,
 * exact start, squad). The first listing in catalogue order is the
 * row's primary station; the rest fold into "Also on".
 */
export function scanSportsFixtures(
  channels: ReadonlyArray<SportsScanChannel>,
  state: GuideEpgStateLike | null | undefined,
  overrides: Record<string, string> | null | undefined,
  playlistId: string,
  nowMs: number = Date.now(),
): SportsScanResult {
  const epgFetchedAt = epgFetchedAtOf(state)
  const loaded = loadGuideProgrammes(channels, state, overrides)
  const byId = new Map<string, SportsScanChannel>()
  for (const channel of channels) byId.set(String(channel.id), channel)

  const groups = new Map<string, SportsFixture>()
  for (const [channelId, programmes] of loaded.programmesByChannel) {
    const channel = byId.get(channelId)
    if (!channel) continue
    const channelName = channelDisplayName(channel)
    const category = channelCategoryOf(channel)
    for (const programme of programmes) {
      const match = matchUnitedFixture(programme.title, channelName, category)
      if (!match) continue
      const fixture = buildFixture(programme, channel, match, nowMs)
      const key = groupKeyFor(
        match.classification.teams as [string, string],
        programme.startMs,
        match.squad,
      )
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, fixture)
        continue
      }
      existing.alsoOn.push({
        channelId: fixture.channelId,
        channelName: fixture.channelName,
      })
    }
  }

  const fixtures = [...groups.values()].sort(
    (a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title),
  )
  return {
    fixtures,
    scannedAt: new Date(nowMs).toISOString(),
    epgFetchedAt,
    playlistId,
    mappedChannelCount: loaded.mappedChannelCount,
    channelCount: channels.length,
  }
}

// ── Memoised entry point (plan §8.3) ────────────────────────────
// Single-entry cache keyed by (playlistId, epgFetchedAt). The
// Followed entry card and the hub share the result within one page
// load; a fresh EPG revision invalidates. The scan is
// follow-independent — follow state gates whether the result is
// SHOWN, so re-follow is instant without a re-scan.

let cachedKey: string | null = null
let cachedResult: SportsScanResult | null = null
let scanRunCount = 0

/** Number of real scans run (tests assert memoisation through this). */
export function getSportsScanRunCount(): number {
  return scanRunCount
}

/** Drop the cached scan (tests / explicit invalidation). */
export function resetSportsScanCache(): void {
  cachedKey = null
  cachedResult = null
}

export function getSportsScan(
  channels: ReadonlyArray<SportsScanChannel>,
  state: GuideEpgStateLike | null | undefined,
  overrides: Record<string, string> | null | undefined,
  playlistId: string,
  nowMs: number = Date.now(),
): SportsScanResult {
  const fetchedAt = epgFetchedAtOf(state)
  const key = `${playlistId}|${fetchedAt ?? "none"}`
  if (cachedResult !== null && cachedKey === key) return cachedResult
  scanRunCount += 1
  const result = scanSportsFixtures(channels, state, overrides, playlistId, nowMs)
  cachedKey = key
  cachedResult = result
  return result
}
