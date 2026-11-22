// Sports Corner v2 — Phase 1 feed tests (plan §8, T-v2-1/2/3/5).
//
// Tests NEVER hit the live API: every network call goes through the
// mock fetch in football-data-mock.ts (or a failing stub), and the
// API key used in the header test is generated at runtime — no key
// value, real or fake, is written in this file.
//
// Clock: Friday 20 Nov 2026, 15:00 Europe/Dublin
// (MOCK_FRIDAY_AFTERNOON_MS) — a Friday afternoon when the EPG's
// ~36h window holds none of the next 5 fixtures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FOOTBALL_DATA_FA_CUP_CODE,
  FOOTBALL_DATA_FIXTURES_CACHE_KEY,
  FOOTBALL_DATA_FIXTURE_COMPETITIONS,
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  FOOTBALL_DATA_LEAGUE_CUP_CODE,
  FOOTBALL_DATA_LIVE_CACHE_KEY,
  FOOTBALL_DATA_RESULTS_CACHE_KEY,
  FOOTBALL_DATA_TABLE_CACHE_KEY,
  STATION_TBC,
  clearFootballDataCache,
  deriveLastFive,
  fixtureResultFor,
  getFootballDataKeyState,
  getLeagueTable,
  getLiveFixtures,
  getNextFixtures,
  getRecentForm,
  matchFixtureStation,
  matchFixtureStations,
  parseMatchesResponse,
  parseStandingsResponse,
  validateFootballDataKey,
} from "@/scripts/lib/football-data.ts"
import {
  MOCK_CL_MATCHES_RESPONSE,
  MOCK_EPG_LISTINGS,
  MOCK_FRIDAY_AFTERNOON_MS,
  MOCK_LEAGUE_TABLE,
  MOCK_NEXT_FIXTURES,
  MOCK_PL_MATCHES_RESPONSE,
  MOCK_PL_RESULTS_RESPONSE,
  MOCK_STANDINGS_RESPONSE,
  createFailingFetch,
  createMockFetch,
} from "@/scripts/lib/football-data-mock.ts"

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
}

const FRIDAY = MOCK_FRIDAY_AFTERNOON_MS
const HOUR_MS = 60 * 60 * 1000

/** Runtime-generated key for the header test — never a literal. */
function runtimeTestKey(): string {
  return `test-key-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function setKey(key: string): void {
  localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, key)
}

function seedTableCache(fetchedAt: number): void {
  localStorage.setItem(
    FOOTBALL_DATA_TABLE_CACHE_KEY,
    JSON.stringify({ fetchedAt, data: MOCK_LEAGUE_TABLE }),
  )
}

function seedFixturesCache(fetchedAt: number): void {
  localStorage.setItem(
    FOOTBALL_DATA_FIXTURES_CACHE_KEY,
    JSON.stringify({ fetchedAt, data: MOCK_NEXT_FIXTURES }),
  )
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage())
  clearFootballDataCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("T-v2-1 — table parsing + United row from the mock", () => {
  it("parses the mock standings payload into a Premier League table", () => {
    const table = parseStandingsResponse(MOCK_STANDINGS_RESPONSE, FRIDAY)
    expect(table.competition).toBe("Premier League")
    expect(table.source).toBe("football-data.org")
    expect(table.asOf).toBe(new Date(FRIDAY).toISOString())
    expect(table.entries.length).toBeGreaterThanOrEqual(4)
  })

  it("renders United 18th, P10 W1 D5 L4, 14–19, −5 GD, 8 pts (16 Nov 2026)", () => {
    const table = parseStandingsResponse(MOCK_STANDINGS_RESPONSE, FRIDAY)
    const united = table.entries.find((entry) => entry.position === 18)
    expect(united).toEqual({
      position: 18,
      team: "Manchester United FC",
      played: 10,
      won: 1,
      drawn: 5,
      lost: 4,
      gf: 14,
      ga: 19,
      gd: -5,
      points: 8,
    })
  })

  it("getLeagueTable returns status ok with the United row (mock fetch)", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    const result = await getLeagueTable({ fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(result.status).toBe("ok")
    expect(result.stale).toBe(false)
    expect(result.mayBeOutOfDate).toBe(false)
    const united = result.table?.entries.find((entry) => entry.position === 18)
    expect(united?.points).toBe(8)
    expect(united?.gd).toBe(-5)
    // The standings endpoint was actually hit.
    expect(mockFetch.calls.some((url) => url.includes("/PL/standings"))).toBe(true)
  })

  it("a malformed standings payload rejects instead of half-rendering", () => {
    expect(() => parseStandingsResponse({ standings: [] }, FRIDAY)).toThrow()
    expect(() => parseStandingsResponse({ standings: [{ type: "TOTAL", table: [{ position: 1 }] }] }, FRIDAY)).toThrow()
    expect(() => parseStandingsResponse(null, FRIDAY)).toThrow()
  })
})

describe("T-v2-2 — next 5 ordering + competitions on a Friday afternoon", () => {
  it("lists Liverpool → Sporting CP → Brentford → Newcastle → Coventry, in order", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    const result = await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(result.status).toBe("ok")
    expect(result.fixtures).toHaveLength(5)
    const starts = result.fixtures!.map((fixture) => fixture.startMs)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(result.fixtures!.map((fixture) => `${fixture.home} v ${fixture.away}`)).toEqual([
      "Liverpool FC v Manchester United FC",
      "Sporting Clube de Portugal v Manchester United FC",
      "Manchester United FC v Brentford FC",
      "Newcastle United FC v Manchester United FC",
      "Manchester United FC v Coventry City FC",
    ])
  })

  it("carries the right competition per fixture (PL / CL)", async () => {
    setKey(runtimeTestKey())
    const result = await getNextFixtures(5, {
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    expect(result.fixtures!.map((fixture) => fixture.competition)).toEqual([
      "Premier League",
      "UEFA Champions League",
      "Premier League",
      "Premier League",
      "Premier League",
    ])
  })

  it("none of the five is inside the EPG's ~36h window on Friday afternoon", async () => {
    setKey(runtimeTestKey())
    const result = await getNextFixtures(5, {
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    const windowEnd = FRIDAY + 36 * HOUR_MS
    for (const fixture of result.fixtures!) {
      expect(fixture.startMs).toBeGreaterThan(windowEnd)
    }
    // Nearest is Liverpool, ~49.5h out — the exact v1 failure case.
    expect(result.fixtures![0].startMs - FRIDAY).toBe(49.5 * HOUR_MS)
  })

  it("the raw parsers accept both competition payloads", () => {
    const pl = parseMatchesResponse(MOCK_PL_MATCHES_RESPONSE)
    const cl = parseMatchesResponse(MOCK_CL_MATCHES_RESPONSE)
    expect(pl).toHaveLength(4)
    expect(cl).toHaveLength(1)
    expect(cl[0].competition).toBe("UEFA Champions League")
  })

  it("a second call inside the TTL reuses the cache (no second fetch)", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY + 30 * 60_000 })
    expect(mockFetch.calls.length).toBe(2) // PL + CL once; second call served from cache
  })
})

describe("feed URL shape — exactly one /v4/ per request (bug 1, 21 Nov)", () => {
  it("no request URL ever contains /v4/v4/ (base URL already ends in /v4)", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    await getLeagueTable({ fetchImpl: mockFetch, nowMs: FRIDAY })
    await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(mockFetch.calls.length).toBe(3) // standings + PL matches + CL matches
    for (const url of mockFetch.calls) {
      expect(url).not.toContain("/v4/v4/")
      // Exactly one /v4/ segment: the one in the base URL.
      expect(url.split("/v4/").length - 1).toBe(1)
    }
  })

  it("standings hits https://api.football-data.org/v4/competitions/PL/standings", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    await getLeagueTable({ fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(mockFetch.calls).toEqual([
      "https://api.football-data.org/v4/competitions/PL/standings",
    ])
  })

  it("fixtures hit the PL + CL matches URLs with the 90-day window", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(mockFetch.calls).toEqual([
      "https://api.football-data.org/v4/competitions/PL/matches?dateFrom=2026-11-20&dateTo=2027-02-18",
      "https://api.football-data.org/v4/competitions/CL/matches?dateFrom=2026-11-20&dateTo=2027-02-18",
    ])
  })

  it("validateFootballDataKey tests the key against the single-/v4/ standings URL", async () => {
    const seen: string[] = []
    const recordingFetch = (async (url: string) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => MOCK_STANDINGS_RESPONSE,
        headers: { get: () => null },
      }
    }) as Parameters<typeof validateFootballDataKey>[1]
    expect(await validateFootballDataKey(runtimeTestKey(), recordingFetch)).toEqual({
      ok: true,
    })
    expect(seen).toEqual([
      "https://api.football-data.org/v4/competitions/PL/standings",
    ])
    expect(seen[0]).not.toContain("/v4/v4/")
  })
})

describe("domestic cups — free-tier gap, not fetched (bug 5, 21 Nov)", () => {
  it("getNextFixtures only ever calls PL and CL — never FAC or FLC", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    const result = await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(result.status).toBe("ok")
    expect(mockFetch.calls).toHaveLength(2)
    expect(mockFetch.calls.some((url) => url.includes("/competitions/FAC/"))).toBe(false)
    expect(mockFetch.calls.some((url) => url.includes("/competitions/FLC/"))).toBe(false)
    expect(mockFetch.calls.some((url) => url.includes("/competitions/PL/matches"))).toBe(true)
    expect(mockFetch.calls.some((url) => url.includes("/competitions/CL/matches"))).toBe(true)
  })

  it("cup codes are FAC (FA Cup) and FLC (League Cup) — ELC is the Championship, never a cup", () => {
    // Codes from the v4 lookup tables (docs.football-data.org):
    // FAC id 2055, FLC id 2139, ELC id 2016 = Championship.
    expect(FOOTBALL_DATA_FA_CUP_CODE).toBe("FAC")
    expect(FOOTBALL_DATA_LEAGUE_CUP_CODE).toBe("FLC")
    expect(FOOTBALL_DATA_FIXTURE_COMPETITIONS).toEqual(["PL", "CL"])
    expect(FOOTBALL_DATA_FIXTURE_COMPETITIONS).not.toContain("ELC")
    expect(FOOTBALL_DATA_FIXTURE_COMPETITIONS).not.toContain("FAC")
    expect(FOOTBALL_DATA_FIXTURE_COMPETITIONS).not.toContain("FLC")
  })

  it("the mock serves no cup payloads — a cup URL 404s, matching the client", async () => {
    const mockFetch = createMockFetch()
    const response = await mockFetch(
      "https://api.football-data.org/v4/competitions/FAC/matches?dateFrom=2026-11-20&dateTo=2027-02-18",
      { headers: { "X-Auth-Token": runtimeTestKey() } },
    )
    expect(response.ok).toBe(false)
    expect(response.status).toBe(404)
  })
})

describe("T-v2-3 — station matched vs Station TBC, no invented Watch data", () => {
  it("Liverpool matches Sky Sports Main Event + Premier League", () => {
    const matched = matchFixtureStations(MOCK_NEXT_FIXTURES, MOCK_EPG_LISTINGS)
    const liverpool = matched[0]
    expect(liverpool.stationKnown).toBe(true)
    expect(liverpool.watchable).toBe(true)
    expect(liverpool.stations).toEqual([
      "Sky Sports Main Event",
      "Sky Sports Premier League",
    ])
    expect(liverpool.station).toContain("Sky Sports Main Event")
    expect(liverpool.station).toContain("Sky Sports Premier League")
  })

  it("the other four fixtures show Station TBC with no Watch", () => {
    const matched = matchFixtureStations(MOCK_NEXT_FIXTURES, MOCK_EPG_LISTINGS)
    for (const row of matched.slice(1)) {
      expect(row.station).toBe(STATION_TBC)
      expect(row.stationKnown).toBe(false)
      expect(row.stations).toEqual([])
      expect(row.watchable).toBe(false)
    }
  })

  it("matching is by normalised teams + the pre-match window (bug 4b)", () => {
    const fixture = MOCK_NEXT_FIXTURES[0]
    // 30 minutes before kick-off (pre-match build-up): still the
    // same fixture's broadcast.
    const prematch = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: fixture.startMs - 30 * 60_000 },
    ])
    expect(prematch.stationKnown).toBe(true)
    // After kick-off the broadcast has already begun elsewhere — a
    // listing starting 30s late is NOT this fixture (the old
    // same-minute rule matched it; the pre-match window does not).
    const afterKickoff = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: fixture.startMs + 30_000 },
    ])
    expect(afterKickoff.station).toBe(STATION_TBC)
    // One minute later: a different slot, no match, TBC.
    const nextMinute = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: fixture.startMs + 61_000 },
    ])
    expect(nextMinute.station).toBe(STATION_TBC)
    // Reversed sides (EPG lists away first) still match.
    const reversed = matchFixtureStation(fixture, [
      {
        home: "Manchester United",
        away: "Liverpool",
        startMs: fixture.startMs,
        channelName: "Sky Sports Main Event",
      },
    ])
    expect(reversed.stationKnown).toBe(true)
    // A different opponent at the same time does not match.
    const wrongTeams = matchFixtureStation(fixture, [
      {
        home: "Liverpool",
        away: "Chelsea",
        startMs: fixture.startMs,
        channelName: "Sky Sports Main Event",
      },
    ])
    expect(wrongTeams.station).toBe(STATION_TBC)
  })
})

describe("T-v2-5 — feed-down failure state + stale >24h flag", () => {
  it("feed down with no cache → error status, null data (table + fixtures)", async () => {
    setKey(runtimeTestKey())
    const failing = createFailingFetch(500)
    const table = await getLeagueTable({ fetchImpl: failing, nowMs: FRIDAY })
    expect(table.status).toBe("error")
    expect(table.table).toBeNull()
    expect(table.stale).toBe(false)
    const fixtures = await getNextFixtures(5, { fetchImpl: failing, nowMs: FRIDAY })
    expect(fixtures.status).toBe("error")
    expect(fixtures.fixtures).toBeNull()
  })

  it("feed down with a 25h-old cache → stale + mayBeOutOfDate, data still served", async () => {
    setKey(runtimeTestKey())
    seedTableCache(FRIDAY - 25 * HOUR_MS)
    seedFixturesCache(FRIDAY - 25 * HOUR_MS)
    const failing = createFailingFetch(500)
    const table = await getLeagueTable({ fetchImpl: failing, nowMs: FRIDAY })
    expect(table.status).toBe("stale")
    expect(table.stale).toBe(true)
    expect(table.mayBeOutOfDate).toBe(true)
    expect(table.table?.entries.find((entry) => entry.position === 18)?.points).toBe(8)
    const fixtures = await getNextFixtures(5, { fetchImpl: failing, nowMs: FRIDAY })
    expect(fixtures.status).toBe("stale")
    expect(fixtures.mayBeOutOfDate).toBe(true)
    expect(fixtures.fixtures).toHaveLength(5)
  })

  it("feed down with a 2h-old cache → stale but NOT mayBeOutOfDate", async () => {
    setKey(runtimeTestKey())
    seedTableCache(FRIDAY - 2 * HOUR_MS)
    const table = await getLeagueTable({
      fetchImpl: createFailingFetch(500),
      nowMs: FRIDAY,
    })
    expect(table.status).toBe("stale")
    expect(table.stale).toBe(true)
    expect(table.mayBeOutOfDate).toBe(false)
    expect(table.table).not.toBeNull()
  })

  it("a 401 from the feed is reported as an error, not a stale table", async () => {
    setKey(runtimeTestKey())
    const table = await getLeagueTable({
      fetchImpl: createFailingFetch(401),
      nowMs: FRIDAY,
    })
    expect(table.status).toBe("error")
    expect(table.table).toBeNull()
    expect(table.error).toContain("API key")
  })
})

describe("key storage — honest no-key state, key never in code", () => {
  it("missing key → no-key status, null data, and no fetch is made", async () => {
    const mockFetch = createMockFetch()
    const table = await getLeagueTable({ fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(table.status).toBe("no-key")
    expect(table.table).toBeNull()
    expect(getFootballDataKeyState()).toBe("missing")
    const fixtures = await getNextFixtures(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(fixtures.status).toBe("no-key")
    expect(fixtures.fixtures).toBeNull()
    expect(mockFetch.calls).toHaveLength(0)
  })

  it("the stored key is sent as the X-Auth-Token header (runtime key)", async () => {
    const key = runtimeTestKey()
    setKey(key)
    const mockFetch = createMockFetch()
    await getLeagueTable({ fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(mockFetch.tokensSeen).toHaveLength(1)
    expect(mockFetch.tokensSeen[0]).toBe(key)
    expect(getFootballDataKeyState()).toBe("set")
  })

  it("validateFootballDataKey ok on 2xx, not ok on 401", async () => {
    const key = runtimeTestKey()
    expect(await validateFootballDataKey(key, createMockFetch())).toEqual({ ok: true })
    expect(await validateFootballDataKey(key, createFailingFetch(401))).toEqual({
      ok: false,
      status: 401,
    })
    expect(await validateFootballDataKey("   ")).toEqual({ ok: false })
  })

  it("no hard-coded token in the feed client, the mock, or Settings storage", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const repo = join(here, "..")
    const files = [
      "src/scripts/lib/football-data.ts",
      "src/scripts/lib/football-data-mock.ts",
      "src/scripts/lib/app-settings.js",
    ]
    for (const relative of files) {
      const content = readFileSync(join(repo, relative), "utf8")
      // A football-data.org token is a 32-char hex string. None may
      // appear anywhere in these files — the key comes from Settings.
      expect(content).not.toMatch(/[0-9a-f]{32}/i)
    }
    // The storage key name is the single source of truth, defined in
    // the client; Settings storage references the constant, never a
    // second literal.
    const client = readFileSync(
      join(repo, "src/scripts/lib/football-data.ts"),
      "utf8",
    )
    expect(client).toContain("xt_football_data_key")
    const settings = readFileSync(
      join(repo, "src/scripts/lib/app-settings.js"),
      "utf8",
    )
    expect(settings).toContain("FOOTBALL_DATA_KEY_STORAGE_KEY")
    expect(settings).toContain("getFootballDataApiKey")
    expect(settings).toContain("setFootballDataApiKey")
    // The mock is labelled MOCK and carries no key storage at all.
    const mock = readFileSync(
      join(repo, "src/scripts/lib/football-data-mock.ts"),
      "utf8",
    )
    expect(mock).toContain("MOCK")
    expect(mock).not.toContain("xt_football_data_key")
  })

  it("the mock module is never imported by production code", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const srcDir = join(here, "..", "src")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!/\.(ts|js|astro)$/.test(entry)) continue
        const content = readFileSync(path, "utf8")
        if (content.includes("football-data-mock")) offenders.push(path)
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})

describe("Last five — recent form from finished PL results (mockup rebuild, 21 Nov)", () => {
  it("parser keeps status + full-time score on FINISHED rows, nulls on SCHEDULED rows", () => {
    const finished = parseMatchesResponse(MOCK_PL_RESULTS_RESPONSE)
    expect(finished).toHaveLength(5)
    // Most recent first in the payload is last: Villa 4–4 at home.
    const villa = finished[4]
    expect(villa.home).toBe("Manchester United FC")
    expect(villa.status).toBe("FINISHED")
    expect(villa.score).toEqual({ home: 4, away: 4 })
    const upcoming = parseMatchesResponse(MOCK_PL_MATCHES_RESPONSE)
    expect(upcoming[0].status).toBe("SCHEDULED")
    expect(upcoming[0].score).toEqual({ home: null, away: null })
  })

  it("parser rejects a FINISHED row with no full-time score — never guess a result", () => {
    expect(() =>
      parseMatchesResponse({
        matches: [
          {
            id: 1,
            utcDate: "2026-11-08T15:00:00Z",
            status: "FINISHED",
            homeTeam: { name: "Manchester United FC" },
            awayTeam: { name: "Aston Villa FC" },
            score: {
              fullTime: { home: null, away: null },
            },
            competition: { name: "Premier League" },
          },
        ],
      }),
    ).toThrow("no full-time score")
  })

  it("deriveLastFive: real mock results → D L L D D, most recent first", () => {
    const fixtures = parseMatchesResponse(MOCK_PL_RESULTS_RESPONSE)
    expect(deriveLastFive(fixtures)).toEqual(["D", "L", "L", "D", "D"])
  })

  it("deriveLastFive ignores non-United finished rows, scheduled rows, and unscored rows", () => {
    const fixtures = parseMatchesResponse({
      matches: [
        {
          id: 1,
          utcDate: "2026-11-08T15:00:00Z",
          status: "FINISHED",
          homeTeam: { name: "Arsenal FC" },
          awayTeam: { name: "Chelsea FC" },
          score: { fullTime: { home: 2, away: 0 } },
          competition: { name: "Premier League" },
        },
        {
          id: 2,
          utcDate: "2026-11-20T20:00:00Z",
          status: "SCHEDULED",
          homeTeam: { name: "Manchester United FC" },
          awayTeam: { name: "Coventry City FC" },
          score: { fullTime: { home: null, away: null } },
          competition: { name: "Premier League" },
        },
        {
          id: 3,
          utcDate: "2026-11-08T15:00:00Z",
          status: "FINISHED",
          homeTeam: { name: "Manchester United FC" },
          awayTeam: { name: "Aston Villa FC" },
          score: { fullTime: { home: 4, away: 4 } },
          competition: { name: "Premier League" },
        },
      ],
    })
    expect(deriveLastFive(fixtures)).toEqual(["D"])
  })

  it("fixtureResultFor reads the result from United's side (away win is W, home loss is L)", () => {
    const [awayWin, homeLoss] = parseMatchesResponse({
      matches: [
        {
          id: 1,
          utcDate: "2026-10-31T15:00:00Z",
          status: "FINISHED",
          homeTeam: { name: "Chelsea FC" },
          awayTeam: { name: "Manchester United FC" },
          score: { fullTime: { home: 0, away: 2 } },
          competition: { name: "Premier League" },
        },
        {
          id: 2,
          utcDate: "2026-10-25T15:00:00Z",
          status: "FINISHED",
          homeTeam: { name: "Manchester United FC" },
          awayTeam: { name: "AFC Bournemouth" },
          score: { fullTime: { home: 0, away: 3 } },
          competition: { name: "Premier League" },
        },
      ],
    })
    expect(fixtureResultFor(awayWin)).toBe("W")
    expect(fixtureResultFor(homeLoss)).toBe("L")
    expect(deriveLastFive([])).toEqual([])
  })

  it("getRecentForm calls the past-window PL matches URL and returns D L L D D", async () => {
    setKey(runtimeTestKey())
    const mockFetch = createMockFetch()
    const form = await getRecentForm(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(form.status).toBe("ok")
    expect(form.form).toEqual(["D", "L", "L", "D", "D"])
    expect(form.results).toHaveLength(5)
    // Most recent first: Villa 4–4 at home, 8 Nov.
    expect(form.results?.[0].home).toBe("Manchester United FC")
    expect(form.results?.[0].away).toBe("Aston Villa FC")
    expect(form.results?.[0].score).toEqual({ home: 4, away: 4 })
    // The call went to the past window (today − 90d → today), not
    // the future fixtures window — the mock routes on dateFrom.
    expect(mockFetch.calls).toHaveLength(1)
    expect(mockFetch.calls[0]).toContain("/competitions/PL/matches")
    expect(mockFetch.calls[0]).toContain("dateFrom=2026-08-22")
    expect(mockFetch.calls[0]).toContain("dateTo=2026-11-20")
    // Second call inside the TTL is served from cache: no new fetch.
    const cached = await getRecentForm(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(cached.status).toBe("ok")
    expect(cached.fromCache).toBe(true)
    expect(cached.form).toEqual(["D", "L", "L", "D", "D"])
    expect(mockFetch.calls).toHaveLength(1)
  })

  it("getRecentForm: no key → no-key + null form + no fetch; feed down → error + null form", async () => {
    const mockFetch = createMockFetch()
    const noKey = await getRecentForm(5, { fetchImpl: mockFetch, nowMs: FRIDAY })
    expect(noKey.status).toBe("no-key")
    expect(noKey.form).toBeNull()
    expect(noKey.results).toBeNull()
    expect(mockFetch.calls).toHaveLength(0)

    setKey(runtimeTestKey())
    const down = await getRecentForm(5, {
      fetchImpl: createFailingFetch(500),
      nowMs: FRIDAY,
    })
    expect(down.status).toBe("error")
    expect(down.form).toBeNull()
  })

  it("getRecentForm: stale cache is served with the stale flag when the feed fails", async () => {
    setKey(runtimeTestKey())
    const recent = parseMatchesResponse(MOCK_PL_RESULTS_RESPONSE)
    localStorage.setItem(
      FOOTBALL_DATA_RESULTS_CACHE_KEY,
      JSON.stringify({ fetchedAt: FRIDAY - 25 * HOUR_MS, data: recent }),
    )
    const stale = await getRecentForm(5, {
      fetchImpl: createFailingFetch(500),
      nowMs: FRIDAY,
      ttlMs: 0,
    })
    expect(stale.status).toBe("stale")
    expect(stale.stale).toBe(true)
    expect(stale.mayBeOutOfDate).toBe(true)
    expect(stale.form).toEqual(["D", "L", "L", "D", "D"])
  })
})

describe("getLiveFixtures — live United fixtures for on-TV-now (feed-first, 0.11.26)", () => {
  // Sun 22 Nov 2026 17:33 — Liverpool v Man Utd kicked off 16:30
  // and is IN_PLAY. The live call is the feed half of on-TV-now:
  // getNextFixtures only ever returns fixtures that have NOT kicked
  // off, so without this the hub could not know a match was live
  // from the feed at all.
  const SUNDAY_1733 = Date.UTC(2026, 10, 22, 17, 33, 0)

  function liveMatch(
    id: number,
    utcDate: string,
    status: string,
    homeTeam: string,
    awayTeam: string,
    competition = "Premier League",
  ) {
    return {
      id,
      utcDate,
      status,
      homeTeam: { name: homeTeam },
      awayTeam: { name: awayTeam },
      score: { fullTime: { home: 1, away: 0 } },
      competition: { name: competition },
    }
  }

  function liveFetch() {
    const calls: string[] = []
    const impl = (async (url: string) => {
      calls.push(url)
      const matches = url.includes("/competitions/PL/")
        ? [
            liveMatch(
              535101,
              "2026-11-22T16:30:00Z",
              "IN_PLAY",
              "Liverpool FC",
              "Manchester United FC",
            ),
            liveMatch(
              535102,
              "2026-11-22T14:00:00Z",
              "IN_PLAY",
              "Arsenal FC",
              "Chelsea FC",
            ),
            liveMatch(
              535103,
              "2026-11-22T19:45:00Z",
              "SCHEDULED",
              "Manchester City FC",
              "Tottenham Hotspur FC",
            ),
          ]
        : [
            liveMatch(
              535201,
              "2026-11-22T18:45:00Z",
              "PAUSED",
              "Real Madrid CF",
              "Manchester United FC",
              "UEFA Champions League",
            ),
          ]
      return {
        ok: true,
        status: 200,
        json: async () => ({ matches }),
        headers: { get: () => null },
      }
    }) as unknown as Parameters<typeof getLiveFixtures>[0]["fetchImpl"]
    return { impl, calls }
  }

  it("returns the IN_PLAY United fixture; SCHEDULED and non-United live rows are dropped", async () => {
    setKey(runtimeTestKey())
    const { impl, calls } = liveFetch()
    const live = await getLiveFixtures({ fetchImpl: impl, nowMs: SUNDAY_1733 })
    expect(live.status).toBe("ok")
    expect(live.fixtures).toHaveLength(1)
    expect(live.fixtures![0]!.home).toBe("Liverpool FC")
    expect(live.fixtures![0]!.away).toBe("Manchester United FC")
    expect(live.fixtures![0]!.status).toBe("IN_PLAY")
    // The live window is centred on today (yesterday → tomorrow),
    // so a match that kicked off earlier today is in the payload.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("/competitions/PL/matches")
    expect(calls[0]).toContain("dateFrom=2026-11-21")
    expect(calls[0]).toContain("dateTo=2026-11-23")
    expect(calls[1]).toContain("/competitions/CL/matches")
  })

  it("a PAUSED United fixture is live too; a SCHEDULED one is not", async () => {
    setKey(runtimeTestKey())
    const { impl } = liveFetch()
    // 18:45 kick-off, PAUSED at half-time — live, but it has not
    // kicked off yet at 17:33, so the live filter drops it (a
    // fixture cannot be live before kick-off).
    const beforeKickoff = await getLiveFixtures({
      fetchImpl: impl,
      nowMs: SUNDAY_1733,
    })
    expect(
      beforeKickoff.fixtures!.some((f) => f.id === "fd-535201"),
    ).toBe(false)
    const atHalfTime = await getLiveFixtures({
      fetchImpl: impl,
      nowMs: Date.UTC(2026, 10, 22, 19, 30, 0),
      forceRefresh: true,
    })
    expect(atHalfTime.fixtures!.some((f) => f.id === "fd-535201")).toBe(true)
  })

  it("a live fixture whose kick-off is more than 3 hours ago is dropped, even from cache", async () => {
    setKey(runtimeTestKey())
    const { impl } = liveFetch()
    const live = await getLiveFixtures({
      fetchImpl: impl,
      nowMs: Date.UTC(2026, 10, 22, 22, 0, 0),
      forceRefresh: true,
    })
    // Liverpool kicked off 16:30 — five and a half hours ago — and
    // Real Madrid 18:45, over three hours ago. Neither can still
    // be live; the stale rows are dropped, never shown as on TV now.
    expect(live.fixtures).toHaveLength(0)
  })

  it("no key → no-key + null + no fetch; feed down → error + null", async () => {
    const { impl } = liveFetch()
    const noKey = await getLiveFixtures({ fetchImpl: impl, nowMs: SUNDAY_1733 })
    expect(noKey.status).toBe("no-key")
    expect(noKey.fixtures).toBeNull()
    expect(impl).not.toBeNull()

    setKey(runtimeTestKey())
    const down = await getLiveFixtures({
      fetchImpl: createFailingFetch(500),
      nowMs: SUNDAY_1733,
    })
    expect(down.status).toBe("error")
    expect(down.fixtures).toBeNull()
  })

  it("5-minute TTL: a second call inside it is cached; past it, it refetches", async () => {
    setKey(runtimeTestKey())
    const { impl, calls } = liveFetch()
    const first = await getLiveFixtures({ fetchImpl: impl, nowMs: SUNDAY_1733 })
    expect(first.status).toBe("ok")
    expect(first.fromCache).toBe(false)
    expect(calls).toHaveLength(2)
    const cached = await getLiveFixtures({
      fetchImpl: impl,
      nowMs: SUNDAY_1733 + 4 * 60_000,
    })
    expect(cached.fromCache).toBe(true)
    expect(calls).toHaveLength(2)
    const refetched = await getLiveFixtures({
      fetchImpl: impl,
      nowMs: SUNDAY_1733 + 6 * 60_000,
    })
    expect(refetched.fromCache).toBe(false)
    expect(calls).toHaveLength(4)
  })

  it("stale cache is served with the stale flag when the feed fails", async () => {
    setKey(runtimeTestKey())
    const live = parseMatchesResponse({
      matches: [
        liveMatch(
          535101,
          "2026-11-22T16:30:00Z",
          "IN_PLAY",
          "Liverpool FC",
          "Manchester United FC",
        ),
      ],
    })
    localStorage.setItem(
      FOOTBALL_DATA_LIVE_CACHE_KEY,
      JSON.stringify({ fetchedAt: SUNDAY_1733 - 10 * 60_000, data: live }),
    )
    const stale = await getLiveFixtures({
      fetchImpl: createFailingFetch(500),
      nowMs: SUNDAY_1733,
      ttlMs: 0,
    })
    expect(stale.status).toBe("stale")
    expect(stale.stale).toBe(true)
    expect(stale.fixtures).toHaveLength(1)
    expect(stale.fixtures![0]!.home).toBe("Liverpool FC")
  })
})
