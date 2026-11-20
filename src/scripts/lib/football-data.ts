// Sports Corner v2 — football-data.org feed client (Phase 1, plan §5.1).
//
// Table + next fixtures come from football-data.org (free tier, €0 —
// approved 2026-11-20, D1-A). Stations and tune-in still come from the
// EPG; this module NEVER invents a station, a table row or a fixture.
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
// Network: plain `fetch()` from the frontend, exactly like the TMDB
// client (tmdb.ts). No Tauri allow-list entry is needed:
// src-tauri/capabilities/default.json already allows `https://**/*`,
// and safe_fetch.rs is only the manifest probe, not a fetch gate.
// Rate limit (free tier): 10 requests/minute. A refresh needs 3 calls
// (standings + PL matches + CL matches) and is cached for 1h, so
// normal use is far inside the limit.
//
// Tests must NEVER hit the live API (no key exists): every public
// fetch takes an injectable `fetchImpl`, and the parsers are pure.

import { log } from "@/scripts/lib/log.js"

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

/** Default cache TTL: 1h (plan §5.1). */
export const FOOTBALL_DATA_DEFAULT_TTL_MS = 60 * 60 * 1000

/** A table older than this is never presented as current: the UI must
 *  flag it "may be out of date" (plan §5.1, T-v2-5). */
export const FOOTBALL_DATA_MAX_TABLE_AGE_MS = 24 * 60 * 60 * 1000

/** "Station TBC" — the only station text used when the EPG has no
 *  listing for a feed fixture yet. Never a guessed channel. */
export const STATION_TBC = "Station TBC"

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
}

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
  lsRemove(FOOTBALL_DATA_TABLE_CACHE_KEY)
  lsRemove(FOOTBALL_DATA_FIXTURES_CACHE_KEY)
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
    return fixture
  })
}

/** The feed's own status values for a match that has not kicked off. */
const UPCOMING_STATUSES: ReadonlySet<string> = new Set([
  "SCHEDULED",
  "TIMED",
])

function matchStatusOf(match: unknown): string | null {
  return isRecord(match) ? nonEmptyString(match.status) : null
}

// ── Feed fetching ─────────────────────────────────────────────────

function defaultFetch(): FootballDataFetchImpl {
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
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  try {
    const payload = await fetchJson(
      fetchImpl,
      `${FOOTBALL_DATA_BASE_URL}/v4/competitions/PL/standings`,
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

function matchesUrl(competition: "PL" | "CL", nowMs: number): string {
  const from = footballDataDate(new Date(nowMs))
  const to = footballDataDate(new Date(nowMs + 90 * 24 * 60 * 60 * 1000))
  return (
    `${FOOTBALL_DATA_BASE_URL}/v4/competitions/${competition}/matches` +
    `?dateFrom=${from}&dateTo=${to}`
  )
}

/**
 * The next `n` Manchester United fixtures (Premier League + Champions
 * League, D3 = A: next 5 by default), earliest first. Fixtures are
 * feed truth; the station for each comes from the EPG via
 * matchFixtureStations() — never from here.
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
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  try {
    const [plPayload, clPayload] = await Promise.all([
      fetchJson(fetchImpl, matchesUrl("PL", nowMs), apiKey),
      fetchJson(fetchImpl, matchesUrl("CL", nowMs), apiKey),
    ])
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
    const selected = [
      ...selectUpcomingUnited(plPayload),
      ...selectUpcomingUnited(clPayload),
    ]
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
    const impl = fetchImpl ?? defaultFetch()
    await fetchJson(
      impl,
      `${FOOTBALL_DATA_BASE_URL}/v4/competitions/PL/standings`,
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
 * order-insensitive, start within the same minute). The match is for
 * the station only; the fixture itself is feed truth.
 */
export function matchFixtureStation(
  fixture: FeedFixture,
  listings: ReadonlyArray<EpgStationListing>,
): MatchedFixture {
  const fixtureMinute = Math.floor(fixture.startMs / 60_000)
  const home = normaliseTeamName(fixture.home)
  const away = normaliseTeamName(fixture.away)
  const match = listings.find((listing) => {
    if (Math.floor(listing.startMs / 60_000) !== fixtureMinute) return false
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
