// Sports Corner v2 — football-data.org feed client (Phase 1, plan §5.1).
//
// Table + next fixtures + recent form come from football-data.org
// (free tier, €0 — approved 2026-11-20, D1-A). Stations and tune-in
// still come from the EPG; this module NEVER invents a station, a
// table row, a fixture or a result.
//
// Honesty contract (plan §3 + §5.1):
// - No API key in code, ever. The key lives in Settings localStorage
//   (`xt_football_data_key`, same pattern as the TMDB key in
//   app-settings.js) and is read at call time. No key -> the typed
//   "no-key" status, never a fabricated table.
// - Feed down + no cache -> typed "error" status, data null. Feed down
//   + cache -> the last-good data with status "stale" and a visible
//   staleness flag; older than 24h -> `mayBeOutOfDate` is true and the
//   UI must say so. A stale table is never silently shown as today's.
// - Cache: in-memory + localStorage, 1h default TTL, never longer than
//   24h for a table (FOOTBALL_DATA_MAX_TABLE_AGE_MS).
// - Team logos are never rendered from the feed (provider terms §9.2);
//   the parsers below deliberately drop every logo/crest URL.
// - Attribution (provider terms §7.1): FOOTBALL_DATA_ATTRIBUTION must
//   be shown wherever the table/fixtures are shown (hub, Phase 2).
//
// Network: inside the Tauri webview the feed goes through the app's
// own providerFetch (src/scripts/lib/provider-fetch.js), which routes
// via @tauri-apps/plugin-http — the request is issued by Rust
// (reqwest), outside the webview, so no CORS check applies. A plain
// webview fetch() CANNOT reach this API: api.football-data.org never
// sends Access-Control-Allow-Origin on GET responses, and its OPTIONS
// preflight always answers the fixed value `http://localhost`, which
// matches neither the production webview origin
// (`https://tauri.localhost`) nor dev (`http://localhost:4321`) —
// verified live 2026-11-22 in a real Chromium (preflight rejection
// quoted in tests/e2e/football-data-live.spec.ts). That CORS failure
// is why the key test and the hub both reported "couldn't be reached"
// while the API itself was up (invalid token -> HTTP 400, no token ->
// HTTP 403). TMDB works from the same dialog because it answers
// `Access-Control-Allow-Origin: *`. The http plugin is already
// registered in src-tauri/src/lib.rs and the `http:default`
// capability already allows `https://**/*`; no native change was
// needed. Outside Tauri (plain browser preview, unit tests) the
// transport stays plain fetch() — a browser origin cannot reach this
// API, which is the honest pre-existing limit there, not a regression.
// Rate limit (free tier): 10 requests/minute. A refresh needs 4 calls
// (standings + PL matches + CL matches + PL past matches for form)
// and is cached for 1h, so normal use is far inside the limit.
//
// Tests must NEVER hit the live API in the unit suite (no key
// exists): every public fetch takes an injectable `fetchImpl`, and
// the parsers are pure. Live reachability through the real client
// path is proven by tests/e2e/football-data-live.spec.ts (gated
// behind FOOTBALL_DATA_LIVE_TEST=1), which runs the real module in
// a real Chromium against the live API with a dummy token.

import { log } from "@/scripts/lib/log.js"
import { epgListingMatchesKickoff } from "@/scripts/lib/sports-corner-v2-hub.js"

/** Base URL for every football-data.org v4 call. */
export const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4"

/** Provider name carried on every result (plan §5.1 `source`). */
export const FOOTBALL_DATA_SOURCE_NAME = "football-data.org"

/**
 * Attribution line (provider General Terms §7.1 — visible attribution
 * required). The hub must show this wherever table/fixtures appear.
 */
export const FOOTBALL_DATA_ATTRIBUTION =
  "Football data provided by the Football-Data.org API"

/** Free-tier rate limit (requests per minute). Documented, not enforced
 *  in code — a cached refresh is 3 calls/hour, far inside it. */
export const FOOTBALL_DATA_RATE_LIMIT_PER_MINUTE = 10

/** localStorage key for the user's own API key. Same pattern as the
 *  TMDB key (`xt_tmdb_key`): the key is entered in Settings on the
 *  user's PC and never committed to the public repo (provider terms
 *  §6.1). Single source of truth for the key string — app-settings.js
 *  imports this constant for its get/set pair. */
export const FOOTBALL_DATA_KEY_STORAGE_KEY = "xt_football_data_key"

/** localStorage cache keys (derived data only — never a key). */
export const FOOTBALL_DATA_TABLE_CACHE_KEY = "xt_football_data_table_cache"
export const FOOTBALL_DATA_FIXTURES_CACHE_KEY =
  "xt_football_data_fixtures_cache"
export const FOOTBALL_DATA_RESULTS_CACHE_KEY =
  "xt_football_data_results_cache"

/** Default cache TTL: 1h (plan §5.1). */
export const FOOTBALL_DATA_DEFAULT_TTL_MS = 60 * 60 * 1000

/** A table older than this is never presented as current: the UI must
 *  flag it "may be out of date" (plan §5.1, T-v2-5). */
export const FOOTBALL_DATA_MAX_TABLE_AGE_MS = 24 * 60 * 60 * 1000

/** "Station TBC" — the only station text used when the EPG has no
 *  listing for a feed fixture yet. Never a guessed channel. */
export const STATION_TBC = "Station TBC"

// ── Domestic cups — codes + free-tier gap (bug 5, 21 Nov 2026) ──

/**
 * FA Cup code (v4 lookup tables, id 2055) and Football League Cup
 * code (id 2139) — the League Cup is the Carabao/EFL Cup.
 * WARNING: ELC (id 2016) is the Championship, NOT the EFL Cup —
 * never use it for the cup.
 *
 * NEITHER CUP IS FETCHED — both are outside the free tier (verified
 * 2026-11-21 against the provider's own pages):
 * - Free tier = exactly 12 competitions (TIER_ONE: PL, ELC, CL, EC,
 *   FL1, BL1, SA, DED, PPL, PD, BSA, WC). No cup of any country is
 *   among them (coverage: football-data.org/coverage, pricing:
 *   football-data.org/pricing).
 * - Per the provider's per-competition plan field (live-probed
 *   2026-08-26, same free key 403s on the cups while PL returns
 *   200): FAC is TIER_TWO, FLC is TIER_THREE. On the published
 *   pricing (Standard €49/mo = 30 competitions, Advanced €99/mo =
 *   50, Pro €199/mo = 100) that means the FA Cup alone needs
 *   Advanced (€99/mo) and the League Cup needs Pro (€199/mo) — both
 *   cups together need Pro. One secondary source claims the EFL Cup
 *   is not sold at any tier, so confirm on the coverage page before
 *   paying anything.
 * - Nothing was bought and no key tier was changed. getNextFixtures
 *   stays PL + CL until the user decides. If a paid key ever lands
 *   in Settings, enabling a cup is a one-line change: extend
 *   FOOTBALL_DATA_FIXTURE_COMPETITIONS — the fetcher, parser and
 *   mock already handle any competition code.
 */
export const FOOTBALL_DATA_FA_CUP_CODE = "FAC"
export const FOOTBALL_DATA_LEAGUE_CUP_CODE = "FLC"

/** Competitions whose fixtures getNextFixtures actually fetches.
 *  Free tier only: PL + CL. Cups stay out until a paid key exists
 *  (see the note above) — adding "FAC" | "FLC" here is the whole
 *  change when that day comes. */
export const FOOTBALL_DATA_FIXTURE_COMPETITIONS: ReadonlyArray<
  "PL" | "CL"
> = ["PL", "CL"]

// ── Types (plan §5.1, verbatim field sets) ───────────────────────

export interface LeagueTableEntry {
  position: number
  team: string
  played: number
  won: number
  drawn: number
  lost: number
  gf: number
  ga: number
  gd: number
  points: number
}

export interface LeagueTable {
  competition: string
  entries: LeagueTableEntry[]
  /** Feed timestamp — the time this table was fetched (the feed
   *  carries no table timestamp of its own). */
  asOf: string
  /** Feed name (FOOTBALL_DATA_SOURCE_NAME). */
  source: string
}

export interface FeedFixture {
  /** Feed-stable id (`fd-<football-data match id>`). */
  id: string
  home: string
  away: string
  competition: string
  startMs: number
  venue?: string
  /** Feed status (`SCHEDULED` / `TIMED` / `FINISHED` …) when the
   *  payload carried one. Upcoming fixtures are filtered on it;
   *  recent form is derived from it — never guessed. */
  status?: string
  /** Full-time score when the feed carried one. Nulls for a match
   *  that has not kicked off; a FINISHED match without numeric
   *  full-time goals is a bad row and the parser rejects it. */
  score?: { home: number | null; away: number | null }
}

/** One Last-five mark, most recent first: W = United won, D = drew,
 *  L = lost. Derived only from FINISHED Premier League results with
 *  feed scores — never invented (mockup rebuild, 2026-11-21). */
export type FormMark = "W" | "D" | "L"

// ── Result shape (typed failure states, never invented data) ─────

/**
 * "ok" — fresh from the feed (or within TTL from cache).
 * "no-key" — no API key in Settings; data is null, no fetch was made.
 * "stale" — feed failed; data is the last-good cache, flagged.
 * "error" — feed failed and there is no cache; data is null.
 */
export type FootballDataFetchStatus = "ok" | "no-key" | "stale" | "error"

export interface LeagueTableResult {
  status: FootballDataFetchStatus
  table: LeagueTable | null
  /** True when the table came from cache because the feed failed. */
  stale: boolean
  /** True when the served table is older than 24h — the UI must render
   *  "may be out of date" next to it (T-v2-5). */
  mayBeOutOfDate: boolean
  /** ms epoch of the fetch that produced the served data, or null. */
  fetchedAt: number | null
  /** True when the data came from cache without a feed call. */
  fromCache: boolean
  /** Human-readable failure reason. Never contains the API key. */
  error?: string
}

export interface FeedFixturesResult {
  status: FootballDataFetchStatus
  fixtures: FeedFixture[] | null
  stale: boolean
  mayBeOutOfDate: boolean
  fetchedAt: number | null
  fromCache: boolean
  error?: string
}

/**
 * Recent-form result (Last five, mockup rebuild 2026-11-21).
 * `form` is the W/D/L marks, most recent first (fewer than `n` early
 * in the season — the hub renders what exists and omits the row when
 * there is nothing). `results` is the finished United PL fixtures
 * behind the marks, most recent first. Null on no-key/error; stale
 * carries the last-good marks.
 */
export interface FeedFormResult {
  status: FootballDataFetchStatus
  form: FormMark[] | null
  results: FeedFixture[] | null
  stale: boolean
  mayBeOutOfDate: boolean
  fetchedAt: number | null
  fromCache: boolean
  error?: string
}

// ── Minimal fetch shape (lets tests stub without a full Response) ─

export interface FootballDataFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  headers?: { get(name: string): string | null }
}

export type FootballDataFetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: unknown },
) => Promise<FootballDataFetchResponse>

export interface FootballDataCallOptions {
  fetchImpl?: FootballDataFetchImpl
  /** Clock override (tests). Defaults to Date.now(). */
  nowMs?: number
  /** Skip the cache and hit the feed even inside the TTL. */
  forceRefresh?: boolean
  /** Cache TTL override (tests). Defaults to FOOTBALL_DATA_DEFAULT_TTL_MS. */
  ttlMs?: number
}

// ── Guarded storage (same lsGet/lsSet style as sports-follow.ts) ──

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
    log.warn("[xt:football-data] localStorage write failed for", key, err)
  }
}

function lsRemove(key: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(key)
  } catch {
    // Removal failing leaves a stale cache entry; reads validate age.
  }
}

/** The API key as stored in Settings, or "" when none is saved.
 *  The value is never logged. */
export function getFootballDataApiKey(): string {
  return (lsGet(FOOTBALL_DATA_KEY_STORAGE_KEY) ?? "").trim()
}

/** "missing" | "set" — lets callers report the honest no-key state
 *  without ever handling the key value. */
export function getFootballDataKeyState(): "missing" | "set" {
  return getFootballDataApiKey() ? "set" : "missing"
}

// ── In-memory cache (cleared by clearFootballDataCache) ──────────

interface Cached<T> {
  fetchedAt: number
  data: T
}

let memoryTable: Cached<LeagueTable> | null = null
let memoryFixtures: Cached<FeedFixture[]> | null = null
let memoryResults: Cached<FeedFixture[]> | null = null

function readCache<T>(key: string): Cached<T> | null {
  const raw = lsGet(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; data?: unknown }
    if (typeof parsed.fetchedAt !== "number" || parsed.data == null) return null
    return { fetchedAt: parsed.fetchedAt, data: parsed.data as T }
  } catch {
    return null
  }
}

function writeCache<T>(key: string, entry: Cached<T>): void {
  lsSet(key, JSON.stringify(entry))
}

/** Drop the in-memory + localStorage caches (tests / explicit refresh). */
export function clearFootballDataCache(): void {
  memoryTable = null
  memoryFixtures = null
  memoryResults = null
  lsRemove(FOOTBALL_DATA_TABLE_CACHE_KEY)
  lsRemove(FOOTBALL_DATA_FIXTURES_CACHE_KEY)
  lsRemove(FOOTBALL_DATA_RESULTS_CACHE_KEY)
}

// ── Team-name normalisation (shared by fixture filter + matcher) ──

/**
 * Normalise a team name for comparison: lowercase, punctuation to
 * spaces, trailing fc/afc stripped, known aliases canonicalised.
 * Mirrors the EPG scan's alias handling (sports-fixture-scan.ts §4.2)
 * so feed names and EPG names meet on the same key.
 */
const UNITED_ALIASES: ReadonlySet<string> = new Set([
  "manchester united",
  "man utd",
  "manchester utd",
  "man united",
  "manu",
  "mufc",
])

const TEAM_ALIASES: Record<string, string> = {
  "sporting clube de portugal": "sporting cp",
  "sporting lisbon": "sporting cp",
}

export function normaliseTeamName(name: string): string {
  const cleaned = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(fc|afc)$/, "")
  if (UNITED_ALIASES.has(cleaned)) return "manchester united"
  return TEAM_ALIASES[cleaned] ?? cleaned
}

/** True when either side of a fixture is Manchester United. */
export function isUnitedFixture(fixture: FeedFixture): boolean {
  return (
    normaliseTeamName(fixture.home) === "manchester united" ||
    normaliseTeamName(fixture.away) === "manchester united"
  )
}

/**
 * One fixture's result from United's side: "W" / "D" / "L", or null
 * when the fixture is not a decidable United result (not United,
 * not FINISHED, or no numeric full-time score). Pure.
 */
export function fixtureResultFor(fixture: FeedFixture): FormMark | null {
  if (!isUnitedFixture(fixture)) return null
  if (fixture.status !== "FINISHED") return null
  const home = fixture.score?.home ?? null
  const away = fixture.score?.away ?? null
  if (home === null || away === null) return null
  const unitedHome =
    normaliseTeamName(fixture.home) === "manchester united"
  const unitedGoals = unitedHome ? home : away
  const opponentGoals = unitedHome ? away : home
  if (unitedGoals > opponentGoals) return "W"
  if (unitedGoals < opponentGoals) return "L"
  return "D"
}

/**
 * Last-five form from finished fixtures, most recent first: keep
 * only decidable United results, newest kick-off first, take `n`.
 * Pure — the mockup's chips are exactly this, never invented.
 */
export function deriveLastFive(
  fixtures: ReadonlyArray<FeedFixture>,
  n: number = 5,
): FormMark[] {
  return fixtures
    .filter((fixture) => fixtureResultFor(fixture) !== null)
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, n)
    .map((fixture) => fixtureResultFor(fixture) as FormMark)
}

// ── Response parsing (pure — no fetch, no clock, no storage) ─────

export class FootballDataError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "FootballDataError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Parse a `GET /v4/competitions/PL/standings` payload into a
 * LeagueTable. Strict: a malformed row rejects the whole payload
 * (a half-parsed table must never render as fact). Logo/crest URLs
 * are deliberately dropped — the app uses its own artwork (terms §9.2).
 */
export function parseStandingsResponse(
  payload: unknown,
  fetchedAtMs: number,
): LeagueTable {
  if (!isRecord(payload)) {
    throw new FootballDataError("Standings payload is not an object")
  }
  const standings = payload.standings
  if (!Array.isArray(standings) || standings.length === 0) {
    throw new FootballDataError("Standings payload has no standings")
  }
  const total =
    standings.find(
      (entry) => isRecord(entry) && entry.type === "TOTAL",
    ) ?? standings[0]
  if (!isRecord(total) || !Array.isArray(total.table)) {
    throw new FootballDataError("Standings payload has no table")
  }
  const entries: LeagueTableEntry[] = total.table.map((row, index) => {
    if (!isRecord(row)) {
      throw new FootballDataError(`Standings row ${index} is not an object`)
    }
    const team = isRecord(row.team) ? nonEmptyString(row.team.name) : null
    const position = finiteNumber(row.position)
    const played = finiteNumber(row.playedGames)
    const won = finiteNumber(row.won)
    const drawn = finiteNumber(row.draw)
    const lost = finiteNumber(row.lost)
    const points = finiteNumber(row.points)
    const gf = finiteNumber(row.goalsFor)
    const ga = finiteNumber(row.goalsAgainst)
    const gd = finiteNumber(row.goalDifference)
    if (
      team === null ||
      position === null ||
      played === null ||
      won === null ||
      drawn === null ||
      lost === null ||
      points === null ||
      gf === null ||
      ga === null ||
      gd === null
    ) {
      throw new FootballDataError(`Standings row ${index} is missing fields`)
    }
    return {
      position,
      team,
      played,
      won,
      drawn,
      lost,
      gf,
      ga,
      gd,
      points,
    }
  })
  if (entries.length === 0) {
    throw new FootballDataError("Standings table is empty")
  }
  const competition = isRecord(payload.competition)
    ? (nonEmptyString(payload.competition.name) ?? "Premier League")
    : "Premier League"
  return {
    competition,
    entries,
    asOf: new Date(fetchedAtMs).toISOString(),
    source: FOOTBALL_DATA_SOURCE_NAME,
  }
}

/**
 * Parse a `GET /v4/competitions/{PL,CL}/matches` payload into feed
 * fixtures. Every match is validated; one bad row rejects the payload
 * rather than silently dropping a fixture. `venue` is carried only
 * when the feed supplies it — never invented.
 */
export function parseMatchesResponse(payload: unknown): FeedFixture[] {
  if (!isRecord(payload)) {
    throw new FootballDataError("Matches payload is not an object")
  }
  if (!Array.isArray(payload.matches)) {
    throw new FootballDataError("Matches payload has no matches array")
  }
  return payload.matches.map((match, index) => {
    if (!isRecord(match)) {
      throw new FootballDataError(`Match ${index} is not an object`)
    }
    const id =
      typeof match.id === "number" || typeof match.id === "string"
        ? String(match.id)
        : null
    const utcDate = nonEmptyString(match.utcDate)
    const startMs = utcDate ? Date.parse(utcDate) : Number.NaN
    const home = isRecord(match.homeTeam)
      ? nonEmptyString(match.homeTeam.name)
      : null
    const away = isRecord(match.awayTeam)
      ? nonEmptyString(match.awayTeam.name)
      : null
    const competition = isRecord(match.competition)
      ? nonEmptyString(match.competition.name)
      : null
    if (
      id === null ||
      utcDate === null ||
      Number.isNaN(startMs) ||
      home === null ||
      away === null ||
      competition === null
    ) {
      throw new FootballDataError(`Match ${index} is missing fields`)
    }
    const fixture: FeedFixture = {
      id: `fd-${id}`,
      home,
      away,
      competition,
      startMs,
    }
    const venue = nonEmptyString(match.venue)
    if (venue) fixture.venue = venue
    // Status + full-time score: the upcoming filter needs the
    // status, recent form needs both. A FINISHED row without numeric
    // full-time goals is a bad row — reject the payload, never
    // guess a result from it.
    const status = matchStatusOf(match)
    if (status !== null) fixture.status = status
    const fullTime = isRecord(match.score)
      ? isRecord(match.score.fullTime)
        ? match.score.fullTime
        : null
      : null
    const scoreHome = fullTime ? finiteNumber(fullTime.home) : null
    const scoreAway = fullTime ? finiteNumber(fullTime.away) : null
    if (status === "FINISHED" && (scoreHome === null || scoreAway === null)) {
      throw new FootballDataError(
        `Match ${index} is FINISHED but has no full-time score`,
      )
    }
    fixture.score = { home: scoreHome, away: scoreAway }
    return fixture
  })
}

/** The feed's own status values for a match that has not kicked off. */
const UPCOMING_STATUSES: ReadonlySet<string> = new Set([
  "SCHEDULED",
  "TIMED",
])

/** The feed's own status value for a match with a final score. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(["FINISHED"])

function matchStatusOf(match: unknown): string | null {
  return isRecord(match) ? nonEmptyString(match.status) : null
}

// ── Feed fetching ─────────────────────────────────────────────────

// ── Default transport (CORS: webview fetch cannot reach this API) ──

/**
 * True when the code runs inside the Tauri webview. Mirrors the
 * check in provider-fetch.js (`window.__TAURI_INTERNALS__` /
 * `window.__TAURI__`).
 */
function isTauriEnvironment(): boolean {
  if (typeof window === "undefined") return false
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown
    __TAURI__?: unknown
  }
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__)
}

/** Cached promise for the lazily-imported provider-fetch module. */
let providerFetchPromise: Promise<{
  providerFetch: FootballDataFetchImpl
}> | null = null

function loadProviderFetch(): Promise<{
  providerFetch: FootballDataFetchImpl
}> {
  if (!providerFetchPromise) {
    providerFetchPromise = import(
      "@/scripts/lib/provider-fetch.js"
    ).catch((error: unknown) => {
      providerFetchPromise = null
      throw error
    })
  }
  return providerFetchPromise
}

/**
 * The default fetch implementation for every feed call. Inside the
 * Tauri webview this is providerFetch (plugin-http, Rust-side
 * reqwest — no CORS); outside Tauri it is plain webview fetch().
 * The import is lazy so this module keeps no static cycle with
 * app-settings.js (which imports this module's key constant, and
 * which provider-fetch.js itself imports).
 */
async function defaultFetch(): Promise<FootballDataFetchImpl> {
  if (isTauriEnvironment()) {
    try {
      const { providerFetch } = await loadProviderFetch()
      return (url: string, init?: { headers?: Record<string, string>; signal?: unknown }) =>
        providerFetch(url, {
          ...init,
          // providerFetch reads logKind for its net log, then strips
          // it before the request — the cast only carries it past
          // this module's narrower fetch-init type.
          logKind: "football-data",
        } as { headers?: Record<string, string>; signal?: unknown }) as unknown as Promise<FootballDataFetchResponse>
    } catch (error) {
      log.warn(
        "[xt:football-data] providerFetch unavailable, falling back to webview fetch:",
        error,
      )
    }
  }
  const impl = (globalThis as { fetch?: unknown }).fetch
  if (typeof impl !== "function") {
    throw new FootballDataError("fetch is not available in this environment")
  }
  return impl as FootballDataFetchImpl
}

function footballDataDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

async function fetchJson(
  fetchImpl: FootballDataFetchImpl,
  url: string,
  apiKey: string,
): Promise<unknown> {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null
  const timer =
    controller !== null
      ? setTimeout(() => controller.abort(), 10_000)
      : null
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "X-Auth-Token": apiKey,
      },
      signal: controller?.signal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new FootballDataError(
          "Football-data.org rejected the API key (check the key in Settings)",
          response.status,
        )
      }
      if (response.status === 429) {
        throw new FootballDataError(
          "Football-data.org rate limit reached (10/min on the free tier)",
          response.status,
        )
      }
      // The provider answers a bad token with HTTP 400 and the body
      // {"message":"Your API token is invalid.","errorCode":400}
      // (verified live 2026-11-22 with a 32-char dummy token) — that
      // is an auth failure, not a network failure, so it must read as
      // a key rejection everywhere, never as "couldn't be reached".
      if (await responseBodySaysTokenInvalid(response)) {
        throw new FootballDataError(
          "Football-data.org rejected the API key (check the key in Settings)",
          response.status,
        )
      }
      throw new FootballDataError(
        `Football-data.org request failed (${response.status})`,
        response.status,
      )
    }
    return await response.json()
  } catch (error) {
    if (error instanceof FootballDataError) throw error
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new FootballDataError("Football-data.org request timed out")
    }
    throw new FootballDataError(
      `Football-data.org request failed (${error instanceof Error ? error.message : "network error"})`,
    )
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * True when an error response's JSON body says the API token is
 * invalid (the provider's bad-token shape). Never throws: an
 * unreadable or non-JSON body is simply not a token error.
 */
async function responseBodySaysTokenInvalid(
  response: FootballDataFetchResponse,
): Promise<boolean> {
  try {
    const body: unknown = await response.json()
    if (!isRecord(body)) return false
    const message = body.message
    return (
      typeof message === "string" && /api token is invalid/i.test(message)
    )
  } catch {
    return false
  }
}

function cachedEntry<T>(
  memory: Cached<T> | null,
  storageKey: string,
): Cached<T> | null {
  return memory ?? readCache<T>(storageKey)
}

function ageMs(entry: Cached<unknown>, nowMs: number): number {
  return nowMs - entry.fetchedAt
}

// ── Public API (what the Phase 2 UI worker calls) ────────────────

/**
 * The Premier League table. Fresh from the feed when possible, else
 * the last-good cache flagged stale, else the typed failure state.
 * Never an invented table.
 */
export async function getLeagueTable(
  options: FootballDataCallOptions = {},
): Promise<LeagueTableResult> {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? FOOTBALL_DATA_DEFAULT_TTL_MS
  const apiKey = getFootballDataApiKey()
  if (!apiKey) {
    return {
      status: "no-key",
      table: null,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: null,
      fromCache: false,
      error: "No football-data.org API key saved in Settings.",
    }
  }
  const cached = cachedEntry<LeagueTable>(
    memoryTable,
    FOOTBALL_DATA_TABLE_CACHE_KEY,
  )
  if (cached && !options.forceRefresh && ageMs(cached, nowMs) <= ttlMs) {
    return {
      status: "ok",
      table: cached.data,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    }
  }
  const fetchImpl = options.fetchImpl ?? (await defaultFetch())
  try {
    const payload = await fetchJson(
      fetchImpl,
      `${FOOTBALL_DATA_BASE_URL}/competitions/PL/standings`,
      apiKey,
    )
    const table = parseStandingsResponse(payload, nowMs)
    const entry: Cached<LeagueTable> = { fetchedAt: nowMs, data: table }
    memoryTable = entry
    writeCache(FOOTBALL_DATA_TABLE_CACHE_KEY, entry)
    return {
      status: "ok",
      table,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: nowMs,
      fromCache: false,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Feed request failed"
    log.warn("[xt:football-data] league table fetch failed:", message)
    if (cached) {
      const age = ageMs(cached, nowMs)
      return {
        status: "stale",
        table: cached.data,
        stale: true,
        mayBeOutOfDate: age > FOOTBALL_DATA_MAX_TABLE_AGE_MS,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        error: message,
      }
    }
    return {
      status: "error",
      table: null,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: null,
      fromCache: false,
      error: message,
    }
  }
}

function matchesUrl(
  competition: (typeof FOOTBALL_DATA_FIXTURE_COMPETITIONS)[number],
  nowMs: number,
): string {
  const from = footballDataDate(new Date(nowMs))
  const to = footballDataDate(new Date(nowMs + 90 * 24 * 60 * 60 * 1000))
  return (
    `${FOOTBALL_DATA_BASE_URL}/competitions/${competition}/matches` +
    `?dateFrom=${from}&dateTo=${to}`
  )
}

/**
 * Past-window matches URL for recent form: the same
 * `/competitions/PL/matches` endpoint the fixtures call already
 * uses, with the window flipped into the past (today − 90d to
 * today). The future-only window carries no finished results, so
 * form is not derivable from the fixtures payload — this one extra
 * free-tier call is the whole gap (mockup rebuild, 2026-11-21).
 */
function pastMatchesUrl(nowMs: number): string {
  const from = footballDataDate(new Date(nowMs - 90 * 24 * 60 * 60 * 1000))
  const to = footballDataDate(new Date(nowMs))
  return (
    `${FOOTBALL_DATA_BASE_URL}/competitions/PL/matches` +
    `?dateFrom=${from}&dateTo=${to}`
  )
}

/**
 * The next `n` Manchester United fixtures (Premier League + Champions
 * League, D3 = A: next 5 by default), earliest first. Fixtures are
 * feed truth; the station for each comes from the EPG via
 * matchFixtureStations() — never from here. Domestic cups (FAC/FLC)
 * are NOT included: both sit outside the free tier (see the
 * FOOTBALL_DATA_FA_CUP_CODE note above) — the next-5 list spans
 * PL + CL only until a paid key exists.
 */
export async function getNextFixtures(
  n: number = 5,
  options: FootballDataCallOptions = {},
): Promise<FeedFixturesResult> {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? FOOTBALL_DATA_DEFAULT_TTL_MS
  const apiKey = getFootballDataApiKey()
  if (!apiKey) {
    return {
      status: "no-key",
      fixtures: null,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: null,
      fromCache: false,
      error: "No football-data.org API key saved in Settings.",
    }
  }
  const upcomingFrom = (list: FeedFixture[]): FeedFixture[] =>
    list
      .filter((fixture) => fixture.startMs > nowMs)
      .sort((a, b) => a.startMs - b.startMs)
  const cached = cachedEntry<FeedFixture[]>(
    memoryFixtures,
    FOOTBALL_DATA_FIXTURES_CACHE_KEY,
  )
  if (cached && !options.forceRefresh && ageMs(cached, nowMs) <= ttlMs) {
    return {
      status: "ok",
      fixtures: upcomingFrom(cached.data).slice(0, n),
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    }
  }
  const fetchImpl = options.fetchImpl ?? (await defaultFetch())
  try {
    const payloads = await Promise.all(
      FOOTBALL_DATA_FIXTURE_COMPETITIONS.map((competition) =>
        fetchJson(fetchImpl, matchesUrl(competition, nowMs), apiKey),
      ),
    )
    // Statuses and the United filter are applied to the RAW payloads
    // first, so the parser only ever sees matches that matter — no
    // index alignment between raw and parsed arrays to keep in sync.
    const selectUpcomingUnited = (payload: unknown): unknown[] => {
      if (!isRecord(payload) || !Array.isArray(payload.matches)) return []
      return payload.matches.filter((match) => {
        const status = matchStatusOf(match)
        if (status === null || !UPCOMING_STATUSES.has(status)) return false
        if (!isRecord(match)) return false
        const home = isRecord(match.homeTeam)
          ? nonEmptyString(match.homeTeam.name)
          : null
        const away = isRecord(match.awayTeam)
          ? nonEmptyString(match.awayTeam.name)
          : null
        if (home === null || away === null) return false
        return (
          normaliseTeamName(home) === "manchester united" ||
          normaliseTeamName(away) === "manchester united"
        )
      })
    }
    const selected = payloads.flatMap(selectUpcomingUnited)
    const upcoming = upcomingFrom(
      parseMatchesResponse({ matches: selected }),
    )
    const entry: Cached<FeedFixture[]> = { fetchedAt: nowMs, data: upcoming }
    memoryFixtures = entry
    writeCache(FOOTBALL_DATA_FIXTURES_CACHE_KEY, entry)
    return {
      status: "ok",
      fixtures: upcoming.slice(0, n),
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: nowMs,
      fromCache: false,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Feed request failed"
    log.warn("[xt:football-data] fixtures fetch failed:", message)
    if (cached) {
      const age = ageMs(cached, nowMs)
      return {
        status: "stale",
        fixtures: upcomingFrom(cached.data).slice(0, n),
        stale: true,
        mayBeOutOfDate: age > FOOTBALL_DATA_MAX_TABLE_AGE_MS,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        error: message,
      }
    }
    return {
      status: "error",
      fixtures: null,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: null,
      fromCache: false,
      error: message,
    }
  }
}

/**
 * The last `n` Premier League results as W/D/L marks, most recent
 * first (Last five, mockup rebuild 2026-11-21). Premier League only:
 * the mockup's chips are league form, and the Champions League
 * results are a different competition — mixing them would misstate
 * the league run. One past-window PL matches call (same endpoint
 * as the fixtures call, window flipped); the standings endpoint
 * carries no form data, so this is the only honest source.
 * Same typed failure states as the other getters: no key -> form
 * null, feed down + cache -> stale marks, feed down + no cache ->
 * error, form null. The hub omits the chips row when form is null
 * or empty — never invented marks.
 */
export async function getRecentForm(
  n: number = 5,
  options: FootballDataCallOptions = {},
): Promise<FeedFormResult> {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? FOOTBALL_DATA_DEFAULT_TTL_MS
  const apiKey = getFootballDataApiKey()
  if (!apiKey) {
    return {
      status: "no-key",
      form: null,
      results: null,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: null,
      fromCache: false,
      error: "No football-data.org API key saved in Settings.",
    }
  }
  const recentFrom = (list: FeedFixture[]): FeedFixture[] =>
    list
      .filter((fixture) => fixtureResultFor(fixture) !== null)
      .sort((a, b) => b.startMs - a.startMs)
  const cached = cachedEntry<FeedFixture[]>(
    memoryResults,
    FOOTBALL_DATA_RESULTS_CACHE_KEY,
  )
  if (cached && !options.forceRefresh && ageMs(cached, nowMs) <= ttlMs) {
    const recent = recentFrom(cached.data).slice(0, n)
    return {
      status: "ok",
      form: deriveLastFive(recent, n),
      results: recent,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    }
  }
  const fetchImpl = options.fetchImpl ?? (await defaultFetch())
  try {
    const payload = await fetchJson(fetchImpl, pastMatchesUrl(nowMs), apiKey)
    // Statuses and the United filter are applied to the RAW payload
    // first, so the parser only ever sees matches that matter — the
    // same shape as getNextFixtures' selectUpcomingUnited, with the
    // status set flipped to FINISHED.
    const selectFinishedUnited = (payload: unknown): unknown[] => {
      if (!isRecord(payload) || !Array.isArray(payload.matches)) return []
      return payload.matches.filter((match) => {
        const status = matchStatusOf(match)
        if (status === null || !FINISHED_STATUSES.has(status)) return false
        if (!isRecord(match)) return false
        const home = isRecord(match.homeTeam)
          ? nonEmptyString(match.homeTeam.name)
          : null
        const away = isRecord(match.awayTeam)
          ? nonEmptyString(match.awayTeam.name)
          : null
        if (home === null || away === null) return false
        return (
          normaliseTeamName(home) === "manchester united" ||
          normaliseTeamName(away) === "manchester united"
        )
      })
    }
    const finished = recentFrom(
      parseMatchesResponse({ matches: selectFinishedUnited(payload) }),
    )
    const entry: Cached<FeedFixture[]> = { fetchedAt: nowMs, data: finished }
    memoryResults = entry
    writeCache(FOOTBALL_DATA_RESULTS_CACHE_KEY, entry)
    const recent = finished.slice(0, n)
    return {
      status: "ok",
      form: deriveLastFive(recent, n),
      results: recent,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: nowMs,
      fromCache: false,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Feed request failed"
    log.warn("[xt:football-data] recent form fetch failed:", message)
    if (cached) {
      const age = ageMs(cached, nowMs)
      const recent = recentFrom(cached.data).slice(0, n)
      return {
        status: "stale",
        form: deriveLastFive(recent, n),
        results: recent,
        stale: true,
        mayBeOutOfDate: age > FOOTBALL_DATA_MAX_TABLE_AGE_MS,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        error: message,
      }
    }
    return {
      status: "error",
      form: null,
      results: null,
      stale: false,
      mayBeOutOfDate: false,
      fetchedAt: null,
      fromCache: false,
      error: message,
    }
  }
}

/**
 * Validate a key against the feed (Settings "Test key" button).
 * Returns ok only on a 2xx standings response. The key value is never
 * logged or stored here — the caller saves it via Settings storage.
 */
export async function validateFootballDataKey(
  key: string,
  fetchImpl?: FootballDataFetchImpl,
): Promise<{ ok: boolean; status?: number }> {
  const trimmed = (key || "").trim()
  if (!trimmed) return { ok: false }
  try {
    const impl = fetchImpl ?? (await defaultFetch())
    await fetchJson(
      impl,
      `${FOOTBALL_DATA_BASE_URL}/competitions/PL/standings`,
      trimmed,
    )
    return { ok: true }
  } catch (error) {
    const status =
      error instanceof FootballDataError ? error.status : undefined
    return { ok: false, status }
  }
}

// ── Station matching (feed fixture × EPG listing) ────────────────

/**
 * An EPG listing, reduced to what the matcher needs. The Phase 2 UI
 * worker maps a scanned SportsFixture to this shape (teams[0]/[1] ->
 * home/away, startMs, primary channelName, alsoOn channel names).
 * The listing is the ONLY source of a station: no match -> STATION_TBC.
 */
export interface EpgStationListing {
  home: string
  away: string
  startMs: number
  channelName: string
  alsoOn?: string[]
}

export interface MatchedFixture {
  fixture: FeedFixture
  /** Channel name(s) joined with " · ", or STATION_TBC when the EPG
   *  has no listing for this fixture yet. */
  station: string
  /** True only when the EPG actually lists this fixture. */
  stationKnown: boolean
  /** Every channel carrying the fixture (primary first). Empty when
   *  the station is TBC. */
  stations: string[]
  /** True only when stationKnown — a Watch action exists only then
   *  (plan §4.1: no Watch button on a TBC row). */
  watchable: boolean
}

/**
 * Match one feed fixture to EPG listings by (normalised teams,
 * order-insensitive, listing starts at kick-off or up to the
 * pre-match window before it — see epgListingMatchesKickoff).
 * The match is for the station only; the fixture itself is feed truth.
 */
export function matchFixtureStation(
  fixture: FeedFixture,
  listings: ReadonlyArray<EpgStationListing>,
): MatchedFixture {
  const home = normaliseTeamName(fixture.home)
  const away = normaliseTeamName(fixture.away)
  const match = listings.find((listing) => {
    if (!epgListingMatchesKickoff(listing.startMs, fixture.startMs)) {
      return false
    }
    const listingHome = normaliseTeamName(listing.home)
    const listingAway = normaliseTeamName(listing.away)
    return (
      (listingHome === home && listingAway === away) ||
      (listingHome === away && listingAway === home)
    )
  })
  if (!match) {
    return {
      fixture,
      station: STATION_TBC,
      stationKnown: false,
      stations: [],
      watchable: false,
    }
  }
  const stations = [match.channelName, ...(match.alsoOn ?? [])].filter(Boolean)
  return {
    fixture,
    station: stations.join(" · "),
    stationKnown: true,
    stations,
    watchable: true,
  }
}

/** Match every feed fixture in the list, preserving feed order. */
export function matchFixtureStations(
  fixtures: ReadonlyArray<FeedFixture>,
  listings: ReadonlyArray<EpgStationListing>,
): MatchedFixture[] {
  return fixtures.map((fixture) => matchFixtureStation(fixture, listings))
}
