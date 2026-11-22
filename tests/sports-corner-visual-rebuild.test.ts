/**
 * @vitest-environment jsdom
 */
// Sports Corner visual rebuild (fix-3, workstream 3) — every
// section below the hero renders as designed cards, never raw
// text lists. The hero, crest, fades, table layout, reminders and
// section order are pinned by the existing suites; this file pins
// the new card shapes only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  clearFootballDataCache,
  getLeagueTable,
  getNextFixtures,
  getRecentForm,
  type FeedFixturesResult,
  type FeedFormResult,
  type LeagueTableResult,
} from "@/scripts/lib/football-data.ts"
import {
  MOCK_FRIDAY_AFTERNOON_MS,
  MOCK_NEXT_FIXTURES,
  createMockFetch,
} from "@/scripts/lib/football-data-mock.ts"
import {
  buildNextMatchRows,
  buildSportsHubModel,
  formatFixtureDayBadge,
  nextFixtureArt,
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

function stubCallbacks(): SportsHubCallbacks {
  return {
    onWatch: () => {},
    onWatchFromStart: () => {},
    onReplay: () => {},
    onOpenGuide: () => {},
    onToggleFollow: () => {},
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
  formResult: FeedFormResult
}> {
  localStorage.setItem(FOOTBALL_DATA_KEY_STORAGE_KEY, runtimeTestKey())
  const tableResult = await getLeagueTable({
    fetchImpl: createMockFetch(),
    nowMs,
  })
  const feedResult = await getNextFixtures(5, {
    fetchImpl: createMockFetch(),
    nowMs,
  })
  const formResult = await getRecentForm(5, {
    fetchImpl: createMockFetch(),
    nowMs,
  })
  return { tableResult, feedResult, formResult }
}

/** Full hub: one EPG fixture per bucket. The live classic is
 *  tier "recorded" (what the real classifier produces for a
 *  classic title) — it is a TV programme, not a fixture, so it
 *  appears nowhere as a row or a card. */
function fullHubFixtures(): SportsFixture[] {
  return [
    fixture({
      title: "United v Bayern Classic 1999",
      teams: ["Man Utd", "Bayern"],
      channelId: 301,
      channelName: "MUTV",
      startMs: FRIDAY - 30 * MINUTE,
      stopMs: FRIDAY + 60 * MINUTE,
      id: "301:classic",
      tier: "recorded",
    }),
    fixture({
      title: "Man Utd v Sunderland",
      startMs: FRIDAY + 2 * HOUR,
      stopMs: FRIDAY + 4 * HOUR,
      id: "101:upcoming",
    }),
    fixture({
      title: "United v Chelsea: Premier League",
      teams: ["United", "Chelsea"],
      tier: "possible",
      channelName: "Sky Sports Main Event",
      startMs: FRIDAY + 5 * HOUR,
      stopMs: FRIDAY + 7 * HOUR,
      id: "101:possible",
    }),
    fixture({
      title: "Manchester United Women v Arsenal Women",
      teams: ["Manchester United Women", "Arsenal Women"],
      squad: "other-squad",
      channelName: "Sky Sports Main Event",
      startMs: FRIDAY + 3 * HOUR,
      stopMs: FRIDAY + 5 * HOUR,
      id: "101:women",
    }),
    fixture({
      title: "Liverpool v Man Utd",
      startMs: FRIDAY - 3 * HOUR,
      stopMs: FRIDAY - HOUR,
      id: "101:recent",
    }),
  ]
}

async function renderFullHub() {
  const { tableResult, feedResult, formResult } = await feedResults(FRIDAY)
  const model = buildSportsHubModel({
    followed: true,
    hasPlaylist: true,
    hasChannels: true,
    epgStatus: "ready",
    scanResult: scanResult(fullHubFixtures()),
    nowMs: FRIDAY,
    tableResult,
    feedResult,
    formResult,
    nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], []),
  })
  renderSportsHub(hubRoot(), model, stubCallbacks(), FRIDAY)
  return model
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

describe("visual rebuild — Next Matches are image cards", () => {
  it("five cards, each with a stadium thumb, date badge, opponent, station and reminder slot", async () => {
    await renderFullHub()
    const cards = [...document.querySelectorAll(".rs-sports-next-row")]
    expect(cards).toHaveLength(5)
    for (const card of cards) {
      expect(card.querySelector(".rs-sports-next-thumb")).not.toBeNull()
      expect(card.querySelector(".rs-sports-next-date")).not.toBeNull()
      expect(card.querySelector(".rs-sports-next-opponent")).not.toBeNull()
      expect(card.querySelector(".rs-sports-next-station")).not.toBeNull()
      expect(card.querySelector("[data-reminder-slot]")).not.toBeNull()
      expect(card.querySelector(".rs-sports-next-body")).not.toBeNull()
    }
  })

  it("date badges read 22 NOV, 25 NOV, 28 NOV, 02 DEC, 05 DEC", async () => {
    await renderFullHub()
    const badges = [
      ...document.querySelectorAll(".rs-sports-next-date"),
    ].map((badge) => ({
      day: badge.querySelector(".rs-sports-next-date-day")?.textContent,
      mon: badge.querySelector(".rs-sports-next-date-mon")?.textContent,
    }))
    expect(badges).toEqual([
      { day: "22", mon: "NOV" },
      { day: "25", mon: "NOV" },
      { day: "28", mon: "NOV" },
      { day: "02", mon: "DEC" },
      { day: "05", mon: "DEC" },
    ])
  })

  it("stadium art: Anfield for Liverpool, Gtech for Brentford, St James' for Newcastle, Old Trafford at home, gradient fallback for Sporting away", async () => {
    const { feedResult } = await feedResults(FRIDAY)
    const fixtures = feedResult.fixtures ?? []
    expect(fixtures).toHaveLength(5)
    const art = fixtures.map((f) => nextFixtureArt(f))
    expect(art[0]).toContain("football-liverpool-anfield-kop.jpg")
    expect(art[1]).toBeNull()
    expect(art[2]).toContain("football-brentford-gtech-lineup.jpg")
    expect(art[3]).toContain("football-newcastle-st-james.jpg")
    expect(art[4]).toContain("football-man-utd-old-trafford.jpg")

    await renderFullHub()
    const thumbs = [...document.querySelectorAll(".rs-sports-next-thumb")]
    expect(thumbs).toHaveLength(5)
    expect(thumbs[0].classList.contains("rs-sports-next-thumb-has-art")).toBe(
      true,
    )
    expect(thumbs[1].classList.contains("rs-sports-next-thumb-has-art")).toBe(
      false,
    )
    expect(thumbs[4].classList.contains("rs-sports-next-thumb-has-art")).toBe(
      true,
    )
  })

  it("formatFixtureDayBadge uses Europe/Dublin: 22 Nov 16:30 UTC is 22 NOV", () => {
    expect(formatFixtureDayBadge(Date.UTC(2026, 10, 22, 16, 30, 0))).toEqual({
      day: "22",
      month: "NOV",
    })
  })
})

describe("visual rebuild — EPG sections are fixture cards, not text lists", () => {
  it("every fixture row is a card with a thumb, body and action pill", async () => {
    await renderFullHub()
    const rows = [...document.querySelectorAll(".rs-sports-row")]
    // Upcoming + Possible + Other Squads + Recent = 4 cards.
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.querySelector(".rs-sports-row-thumb")).not.toBeNull()
      expect(row.querySelector(".rs-sports-row-body")).not.toBeNull()
      expect(row.querySelector(".rs-sports-row-title")).not.toBeNull()
      expect(row.querySelector(".rs-sports-row-meta")).not.toBeNull()
      expect(row.querySelector(".rs-sports-row-action-label")).not.toBeNull()
    }
    // No bare list rows: the grid holds cards, not hairline rows.
    expect(document.querySelectorAll(".rs-sports-list")).toHaveLength(4)
  })

  it("possible card is dashed with the Unconfirmed-team badge; recent card is muted", async () => {
    await renderFullHub()
    const possible = document.querySelector(
      '[data-sports-section="possible"] .rs-sports-row',
    )
    expect(possible?.classList.contains("rs-sports-row--possible")).toBe(true)
    expect(possible?.textContent).toContain("Unconfirmed team")
    const recent = document.querySelector(
      '[data-sports-section="recent"] .rs-sports-row',
    )
    expect(recent?.classList.contains("rs-sports-row--recent")).toBe(true)
    const other = document.querySelector(
      '[data-sports-section="other-squads"] .rs-sports-row',
    )
    expect(other?.classList.contains("rs-sports-row--other")).toBe(true)
  })

  // Feed-first (0.11.26) — the old test pinned an ON NOW badge
  // on a classic's on-TV-now card. A classic is never an
  // on-TV-now card now (no feed fixture, no entry). The badge
  // placement pin survives in its correct form: a feed-backed
  // live fixture's LIVE badge sits on the card thumb.
  it("on-TV-now live badge sits on the card thumb", async () => {
    const { tableResult, feedResult, formResult } =
      await feedResults(FRIDAY)
    const sunday = KICKOFF + 63 * MINUTE
    const listing = fixture({
      title: "Liverpool v Man Utd",
      teams: ["Liverpool", "Man Utd"],
      channelId: 201,
      channelName: "Sky Sports Main Event",
      alsoOn: [{ channelId: 202, channelName: "Sky Sports Premier League" }],
      startMs: KICKOFF,
      stopMs: KICKOFF + 143 * MINUTE,
      id: "201:liverpool-live",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([listing]),
      nowMs: sunday,
      tableResult,
      feedResult,
      formResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], [listing]),
      liveMatches: buildNextMatchRows([MOCK_NEXT_FIXTURES[0]], [listing]),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), sunday)
    const card = document.querySelector(".rs-sports-onnow-card")
    expect(
      card?.querySelector(".rs-sports-onnow-thumb .rs-sports-badge")
        ?.textContent,
    ).toBe("LIVE")
  })

  it("section titles carry count pills", async () => {
    await renderFullHub()
    for (const key of ["upcoming", "possible", "other-squads", "recent"]) {
      const section = document.querySelector(
        `[data-sports-section="${key}"]`,
      )
      expect(
        section?.querySelector(".rs-sports-section-count")?.textContent,
      ).toBe("1")
    }
  })

  // Feed-first (0.11.26) — the old test used an EPG-only live
  // fixture, which now stays in Upcoming. Empty Upcoming needs a
  // feed-backed live fixture: Liverpool live (feed) + the Sky
  // listing (EPG) is featured once in on-TV-now and excluded from
  // Upcoming, so Upcoming renders its designed empty panel.
  it("empty Upcoming renders a designed empty panel, not a bare line", async () => {
    const { tableResult, feedResult, formResult } =
      await feedResults(FRIDAY)
    const sunday = KICKOFF + 63 * MINUTE
    const listing = fixture({
      title: "Liverpool v Man Utd",
      teams: ["Liverpool", "Man Utd"],
      channelId: 201,
      channelName: "Sky Sports Main Event",
      alsoOn: [{ channelId: 202, channelName: "Sky Sports Premier League" }],
      startMs: KICKOFF,
      stopMs: KICKOFF + 143 * MINUTE,
      id: "201:liverpool-live",
    })
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([listing]),
      nowMs: sunday,
      tableResult,
      feedResult,
      formResult,
      nextMatches: buildNextMatchRows(feedResult.fixtures ?? [], [listing]),
      liveMatches: buildNextMatchRows([MOCK_NEXT_FIXTURES[0]], [listing]),
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), sunday)
    const empty = document.querySelector(
      '[data-sports-section="upcoming"] .rs-sports-empty-line',
    )
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain("No upcoming matches")
  })

  it("section order is unchanged: table, hero, on-tv-now, next, upcoming, possible, other-squads, recent", async () => {
    await renderFullHub()
    expect(sectionOrder()).toEqual([
      "table",
      "hero",
      "on-tv-now",
      "next-matches",
      "upcoming",
      "possible",
      "other-squads",
      "recent",
    ])
  })
})

describe("visual rebuild — mini-table is a panel card", () => {
  it("panel head carries the genuine crest and the Premier League label", async () => {
    await renderFullHub()
    const section = document.querySelector(
      '[data-sports-section="table"]',
    )
    expect(section?.classList.contains("rs-sports-table-section")).toBe(true)
    const crest = section?.querySelector(".rs-sports-table-panel-crest")
    expect(crest?.getAttribute("src")).toBe("/brand/man-utd-crest.svg")
    expect(
      section?.querySelector(".rs-sports-table-panel-comp")?.textContent,
    ).toBe("Premier League")
    // Table facts unchanged: United 18th, 8 points, D L L D D.
    expect(
      document.querySelector(".rs-sports-table-big")?.textContent,
    ).toBe("18th")
    expect(
      document.querySelector(".rs-sports-table-points")?.textContent,
    ).toBe("8 points")
    expect(
      [...document.querySelectorAll(".rs-sports-form-chip")].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["D", "L", "L", "D", "D"])
  })
})
