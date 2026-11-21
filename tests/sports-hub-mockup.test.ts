/**
 * @vitest-environment jsdom
 */
// Sports Corner mockup rebuild (0.11.17) — bug 2 decoupling, bug 4b
// call-site wiring, and the mockup layout itself.
//
// Bug 2: the feed-backed sections (table, feed hero, Next fixtures)
// render as soon as their own data arrives, regardless of TV guide
// state. Bug 4b: matchFixtureStation (station) and
// buildNextMatchRows (Watch target) both use epgListingMatchesKickoff,
// so station and Watch can never disagree about which listing a
// match belongs to.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  clearFootballDataCache,
  getLeagueTable,
  getNextFixtures,
  matchFixtureStation,
  STATION_TBC,
  type FeedFixturesResult,
  type LeagueTableResult,
} from "@/scripts/lib/football-data.ts"
import {
  MOCK_EPG_LISTINGS,
  MOCK_FRIDAY_AFTERNOON_MS,
  MOCK_NEXT_FIXTURES,
  createMockFetch,
} from "@/scripts/lib/football-data-mock.ts"
import {
  buildNextMatchRows,
  buildSportsHubModel,
  feedFixtureHomeAway,
  feedFixtureOpponent,
  formatFeedHeroDateTime,
  formatFixtureDayTime,
  querySportsHubRoot,
  renderSportsHub,
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

function liverpoolEpg(startMs: number): SportsFixture {
  return fixture({
    title: "Liverpool v Man Utd",
    teams: ["Liverpool", "Man Utd"],
    channelId: 201,
    channelName: "Sky Sports Main Event",
    alsoOn: [{ channelId: 202, channelName: "Sky Sports Premier League" }],
    startMs,
    stopMs: startMs + 2 * HOUR,
    id: `201:${startMs}:liverpool v man utd`,
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

describe("bug 2 — feed sections render without the TV guide", () => {
  it("no EPG scan yet + feed arrived → ready, table + hero + fixtures render", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "loading",
      scanResult: null,
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    expect(model.state).toBe("ready")
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(document.querySelector(".rs-sports-table")).not.toBeNull()
    expect(document.querySelector(".rs-sports-hero")).not.toBeNull()
    expect(document.querySelectorAll(".rs-sports-next-row")).toHaveLength(5)
    // The on-TV-now section still renders its honest empty line —
    // the guide gate survives only where the guide is actually needed.
    expect(document.body.textContent).toContain("United on TV now")
    expect(document.body.textContent).toContain(
      "No Manchester United programmes on TV right now",
    )
  })

  it("guide failed + feed arrived → ready + stale, feed sections still render", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "failed",
      scanResult: null,
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    expect(model.state).toBe("ready")
    expect(model.stale).toBe(true)
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(document.querySelector(".rs-sports-table")).not.toBeNull()
  })

  it("no EPG scan + no feed → still loading, never a faked hub", () => {
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "loading",
      scanResult: null,
      nowMs: FRIDAY,
    })
    expect(model.state).toBe("loading")
    const failed = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "failed",
      scanResult: null,
      nowMs: FRIDAY,
    })
    expect(failed.state).toBe("failed")
  })

  it("zero mapped channels + feed arrived → ready; without feed → no-mapping", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const withFeed = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([], 0),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    expect(withFeed.state).toBe("ready")
    const withoutFeed = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([], 0),
      nowMs: FRIDAY,
    })
    expect(withoutFeed.state).toBe("no-mapping")
  })

  it("no playlist / no channels + feed arrived → ready, with the Add-a-playlist way in", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    for (const input of [
      { hasPlaylist: false, hasChannels: false },
      { hasPlaylist: true, hasChannels: false },
    ]) {
      const model = buildSportsHubModel({
        followed: true,
        ...input,
        epgStatus: "loading",
        scanResult: null,
        nowMs: FRIDAY,
        tableResult,
        feedResult,
        nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
      })
      expect(model.state).toBe("ready")
      renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
      expect(document.querySelector(".rs-sports-table")).not.toBeNull()
      expect(document.querySelector(".rs-sports-hero")).not.toBeNull()
      expect(
        document.querySelectorAll(".rs-sports-next-row"),
      ).toHaveLength(5)
      if (!input.hasPlaylist) {
        expect(
          document.querySelector(".rs-sports-state-action")?.textContent,
        ).toBe("Add a playlist")
      }
      document.body.innerHTML = shellHtml()
    }
    // Without feed data the old gates stand.
    expect(
      buildSportsHubModel({
        followed: true,
        hasPlaylist: false,
        hasChannels: true,
        epgStatus: "loading",
        scanResult: null,
        nowMs: FRIDAY,
      }).state,
    ).toBe("no-playlist")
    expect(
      buildSportsHubModel({
        followed: true,
        hasPlaylist: true,
        hasChannels: false,
        epgStatus: "loading",
        scanResult: null,
        nowMs: FRIDAY,
      }).state,
    ).toBe("no-channels")
  })
})

describe("bug 4b — both call sites use the pre-match window", () => {
  it("matchFixtureStation: 30 min before matches, 90 min before does not, after kick-off does not", () => {
    const fixture = MOCK_NEXT_FIXTURES[0]
    const prematch = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: KICKOFF - 30 * MINUTE },
    ])
    expect(prematch.stationKnown).toBe(true)
    expect(prematch.station).toContain("Sky Sports Main Event")
    const tooEarly = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: KICKOFF - 90 * MINUTE },
    ])
    expect(tooEarly.station).toBe(STATION_TBC)
    expect(tooEarly.stationKnown).toBe(false)
    const late = matchFixtureStation(fixture, [
      { ...MOCK_EPG_LISTINGS[0], startMs: KICKOFF + 5 * MINUTE },
    ])
    expect(late.station).toBe(STATION_TBC)
  })

  it("buildNextMatchRows: the Watch target agrees with the station in all three cases", () => {
    const prematch = buildNextMatchRows(MOCK_NEXT_FIXTURES, [
      liverpoolEpg(KICKOFF - 30 * MINUTE),
    ])
    expect(prematch[0].matched.stationKnown).toBe(true)
    expect(prematch[0].matched.watchable).toBe(true)
    expect(prematch[0].epgFixture).not.toBeNull()
    expect(prematch[0].epgFixture?.channelName).toBe(
      "Sky Sports Main Event",
    )

    const tooEarly = buildNextMatchRows(MOCK_NEXT_FIXTURES, [
      liverpoolEpg(KICKOFF - 90 * MINUTE),
    ])
    expect(tooEarly[0].matched.stationKnown).toBe(false)
    expect(tooEarly[0].epgFixture).toBeNull()

    const late = buildNextMatchRows(MOCK_NEXT_FIXTURES, [
      liverpoolEpg(KICKOFF + 5 * MINUTE),
    ])
    expect(late[0].matched.stationKnown).toBe(false)
    expect(late[0].epgFixture).toBeNull()
  })
})

describe("mockup layout — feed hero, panel, on-TV-now, fixtures row", () => {
  it("feed hero: crest + UNITED CORNER + Liverpool + Sunday 16:30 + Remind me + TV listing TBC", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const hero = document.querySelector(".rs-sports-hero")
    expect(hero).not.toBeNull()
    expect(hero?.getAttribute("data-feed-fixture-id")).toBe("fd-535101")
    const crest = hero?.querySelector(".rs-sports-hero-crest")
    expect(crest?.getAttribute("src")).toBe("/brand/man-utd-crest.svg")
    expect(
      hero?.querySelector(".rs-sports-hero-body")?.firstElementChild,
    ).toBe(crest)
    const text = hero?.textContent ?? ""
    expect(text).toContain("UNITED CORNER")
    expect(text).toContain("Next match")
    expect(text).toContain("Liverpool v Man Utd")
    expect(text).toContain("Sunday · 16:30")
    expect(text).toContain("Premier League")
    expect(text).toContain("TV listing to be confirmed")
    expect(
      hero?.querySelector('[data-couch-key="sports:hero:remind"]')
        ?.textContent,
    ).toBe("🔔 Remind me")
    // Panel: big position + points (real data — 18th, 8 pts).
    expect(
      document.querySelector(".rs-sports-table-big")?.textContent,
    ).toBe("18th")
    expect(
      document.querySelector(".rs-sports-table-points")?.textContent,
    ).toBe("8 points")
    expect(document.body.textContent).toContain("League position")
    // Section order follows the mockup. (No EPG fixtures at all, so
    // the Upcoming section is replaced by the honest empty block.)
    expect(
      [...document.querySelectorAll("[data-sports-section]")].map((node) =>
        node.getAttribute("data-sports-section"),
      ),
    ).toEqual(["table", "hero", "on-tv-now", "next-matches"])
  })

  it("hero shows the station once the EPG listing lands (pre-match window)", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const listing = liverpoolEpg(KICKOFF - 30 * MINUTE)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([listing]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], [listing]),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const hero = document.querySelector(".rs-sports-hero")
    expect(hero?.textContent).toContain("Sky Sports Main Event")
    expect(hero?.textContent).not.toContain("TV listing to be confirmed")
  })

  it("on-TV-now: a live classic gets an ON NOW card with channel, type, minutes left, Watch", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const classic = fixture({
      title: "United v Bayern Classic 1999",
      teams: ["Man Utd", "Bayern"],
      channelId: 301,
      channelName: "MUTV",
      startMs: FRIDAY - 30 * MINUTE,
      stopMs: FRIDAY + 60 * MINUTE,
      id: "301:classic",
    })
    const callbacks = stubCallbacks()
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([classic]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    renderSportsHub(hubRoot(), model, callbacks, FRIDAY)
    const cards = [...document.querySelectorAll(".rs-sports-onnow-card")]
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card.querySelector(".rs-sports-badge")?.textContent).toBe("ON NOW")
    expect(card.querySelector(".rs-sports-onnow-title")?.textContent).toBe(
      "United v Bayern Classic 1999",
    )
    expect(card.querySelector(".rs-sports-onnow-meta")?.textContent).toBe(
      "MUTV · Classic · 60 min left",
    )
    const watch = card.querySelector<HTMLElement>(
      '[data-couch-key^="sports:onnow:watch:"]',
    )
    expect(watch?.textContent).toBe("Ⓐ Watch")
    watch?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(callbacks.calls).toEqual([{ action: "watch", fixture: classic }])
  })

  it("on-TV-now: a live match gets a LIVE badge, not ON NOW", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const live = fixture({
      title: "Man Utd v Sunderland",
      startMs: FRIDAY - 10 * MINUTE,
      stopMs: FRIDAY + 80 * MINUTE,
      id: "101:live",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([live]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const card = document.querySelector(".rs-sports-onnow-card")
    expect(card?.querySelector(".rs-sports-badge")?.textContent).toBe("LIVE")
    expect(card?.querySelector(".rs-sports-onnow-meta")?.textContent).toBe(
      "Sky Sports Main Event · Sports · 80 min left",
    )
  })

  it("formatters: hero day/time, column day/time, opponent, HOME/AWAY", () => {
    expect(formatFeedHeroDateTime(KICKOFF)).toBe("Sunday · 16:30")
    expect(formatFixtureDayTime(KICKOFF)).toBe("Sun · 16:30")
    expect(feedFixtureOpponent(MOCK_NEXT_FIXTURES[0])).toBe("Liverpool")
    expect(feedFixtureHomeAway(MOCK_NEXT_FIXTURES[0])).toBe("AWAY")
    expect(feedFixtureOpponent(MOCK_NEXT_FIXTURES[2])).toBe("Brentford")
    expect(feedFixtureHomeAway(MOCK_NEXT_FIXTURES[2])).toBe("HOME")
  })
})
