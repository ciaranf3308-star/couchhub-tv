// Sports Corner v2 — MOCK football-data.org feed (TESTS ONLY).
//
// *** MOCK — NEVER import this module from production code. ***
// It exists so the Phase 1 tests (T-v2-1/2/3/5) can exercise the real
// parsers, cache, station matcher and failure states without a live
// API key (none exists) and without ever touching the network. The
// Phase 2 UI worker must call football-data.ts, never this file.
// A test in sports-corner-v2-feed.test.ts scans src/ and fails if any
// production file imports this module.
//
// WHAT IS REAL HERE (live facts checked 2026-11-20, plan §2):
// - Manchester United's table row: 18th, P10 W1 D5 L4, 14–19, −5 GD,
//   8 points, as of 16 Nov 2026. Exact, in MOCK_STANDINGS_RESPONSE.
// - The next 5 fixtures (all Europe/Dublin; Nov/Dec is GMT, so the
//   UTC times below equal local times): Liverpool (A) Sun 22 Nov
//   16:30 PL, Sporting CP (A) Wed 25 Nov 20:00 CL, Brentford (H)
//   Sat 28 Nov 15:00 PL, Newcastle (A) Wed 2 Dec 20:15 PL, Coventry
//   (H) Sat 5 Dec 15:00 PL. Exact, in the matches responses.
// - Liverpool 4th on 18 points; Sunderland level with United on 8
//   points; Crystal Palace one behind on 7 points (plan §2).
// - Venues Anfield (Liverpool) and Old Trafford (Brentford, Coventry)
//   are the only venues stated; the away venues for Sporting CP and
//   Newcastle are OMITTED, not guessed.
// - The mock EPG listing for Liverpool: Sky Sports Main Event +
//   Premier League (plan §2, verified broadcast).
//
// WHAT IS SYNTHETIC FILLER (labelled SYNTHETIC below, never real):
// - The W/D/L and goals numbers on the Liverpool, Sunderland and
//   Crystal Palace table rows. Only their position + points are live
//   facts; the rest exists so the parser has neighbours to operate on.
//   Tests assert ONLY the United row's full record and Liverpool's
//   position/points — never the filler numbers.
// - The football-data match ids (fd-535xxx): arbitrary mock ids.
//
// Broadcasters beyond Liverpool are NOT in this mock: the feed or the
// EPG must supply them; they are not hard-coded from the plan.

import type {
  EpgStationListing,
  FeedFixture,
  FootballDataFetchImpl,
  FootballDataFetchResponse,
  LeagueTable,
} from "./football-data.ts"

/** Friday 20 Nov 2026, 15:00 Europe/Dublin (= UTC, GMT). The
 *  T-v2-2 clock: a Friday afternoon when the EPG's ~36h window holds
 *  none of the next 5 fixtures (Liverpool, ~49.5h away, is nearest). */
export const MOCK_FRIDAY_AFTERNOON_MS = Date.UTC(2026, 10, 20, 15, 0, 0)

/** Table last updated 16 Nov 2026 (plan §2). */
export const MOCK_TABLE_AS_OF = "2026-11-16T00:00:00.000Z"

// ── Raw v4 payloads (what the stub fetch serves) ─────────────────

export const MOCK_STANDINGS_RESPONSE = {
  filters: { season: "2026" },
  competition: { id: 2021, name: "Premier League", code: "PL" },
  season: {
    id: 1,
    startDate: "2026-08-14",
    endDate: "2027-05-23",
    currentMatchday: 11,
  },
  standings: [
    {
      stage: "REGULAR_SEASON",
      type: "TOTAL",
      group: null,
      table: [
        // SYNTHETIC FILLER (see header): only position 4 + 18 pts are
        // live facts for Liverpool; W/D/L and goals are invented
        // shape data, never asserted by any test.
        {
          position: 4,
          team: { id: 64, name: "Liverpool FC", shortName: "Liverpool", tla: "LIV" },
          playedGames: 10,
          won: 6,
          draw: 0,
          lost: 4,
          points: 18,
          goalsFor: 20,
          goalsAgainst: 10,
          goalDifference: 10,
        },
        // SYNTHETIC FILLER: only position 17 + 8 pts are live facts
        // ("level with Sunderland" — plan §2).
        {
          position: 17,
          team: { id: 71, name: "Sunderland AFC", shortName: "Sunderland", tla: "SUN" },
          playedGames: 10,
          won: 2,
          draw: 2,
          lost: 6,
          points: 8,
          goalsFor: 9,
          goalsAgainst: 18,
          goalDifference: -9,
        },
        // LIVE FACT (plan §2): United 18th, P10 W1 D5 L4, 14–19, −5, 8 pts.
        {
          position: 18,
          team: { id: 66, name: "Manchester United FC", shortName: "Man United", tla: "MUN" },
          playedGames: 10,
          won: 1,
          draw: 5,
          lost: 4,
          points: 8,
          goalsFor: 14,
          goalsAgainst: 19,
          goalDifference: -5,
        },
        // SYNTHETIC FILLER: only position 19 + 7 pts are live facts
        // ("one ahead of Crystal Palace" — plan §2).
        {
          position: 19,
          team: { id: 354, name: "Crystal Palace FC", shortName: "Crystal Palace", tla: "CRY" },
          playedGames: 10,
          won: 1,
          draw: 4,
          lost: 5,
          points: 7,
          goalsFor: 10,
          goalsAgainst: 16,
          goalDifference: -6,
        },
      ],
    },
  ],
}

function mockMatch(
  id: number,
  utcDate: string,
  homeTeam: string,
  awayTeam: string,
  competition: string,
  competitionCode: string,
  venue?: string,
) {
  return {
    id,
    utcDate,
    status: "SCHEDULED",
    matchday: 11,
    stage: "REGULAR_SEASON",
    group: null,
    homeTeam: { id: 1, name: homeTeam },
    awayTeam: { id: 2, name: awayTeam },
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    competition: { id: competitionCode === "PL" ? 2021 : 2001, name: competition, code: competitionCode },
    ...(venue ? { venue } : {}),
  }
}

/** Premier League fixtures (raw v4 shape). Times are UTC == Dublin. */
export const MOCK_PL_MATCHES_RESPONSE = {
  filters: { dateFrom: "2026-11-20", dateTo: "2027-02-18" },
  resultSet: { count: 4 },
  competition: { id: 2021, name: "Premier League", code: "PL" },
  matches: [
    mockMatch(
      535101,
      "2026-11-22T16:30:00Z",
      "Liverpool FC",
      "Manchester United FC",
      "Premier League",
      "PL",
      "Anfield",
    ),
    mockMatch(
      535112,
      "2026-11-28T15:00:00Z",
      "Manchester United FC",
      "Brentford FC",
      "Premier League",
      "PL",
      "Old Trafford",
    ),
    mockMatch(
      535125,
      "2026-12-02T20:15:00Z",
      "Newcastle United FC",
      "Manchester United FC",
      "Premier League",
      "PL",
    ),
    mockMatch(
      535138,
      "2026-12-05T15:00:00Z",
      "Manchester United FC",
      "Coventry City FC",
      "Premier League",
      "PL",
      "Old Trafford",
    ),
  ],
}

/** Champions League fixtures (raw v4 shape). */
export const MOCK_CL_MATCHES_RESPONSE = {
  filters: { dateFrom: "2026-11-20", dateTo: "2027-02-18" },
  resultSet: { count: 1 },
  competition: { id: 2001, name: "UEFA Champions League", code: "CL" },
  matches: [
    mockMatch(
      535201,
      "2026-11-25T20:00:00Z",
      "Sporting Clube de Portugal",
      "Manchester United FC",
      "UEFA Champions League",
      "CL",
    ),
  ],
}

// ── Parsed conveniences (what the mock fetch produces) ───────────

export const MOCK_LEAGUE_TABLE: LeagueTable = {
  competition: "Premier League",
  entries: [
    { position: 4, team: "Liverpool FC", played: 10, won: 6, drawn: 0, lost: 4, gf: 20, ga: 10, gd: 10, points: 18 },
    { position: 17, team: "Sunderland AFC", played: 10, won: 2, drawn: 2, lost: 6, gf: 9, ga: 18, gd: -9, points: 8 },
    { position: 18, team: "Manchester United FC", played: 10, won: 1, drawn: 5, lost: 4, gf: 14, ga: 19, gd: -5, points: 8 },
    { position: 19, team: "Crystal Palace FC", played: 10, won: 1, drawn: 4, lost: 5, gf: 10, ga: 16, gd: -6, points: 7 },
  ],
  asOf: MOCK_TABLE_AS_OF,
  source: "football-data.org",
}

export const MOCK_NEXT_FIXTURES: FeedFixture[] = [
  {
    id: "fd-535101",
    home: "Liverpool FC",
    away: "Manchester United FC",
    competition: "Premier League",
    startMs: Date.UTC(2026, 10, 22, 16, 30, 0),
    venue: "Anfield",
  },
  {
    id: "fd-535201",
    home: "Sporting Clube de Portugal",
    away: "Manchester United FC",
    competition: "UEFA Champions League",
    startMs: Date.UTC(2026, 10, 25, 20, 0, 0),
  },
  {
    id: "fd-535112",
    home: "Manchester United FC",
    away: "Brentford FC",
    competition: "Premier League",
    startMs: Date.UTC(2026, 10, 28, 15, 0, 0),
    venue: "Old Trafford",
  },
  {
    id: "fd-535125",
    home: "Newcastle United FC",
    away: "Manchester United FC",
    competition: "Premier League",
    startMs: Date.UTC(2026, 11, 2, 20, 15, 0),
  },
  {
    id: "fd-535138",
    home: "Manchester United FC",
    away: "Coventry City FC",
    competition: "Premier League",
    startMs: Date.UTC(2026, 11, 5, 15, 0, 0),
    venue: "Old Trafford",
  },
]

/**
 * Mock EPG listings for T-v2-3. Only Liverpool is inside the EPG's
 * ~36h window on a matchday weekend; the other four fixtures have no
 * listing yet, so they must render "Station TBC". The Liverpool
 * listing carries both simulcast channels (plan §2: Sky Sports Main
 * Event + Premier League).
 */
export const MOCK_EPG_LISTINGS: EpgStationListing[] = [
  {
    home: "Liverpool",
    away: "Manchester United",
    startMs: Date.UTC(2026, 10, 22, 16, 30, 0),
    channelName: "Sky Sports Main Event",
    alsoOn: ["Sky Sports Premier League"],
  },
]

// ── Stub fetch implementations (tests only) ──────────────────────

function mockResponse(
  payload: unknown,
  status = 200,
): FootballDataFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: () => null },
  }
}

export interface MockFetch extends FootballDataFetchImpl {
  /** Every URL the stub was called with, in order. */
  calls: string[]
  /** The X-Auth-Token header values seen, in order. */
  tokensSeen: string[]
}

/**
 * A stub fetch that serves the mock payloads by endpoint and records
 * calls. Never touches the network. The standings + matches URLs are
 * matched on path only (query params ignored).
 */
export function createMockFetch(): MockFetch {
  const calls: string[] = []
  const tokensSeen: string[] = []
  const impl = (async (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    calls.push(url)
    const token = init?.headers?.["X-Auth-Token"] ?? ""
    tokensSeen.push(token)
    if (url.includes("/competitions/PL/standings")) {
      return mockResponse(MOCK_STANDINGS_RESPONSE)
    }
    if (url.includes("/competitions/PL/matches")) {
      return mockResponse(MOCK_PL_MATCHES_RESPONSE)
    }
    if (url.includes("/competitions/CL/matches")) {
      return mockResponse(MOCK_CL_MATCHES_RESPONSE)
    }
    return mockResponse({ error: "mock: unknown endpoint" }, 404)
  }) as MockFetch
  impl.calls = calls
  impl.tokensSeen = tokensSeen
  return impl
}

/** A stub fetch that always fails (feed-down, T-v2-5). */
export function createFailingFetch(status = 500): FootballDataFetchImpl {
  return async () => mockResponse({ error: "mock feed down" }, status)
}
