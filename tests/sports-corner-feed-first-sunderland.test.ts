// Sports Corner — feed-first diagnosis: the Sunderland replay is not
// the next match (22 Nov 2026, live Liverpool v Man Utd).
//
// THE BUG (live on the user's TV, Sun 22 Nov 2026 ~17:33 Europe/Dublin):
// the hub's Next Matches presentation showed Sunderland as the next
// match. United do not play Sunderland next — the real next match is
// Sporting CP away, Wed 25 Nov 2026 20:00 (Champions League), then
// Brentford, Newcastle, Coventry. The next United v Sunderland fixture
// is Wed 30 Dec 2026 19:30, 38 days away.
//
// MECHANISM (proven here, production code untouched): the EPG scan has
// no live-vs-recorded distinction. A replay / classic / highlights
// programme whose title is fixture-shaped ("Manchester United v
// Sunderland", "Manchester United v Sunderland: Highlights") — or
// whose description names the fixture ("Football Classics" whose desc
// reads "Manchester United v Sunderland, 4 October 2025") — is
// classified CONFIRMED first-team by matchUnitedFixture
// (src/scripts/lib/sports-fixture-scan.ts), lands in the Upcoming
// split sorted earliest-first, and — once the live Liverpool match is
// filtered out of the rendered Upcoming list
// (followed-sports-page.ts, "Upcoming Matches" render filter) —
// becomes the first "next match" row. After Liverpool ends it also
// becomes the hero via selectNextFixture. The only United v
// Sunderland match that could be listed is the 4 Oct 2025 2-0 win at
// Old Trafford, so a replay/classic of it is the source; the feed
// cannot produce Sunderland (see the feed-control test below).
//
// THE CONTRADICTION: the codebase already knows these programmes are
// not live — sportsFixtureLiveBadge downgrades them to "ON NOW" via
// NON_LIVE_PROGRAMME_MARKERS — but the split / hero selection never
// consults those markers. The badge knows; the next-match logic
// does not.
//
// KNOWN CONFLICT: tests/sports-fixture-scan.test.ts T12 (line 101)
// currently pins "Manchester United v Sunderland: Highlights" as
// CONFIRMED. That test pins the buggy behaviour for the next-match
// path; the rebuild must overturn it (at the matcher or at the
// split/hero layer — this file asserts the presentation behaviour,
// not the internal fix location).
//
// This file is DIAGNOSIS ONLY: it adds tests, changes no production
// behaviour. The Sunderland assertions below FAIL on main (0.11.25)
// and must pass after the feed-first rebuild (feed = single source
// of truth for fixtures, EPG = station lookup only).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { buildChannelNameIndex } from "@/scripts/lib/epg-data.js"
import {
  clearFootballDataCache,
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  getNextFixtures,
} from "@/scripts/lib/football-data.ts"
import {
  buildSportsHubModel,
} from "@/scripts/followed-sports-page.ts"
import {
  matchUnitedFixture,
  scanSportsFixtures,
  selectNextFixture,
  splitSportsFixtures,
  sportsFixtureLiveBadge,
  sportsFixtureState,
  type SportsFixture,
  type SportsScanChannel,
} from "@/scripts/lib/sports-fixture-scan.ts"

// Sun 22 Nov 2026 17:33 UTC == 17:33 Europe/Dublin (GMT in November).
// Liverpool v Man Utd kicked off 16:30 and is live at this clock.
const NOW_1733 = Date.UTC(2026, 10, 22, 17, 33, 0)
// 18:30 the same evening: Liverpool (16:30–18:15) is over.
const AFTER_LIVERPOOL = Date.UTC(2026, 10, 22, 18, 30, 0)

function programme(
  startMs: number,
  stopMs: number,
  title: string,
  desc = "",
) {
  return { start: startMs, stop: stopMs, title, desc }
}

function epgState(
  entries: Array<{ id: string; name: string; programmes: unknown[] }>,
  fetchedAt: number | null = NOW_1733,
) {
  const programmes = new Map<string, unknown[]>()
  const channelNames = new Map<string, string>()
  for (const entry of entries) {
    programmes.set(entry.id.toLowerCase(), entry.programmes)
    channelNames.set(entry.id.toLowerCase(), entry.name)
  }
  return {
    programmes,
    channelNames,
    nameIndex: buildChannelNameIndex(channelNames),
    fetchedAt,
  }
}

function channel(
  id: number,
  name: string,
  tvgId: string,
  extra: Partial<SportsScanChannel> = {},
): SportsScanChannel {
  return { id, name, tvgId, category: "Sports", ...extra }
}

/**
 * The guide window as the user saw it on Sun 22 Nov 2026 ~17:33:
 * Liverpool v Man Utd live on Sky Sports Main Event, and — the only
 * United v Sunderland material any guide can list that weekend — a
 * replay/classic of the 4 Oct 2025 2-0 win, in the three shapes the
 * EPG actually uses: a verbatim fixture title with a replay desc, a
 * ": Highlights" title, and a generic title whose desc names the
 * fixture. No real future United fixture falls inside the ~36h guide
 * window (the next one, Sporting CP, is Wed 25 Nov).
 */
function eveningGuide() {
  const state = epgState([
    {
      id: "sky-main",
      name: "Sky Sports Main Event",
      programmes: [
        programme(
          Date.UTC(2026, 10, 22, 16, 30),
          Date.UTC(2026, 10, 22, 18, 15),
          "Liverpool v Manchester United",
          "Premier League",
        ),
      ],
    },
    {
      id: "mutv",
      name: "MUTV",
      programmes: [
        // A: verbatim fixture title; the replay marker is in the desc.
        programme(
          Date.UTC(2026, 10, 23, 19, 0),
          Date.UTC(2026, 10, 23, 20, 45),
          "Manchester United v Sunderland",
          "Full match replay: Manchester United 2-0 Sunderland, 4 October 2025.",
        ),
        // B: the replay marker is in the title itself (T12's shape).
        programme(
          Date.UTC(2026, 10, 23, 21, 0),
          Date.UTC(2026, 10, 23, 21, 30),
          "Manchester United v Sunderland: Highlights",
          "Highlights from the 2-0 win over Sunderland at Old Trafford.",
        ),
        // C: generic title; the fixture is mined from the desc.
        programme(
          Date.UTC(2026, 10, 23, 23, 0),
          Date.UTC(2026, 10, 24, 0, 45),
          "Football Classics",
          "Manchester United v Sunderland, 4 October 2025. Mount and Sesko score in a 2-0 win at Old Trafford.",
        ),
      ],
    },
  ])
  const channels = [
    channel(1, "Sky Sports Main Event", "sky-main"),
    channel(2, "MUTV", "mutv"),
  ]
  return { state, channels }
}

/** The Upcoming list exactly as the hub renders it: the split's
 *  upcoming rows minus anything on air right now
 *  (followed-sports-page.ts renderSportsHub). */
function renderedUpcoming(
  fixtures: ReadonlyArray<SportsFixture>,
  nowMs: number,
): SportsFixture[] {
  return splitSportsFixtures(fixtures, nowMs).upcoming.filter(
    (fixture) => sportsFixtureState(fixture, nowMs) !== "now",
  )
}

function namesSunderland(fixture: SportsFixture): boolean {
  return fixture.teams.some((side) =>
    side.toLowerCase().includes("sunderland"),
  )
}

describe("Sunderland replay must not be the next match (22 Nov 2026)", () => {
  it("rendered Upcoming holds no Sunderland replay while Liverpool is live", () => {
    const { state, channels } = eveningGuide()
    const { fixtures } = scanSportsFixtures(
      channels,
      state,
      {},
      "pl1",
      NOW_1733,
    )
    const upcoming = renderedUpcoming(fixtures, NOW_1733)
    // The only future programmes in the guide window are replays of
    // the 4 Oct 2025 win. A replay is not a next match: this list
    // must be empty, never headed by Sunderland.
    expect(upcoming).toHaveLength(0)
    expect(upcoming.some(namesSunderland)).toBe(false)
  })

  it("after Liverpool ends, the hero is null — no real next match is in the guide window", () => {
    const { state, channels } = eveningGuide()
    const { fixtures } = scanSportsFixtures(
      channels,
      state,
      {},
      "pl1",
      AFTER_LIVERPOOL,
    )
    // Today selectNextFixture promotes the Mon 19:00 Sunderland
    // replay to the hero. The rebuild must not: there is no live or
    // upcoming real fixture in the window, so there is no hero.
    expect(selectNextFixture(fixtures, AFTER_LIVERPOOL)).toBeNull()
  })

  it("hub model: no Sunderland in rendered Upcoming at 17:33, and no Sunderland hero after Liverpool", () => {
    const { state, channels } = eveningGuide()
    const scan = scanSportsFixtures(channels, state, {}, "pl1", NOW_1733)
    const modelAt1733 = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scan,
      nowMs: NOW_1733,
    })
    expect(
      modelAt1733.split.upcoming.filter(
        (fixture) => sportsFixtureState(fixture, NOW_1733) !== "now",
      ),
    ).toHaveLength(0)
    const modelAfter = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scan,
      nowMs: AFTER_LIVERPOOL,
    })
    expect(modelAfter.hero).toBeNull()
  })

  it("control: the live Liverpool match IS the hero at 17:33 (must stay true)", () => {
    const { state, channels } = eveningGuide()
    const { fixtures } = scanSportsFixtures(
      channels,
      state,
      {},
      "pl1",
      NOW_1733,
    )
    const hero = selectNextFixture(fixtures, NOW_1733)
    expect(hero).not.toBeNull()
    expect(hero!.title).toBe("Liverpool v Manchester United")
    expect(sportsFixtureState(hero!, NOW_1733)).toBe("now")
  })

  it("control: the badge already knows a replay is not live (ON NOW, never LIVE)", () => {
    const state = epgState([
      {
        id: "mutv",
        name: "MUTV",
        programmes: [
          programme(
            Date.UTC(2026, 10, 22, 17, 0),
            Date.UTC(2026, 10, 22, 18, 45),
            "Manchester United v Sunderland",
            "Full match replay: Manchester United 2-0 Sunderland, 4 October 2025.",
          ),
        ],
      },
    ])
    const { fixtures } = scanSportsFixtures(
      [channel(2, "MUTV", "mutv")],
      state,
      {},
      "pl1",
      NOW_1733,
    )
    expect(fixtures).toHaveLength(1)
    expect(sportsFixtureState(fixtures[0]!, NOW_1733)).toBe("now")
    expect(sportsFixtureLiveBadge(fixtures[0]!, NOW_1733)).toBe("ON NOW")
  })

  it("mechanism: all three replay shapes classify CONFIRMED today", () => {
    // Documents the root cause — the matcher never consults the
    // non-live markers. If the rebuild fixes this at the matcher,
    // this test's expectations flip with it and the presentation
    // tests above are what must stay green.
    expect(
      matchUnitedFixture(
        "Manchester United v Sunderland",
        "MUTV",
        "Sports",
        "Full match replay: Manchester United 2-0 Sunderland, 4 October 2025.",
      )?.tier,
    ).toBe("confirmed")
    expect(
      matchUnitedFixture(
        "Manchester United v Sunderland: Highlights",
        "MUTV",
        "Sports",
      )?.tier,
    ).toBe("confirmed")
    expect(
      matchUnitedFixture(
        "Football Classics",
        "MUTV",
        "Sports",
        "Manchester United v Sunderland, 4 October 2025.",
      )?.tier,
    ).toBe("confirmed")
  })
})

describe("feed control — the feed cannot produce Sunderland as next", () => {
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

  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage())
    localStorage.setItem(
      FOOTBALL_DATA_KEY_STORAGE_KEY,
      `test-key-${Math.random().toString(36).slice(2)}`,
    )
    clearFootballDataCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("getNextFixtures returns Sporting CP first; Sunderland (30 Dec) is not in the next 5", async () => {
    // The real 22 Nov 2026 picture, as the feed carries it: Liverpool
    // IN_PLAY (dropped — it has kicked off), Sporting CP / Brentford /
    // Newcastle / Coventry / RB Leipzig SCHEDULED, Sunderland not
    // until Wed 30 Dec 2026 19:30 — 6th in line, outside the next 5.
    // A no-token call to the live API answers 403 (verified 22 Nov
    // 2026), so the live API is reachable; its fixture content cannot
    // be checked without a key, and none exists in the repo.
    const plMatches = [
      {
        id: 1,
        utcDate: "2026-11-22T16:30:00Z",
        status: "IN_PLAY",
        homeTeam: { name: "Liverpool FC" },
        awayTeam: { name: "Manchester United FC" },
        competition: { name: "Premier League" },
        score: { fullTime: { home: 1, away: 0 } },
      },
      {
        id: 2,
        utcDate: "2026-11-28T15:00:00Z",
        status: "SCHEDULED",
        homeTeam: { name: "Manchester United FC" },
        awayTeam: { name: "Brentford FC" },
        competition: { name: "Premier League" },
        score: { fullTime: { home: null, away: null } },
      },
      {
        id: 3,
        utcDate: "2026-12-02T20:15:00Z",
        status: "SCHEDULED",
        homeTeam: { name: "Newcastle United FC" },
        awayTeam: { name: "Manchester United FC" },
        competition: { name: "Premier League" },
        score: { fullTime: { home: null, away: null } },
      },
      {
        id: 4,
        utcDate: "2026-12-05T15:00:00Z",
        status: "SCHEDULED",
        homeTeam: { name: "Manchester United FC" },
        awayTeam: { name: "Coventry City FC" },
        competition: { name: "Premier League" },
        score: { fullTime: { home: null, away: null } },
      },
      {
        id: 5,
        utcDate: "2026-12-30T19:30:00Z",
        status: "SCHEDULED",
        homeTeam: { name: "Sunderland AFC" },
        awayTeam: { name: "Manchester United FC" },
        competition: { name: "Premier League" },
        score: { fullTime: { home: null, away: null } },
      },
    ]
    const clMatches = [
      {
        id: 6,
        utcDate: "2026-11-25T20:00:00Z",
        status: "SCHEDULED",
        homeTeam: { name: "Sporting Clube de Portugal" },
        awayTeam: { name: "Manchester United FC" },
        competition: { name: "UEFA Champions League" },
        score: { fullTime: { home: null, away: null } },
      },
      {
        id: 7,
        utcDate: "2026-12-08T20:00:00Z",
        status: "SCHEDULED",
        homeTeam: { name: "Manchester United FC" },
        awayTeam: { name: "RB Leipzig" },
        competition: { name: "UEFA Champions League" },
        score: { fullTime: { home: null, away: null } },
      },
    ]
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        matches: url.includes("/competitions/PL/")
          ? plMatches
          : clMatches,
      }),
    })
    const result = await getNextFixtures(5, {
      nowMs: NOW_1733,
      fetchImpl: fetchImpl as never,
    })
    expect(result.status).toBe("ok")
    expect(result.fixtures).toHaveLength(5)
    expect(result.fixtures![0]!.away).toBe("Manchester United FC")
    expect(result.fixtures![0]!.home).toBe("Sporting Clube de Portugal")
    expect(
      result.fixtures!.some(
        (fixture) =>
          fixture.home.includes("Sunderland") ||
          fixture.away.includes("Sunderland"),
      ),
    ).toBe(false)
  })
})
