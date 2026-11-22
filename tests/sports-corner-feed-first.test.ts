/**
 * @vitest-environment jsdom
 */
// Sports Corner feed-first (0.11.26) — the feed is the single
// source of truth for fixtures; the EPG is a station lookup only.
//
// The 22 Nov 17:33 bug: the hub showed Sunderland as the next
// match because a replay of the 4 Oct 2025 2–0 win over Sunderland
// classified as a CONFIRMED fixture and landed first in Upcoming.
// These tests pin the rebuild at every layer: the feed's next 5
// are the next 5 exactly (Liverpool live, Sporting next; Sunderland
// 30 Dec is 6th and outside the slice); no invented fixtures
// anywhere; stations come from the EPG or show TBC; on-TV-now is
// driven by feed fixtures only; replays/classics never count as
// fixtures anywhere, including Possible; Possible stays honestly
// labelled; and a missing/failed feed renders an honest failed
// state, never an EPG fixture standing in as hero or next match.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  STATION_TBC,
  clearFootballDataCache,
  getLeagueTable,
  getNextFixtures,
  type FeedFixture,
  type FeedFixturesResult,
  type FootballDataFetchImpl,
  type LeagueTableResult,
} from "@/scripts/lib/football-data.ts"
import {
  MOCK_CL_MATCHES_RESPONSE,
  MOCK_FRIDAY_AFTERNOON_MS,
  MOCK_NEXT_FIXTURES,
  MOCK_PL_MATCHES_RESPONSE,
  createMockFetch,
} from "@/scripts/lib/football-data-mock.ts"
import {
  buildNextMatchRows,
  buildSportsHubModel,
  feedFixtureOpponent,
  querySportsHubRoot,
  renderSportsHub,
  selectOnTvNowRows,
  type SportsHubCallbacks,
  type SportsHubRoot,
} from "@/scripts/followed-sports-page.ts"
import type {
  SportsFixture,
  SportsScanResult,
} from "@/scripts/lib/sports-fixture-scan.ts"

const FRIDAY = MOCK_FRIDAY_AFTERNOON_MS
const HOUR = 3_600_000
const MINUTE = 60_000
const KICKOFF = Date.UTC(2026, 10, 22, 16, 30, 0)
/** Sun 22 Nov 2026 17:33 — the moment the bug was reported live. */
const SUNDAY_1733 = KICKOFF + 63 * MINUTE

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

/** Runtime-generated key — never a literal. */
function runtimeTestKey(): string {
  return `test-key-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function fixture(
  overrides: Partial<SportsFixture> & { title: string },
): SportsFixture {
  return {
    id: `1:${overrides.startMs ?? FRIDAY}:${overrides.title}`,
    teams: ["Man Utd", "Sunderland"],
    startMs: FRIDAY + 2 * HOUR,
    stopMs: FRIDAY + 4 * HOUR,
    channelId: 101,
    channelName: "Sky Sports Main Event",
    channelLogo: null,
    channelCategory: "Sports",
    alsoOn: [],
    tier: "confirmed",
    squad: "first-team",
    catchupAction: "none",
    channelCatchup: {},
    ...overrides,
  }
}

function scanResult(
  fixtures: SportsFixture[],
  mappedChannelCount = 3,
): SportsScanResult {
  return {
    fixtures,
    scannedAt: new Date(FRIDAY).toISOString(),
    epgFetchedAt: FRIDAY,
    playlistId: "pl1",
    mappedChannelCount,
    channelCount: 3,
  }
}

function shellHtml(): string {
  return `
  <div data-sports-hub-shell>
    <header>
      <p data-sports-hub-meta></p>
      <p data-sports-hub-stale hidden>Programme guide data may be out of date.</p>
      <button data-sports-hub-follow data-couch-key="sports:unfollow" type="button">Unfollow</button>
    </header>
    <div data-sports-hub-states></div>
    <div data-sports-hub-content></div>
  </div>`
}

function stubCallbacks(): SportsHubCallbacks & {
  calls: Array<{ action: string; fixture?: SportsFixture }>
} {
  const calls: Array<{ action: string; fixture?: SportsFixture }> = []
  return {
    calls,
    onWatch: (f) => calls.push({ action: "watch", fixture: f }),
    onWatchFromStart: (f) =>
      calls.push({ action: "watch-from-start", fixture: f }),
    onReplay: (f) => calls.push({ action: "replay", fixture: f }),
    onOpenGuide: () => calls.push({ action: "guide" }),
    onToggleFollow: () => calls.push({ action: "toggle-follow" }),
  }
}

function hubRoot(): SportsHubRoot {
  const root = querySportsHubRoot(document)
  if (!root) throw new Error("hub shell missing")
  return root
}

async function feedResults(nowMs: number): Promise<{
  tableResult: LeagueTableResult
  feedResult: FeedFixturesResult
}> {
  localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeTestKey())
  const mockFetch = createMockFetch()
  const tableResult = await getLeagueTable({ fetchImpl: mockFetch, nowMs })
  const feedResult = await getNextFixtures(5, {
    fetchImpl: createMockFetch(),
    nowMs,
  })
  return { tableResult, feedResult }
}

function feedResult(
  status: FeedFixturesResult["status"],
  fixtures: FeedFixture[] | null,
): FeedFixturesResult {
  return {
    status,
    fixtures,
    stale: false,
    mayBeOutOfDate: false,
    fetchedAt: FRIDAY,
    fromCache: false,
  }
}

function liverpoolListing(overrides: Partial<SportsFixture> = {}): SportsFixture {
  return fixture({
    title: "Liverpool v Man Utd",
    teams: ["Liverpool", "Man Utd"],
    channelId: 201,
    channelName: "Sky Sports Main Event",
    alsoOn: [{ channelId: 202, channelName: "Sky Sports Premier League" }],
    startMs: KICKOFF,
    stopMs: KICKOFF + 143 * MINUTE,
    id: "201:liverpool-live",
    ...overrides,
  })
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage())
  clearFootballDataCache()
  document.body.innerHTML = shellHtml()
})

afterEach(() => {
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("feed-first — Next Matches equals the feed's next 5 exactly", () => {
  it("the feed's next 5 are Liverpool, Sporting, Brentford, Newcastle, Coventry — in order", async () => {
    const { feedResult: result } = await feedResults(FRIDAY)
    expect(result.status).toBe("ok")
    expect(result.fixtures?.map((f) => f.id)).toEqual([
      "fd-535101",
      "fd-535201",
      "fd-535112",
      "fd-535125",
      "fd-535138",
    ])
    expect(result.fixtures?.map(feedFixtureOpponent)).toEqual([
      "Liverpool",
      "Sporting CP",
      "Brentford",
      "Newcastle",
      "Coventry",
    ])
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([]),
      nowMs: FRIDAY,
      feedResult: result,
      nextMatches: buildNextMatchRows(result.fixtures ?? [], []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(
      [...document.querySelectorAll(".rs-sports-next-opponent")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Liverpool", "Sporting CP", "Brentford", "Newcastle", "Coventry"])
    // The hero is the feed's first fixture — Liverpool away.
    expect(
      document.querySelector(".rs-sports-hero")?.textContent,
    ).toContain("Liverpool v Man Utd")
  })

  it("a 6th fixture (Sunderland, 30 Dec) is outside the next-5 slice", async () => {
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeTestKey())
    // Raw v4 shape, mirroring the mock's mockMatch rows.
    const sunderlandMatch = {
      id: 535199,
      utcDate: "2026-12-30T19:45:00Z",
      status: "SCHEDULED",
      matchday: 18,
      stage: "REGULAR_SEASON",
      group: null,
      homeTeam: { id: 1, name: "Manchester United FC" },
      awayTeam: { id: 2, name: "Sunderland AFC" },
      score: {
        winner: null,
        duration: "REGULAR",
        fullTime: { home: null, away: null },
        halfTime: { home: null, away: null },
      },
      competition: { id: 2021, name: "Premier League", code: "PL" },
    }
    const fetchImpl: FootballDataFetchImpl = async (url: string) => {
      const payload = url.includes("/competitions/PL/matches")
        ? {
            ...MOCK_PL_MATCHES_RESPONSE,
            matches: [...MOCK_PL_MATCHES_RESPONSE.matches, sunderlandMatch],
          }
        : MOCK_CL_MATCHES_RESPONSE
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        headers: { get: () => null },
      }
    }
    const result = await getNextFixtures(5, { fetchImpl, nowMs: FRIDAY })
    expect(result.status).toBe("ok")
    expect(result.fixtures).toHaveLength(5)
    expect(result.fixtures?.map((f) => f.id)).toEqual([
      "fd-535101",
      "fd-535201",
      "fd-535112",
      "fd-535125",
      "fd-535138",
    ])
    expect(
      result.fixtures?.some((f) => /sunderland/i.test(`${f.home} ${f.away}`)),
    ).toBe(false)
  })
})

describe("feed-first — no invented fixtures anywhere (22 Nov 17:33)", () => {
  // The evening guide as it was when the bug was reported: the
  // Liverpool match live on Sky, and replays of the 4 Oct 2025
  // 2–0 win over Sunderland on MUTV.
  function eveningGuide(): SportsFixture[] {
    return [
      liverpoolListing(),
      fixture({
        title: "Man Utd v Sunderland: Full Match Replay",
        teams: ["Man Utd", "Sunderland"],
        channelId: 301,
        channelName: "MUTV",
        startMs: SUNDAY_1733 - 30 * MINUTE,
        stopMs: SUNDAY_1733 + 90 * MINUTE,
        id: "301:replay-sunderland",
        tier: "recorded",
      }),
      fixture({
        title: "Man Utd v Sunderland: Full Match Replay",
        teams: ["Man Utd", "Sunderland"],
        channelId: 301,
        channelName: "MUTV",
        startMs: Date.UTC(2026, 10, 23, 19, 0, 0),
        stopMs: Date.UTC(2026, 10, 23, 21, 0, 0),
        id: "301:replay-sunderland-mon",
        tier: "recorded",
      }),
    ]
  }

  it("feed down + evening guide of replays → no Sunderland as a fixture; hero is the honest error state", async () => {
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult(eveningGuide()),
      nowMs: SUNDAY_1733,
      feedResult: feedResult("error", null),
      nextMatches: [],
      liveMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), SUNDAY_1733)
    // The hero is the feed-state hero, never the EPG fixture.
    const hero = document.querySelector(".rs-sports-hero")
    expect(hero?.classList.contains("rs-sports-hero-feed")).toBe(true)
    expect(hero?.textContent).toContain(
      "Next matches unavailable — the feed couldn't be reached.",
    )
    expect(hero?.textContent).not.toContain("Sunderland")
    expect(hero?.getAttribute("data-fixture-id")).toBeNull()
    // No Next Matches rows at all.
    expect(document.querySelectorAll(".rs-sports-next-row")).toHaveLength(0)
    // On-TV-now is feed-driven: no feed fixture, no card — and the
    // empty line says why, instead of showing the replay.
    expect(document.querySelectorAll(".rs-sports-onnow-card")).toHaveLength(0)
    expect(
      document.querySelector('[data-sports-section="on-tv-now"]')
        ?.textContent,
    ).toContain("Can't tell what's on TV right now — the feed couldn't be reached.")
    // The live Liverpool listing still renders in Upcoming (an EPG
    // fixture the feed does not back is guide content, not a
    // fixture claim); the Sunderland replay appears nowhere.
    const upcoming = document.querySelector(
      '[data-sports-section="upcoming"]',
    )?.textContent
    expect(upcoming).toContain("Liverpool v Man Utd")
    expect(upcoming).not.toContain("Sunderland")
    expect(document.body.textContent).not.toContain("Full Match Replay")
  })

  it("feed down (no key) + EPG fixture present → hero is the no-key state with a Set up key button", () => {
    const live = liverpoolListing()
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([live]),
      nowMs: SUNDAY_1733,
      feedResult: feedResult("no-key", null),
      nextMatches: [],
      liveMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), SUNDAY_1733)
    const hero = document.querySelector(".rs-sports-hero")
    expect(hero?.textContent).toContain(
      "Next matches need your football-data.org API key in Settings.",
    )
    expect(hero?.textContent).not.toContain("Liverpool v Man Utd")
    expect(
      hero?.querySelector('[data-couch-key="sports:setup-key:hero"]')
        ?.textContent,
    ).toBe("Set up key")
  })
})

describe("feed-first — stations come from the EPG or show TBC", () => {
  it("a feed fixture with a Sky listing shows Sky; without a listing shows Station TBC", async () => {
    const { feedResult: result } = await feedResults(FRIDAY)
    const listing = liverpoolListing({
      startMs: KICKOFF - 30 * MINUTE,
      stopMs: KICKOFF + 113 * MINUTE,
    })
    const rows = buildNextMatchRows(result.fixtures ?? [], [listing])
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([listing]),
      nowMs: FRIDAY,
      feedResult: result,
      nextMatches: rows,
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const stations = [
      ...document.querySelectorAll(".rs-sports-next-station"),
    ].map((node) => node.textContent)
    expect(stations).toHaveLength(5)
    expect(stations[0]).toContain("Sky Sports Main Event")
    expect(stations[0]).not.toContain(STATION_TBC)
    for (const station of stations.slice(1)) {
      expect(station).toBe(STATION_TBC)
    }
  })

  it("a recorded listing never supplies a station — the hero says TV listing to be confirmed", () => {
    const replay = fixture({
      title: "Liverpool v Man Utd: Full Match Replay",
      teams: ["Liverpool", "Man Utd"],
      channelId: 301,
      channelName: "MUTV",
      startMs: KICKOFF,
      stopMs: KICKOFF + 2 * HOUR,
      id: "301:replay-liverpool",
      tier: "recorded",
    })
    const rows = buildNextMatchRows([MOCK_NEXT_FIXTURES[0]], [replay])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.matched.stationKnown).toBe(false)
    expect(rows[0]?.matched.station).toBe(STATION_TBC)
    expect(rows[0]?.epgFixture).toBeNull()
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([replay]),
      nowMs: FRIDAY,
      feedResult: feedResult("ok", [MOCK_NEXT_FIXTURES[0]]),
      nextMatches: rows,
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(
      document.querySelector(".rs-sports-hero")?.textContent,
    ).toContain("TV listing to be confirmed")
    expect(document.body.textContent).not.toContain("MUTV")
  })
})

describe("feed-first — on-TV-now is driven by feed fixtures only", () => {
  it("live Liverpool feed fixture + Sky listing → LIVE card with Sky, minutes left, Watch", () => {
    const listing = liverpoolListing()
    const callbacks = stubCallbacks()
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([listing]),
      nowMs: SUNDAY_1733,
      feedResult: feedResult("ok", MOCK_NEXT_FIXTURES),
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, [listing]),
      liveMatches: buildNextMatchRows([MOCK_NEXT_FIXTURES[0]], [listing]),
    })
    renderSportsHub(hubRoot(), model, callbacks, SUNDAY_1733)
    const cards = [...document.querySelectorAll(".rs-sports-onnow-card")]
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card?.querySelector(".rs-sports-badge")?.textContent).toBe("LIVE")
    expect(card?.querySelector(".rs-sports-onnow-title")?.textContent).toBe(
      "Liverpool v Man Utd",
    )
    expect(card?.querySelector(".rs-sports-onnow-meta")?.textContent).toBe(
      "Sky Sports Main Event · Premier League · 80 min left",
    )
    const watch = card?.querySelector<HTMLElement>(
      '[data-couch-key^="sports:onnow:watch:"]',
    )
    expect(watch?.textContent).toBe("Ⓐ Watch")
    watch?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(callbacks.calls).toEqual([{ action: "watch", fixture: listing }])
  })

  it("a live feed fixture with no EPG listing still shows, with Station TBC and no Watch pill", () => {
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([]),
      nowMs: SUNDAY_1733,
      feedResult: feedResult("ok", MOCK_NEXT_FIXTURES),
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, []),
      liveMatches: buildNextMatchRows([MOCK_NEXT_FIXTURES[0]], []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), SUNDAY_1733)
    const cards = [...document.querySelectorAll(".rs-sports-onnow-card")]
    expect(cards).toHaveLength(1)
    expect(cards[0]?.querySelector(".rs-sports-badge")?.textContent).toBe(
      "LIVE",
    )
    expect(cards[0]?.querySelector(".rs-sports-onnow-meta")?.textContent).toBe(
      "Station TBC · Premier League · Live now",
    )
    expect(
      cards[0]?.querySelector('[data-couch-key^="sports:onnow:watch:"]'),
    ).toBeNull()
  })

  it("a replay on now with no feed fixture → no on-TV-now card", () => {
    const replay = fixture({
      title: "Man Utd v Sunderland: Full Match Replay",
      teams: ["Man Utd", "Sunderland"],
      channelId: 301,
      channelName: "MUTV",
      startMs: SUNDAY_1733 - 30 * MINUTE,
      stopMs: SUNDAY_1733 + 90 * MINUTE,
      id: "301:replay-sunderland",
      tier: "recorded",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([replay]),
      nowMs: SUNDAY_1733,
      feedResult: feedResult("ok", MOCK_NEXT_FIXTURES),
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, []),
      liveMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), SUNDAY_1733)
    expect(document.querySelectorAll(".rs-sports-onnow-card")).toHaveLength(0)
    expect(
      document.querySelector('[data-sports-section="on-tv-now"]')
        ?.textContent,
    ).toContain("No Manchester United programmes on TV right now")
  })

  it("pre-match feed fixture (kick-off in 30 min) + build-up on air → card with LIVE badge and Starts in 30 min", () => {
    // The build-up listing carries the plain match title, so the
    // badge rule reads the coverage on air as LIVE; the meta
    // follows kick-off, not the programme start.
    const buildup = liverpoolListing({
      startMs: KICKOFF - 30 * MINUTE,
      stopMs: KICKOFF + 113 * MINUTE,
    })
    const nowMs = KICKOFF - 30 * MINUTE
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([buildup]),
      nowMs,
      feedResult: feedResult("ok", MOCK_NEXT_FIXTURES),
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, [buildup]),
      liveMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), nowMs)
    const cards = [...document.querySelectorAll(".rs-sports-onnow-card")]
    expect(cards).toHaveLength(1)
    expect(cards[0]?.querySelector(".rs-sports-badge")?.textContent).toBe(
      "LIVE",
    )
    expect(cards[0]?.querySelector(".rs-sports-onnow-meta")?.textContent).toBe(
      "Sky Sports Main Event · Premier League · Starts in 30 min",
    )
  })

  it("pre-match feed fixture (kick-off in 30 min) + listing starting at kick-off → card with no badge yet, Watch present", () => {
    const listing = liverpoolListing()
    const nowMs = KICKOFF - 30 * MINUTE
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([listing]),
      nowMs,
      feedResult: feedResult("ok", MOCK_NEXT_FIXTURES),
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, [listing]),
      liveMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), nowMs)
    const cards = [...document.querySelectorAll(".rs-sports-onnow-card")]
    expect(cards).toHaveLength(1)
    // The listing is not on air yet, so there is no badge — the
    // card is honest about what is actually showing.
    expect(cards[0]?.querySelector(".rs-sports-badge")).toBeNull()
    expect(cards[0]?.querySelector(".rs-sports-onnow-meta")?.textContent).toBe(
      "Sky Sports Main Event · Premier League · Starts in 30 min",
    )
    expect(
      cards[0]?.querySelector('[data-couch-key^="sports:onnow:watch:"]'),
    ).not.toBeNull()
  })

  it("pre-match feed fixture without a listing → no on-TV-now card (it is just upcoming)", () => {
    const nowMs = KICKOFF - 30 * MINUTE
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([]),
      nowMs,
      feedResult: feedResult("ok", MOCK_NEXT_FIXTURES),
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, []),
      liveMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), nowMs)
    expect(document.querySelectorAll(".rs-sports-onnow-card")).toHaveLength(0)
    // The fixture is still in Next fixtures with Station TBC.
    expect(
      document.querySelector(".rs-sports-hero")?.textContent,
    ).toContain("Liverpool v Man Utd")
    expect(
      [...document.querySelectorAll(".rs-sports-next-station")].map(
        (node) => node.textContent,
      )[0],
    ).toBe(STATION_TBC)
  })
})

describe("feed-first — selectOnTvNowRows (pure derivation)", () => {
  function rowFor(fixture: FeedFixture, stationKnown = true): ReturnType<
    typeof buildNextMatchRows
  >[number] {
    return {
      matched: {
        fixture,
        stationKnown,
        station: stationKnown ? "Sky Sports Main Event" : STATION_TBC,
        watchable: stationKnown,
      },
      epgFixture: null,
    } as ReturnType<typeof buildNextMatchRows>[number]
  }

  it("live first, then pre-match, each earliest first, capped at three", () => {
    const live = rowFor(MOCK_NEXT_FIXTURES[0])
    const prematchFixture: FeedFixture = {
      id: "fd-test-pre",
      home: "Manchester United FC",
      away: "Brentford FC",
      competition: "Premier League",
      startMs: SUNDAY_1733 + 30 * MINUTE,
    }
    const rows = selectOnTvNowRows(
      [live],
      [rowFor(prematchFixture)],
      SUNDAY_1733,
    )
    expect(rows.map((r) => r.matched.fixture.id)).toEqual([
      "fd-535101",
      "fd-test-pre",
    ])
    // Four pre-match fixtures inside the window → three cards,
    // earliest first.
    const four = [10, 20, 30, 40].map((minutes) =>
      rowFor({
        id: `fd-test-pre-${minutes}`,
        home: "Manchester United FC",
        away: "Brentford FC",
        competition: "Premier League",
        startMs: SUNDAY_1733 + minutes * MINUTE,
      }),
    )
    const capped = selectOnTvNowRows([], four, SUNDAY_1733)
    expect(capped.map((r) => r.matched.fixture.id)).toEqual([
      "fd-test-pre-10",
      "fd-test-pre-20",
      "fd-test-pre-30",
    ])
  })

  it("a live fixture older than 3 hours is dropped, even from the live rows", () => {
    const stale = rowFor(MOCK_NEXT_FIXTURES[0])
    const rows = selectOnTvNowRows([stale], [], KICKOFF + 3 * HOUR + MINUTE)
    expect(rows).toHaveLength(0)
  })

  it("a pre-match fixture without a station is dropped", () => {
    const liverpoolNoStation = rowFor(MOCK_NEXT_FIXTURES[0], false)
    expect(
      selectOnTvNowRows([], [liverpoolNoStation], KICKOFF - 30 * MINUTE),
    ).toHaveLength(0)
    // …while the same fixture with a station is a pre-match row.
    expect(
      selectOnTvNowRows(
        [],
        [rowFor(MOCK_NEXT_FIXTURES[0])],
        KICKOFF - 30 * MINUTE,
      ),
    ).toHaveLength(1)
  })
})

describe("feed-first — replays never count as fixtures (render level)", () => {
  it("a replay that already aired is not in Recent", () => {
    const replay = fixture({
      title: "Man Utd v Sunderland: Full Match Replay",
      teams: ["Man Utd", "Sunderland"],
      channelId: 301,
      channelName: "MUTV",
      startMs: FRIDAY - 3 * HOUR,
      stopMs: FRIDAY - HOUR,
      id: "301:replay-aired",
      tier: "recorded",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([replay]),
      nowMs: FRIDAY,
    })
    expect(model.split.recent).toHaveLength(0)
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(
      document.querySelector('[data-sports-section="recent"]'),
    ).toBeNull()
    expect(document.body.textContent).not.toContain("Full Match Replay")
  })

  it("a recorded possible-shaped listing is not in Possible", () => {
    const recorded = fixture({
      title: "United v Chelsea: Premier League Highlights",
      teams: ["United", "Chelsea"],
      channelName: "Sky Sports Main Event",
      startMs: FRIDAY + 5 * HOUR,
      stopMs: FRIDAY + 7 * HOUR,
      id: "101:recorded-possible",
      tier: "recorded",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([recorded]),
      nowMs: FRIDAY,
    })
    expect(model.split.possible).toHaveLength(0)
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(
      document.querySelector('[data-sports-section="possible"]'),
    ).toBeNull()
    expect(document.body.textContent).not.toContain("Chelsea")
  })
})

describe("feed-first — Possible stays honestly labelled", () => {
  it("a possible-tier live listing renders with Unconfirmed team + the explainer, and nowhere else", () => {
    const possible = fixture({
      title: "United v Chelsea: Premier League",
      teams: ["United", "Chelsea"],
      tier: "possible",
      channelName: "Sky Sports Main Event",
      startMs: FRIDAY - 10 * MINUTE,
      stopMs: FRIDAY + 80 * MINUTE,
      id: "101:possible",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([possible]),
      nowMs: FRIDAY,
    })
    expect(model.split.possible).toHaveLength(1)
    expect(model.split.upcoming).toHaveLength(0)
    expect(model.onTvNow).toHaveLength(0)
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const section = document.querySelector('[data-sports-section="possible"]')
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain("Unconfirmed team")
    expect(section?.textContent).toContain(
      "These titles say 'United' without naming the club.",
    )
    // It is not a confirmed fixture anywhere else.
    expect(document.querySelectorAll(".rs-sports-onnow-card")).toHaveLength(0)
    expect(document.querySelector(".rs-sports-hero")).toBeNull()
    // Upcoming renders its honest empty line — the possible
    // listing is not a confirmed upcoming fixture.
    expect(
      document.querySelector('[data-sports-section="upcoming"]')
        ?.textContent,
    ).toContain("No upcoming matches in the guide right now")
    expect(
      document.querySelector('[data-sports-section="upcoming"]')
        ?.textContent,
    ).not.toContain("Chelsea")
  })
})
