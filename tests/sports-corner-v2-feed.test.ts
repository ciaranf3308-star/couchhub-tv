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
  FOOTBALL_DATA_FIXTURES_CACHE_KEY,
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  FOOTBALL_DATA_TABLE_CACHE_KEY,
  STATION_TBC,
  clearFootballDataCache,
  getFootballDataKeyState,
  getLeagueTable,
  getNextFixtures,
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

  it("matching is by normalised teams + start within the same minute", () => {
    const fixture = MOCK_NEXT_FIXTURES[0]
    // Same minute, 30s later: still the same fixture.
    const sameMinute = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: fixture.startMs + 30_000 },
    ])
    expect(sameMinute.stationKnown).toBe(true)
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
