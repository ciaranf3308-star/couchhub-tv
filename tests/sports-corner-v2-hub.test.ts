/**
 * @vitest-environment jsdom
 */
// Sports Corner v2 — Phase 2 hub UI (plan §8: T-v2-1/2/3/5/6/7).
//
// The hub renders from the Phase 1 feed client through the mock
// fetch (no live API, no key exists) plus synthetic EPG fixtures.
// Clock: Friday 20 Nov 2026, 15:00 Europe/Dublin
// (MOCK_FRIDAY_AFTERNOON_MS) — a Friday afternoon when the EPG's
// ~36h window holds none of the next 5 fixtures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import {
  FOOTBALL_DATA_FIXTURES_CACHE_KEY,
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  FOOTBALL_DATA_TABLE_CACHE_KEY,
  clearFootballDataCache,
  getLeagueTable,
  getNextFixtures,
  type FeedFixturesResult,
  type LeagueTableResult,
} from "@/scripts/lib/football-data.ts"
import {
  MOCK_EPG_LISTINGS,
  MOCK_FRIDAY_AFTERNOON_MS,
  MOCK_LEAGUE_TABLE,
  MOCK_NEXT_FIXTURES,
  createFailingFetch,
  createMockFetch,
} from "@/scripts/lib/football-data-mock.ts"
import { buildSportsEntryCardFeed } from "@/scripts/lib/sports-corner-v2-hub.ts"
import {
  buildNextMatchRows,
  buildSportsEntryCardModel,
  buildSportsHubModel,
  querySportsHubRoot,
  renderSportsEntryCard,
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
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)

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
    id: `1:${overrides.startMs ?? NOW}:${overrides.title}`,
    teams: ["Man Utd", "Sunderland"],
    startMs: NOW + 2 * HOUR,
    stopMs: NOW + 4 * HOUR,
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

function scanResult(fixtures: SportsFixture[]): SportsScanResult {
  return {
    fixtures,
    scannedAt: new Date(NOW).toISOString(),
    epgFetchedAt: NOW,
    playlistId: "pl1",
    mappedChannelCount: 3,
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

function sectionOrder(): string[] {
  return [...document.querySelectorAll("[data-sports-section]")].map(
    (node) => node.getAttribute("data-sports-section") ?? "",
  )
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

describe("T-v2-1 — mini-table renders United 18th, expand shows the full table", () => {
  it("renders United 18th P10 8 pts in the compact panel, dated and sourced", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)

    const table = document.querySelector(".rs-sports-table")
    expect(table).not.toBeNull()
    const unitedRow = document.querySelector(".rs-sports-table-row-united")
    expect(unitedRow).not.toBeNull()
    expect([...(unitedRow as HTMLElement).querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "18",
      "Man Utd",
      "10",
      "8",
    ])
    // Big position + points above the mini-table (mockup panel).
    expect(
      document.querySelector(".rs-sports-table-big")?.textContent,
    ).toBe("18th")
    expect(
      document.querySelector(".rs-sports-table-points")?.textContent,
    ).toBe("8 points")
    const text = document.body.textContent ?? ""
    // "As of" is the fetch time — the feed carries no table
    // timestamp of its own (football-data.ts), so the honest date
    // is when the table was fetched, Fri 20 Nov 2026.
    expect(text).toContain("Table as of 20 Nov 2026")
    expect(text).toContain("Football data provided by the Football-Data.org API")
  })

  it("mini-table shows United + neighbours only; expand reveals the full table", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const callbacks = stubCallbacks()
    let expanded = false
    callbacks.onToggleTableExpanded = () => {
      expanded = !expanded
    }
    const render = () => {
      const model = buildSportsHubModel({
        followed: true,
        hasPlaylist: true,
        hasChannels: true,
        epgStatus: "ready",
        scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
        nowMs: FRIDAY,
        tableResult,
        feedResult,
        nextMatches: [],
        tableExpanded: expanded,
      })
      renderSportsHub(hubRoot(), model, callbacks, FRIDAY)
    }
    render()
    // Mini: 17, 18, 19 — Liverpool 4th is NOT in the mini-table.
    let positions = [
      ...document.querySelectorAll(".rs-sports-table tr"),
    ]
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent)
    expect(positions).toEqual(["17", "18", "19"])
    const expand = document.querySelector<HTMLElement>(
      '[data-couch-key="sports:table:expand"]',
    )
    expect(expand).not.toBeNull()
    expect(expand?.textContent).toBe("View full table ›")
    expand?.click()
    expect(expanded).toBe(true)
    render()
    positions = [...document.querySelectorAll(".rs-sports-table tr")]
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent)
    expect(positions).toEqual(["4", "17", "18", "19"])
    expect(
      document.querySelector('[data-couch-key="sports:table:expand"]')
        ?.textContent,
    ).toBe("Show fewer teams")
  })

  it("the table section leads the hub, ahead of the hero", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([
        fixture({
          title: "Man Utd v Sunderland",
          startMs: FRIDAY + 2 * HOUR,
          stopMs: FRIDAY + 4 * HOUR,
        }),
      ]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    expect(sectionOrder()[0]).toBe("table")
    expect(sectionOrder()).toContain("hero")
    expect(sectionOrder().indexOf("table")).toBeLessThan(
      sectionOrder().indexOf("hero"),
    )
  })
})

describe("Sports Corner crest (0.11.16) — genuine crest in the hero and on the entry card", () => {
  it("the hero carries the real crest first, before the Next match eyebrow", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([
        fixture({
          title: "Man Utd v Sunderland",
          startMs: FRIDAY + 2 * HOUR,
          stopMs: FRIDAY + 4 * HOUR,
        }),
      ]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)

    const hero = document.querySelector(".rs-sports-hero")
    expect(hero).not.toBeNull()
    const crest = hero?.querySelector(".rs-sports-hero-crest")
    expect(crest).not.toBeNull()
    expect(crest?.tagName).toBe("IMG")
    // Bundled repo asset — never a feed URL (terms §9.2).
    expect(crest?.getAttribute("src")).toBe("/brand/man-utd-crest.svg")
    expect(crest?.getAttribute("alt")).toBe("Manchester United crest")
    // First thing in the hero body, above the "Next match" eyebrow.
    expect(
      hero?.querySelector(".rs-sports-hero-body")?.firstElementChild,
    ).toBe(crest)
  })

  it("the entry card carries the crest in its art panel", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    renderSportsEntryCard(
      container,
      buildSportsEntryCardModel(
        true,
        true,
        "ready",
        scanResult([
          fixture({
            title: "Man Utd v Sunderland",
            startMs: FRIDAY + 2 * HOUR,
            stopMs: FRIDAY + 4 * HOUR,
          }),
        ]),
        FRIDAY,
      ),
      { onWatchLive: () => {}, onToggleFollow: () => {} },
      FRIDAY,
    )
    const crest = container.querySelector(".rs-sports-card-crest")
    expect(crest).not.toBeNull()
    expect(crest?.tagName).toBe("IMG")
    expect(crest?.getAttribute("src")).toBe("/brand/man-utd-crest.svg")
    expect(crest?.getAttribute("alt")).toBe("Manchester United crest")
    expect(crest?.closest(".rs-sports-card-art")).not.toBeNull()
  })

  it("the crest file exists on disk as a real SVG brand asset", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..")
    const diskPath = join(root, "public", "brand", "man-utd-crest.svg")
    expect(existsSync(diskPath)).toBe(true)
    const svg = readFileSync(diskPath, "utf8")
    expect(svg).toContain("<svg")
    expect(svg.length).toBeGreaterThan(10_000)
  })
})

describe("T-v2-2 — Next Matches lists the next 5 on a Friday afternoon", () => {
  it("lists Liverpool → Sporting CP → Brentford → Newcastle → Coventry with competitions", async () => {
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

    const rows = [...document.querySelectorAll(".rs-sports-next-row")]
    expect(rows).toHaveLength(5)
    // Mockup columns: opponent, day/time, HOME/AWAY · competition.
    expect(rows.map((row) => row.querySelector(".rs-sports-next-opponent")?.textContent)).toEqual([
      "Liverpool",
      "Sporting CP",
      "Brentford",
      "Newcastle",
      "Coventry",
    ])
    const whens = rows.map((row) => row.querySelector(".rs-sports-next-when")?.textContent ?? "")
    expect(whens[0]).toContain("Sun")
    expect(whens[0]).toContain("16:30")
    expect(whens[1]).toContain("Wed")
    expect(whens[1]).toContain("20:00")
    expect(whens[2]).toContain("Sat")
    expect(whens[2]).toContain("15:00")
    expect(whens[3]).toContain("Wed")
    expect(whens[3]).toContain("20:15")
    expect(whens[4]).toContain("Sat")
    expect(whens[4]).toContain("15:00")
    const metas = rows.map((row) => row.querySelector(".rs-sports-row-meta")?.textContent ?? "")
    expect(metas[0]).toContain("AWAY")
    expect(metas[0]).toContain("Premier League")
    expect(metas[1]).toContain("UEFA Champions League")
    expect(metas[2]).toContain("Premier League")
    expect(metas[3]).toContain("Premier League")
    expect(metas[4]).toContain("Premier League")
    // None of the five is inside the EPG window — every column is TBC.
    for (const row of rows) {
      expect(
        row.querySelector(".rs-sports-next-station")?.textContent,
      ).toBe("Station TBC")
    }
    expect(document.querySelectorAll(".rs-sports-next-watch")).toHaveLength(0)
  })

  it("every Next Matches row carries the Phase 3 reminder bell (no Watch on TBC rows)", async () => {
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
    const slots = [...document.querySelectorAll("[data-reminder-slot]")]
    expect(slots).toHaveLength(5)
    expect(slots.map((slot) => slot.getAttribute("data-reminder-slot"))).toEqual(
      MOCK_NEXT_FIXTURES.map((fixture) => fixture.id),
    )
    // Phase 3 fills the slot: exactly one bell toggle per row, and
    // no Watch button — every row is Station TBC on a Friday.
    for (const slot of slots) {
      expect(slot.childElementCount).toBe(1)
      const bell = slot.querySelector(
        `[data-couch-key="sports:remind:${slot.getAttribute("data-reminder-slot")}"]`,
      )
      expect(bell).not.toBeNull()
      expect(bell?.textContent).toBe("🔔 Remind me")
    }
  })
})

describe("T-v2-3 — Liverpool shows its station + Watch once inside the EPG window", () => {
  const liverpoolEpg = fixture({
    title: "Liverpool v Man Utd",
    teams: ["Liverpool", "Man Utd"],
    channelId: 201,
    channelName: "Sky Sports Main Event",
    alsoOn: [{ channelId: 202, channelName: "Sky Sports Premier League" }],
    startMs: Date.UTC(2026, 10, 22, 16, 30, 0),
    stopMs: Date.UTC(2026, 10, 22, 18, 30, 0),
    id: "201:1795:liverpool v man utd",
  })

  it("Liverpool row shows Sky Sports Main Event + Premier League with Watch; the rest stay TBC", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const nextMatches = buildNextMatchRows(feedResult.fixtures ?? [], [
      liverpoolEpg,
    ])
    expect(nextMatches[0].matched.stationKnown).toBe(true)
    expect(nextMatches[0].matched.watchable).toBe(true)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([liverpoolEpg]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches,
    })
    const callbacks = stubCallbacks()
    renderSportsHub(hubRoot(), model, callbacks, FRIDAY)

    const rows = [...document.querySelectorAll(".rs-sports-next-row")]
    expect(rows).toHaveLength(5)
    const liverpoolStation =
      rows[0].querySelector(".rs-sports-next-station")?.textContent ?? ""
    expect(liverpoolStation).toContain("Sky Sports Main Event")
    expect(liverpoolStation).toContain("Sky Sports Premier League")
    expect(liverpoolStation).not.toContain("Station TBC")
    const liverpoolMeta =
      rows[0].querySelector(".rs-sports-row-meta")?.textContent ?? ""
    expect(liverpoolMeta).toContain("Premier League")
    expect(liverpoolMeta).not.toContain("Station TBC")
    const watches = [...document.querySelectorAll(".rs-sports-next-watch")]
    expect(watches).toHaveLength(1)
    expect(watches[0].textContent).toBe("Watch")
    for (const row of rows.slice(1)) {
      expect(
        row.querySelector(".rs-sports-next-station")?.textContent,
      ).toBe("Station TBC")
    }
    // Watch tunes the EPG fixture's channel, not an invented one.
    watches[0].dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(callbacks.calls).toEqual([
      { action: "watch", fixture: liverpoolEpg },
    ])
  })

  it("before the EPG window, the same build shows Station TBC and no Watch", async () => {
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
    expect(document.querySelectorAll(".rs-sports-next-watch")).toHaveLength(0)
    expect(document.body.textContent).toContain("Station TBC")
    expect(MOCK_EPG_LISTINGS).toHaveLength(1)
  })
})

describe("T-v2-5 — feed down / stale / no-key states stay honest", () => {
  it("feed down → 'table unavailable' copy, EPG fixtures still render", async () => {
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeTestKey())
    const failing = createFailingFetch(500)
    const tableResult = await getLeagueTable({ fetchImpl: failing, nowMs: FRIDAY })
    const feedResult = await getNextFixtures(5, { fetchImpl: failing, nowMs: FRIDAY })
    expect(tableResult.status).toBe("error")
    expect(feedResult.status).toBe("error")
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const text = document.body.textContent ?? ""
    expect(text).toContain("League table unavailable")
    expect(text).toContain("Next matches unavailable")
    // The EPG fixture still renders — the feed failure hides nothing.
    expect(text).toContain("Man Utd v Sunderland")
    expect(document.querySelector(".rs-sports-table")).toBeNull()
  })

  it("stale >24h → 'may be out of date' next to the table", async () => {
    localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeTestKey())
    localStorage.setItem(
      FOOTBALL_DATA_TABLE_CACHE_KEY,
      JSON.stringify({ fetchedAt: FRIDAY - 25 * HOUR, data: MOCK_LEAGUE_TABLE }),
    )
    const tableResult = await getLeagueTable({
      fetchImpl: createFailingFetch(500),
      nowMs: FRIDAY,
    })
    expect(tableResult.status).toBe("stale")
    expect(tableResult.mayBeOutOfDate).toBe(true)
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([]),
      nowMs: FRIDAY,
      tableResult,
      feedResult: {
        status: "stale",
        fixtures: MOCK_NEXT_FIXTURES,
        stale: true,
        mayBeOutOfDate: true,
        fetchedAt: FRIDAY - 25 * HOUR,
        fromCache: true,
      },
      nextMatches: buildNextMatchRows(MOCK_NEXT_FIXTURES, []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const text = document.body.textContent ?? ""
    expect(text).toContain("may be out of date")
    // The stale table still renders — flagged, never silently current.
    expect(document.querySelector(".rs-sports-table-row-united")).not.toBeNull()
  })

  it("no key → honest no-key copy pointing at Settings, no invented table", async () => {
    const tableResult = await getLeagueTable({
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    const feedResult = await getNextFixtures(5, {
      fetchImpl: createMockFetch(),
      nowMs: FRIDAY,
    })
    expect(tableResult.status).toBe("no-key")
    expect(feedResult.status).toBe("no-key")
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: [],
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const text = document.body.textContent ?? ""
    expect(text).toContain("API key in Settings")
    expect(document.querySelector(".rs-sports-table")).toBeNull()
    expect(text).toContain("Man Utd v Sunderland")
  })
})

describe("T-v2-6 — Recent never leads", () => {
  it("with no upcoming EPG fixture the order is Table → Next Matches → Upcoming → Recent", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const recent = fixture({
      title: "Man Utd v Fulham",
      startMs: NOW - 3 * HOUR,
      stopMs: NOW - HOUR,
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([recent]),
      nowMs: NOW,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), NOW)
    expect(sectionOrder()).toEqual([
      "table",
      "hero",
      "on-tv-now",
      "next-matches",
      "upcoming",
      "recent",
    ])
    const text = document.body.textContent ?? ""
    expect(text).toContain(
      "No upcoming matches in the guide right now — the guide covers about the next day and a half.",
    )
    // Recent is last, never the lead.
    expect(text.indexOf("Recent Matches")).toBeGreaterThan(
      text.indexOf("Next fixtures"),
    )
    expect(text.indexOf("Man Utd v Fulham")).toBeGreaterThan(
      text.indexOf("Recent Matches"),
    )
  })
})

describe("T-v2-7 — women's fixture stays in Other Squads", () => {
  it("Birmingham v United Women is Other Squads only — never hero, never Next Matches", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const women = fixture({
      title: "Birmingham v United Women",
      teams: ["Birmingham", "United Women"],
      squad: "other-squad",
      startMs: Date.UTC(2026, 10, 22, 12, 0, 0),
      stopMs: Date.UTC(2026, 10, 22, 14, 0, 0),
      id: "1:x:women",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([women]),
      nowMs: FRIDAY,
      tableResult,
      feedResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], [women]),
    })
    expect(model.hero).toBeNull()
    renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
    const text = document.body.textContent ?? ""
    // In Other Squads, after its heading.
    expect(text).toContain("Other Squads")
    expect(text.indexOf("Birmingham v United Women")).toBeGreaterThan(
      text.indexOf("Other Squads"),
    )
    // Never the hero: the hero is the feed's next men's match.
    const hero = document.querySelector(".rs-sports-hero")
    expect(hero).not.toBeNull()
    expect(hero?.textContent).toContain("UNITED CORNER")
    expect(hero?.textContent).toContain("Liverpool v Man Utd")
    expect(hero?.textContent).not.toContain("Women")
    // Never in Next fixtures: the feed list is the men's five only.
    const nextOpponents = [
      ...document.querySelectorAll(".rs-sports-next-row .rs-sports-next-opponent"),
    ].map((node) => node.textContent)
    expect(nextOpponents).toHaveLength(5)
    expect(nextOpponents.join(" ")).not.toContain("Women")
    // Upcoming renders its honest empty line (no first-team EPG
    // fixture is upcoming); Other Squads follows it.
    expect(sectionOrder()).toEqual([
      "table",
      "hero",
      "on-tv-now",
      "next-matches",
      "upcoming",
      "other-squads",
    ])
  })
})

describe("entry card (v2 §4.2) — table line + feed next match", () => {
  it("shows '18th · 8 pts' and the next feed fixture with Station TBC when the EPG window is empty", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const feed = buildSportsEntryCardFeed(tableResult, feedResult, FRIDAY)
    expect(feed.tableLine).toBe("18th · 8 pts")
    expect(feed.nextFeedFixture?.id).toBe("fd-535101")
    const cardModel = buildSportsEntryCardModel(
      true,
      true,
      "ready",
      scanResult([]),
      FRIDAY,
      feed,
    )
    const container = document.createElement("div")
    document.body.appendChild(container)
    renderSportsEntryCard(
      container,
      cardModel,
      { onWatchLive: () => {}, onToggleFollow: () => {} },
      FRIDAY,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("18th · 8 pts")
    expect(text).toContain("Next match: Liverpool v Man Utd")
    expect(text).toContain("Sun 22 Nov 16:30")
    expect(text).toContain("Station TBC")
    // The card never says "no matches" while the feed knows one.
    expect(text).not.toContain("No Manchester United matches")
    // No Watch button: there is no EPG listing to tune.
    expect(text).not.toContain("Watch live")
  })

  it("the EPG next fixture still wins when the guide holds one", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const feed = buildSportsEntryCardFeed(tableResult, feedResult, FRIDAY)
    const epgNext = fixture({
      title: "Man Utd v Sunderland",
      startMs: FRIDAY + 2 * HOUR,
      stopMs: FRIDAY + 4 * HOUR,
    })
    const cardModel = buildSportsEntryCardModel(
      true,
      true,
      "ready",
      scanResult([epgNext]),
      FRIDAY,
      feed,
    )
    const container = document.createElement("div")
    document.body.appendChild(container)
    renderSportsEntryCard(
      container,
      cardModel,
      { onWatchLive: () => {}, onToggleFollow: () => {} },
      FRIDAY,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Next match: Man Utd v Sunderland")
    expect(text).toContain("18th · 8 pts")
    expect(text).not.toContain("Station TBC")
  })
})
