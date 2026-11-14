/**
 * @vitest-environment jsdom
 */
// Sports Corner (0.11.13) — hub states, controller contract, §7.4
// return, tune-in deep links. Plan §12: T20–T22 + T24 (screens),
// T25–T28 (controller), and the sandbox-verifiable halves of the
// [H] round-trip tests (T29–T31 stay open until hardware testing).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveBack } from "@/scripts/lib/back-handler.ts"
import { HINT_CONFIGS } from "@/scripts/lib/couch-button-hints.ts"
import { getLogicalView } from "@/scripts/lib/couch-focus.ts"
import { handleLandingBack } from "@/scripts/lib/livetv-landing.ts"
import {
  closeTitleContextMenu,
  isTitleContextMenuOpen,
} from "@/scripts/lib/poster-menu.ts"
import {
  clearRouteOrigin,
  readRouteOrigin,
  recordRouteOrigin,
  setRouteNavigator,
} from "@/scripts/lib/route-origin.ts"
import {
  buildCatchupTuneUrl,
  buildLiveTuneUrl,
  buildSportsEntryCardModel,
  buildSportsHubModel,
  fixtureContextActions,
  focusSportsHubInitial,
  installSportsHubController,
  querySportsHubRoot,
  renderSportsEntryCard,
  renderSportsHub,
  SPORTS_HUB_HINTS,
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
    onWatchFromStart: (f) => calls.push({ action: "watch-from-start", fixture: f }),
    onReplay: (f) => calls.push({ action: "replay", fixture: f }),
    onOpenGuide: () => calls.push({ action: "guide" }),
    onToggleFollow: () => calls.push({ action: "toggle-follow" }),
  }
}

beforeEach(() => {
  closeTitleContextMenu()
  sessionStorage.clear()
  localStorage.clear()
  clearRouteOrigin()
  setRouteNavigator(null)
  document.body.innerHTML = shellHtml()
})

afterEach(() => {
  closeTitleContextMenu()
  document.body.innerHTML = ""
  sessionStorage.clear()
  localStorage.clear()
  clearRouteOrigin()
  setRouteNavigator(null)
  vi.unstubAllGlobals()
})

function hubRoot(): SportsHubRoot {
  const root = querySportsHubRoot(document)
  if (!root) throw new Error("hub shell missing")
  return root
}

describe("hub states (T20, T21, T22)", () => {
  it("T20: no EPG state → loading copy, no rows; fixtures render on load", () => {
    const callbacks = stubCallbacks()
    const loading = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "loading",
      scanResult: null,
      nowMs: NOW,
    })
    expect(loading.state).toBe("loading")
    renderSportsHub(hubRoot(), loading, callbacks, NOW)
    expect(document.body.textContent).toContain("Loading the programme guide")
    expect(
      document.querySelectorAll("[data-couch-key^='sports:fixture:']").length,
    ).toBe(0)

    const ready = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
      nowMs: NOW,
    })
    renderSportsHub(hubRoot(), ready, callbacks, NOW)
    expect(document.body.textContent).toContain("Man Utd v Sunderland")
    expect(document.body.textContent).not.toContain(
      "Loading the programme guide",
    )
  })

  it("T21: failure + no state → failure copy, no invented rows", () => {
    const failed = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "failed",
      scanResult: null,
      nowMs: NOW,
    })
    expect(failed.state).toBe("failed")
    renderSportsHub(hubRoot(), failed, stubCallbacks(), NOW)
    expect(document.body.textContent).toContain(
      "The programme guide couldn't be loaded",
    )
    expect(document.body.textContent).toContain(
      "no listings are shown rather than guessed ones",
    )
    expect(
      document.querySelectorAll("[data-couch-key^='sports:fixture:']").length,
    ).toBe(0)
  })

  it("T21: failure + last-good state → fixtures + staleness note", () => {
    const stale = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "failed",
      scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
      nowMs: NOW,
    })
    expect(stale.state).toBe("ready")
    expect(stale.stale).toBe(true)
    renderSportsHub(hubRoot(), stale, stubCallbacks(), NOW)
    expect(document.body.textContent).toContain("Man Utd v Sunderland")
    const note = document.querySelector("[data-sports-hub-stale]")
    expect((note as HTMLElement).hidden).toBe(false)
    expect(note?.textContent).toContain("may be out of date")
  })

  it("T22: EPG loaded, zero fixtures → honest empty copy, no hero, no rows", () => {
    const empty = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([]),
      nowMs: NOW,
    })
    renderSportsHub(hubRoot(), empty, stubCallbacks(), NOW)
    expect(document.body.textContent).toContain(
      "No Manchester United matches in your programme guide right now",
    )
    expect(document.body.textContent).toContain("next day and a half")
    expect(document.querySelector(".rs-sports-hero")).toBeNull()
    expect(
      document.querySelectorAll("[data-couch-key^='sports:fixture:']").length,
    ).toBe(0)
  })

  it("unfollowed → Follow CTA, no fixtures rendered", () => {
    const model = buildSportsHubModel({
      followed: false,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([fixture({ title: "Man Utd v Sunderland" })]),
      nowMs: NOW,
    })
    expect(model.state).toBe("unfollowed")
    renderSportsHub(hubRoot(), model, stubCallbacks(), NOW)
    expect(document.body.textContent).toContain("Follow Manchester United")
    expect(document.body.textContent).not.toContain("Man Utd v Sunderland")
  })

  it("no channels mapped → no-mapping copy", () => {
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: { ...scanResult([]), mappedChannelCount: 0 },
      nowMs: NOW,
    })
    expect(model.state).toBe("no-mapping")
    renderSportsHub(hubRoot(), model, stubCallbacks(), NOW)
    expect(document.body.textContent).toContain(
      "None of your channels matched programme data",
    )
  })

  it("possible + other-squad fixtures render in their own flagged sections", () => {
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult([
        fixture({ title: "Man Utd v Sunderland" }),
        fixture({
          title: "United v Chelsea",
          tier: "possible",
          id: "2:x:possible",
          startMs: NOW + 5 * HOUR,
          stopMs: NOW + 7 * HOUR,
        }),
        fixture({
          title: "Manchester United Women v Arsenal Women",
          squad: "other-squad",
          id: "3:x:women",
          startMs: NOW + 6 * HOUR,
          stopMs: NOW + 8 * HOUR,
        }),
      ]),
      nowMs: NOW,
    })
    renderSportsHub(hubRoot(), model, stubCallbacks(), NOW)
    const text = document.body.textContent ?? ""
    expect(text).toContain("Possible Matches")
    expect(text).toContain("without naming the club")
    expect(text).toContain("Unconfirmed team")
    expect(text).toContain("Other Squads")
    // The women's fixture is NOT in the Upcoming section: it appears
    // after the Other Squads heading, not before it.
    const squadsAt = text.indexOf("Other Squads")
    const womenAt = text.indexOf("Manchester United Women v Arsenal Women")
    expect(womenAt).toBeGreaterThan(squadsAt)
  })
})

describe("entry card (T24)", () => {
  it("T24: card next-match line matches the hub hero fixture", () => {
    const hero = fixture({ title: "Man Utd v Sunderland" })
    const result = scanResult([
      hero,
      fixture({
        title: "Man Utd v Fulham",
        id: "2:x:fulham",
        startMs: NOW + 20 * HOUR,
        stopMs: NOW + 22 * HOUR,
      }),
    ])
    const hubModel = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: result,
      nowMs: NOW,
    })
    const cardModel = buildSportsEntryCardModel(
      true,
      true,
      "ready",
      result,
      NOW,
    )
    expect(cardModel.nextFixture?.id).toBe(hubModel.hero?.id)
    const container = document.createElement("div")
    document.body.appendChild(container)
    renderSportsEntryCard(container, cardModel, {
      onWatchLive: () => {},
      onToggleFollow: () => {},
    })
    expect(container.textContent).toContain(
      "Next match: Man Utd v Sunderland",
    )
  })

  it("T24: Watch button present only when a fixture is live now", () => {
    const live = fixture({
      title: "Man Utd v Sunderland",
      startMs: NOW - HOUR,
      stopMs: NOW + HOUR,
    })
    const upcoming = fixture({ title: "Man Utd v Fulham" })
    const liveContainer = document.createElement("div")
    document.body.appendChild(liveContainer)
    renderSportsEntryCard(
      liveContainer,
      buildSportsEntryCardModel(true, true, "ready", scanResult([live]), NOW),
      { onWatchLive: () => {}, onToggleFollow: () => {} },
      NOW,
    )
    expect(liveContainer.textContent).toContain("Watch live")

    const upcomingContainer = document.createElement("div")
    document.body.appendChild(upcomingContainer)
    renderSportsEntryCard(
      upcomingContainer,
      buildSportsEntryCardModel(
        true,
        true,
        "ready",
        scanResult([upcoming]),
        NOW,
      ),
      { onWatchLive: () => {}, onToggleFollow: () => {} },
      NOW,
    )
    expect(upcomingContainer.textContent).not.toContain("Watch live")
    expect(upcomingContainer.textContent).toContain("Open Sports Corner")
  })
})

describe("controller contract (T25, T26, T27, T28)", () => {
  function mountHub(fixtures: SportsFixture[]) {
    const callbacks = stubCallbacks()
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult(fixtures),
      nowMs: NOW,
    })
    renderSportsHub(hubRoot(), model, callbacks, NOW)
    const shell = document.querySelector<HTMLElement>(
      "[data-sports-hub-shell]",
    )!
    const controller = installSportsHubController(
      shell,
      () => fixtures,
      callbacks,
    )
    return { callbacks, controller, shell }
  }

  it("installing the controller sets the logical view + hints", () => {
    const { controller } = mountHub([
      fixture({ title: "Man Utd v Sunderland" }),
    ])
    expect(getLogicalView()).toBe("followed-sports")
    expect(SPORTS_HUB_HINTS.id).toBe("followed-sports")
    expect(HINT_CONFIGS["followed-sports"]).toEqual(SPORTS_HUB_HINTS)
    controller.destroy()
  })

  it("T25: B with the menu open closes the menu and refocuses the row; B again → Followed", () => {
    const navigated: string[] = []
    setRouteNavigator((url) => navigated.push(url))
    const row = fixture({ title: "Man Utd v Sunderland" })
    const { controller } = mountHub([row])
    const rowEl = document.querySelector<HTMLElement>(
      "[data-couch-key^='sports:fixture:']",
    )!
    rowEl.focus()
    rowEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true }),
    )
    expect(isTitleContextMenuOpen()).toBe(true)

    expect(resolveBack()).toBe(true)
    expect(isTitleContextMenuOpen()).toBe(false)
    expect(document.activeElement).toBe(rowEl)
    expect(navigated).toEqual([])

    expect(resolveBack()).toBe(true)
    expect(navigated).toEqual(["/followed"])
    controller.destroy()
  })

  it("T26: B with no menu → navigateBackWithOrigin('/followed'); recorded origin honoured", () => {
    const navigated: string[] = []
    setRouteNavigator((url) => navigated.push(url))
    const { controller } = mountHub([
      fixture({ title: "Man Utd v Sunderland" }),
    ])
    expect(resolveBack()).toBe(true)
    expect(navigated).toEqual(["/followed"])
    controller.destroy()

    recordRouteOrigin({ route: "/movies" })
    const second = mountHub([fixture({ title: "Man Utd v Sunderland" })])
    expect(resolveBack()).toBe(true)
    expect(navigated).toEqual(["/followed", "/movies"])
    second.controller.destroy()
  })

  it("T27: X on a row opens the menu with real actions only", () => {
    // 0.11.14 integration adjudication: the X-key menu path derives
    // actions with the REAL wall clock (fixtureContextActions
    // defaults nowMs to Date.now()), while mountHub renders against
    // the fixed NOW. A fixed-clock fixture ages into "past" and the
    // menu honestly drops Watch (past + no catch-up → Guide only,
    // pinned by the sibling T27 below) — that failure is pre-existing
    // on 0.11.13, not a 0.11.14 change. Anchor this fixture to the
    // wall clock so the test keeps testing what it claims: an
    // upcoming row without catch-up.
    const row = fixture({
      title: "Man Utd v Sunderland",
      startMs: Date.now() + 2 * HOUR,
      stopMs: Date.now() + 4 * HOUR,
    })
    const { controller } = mountHub([row])
    const rowEl = document.querySelector<HTMLElement>(
      "[data-couch-key^='sports:fixture:']",
    )!
    rowEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true }),
    )
    expect(isTitleContextMenuOpen()).toBe(true)
    const labels = [...document.querySelectorAll("[role='menuitem']")].map(
      (item) => item.textContent,
    )
    // Upcoming row without catch-up: Watch + Open in Guide only.
    expect(labels).toEqual(["Watch", "Open in Guide"])
    controller.destroy()
  })

  it("T27: X on the Unfollow button is a no-op; Y is unconsumed; LB/RB not hinted", () => {
    const { controller } = mountHub([
      fixture({ title: "Man Utd v Sunderland" }),
    ])
    const unfollow = document.querySelector<HTMLElement>(
      "[data-sports-hub-follow]",
    )!
    unfollow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true }),
    )
    expect(isTitleContextMenuOpen()).toBe(false)

    const rowEl = document.querySelector<HTMLElement>(
      "[data-couch-key^='sports:fixture:']",
    )!
    rowEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", bubbles: true }),
    )
    expect(isTitleContextMenuOpen()).toBe(false)

    const glyphs = SPORTS_HUB_HINTS.items.map((item) => item.glyph)
    expect(glyphs).not.toContain("lb")
    expect(glyphs).not.toContain("rb")
    controller.destroy()
  })

  it("T27: context actions for a live catch-up row include Watch from start; past replay rows offer Replay", () => {
    const callbacks = stubCallbacks()
    // Catch-up actions are re-derived at render time from the
    // channel's catch-up capability — the scan-time field is
    // advisory. tvArchive: 1 + a window covering the programme is
    // what makes a row restartable/replayable.
    const catchupChannel = { tvArchive: 1, tvArchiveDuration: 48 }
    const live = fixture({
      title: "Man Utd v Sunderland",
      startMs: NOW - HOUR,
      stopMs: NOW + HOUR,
      channelCatchup: catchupChannel,
    })
    expect(
      fixtureContextActions(live, callbacks, NOW).map((a) => a.id),
    ).toEqual(["watch", "watch-from-start", "open-guide"])

    const past = fixture({
      title: "Liverpool v Man Utd",
      startMs: NOW - 3 * HOUR,
      stopMs: NOW - HOUR,
      channelCatchup: catchupChannel,
    })
    expect(
      fixtureContextActions(past, callbacks, NOW).map((a) => a.id),
    ).toEqual(["replay", "open-guide"])

    const pastNoReplay = fixture({
      title: "Liverpool v Man Utd",
      startMs: NOW - 3 * HOUR,
      stopMs: NOW - HOUR,
      channelCatchup: {},
    })
    expect(
      fixtureContextActions(pastNoReplay, callbacks, NOW).map((a) => a.id),
    ).toEqual(["open-guide"])
  })

  it("T28: focus memory restores the focused row across a re-render + reorder", () => {
    const rows = [
      fixture({ title: "Man Utd v Sunderland", id: "1:a" }),
      fixture({ title: "Man Utd v Fulham", id: "2:b", startMs: NOW + 5 * HOUR, stopMs: NOW + 7 * HOUR }),
      fixture({ title: "Man Utd v Brentford", id: "3:c", startMs: NOW + 8 * HOUR, stopMs: NOW + 10 * HOUR }),
    ]
    const { callbacks, controller } = mountHub(rows)
    const rowEls = [...document.querySelectorAll<HTMLElement>(
      "[data-couch-key^='sports:fixture:']",
    )]
    // Focus "row 3" (the third fixture row in the Upcoming list;
    // the hero Watch button is a separate control).
    const third = rowEls.find((el) =>
      el.getAttribute("data-fixture-id") === "3:c",
    )!
    third.focus()
    third.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))

    // Leave (focus drops to body) and return with a reordered list.
    ;(document.activeElement as HTMLElement | null)?.blur()
    const reordered = [rows[2]!, rows[0]!, rows[1]!]
    const model = buildSportsHubModel({
      followed: true,
      hasPlaylist: true,
      hasChannels: true,
      epgStatus: "ready",
      scanResult: scanResult(reordered),
      nowMs: NOW,
    })
    renderSportsHub(hubRoot(), model, callbacks, NOW)
    focusSportsHubInitial(document)
    const focused = document.activeElement as HTMLElement | null
    expect(focused?.getAttribute("data-fixture-id")).toBe("3:c")
    controller.destroy()
  })

  it("initial focus falls back to the hero Watch button when no memory exists", () => {
    const { controller } = mountHub([
      fixture({ title: "Man Utd v Sunderland" }),
    ])
    focusSportsHubInitial(document)
    expect(
      (document.activeElement as HTMLElement | null)?.getAttribute(
        "data-couch-key",
      ),
    ).toBe("sports:hero:watch")
    controller.destroy()
  })
})

describe("§7.4 landing-B return (sandbox half of T29)", () => {
  it("recorded hub origin → B returns to the hub and sets the back-nav flag", () => {
    recordRouteOrigin({ route: "/followed/sports" })
    const seen: string[] = []
    expect(
      handleLandingBack({ detail: { context: "landing" } }, (url) =>
        seen.push(url),
      ),
    ).toBe(true)
    expect(seen).toEqual(["/followed/sports"])
    // One-shot: the origin is consumed.
    expect(readRouteOrigin()).toBeNull()
    // The back-nav flag stops the hub recording /livetv as an origin.
    expect(sessionStorage.getItem("nylah:route-back-nav")).toBe("1")
  })

  it("no origin → Home, as before", () => {
    const seen: string[] = []
    expect(handleLandingBack(null, (url) => seen.push(url))).toBe(true)
    expect(seen).toEqual(["/"])
  })

  it("a Live TV origin is ignored — the landing never returns to itself", () => {
    recordRouteOrigin({ route: "/livetv" })
    const seen: string[] = []
    expect(handleLandingBack(null, (url) => seen.push(url))).toBe(true)
    expect(seen).toEqual(["/"])
    expect(readRouteOrigin()).toBeNull()
  })

  it("a Followed origin returns to Followed", () => {
    recordRouteOrigin({ route: "/followed" })
    const seen: string[] = []
    expect(handleLandingBack(null, (url) => seen.push(url))).toBe(true)
    expect(seen).toEqual(["/followed"])
  })
})

describe("tune-in deep links (sandbox halves of T30/T31)", () => {  it("live tune: /livetv?channel=<numeric id>", () => {
    const target = buildLiveTuneUrl(fixture({ title: "Man Utd v Sunderland" }))
    expect(target?.url).toBe("/livetv?channel=101")
  })

  it("catch-up tune mirrors epg.ts: cstart/cstop/ctitle, no cid", () => {
    const target = buildCatchupTuneUrl(
      fixture({
        title: "Liverpool v Man Utd",
        startMs: NOW - 3 * HOUR,
        stopMs: NOW - HOUR,
        rawStartMs: NOW - 3 * HOUR,
        rawStopMs: NOW - HOUR,
      }),
      "pl1",
    )
    expect(target?.url).toBe(
      `/livetv?channel=101&cstart=${NOW - 3 * HOUR}&cstop=${NOW - HOUR}&ctitle=Liverpool%20v%20Man%20Utd`,
    )
    expect(target?.url).not.toContain("cid=")
  })

  it("non-numeric channel id → null (caller falls back to landing + toast)", () => {
    expect(
      buildLiveTuneUrl(
        fixture({ title: "Man Utd v Sunderland", channelId: "sky-main" }),
      ),
    ).toBeNull()
    expect(
      buildCatchupTuneUrl(
        fixture({ title: "Man Utd v Sunderland", channelId: "sky-main" }),
        "pl1",
      ),
    ).toBeNull()
  })
})

describe("channel-cache hydration (plan §2.4 gap fix)", () => {
  it("both mounts hydrate the live/m3u cache from IndexedDB before reading channels", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    // The in-memory channel cache is per-page-load: without
    // hydration a fresh hub load always reads zero channels and
    // shows the no-channels state. Both mounts must warm the
    // cache first (the livetv-data.ts / home.ts pattern).
    const hubSource = readFileSync(
      join(here, "..", "src", "scripts", "followed-sports-page.ts"),
      "utf8",
    )
    const hubMount = hubSource.slice(
      hubSource.indexOf("async function resolvePlaylist"),
    )
    expect(hubMount).toContain('hydrateCache(runtime.playlistId, "live")')
    expect(hubMount).toContain('hydrateCache(runtime.playlistId, "m3u")')
    expect(
      hubMount.indexOf("hydrateCache(runtime.playlistId"),
    ).toBeLessThan(hubMount.indexOf("readCachedLiveChannels("))

    const followedSource = readFileSync(
      join(here, "..", "src", "scripts", "followed-page.ts"),
      "utf8",
    )
    const cardMount = followedSource.slice(
      followedSource.indexOf("async function mountSportsEntryCard"),
    )
    expect(cardMount).toContain('hydrateCache(playlistId, "live")')
    expect(cardMount).toContain('hydrateCache(playlistId, "m3u")')
    expect(cardMount.indexOf("hydrateCache(playlistId")).toBeLessThan(
      cardMount.indexOf("readCachedLiveChannels("),
    )
  })
})
