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
 * United fixture.
 *
 * Title-first, description as fallback (bug 3, 2026-11-21): the
 * classifier never reads `desc`, so a generic title such as
 * "Football Classics" used to be invisible even when its
 * description named the fixture. The title path below is
 * unchanged; only when it finds nothing is the description
 * consulted (see matchDescFixture). Channel/category are
 * supporting evidence only and can never create a match on their
 * own.
 */
export function matchUnitedFixture(
  title: string,
  channelName: string,
  category: string,
  desc = "",
): UnitedMatch | null {
  const rawTitle = (title || "").trim()
  if (!rawTitle) return null
  const titleOutcome = matchTitleFixture(rawTitle, channelName, category)
  if (titleOutcome.match) return titleOutcome.match
  return matchDescFixture(
    rawTitle,
    titleOutcome.classification,
    desc,
    channelName,
    category,
  )
}

interface TitleMatchOutcome {
  match: UnitedMatch | null
  /** Classification of the (prefix-stripped) title, for the
   *  description-path guard: a title that IS another fixture
   *  defines the programme, so its description is never mined. */
  classification: SportsClassification
}

function matchTitleFixture(
  rawTitle: string,
  channelName: string,
  category: string,
): TitleMatchOutcome {
  // Step 1: cheap pre-filter.
  if (!passesPrefilter(rawTitle.toLowerCase())) {
    return {
      match: null,
      classification: classifySportsProgramme(rawTitle, {
        channelName,
        category,
      }),
    }
  }
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
  const outcome = (match: UnitedMatch | null): TitleMatchOutcome => ({
    match,
    classification,
  })
  // Step 3: kind gate — fixture rows only.
  if (classification.kind !== "fixture" || !classification.teams) {
    return outcome(null)
  }
  // Step 4: sport guard — football or unknown; any other sport excludes.
  const sport = sportForGuard(classification, rawTitle)
  if (sport !== null && sport !== "football") return outcome(null)
  // Step 5: side match against the alias set.
  const sides = classification.teams.map((side) =>
    normaliseSideForUnited(side),
  ) as [string, string]
  const squad = detectSquad(classification.teams, rawTitle)
  if (UNITED_ALIASES.has(sides[0]) || UNITED_ALIASES.has(sides[1])) {
    return outcome({ tier: "confirmed", squad, classification })
  }
  // Step 6: ambiguous bare-"United" side → corroboration rule.
  const ambiguousIndex = sides[0] === "united" ? 0 : sides[1] === "united" ? 1 : -1
  if (ambiguousIndex === -1) return outcome(null)
  const otherSide = sides[1 - ambiguousIndex] as string
  if (
    isCorroboratedAmbiguous(otherSide, classification, channelName, category)
  ) {
    return outcome({ tier: "possible", squad, classification })
  }
  return outcome(null)
}

// ── Description matching (bug 3, 2026-11-21) ────────────────────
// The title path above is unchanged. Only when it finds nothing is
// the description consulted, in two steps:
//   (a) a fixture named in the description ("Football Classics"
//       whose description reads "Manchester United v Arsenal,
//       1999") — the fixture is recovered from the prose and run
//       through the SAME title matcher, so tier, squad, sport
//       guard and corroboration all apply unchanged;
//   (b) a description that names United without a fixture ("a look
//       back at Manchester United's treble season") — found only
//       as POSSIBLE, and only with football evidence in the title
//       or description (or sports-channel support). A bare
//       "united" never counts here: only full aliases, so "Leeds
//       United" or "United Rugby Championship" cannot match.
// Guard, both steps: a title that IS another fixture ("Arsenal v
// Chelsea") defines the programme — its description is never
// mined, so a passing United mention cannot re-label that match.

/** Full United aliases as they appear in prose (word-boundary:
 *  "Manu" the person never matches, "Leeds United" never matches
 *  — bare "united" is deliberately absent). */
const UNITED_ALIAS_IN_TEXT =
  /\b(manchester united|manchester utd|man utd|man united|manu|mufc)\b/i

/** Fixture separators, scanned across the description prose. */
const DESC_SEPARATOR_SCAN = /\s+(?:v\.?|vs\.?|versus|@)\s+/gi

/** Words either side of one separator that can still name a club
 *  — a 45-character window, far longer than any club name. */
const DESC_FIXTURE_WINDOW_CHARS = 45

function descWords(text: string): string[] {
  return text
    .replace(/[^A-Za-z0-9'’&]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Longest leading (side B) or trailing (side A) word-run that names
 * a club: a United alias, bare "united", or a known football club.
 * Longest-first matters: "Leeds United" must win over its
 * "United" suffix, or every Leeds fixture would read as a
 * bare-United one.
 */
function longestNamedSide(words: string[], trailing: boolean): string | null {
  const isNamed = (candidate: string): boolean => {
    const norm = normaliseSideForUnited(candidate)
    return (
      UNITED_ALIASES.has(norm) ||
      norm === "united" ||
      isKnownFootballClub(norm)
    )
  }
  if (trailing) {
    for (let start = 0; start < words.length; start++) {
      const candidate = words.slice(start).join(" ")
      if (isNamed(candidate)) return candidate
    }
    return null
  }
  for (let end = words.length; end > 0; end--) {
    const candidate = words.slice(0, end).join(" ")
    if (isNamed(candidate)) return candidate
  }
  return null
}

function isUnitedSide(side: string): boolean {
  const norm = normaliseSideForUnited(side)
  return UNITED_ALIASES.has(norm) || norm === "united"
}

/**
 * Recover the two sides around one description separator: side A
 * is the trailing club-naming run before it, side B the leading
 * club-naming run after it. Null unless at least one side is
 * United — a fixture between two other clubs is not our match.
 */
function sidesFromDescSeparator(
  before: string,
  after: string,
): [string, string] | null {
  const sideA = longestNamedSide(descWords(before), true)
  const sideB = longestNamedSide(descWords(after), false)
  if (!sideA || !sideB) return null
  if (!isUnitedSide(sideA) && !isUnitedSide(sideB)) return null
  return [sideA, sideB]
}

function matchDescFixtureText(
  rawDesc: string,
  channelName: string,
  category: string,
  title: string,
): UnitedMatch | null {
  DESC_SEPARATOR_SCAN.lastIndex = 0
  let separator: RegExpExecArray | null
  while ((separator = DESC_SEPARATOR_SCAN.exec(rawDesc)) !== null) {
    const before = rawDesc.slice(
      Math.max(0, separator.index - DESC_FIXTURE_WINDOW_CHARS),
      separator.index,
    )
    const afterStart = separator.index + separator[0].length
    const after = rawDesc.slice(
      afterStart,
      afterStart + DESC_FIXTURE_WINDOW_CHARS,
    )
    const sides = sidesFromDescSeparator(before, after)
    if (!sides) continue
    const constructed = `${sides[0]} v ${sides[1]}`
    const outcome = matchTitleFixture(constructed, channelName, category)
    if (!outcome.match) continue
    // A title match always carries teams (the kind gate); narrow
    // the optional for the squad re-check below.
    const teams = outcome.match.classification.teams
    if (!teams) continue
    // Squad markers may live in the surrounding title/description
    // prose ("a women's classic: Man Utd v Chelsea") rather than
    // in the recovered sides themselves.
    const squad = detectSquad(teams, `${title} ${rawDesc}`)
    return squad === outcome.match.squad
      ? outcome.match
      : { ...outcome.match, squad }
  }
  return null
}

/**
 * Best-effort other side for a mention-only match: the first known
 * football club named in the text (longest phrase first), so the
 * synthetic teams can still feed station matching. Null when the
 * description names no other club — the United side is then
 * repeated, which can never match a feed fixture (both sides the
 * same club) and only affects grouping.
 */
function otherKnownClubInText(text: string): string | null {
  const words = descWords(text)
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const phrase = words.slice(i, i + size).join(" ")
      const norm = normaliseSideForUnited(phrase)
      if (UNITED_ALIASES.has(norm) || norm === "united") continue
      if (isKnownFootballClub(norm)) return phrase
    }
  }
  return null
}

function matchDescMention(
  title: string,
  rawDesc: string,
  channelName: string,
  category: string,
): UnitedMatch | null {
  if (!UNITED_ALIAS_IN_TEXT.test(rawDesc)) return null
  const titleClass = classifySportsProgramme(title, {
    channelName,
    category,
  })
  const descClass = classifySportsProgramme(rawDesc, {
    channelName,
    category,
  })
  const footballEvidence =
    titleClass.sport === "football" ||
    descClass.sport === "football" ||
    (titleClass.competition !== undefined &&
      UNITED_COMPETITIONS.has(titleClass.competition)) ||
    (descClass.competition !== undefined &&
      UNITED_COMPETITIONS.has(descClass.competition)) ||
    hasSportsChannelSupport({ channelName, category })
  if (!footballEvidence) return null
  const competition =
    titleClass.competition !== undefined &&
    UNITED_COMPETITIONS.has(titleClass.competition)
      ? titleClass.competition
      : descClass.competition !== undefined &&
          UNITED_COMPETITIONS.has(descClass.competition)
        ? descClass.competition
        : undefined
  const teams: [string, string] = [
    "Manchester United",
    otherKnownClubInText(rawDesc) ?? "Manchester United",
  ]
  const classification: SportsClassification = {
    isSport: true,
    sport: "football",
    kind: "general-sport",
    confidence: "low",
    teams,
  }
  if (competition) classification.competition = competition
  return {
    tier: "possible",
    squad: detectSquad(teams, `${title} ${rawDesc}`),
    classification,
  }
}

function matchDescFixture(
  rawTitle: string,
  titleClassification: SportsClassification,
  desc: string,
  channelName: string,
  category: string,
): UnitedMatch | null {
  const rawDesc = (desc || "").trim()
  if (!rawDesc) return null
  // A title that IS another fixture defines the programme.
  if (titleClassification.kind === "fixture") return null
  // Cheap pre-filter: no United indicator in the description.
  if (!UNITED_INDICATORS.some((indicator) => rawDesc.toLowerCase().includes(indicator))) {
    return null
  }
  return (
    matchDescFixtureText(rawDesc, channelName, category, rawTitle) ??
    matchDescMention(rawTitle, rawDesc, channelName, category)
  )
}

// ── Station preference (fix-3, 2026-11-22) ─────────────────────
// WHY STAN SPORT BEAT SKY SPORTS MAIN EVENT 4K, LIVE 22 NOV:
// the scan made the FIRST listing in catalogue order the row's
// primary station, and Stan Sport sits before Sky Sports Main
// Event 4K in the user's 15,319-channel playlist. Catalogue order
// is provider order, not a quality signal — an Australian feed
// the user has never heard of, whose stream does not even load,
// became the station string AND the Watch tune-in target (the
// hero, Next Matches and reminders all tune fixture.channelId).
// There was no broadcaster preference anywhere in the chain, and
// no check that the channel plays.
//
// The primary is now chosen by broadcaster preference for a
// UK/Irish household: the domestic rights holders first, every
// other feed after. Within a tier, catalogue order still decides,
// so behaviour is unchanged where no preferred broadcaster
// carries the fixture. The ranking is name-based only — it never
// invents a station: a fixture with no EPG listing is still
// Station TBC, and a fixture carried only by an international
// feed still shows that feed (it is the honest listing).

/**
 * Preference tier for a channel name, 0 (best) to 3. Pure and
 * exported for the scan, the hero tie-break and the Next Matches
 * Watch-target pick, so all three can never disagree.
 */
export function sportsChannelPreferenceTier(channelName: string): number {
  const name = (channelName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!name) return 3
  const words = name.split(" ")
  const hasWordStarting = (prefix: string): boolean =>
    words.some((word) => word.startsWith(prefix))
  // Tier 0 — UK/Irish primary Premier League rights holders.
  // "4K" / "UHD" / "HD" suffixes ride along via includes().
  if (
    name.includes("sky sports main event") ||
    name.includes("sky sports premier league") ||
    name.includes("sky sports football")
  ) {
    return 0
  }
  // Tier 1 — other UK/Irish rights holders / free-to-air.
  if (
    name.includes("tnt sports") ||
    name.includes("premier sports") ||
    name.includes("bbc ") ||
    name === "bbc" ||
    hasWordStarting("itv") ||
    words.includes("utv") ||
    words.includes("stv") ||
    hasWordStarting("rte") ||
    name.includes("virgin media") ||
    name.includes("channel 4") ||
    words.includes("s4c")
  ) {
    return 1
  }
  // Tier 2 — other domestic sports channels.
  if (
    name.includes("sky sports") ||
    words.includes("mutv") ||
    name.includes("eurosport")
  ) {
    return 2
  }
  // Tier 3 — everything else: international feeds (Stan Sport,
  // beIN, ESPN, DAZN, SuperSport, Paramount+, …).
  return 3
}

/**
 * True only when a channel row explicitly carries a blank stream
 * URL — an M3U row whose `url` (or `streamUrl`) is present but
 * empty has nothing to play. An ABSENT url is NOT unplayable:
 * Xtream rows carry no url at all (the stream URL is built at
 * tune time from server + creds + stream id), so absence is the
 * normal playable shape. Only a present-but-blank URL demotes.
 * This is the only static playability signal the scan has: a
 * stream that exists in the playlist but does not load (Stan
 * Sport on 22 Nov) cannot be detected without a live probe, and
 * the scan never probes — the preference ranking above is what
 * keeps such feeds from being primary while a domestic carrier
 * lists the fixture.
 */
function channelStreamUrlIsBlank(channel: SportsScanChannel): boolean {
  const values: unknown[] = [
    channel.url,
    (channel as { streamUrl?: unknown }).streamUrl,
  ]
  for (const value of values) {
    if (typeof value === "string") return value.trim() === ""
  }
  return false
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

// ── ON NOW vs LIVE badge (bug 4a, 2026-11-21) ───────────────────
// An on-now row used to read "LIVE" whatever the programme was —
// a classic, a replay and a highlights show all claimed to be
// live. "LIVE" is reserved for a programme that is actually live
// football: on now, with no non-live marker in its title or
// description. Everything else on now reads "ON NOW". The marker
// list is deliberately narrow (programme-type words, not teams or
// competitions): a plain "Man Utd v Liverpool" on now still reads
// LIVE, because without any signal to the contrary the listing IS
// the live broadcast — only positive evidence of non-live content
// downgrades it. Build-up/preview count as non-live: live studio
// coverage before kick-off is not the match itself.

export type SportsNowLabel = "LIVE" | "ON NOW"

const NON_LIVE_PROGRAMME_MARKERS: ReadonlyArray<RegExp> = [
  /\bclassics?\b/i,
  /\breplays?\b/i,
  /\bhighlights?\b/i,
  /\barchive\b/i,
  /\bretro\b/i,
  /\brewind\b/i,
  /\brepeats?\b/i,
  /\breruns?\b/i,
  /\bbest\s+of\b/i,
  /\bbuild[\s-]?up\b/i,
  /\bpreview\b/i,
  /\bpost[\s-]?match\b/i,
  /\bseason\s+review\b/i,
  /\bdocumentary\b/i,
]

/**
 * The on-now badge for one fixture: "LIVE" for live football,
 * "ON NOW" for any other programme on now, null when the fixture
 * is not on now. Pure — the row renderer calls this, so the
 * labelling rule is testable without DOM.
 */
export function sportsFixtureLiveBadge(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): SportsNowLabel | null {
  if (fixtureStateOf(fixture, nowMs) !== "now") return null
  const text = `${fixture.title} ${fixture.desc ?? ""}`
  if (
    NON_LIVE_PROGRAMME_MARKERS.some((pattern) => pattern.test(text))
  ) {
    return "ON NOW"
  }
  return "LIVE"
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
 *
 * Same-fixture exception (fix-3, 2026-11-22): one match can be
 * listed twice with different starts (a build-up slot on one
 * channel, kick-off on another). Those two rows are the SAME
 * fixture — same sides, same squad, starts within the 60-minute
 * pre-match window — so the earliest-start rule must not hand the
 * hero to the earlier-starting international feed. Between two
 * listings of the same fixture the better-ranked primary wins;
 * the earliest-start rule only decides between different
 * fixtures, and between same-fixture listings on equally-ranked
 * channels.
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
    if (isSameFixtureListing(best, fixture)) {
      const tierDiff =
        sportsChannelPreferenceTier(fixture.channelName) -
        sportsChannelPreferenceTier(best.channelName)
      if (tierDiff < 0) best = fixture
      else if (
        tierDiff === 0 &&
        state === bestState &&
        fixture.startMs < best.startMs
      ) {
        best = fixture
      }
      continue
    }
    // Live beats upcoming regardless of start order; otherwise earliest wins.
    if (state === "now" && bestState !== "now") best = fixture
    else if (state === bestState && fixture.startMs < best.startMs) {
      best = fixture
    }
  }
  return best
}

/**
 * Two rows are listings of the same fixture when the sides match
 * (canonicalised, order-insensitive — the group key with the
 * start zeroed out), the squad matches, and the starts are within
 * the 60-minute pre-match window of each other (SPORTS_PREMATCH_WINDOW_MS
 * in sports-corner-v2-hub.ts; mirrored here as a literal so this
 * module does not import the hub — the two must stay in step).
 */
function isSameFixtureListing(
  a: SportsFixture,
  b: SportsFixture,
): boolean {
  if (a.squad !== b.squad) return false
  if (
    groupKeyFor(a.teams, 0, a.squad) !== groupKeyFor(b.teams, 0, b.squad)
  ) {
    return false
  }
  return Math.abs(a.startMs - b.startMs) <= 60 * 60_000
}

/**
 * Scan the EPG state for United fixtures. Single pass over the
 * batch loader's output; simulcasts group by (canonicalised sides,
 * exact start, squad). The row's primary station is the
 * best-ranked carrier (fix-3: broadcaster preference, unplayable
 * rows last, catalogue order as the tie-break) — NOT the first
 * listing in catalogue order, which is how Stan Sport beat Sky
 * Sports Main Event 4K on 22 Nov. The remaining carriers fold
 * into "Also on" in the same ranked order, so the station string
 * ("Sky Sports Main Event 4K · Sky Sports Premier League") and
 * the Watch tune-in target always agree on the primary.
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

  interface GroupCandidate {
    fixture: SportsFixture
    /** Encounter order (playlist order). Tie-break within a tier. */
    order: number
    tier: number
    /** Explicitly blank stream URL — nothing to play. */
    unplayable: boolean
  }
  const compareCandidates = (a: GroupCandidate, b: GroupCandidate): number => {
    if (a.unplayable !== b.unplayable) return a.unplayable ? 1 : -1
    if (a.tier !== b.tier) return a.tier - b.tier
    return a.order - b.order
  }

  const groups = new Map<string, GroupCandidate[]>()
  let order = 0
  for (const [channelId, programmes] of loaded.programmesByChannel) {
    const channel = byId.get(channelId)
    if (!channel) continue
    const channelName = channelDisplayName(channel)
    const category = channelCategoryOf(channel)
    for (const programme of programmes) {
      const match = matchUnitedFixture(
        programme.title,
        channelName,
        category,
        programme.desc,
      )
      if (!match) continue
      const fixture = buildFixture(programme, channel, match, nowMs)
      const key = groupKeyFor(
        match.classification.teams as [string, string],
        programme.startMs,
        match.squad,
      )
      const candidate: GroupCandidate = {
        fixture,
        order: order++,
        tier: sportsChannelPreferenceTier(channelName),
        unplayable: channelStreamUrlIsBlank(channel),
      }
      const list = groups.get(key)
      if (list) list.push(candidate)
      else groups.set(key, [candidate])
    }
  }

  const fixtures = [...groups.values()]
    .map((candidates) => {
      const ranked = [...candidates].sort(compareCandidates)
      const primary = ranked[0]!.fixture
      primary.alsoOn = ranked.slice(1).map((candidate) => ({
        channelId: candidate.fixture.channelId,
        channelName: candidate.fixture.channelName,
      }))
      return primary
    })
    .sort(
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
