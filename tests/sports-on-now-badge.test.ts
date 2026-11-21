/**
 * @vitest-environment jsdom
 */
// Sports Corner — ON NOW vs LIVE badge, rendered (bug 4a, 2026-11-21).
// The pure labelling rule lives in sportsFixtureLiveBadge (tested in
// sports-fixture-scan.test.ts); these tests prove the hub row actually
// paints it: a classic/replay on now reads "ON NOW", a live match on
// now reads "LIVE".
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildSportsHubModel,
  renderSportsHub,
  querySportsHubRoot,
  type SportsHubCallbacks,
  type SportsHubRoot,
} from "@/scripts/followed-sports-page.ts"
import type {
  SportsFixture,
  SportsScanResult,
} from "@/scripts/lib/sports-fixture-scan.ts"

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)
const HOUR = 3_600_000

function fixture(
  overrides: Partial<SportsFixture> & { title: string },
): SportsFixture {
  return {
    id: `1:${overrides.startMs ?? NOW - HOUR}:${overrides.title}`,
    teams: ["Man Utd", "Sunderland"],
    startMs: NOW - HOUR,
    stopMs: NOW + HOUR,
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
    mappedChannelCount: 1,
    channelCount: 1,
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

beforeEach(() => {
  document.body.innerHTML = shellHtml()
})

afterEach(() => {
  document.body.innerHTML = ""
})

function hubRoot(): SportsHubRoot {
  const root = querySportsHubRoot(document)
  if (!root) throw new Error("hub shell missing")
  return root
}

function renderWith(fixtures: SportsFixture[]): void {
  const model = buildSportsHubModel({
    followed: true,
    hasPlaylist: true,
    hasChannels: true,
    epgStatus: "ready",
    scanResult: scanResult(fixtures),
    nowMs: NOW,
  })
  expect(model.state).toBe("ready")
  renderSportsHub(hubRoot(), model, stubCallbacks(), NOW)
}

function badgeTexts(): string[] {
  return [...document.querySelectorAll(".rs-sports-badge")].map(
    (badge) => badge.textContent ?? "",
  )
}

describe("on-now badge — rendered rows (bug 4a)", () => {
  it("a live match on now reads LIVE", () => {
    renderWith([fixture({ title: "Man Utd v Sunderland" })])
    expect(badgeTexts()).toEqual(["LIVE"])
  })

  it("a classic on now reads ON NOW, never LIVE", () => {
    renderWith([
      fixture({ title: "Football Classics: Man Utd v Sunderland" }),
    ])
    expect(badgeTexts()).toEqual(["ON NOW"])
  })

  it("a replay on now reads ON NOW, never LIVE", () => {
    renderWith([
      fixture({ title: "Man Utd v Sunderland: Full Match Replay" }),
    ])
    expect(badgeTexts()).toEqual(["ON NOW"])
  })

  it("a live match and a classic side by side read LIVE and ON NOW", () => {
    renderWith([
      fixture({
        title: "Man Utd v Sunderland",
        startMs: NOW - HOUR,
        stopMs: NOW + HOUR,
      }),
      fixture({
        id: "2:classic",
        title: "Football Classics: Man Utd v Arsenal",
        startMs: NOW - HOUR,
        stopMs: NOW + HOUR,
      }),
    ])
    // Same start: Upcoming sorts by start, then title, so the
    // classic ("Football…") renders before the live match ("Man…").
    expect(badgeTexts()).toEqual(["ON NOW", "LIVE"])
  })
})
