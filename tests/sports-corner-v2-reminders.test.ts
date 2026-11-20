/**
 * @vitest-environment jsdom
 */
// Sports Corner v2 — Phase 3 reminders (plan §8: T-v2-4, D2-A).
//
// Reminder set on Liverpool on Friday; app open Sunday 16:00 →
// banner fires with Watch; toggling off clears it; restart
// preserves it; past-fixture reminder prunes on load. Plus: toggle
// state rendering on rows, X-menu label state, delivered-once (no
// re-fire), and no firing while the app is "closed" (the store
// alone fires nothing — only the hub checker does).
//
// Clock: Friday 20 Nov 2026, 15:00 Europe/Dublin
// (MOCK_FRIDAY_AFTERNOON_MS) for the set; Sunday 22 Nov 16:00 for
// the fire (lead time 30 min before the 16:30 kick-off).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FOOTBALL_DATA_KEY_STORAGE_KEY,
  clearFootballDataCache,
  getLeagueTable,
  getNextFixtures,
  matchFixtureStations,
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
  SPORTS_REMINDERS_STORAGE_KEY,
  SPORTS_REMINDER_PRUNE_AFTER_MS,
  clearSportsReminder,
  dueSportsReminders,
  getSportsReminder,
  hasSportsReminder,
  markReminderDelivered,
  parseSportsReminders,
  readSportsReminders,
  restoreSportsReminders,
  setSportsReminder,
  toggleSportsReminder,
} from "@/scripts/lib/sports-reminders.ts"
import {
  buildNextMatchRows,
  buildSportsHubModel,
  checkSportsReminders,
  fixtureContextActions,
  querySportsHubRoot,
  renderSportsHub,
  resolveDueReminders,
  showSportsReminderBanner,
  type NextMatchRow,
  type SportsHubCallbacks,
  type SportsHubRoot,
} from "@/scripts/followed-sports-page.ts"
import type {
  SportsFixture,
  SportsScanResult,
} from "@/scripts/lib/sports-fixture-scan.ts"
import { resolveBack } from "@/scripts/lib/back-handler.ts"

const FRIDAY = MOCK_FRIDAY_AFTERNOON_MS
const HOUR = 3_600_000
const LIVERPOOL = MOCK_NEXT_FIXTURES[0]!
const LIVERPOOL_KICKOFF = LIVERPOOL.startMs // Sun 22 Nov 2026, 16:30
const SUN_15_59 = LIVERPOOL_KICKOFF - 31 * 60_000
const SUN_16_00 = LIVERPOOL_KICKOFF - 30 * 60_000
const SUN_16_30 = LIVERPOOL_KICKOFF

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

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)

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

/** The EPG fixture for Liverpool (A), Sun 22 Nov 16:30 — the
 *  listing the mock feed's first fixture matches (plan §2). */
function liverpoolEpgFixture(): SportsFixture {
  return fixture({
    id: "1:liv:2026-11-22",
    title: "Liverpool v Man Utd",
    teams: ["Liverpool", "Manchester United"],
    startMs: LIVERPOOL_KICKOFF,
    stopMs: LIVERPOOL_KICKOFF + 2 * HOUR,
    channelName: "Sky Sports Main Event",
    alsoOn: [{ channelId: 102, channelName: "Sky Sports Premier League" }],
  })
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
  reminded: Array<string>
} {
  const calls: Array<{ action: string; fixture?: SportsFixture }> = []
  const reminded: string[] = []
  return {
    calls,
    reminded,
    onWatch: (f) => calls.push({ action: "watch", fixture: f }),
    onWatchFromStart: (f) =>
      calls.push({ action: "watch-from-start", fixture: f }),
    onReplay: (f) => calls.push({ action: "replay", fixture: f }),
    onOpenGuide: () => calls.push({ action: "guide" }),
    onToggleFollow: () => calls.push({ action: "toggle-follow" }),
    onToggleReminder: (f) => reminded.push(f.id),
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

/** Next Matches rows for the mock feed, with the Liverpool EPG
 *  listing attached (so the Liverpool row is watchable); pass []
 *  for the all-TBC variant. */
function nextRows(epgFixtures: SportsFixture[]): NextMatchRow[] {
  return buildNextMatchRows(MOCK_NEXT_FIXTURES, epgFixtures)
}

function renderHub(
  callbacks: SportsHubCallbacks,
  nowMs: number,
  nextMatches: NextMatchRow[],
  tableResult: LeagueTableResult | null = null,
  feedResult: FeedFixturesResult | null = null,
): void {
  const model = buildSportsHubModel({
    followed: true,
    hasPlaylist: true,
    hasChannels: true,
    epgStatus: "ready",
    scanResult: scanResult([liverpoolEpgFixture()]),
    nowMs,
    tableResult,
    feedResult,
    nextMatches,
  })
  renderSportsHub(hubRoot(), model, callbacks, nowMs)
}

function bellFor(fixtureId: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-couch-key="sports:remind:${fixtureId}"]`,
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
  vi.useRealTimers()
})

describe("store — set / toggle / persist (plan §5.2)", () => {
  it("set stores the exact §5.2 record shape, 30-min default lead", () => {
    const record = setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    expect(record).toEqual({
      fixtureId: "fd-535101",
      title: "Liverpool v Man Utd",
      startMs: LIVERPOOL_KICKOFF,
      leadMinutes: 30,
      createdAt: new Date(FRIDAY).toISOString(),
      delivered: false,
    })
    expect(getSportsReminder("fd-535101", FRIDAY)).toEqual(record)
    expect(hasSportsReminder("fd-535101", FRIDAY)).toBe(true)
  })

  it("toggle sets then clears, and clearing a missing reminder is a no-op", () => {
    const target = {
      id: LIVERPOOL.id,
      title: "Liverpool v Man Utd",
      startMs: LIVERPOOL_KICKOFF,
    }
    expect(toggleSportsReminder(target, { nowMs: FRIDAY }).set).toBe(true)
    expect(hasSportsReminder("fd-535101", FRIDAY)).toBe(true)
    const cleared = toggleSportsReminder(target, { nowMs: FRIDAY })
    expect(cleared.set).toBe(false)
    expect(cleared.reminder).toBeNull()
    expect(hasSportsReminder("fd-535101", FRIDAY)).toBe(false)
    expect(clearSportsReminder("fd-535101")).toBe(false)
  })

  it("restart preserves it: a fresh module read finds the stored record", async () => {
    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    // Raw localStorage holds the record — persistence is the store,
    // not module state.
    expect(localStorage.getItem(SPORTS_REMINDERS_STORAGE_KEY)).toContain(
      "fd-535101",
    )
    vi.resetModules()
    const fresh = await import("@/scripts/lib/sports-reminders.ts")
    expect(fresh.getSportsReminder("fd-535101", FRIDAY)?.title).toBe(
      "Liverpool v Man Utd",
    )
  })

  it("corrupt stored data is rejected, never coerced into a reminder", () => {
    localStorage.setItem(SPORTS_REMINDERS_STORAGE_KEY, "{not json")
    expect(readSportsReminders(FRIDAY)).toEqual({})
    localStorage.setItem(
      SPORTS_REMINDERS_STORAGE_KEY,
      JSON.stringify({
        "fd-535101": { fixtureId: "fd-535101", title: "Liverpool v Man Utd" },
        "fd-999": {
          fixtureId: "fd-999",
          title: "Bogus",
          startMs: LIVERPOOL_KICKOFF,
          leadMinutes: 30,
          createdAt: new Date(FRIDAY).toISOString(),
          delivered: false,
        },
      }),
    )
    // The half-record is dropped; the well-formed one survives.
    expect(Object.keys(readSportsReminders(FRIDAY))).toEqual(["fd-999"])
    expect(parseSportsReminders("junk")).toEqual({})
    expect(parseSportsReminders([{ fixtureId: "fd-1" }])).toEqual({})
  })

  it("restore validates, drops bad entries, and returns the count kept", () => {
    const kept = restoreSportsReminders({
      "fd-535101": {
        fixtureId: "fd-535101",
        title: "Liverpool v Man Utd",
        startMs: LIVERPOOL_KICKOFF,
        leadMinutes: 30,
        createdAt: new Date(FRIDAY).toISOString(),
        delivered: false,
      },
      "fd-bad": { fixtureId: "fd-bad", title: "Bogus" },
    })
    expect(kept).toBe(1)
    expect(hasSportsReminder("fd-535101", FRIDAY)).toBe(true)
    expect(restoreSportsReminders("junk")).toBe(0)
    expect(restoreSportsReminders({})).toBe(0)
  })
})

describe("store — prune on load (plan §5.2)", () => {
  it("a reminder for a fixture >2h past is deleted silently on load", () => {
    setSportsReminder(
      { id: "fd-past", title: "Old match", startMs: FRIDAY - SPORTS_REMINDER_PRUNE_AFTER_MS - 60_000 },
      { nowMs: FRIDAY - SPORTS_REMINDER_PRUNE_AFTER_MS - 2 * 60_000 },
    )
    expect(readSportsReminders(FRIDAY)).toEqual({})
    expect(localStorage.getItem(SPORTS_REMINDERS_STORAGE_KEY)).toBeNull()
  })

  it("a reminder for a fixture 1h past survives the load prune", () => {
    setSportsReminder(
      { id: "fd-recent", title: "Just played", startMs: FRIDAY - HOUR },
      { nowMs: FRIDAY - HOUR },
    )
    expect(Object.keys(readSportsReminders(FRIDAY))).toEqual(["fd-recent"])
  })
})

describe("store — due window", () => {
  it("not due at 15:59, due at 16:00, due at kick-off, never after", () => {
    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    expect(dueSportsReminders(SUN_15_59)).toEqual([])
    expect(dueSportsReminders(SUN_16_00).map((r) => r.fixtureId)).toEqual([
      "fd-535101",
    ])
    expect(dueSportsReminders(SUN_16_30).map((r) => r.fixtureId)).toEqual([
      "fd-535101",
    ])
    expect(dueSportsReminders(SUN_16_30 + 60_000)).toEqual([])
  })

  it("a delivered reminder is never due again", () => {
    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    expect(markReminderDelivered("fd-535101")?.delivered).toBe(true)
    expect(dueSportsReminders(SUN_16_00)).toEqual([])
  })
})

describe("T-v2-4 — bell toggle rendering on Next Matches rows", () => {
  it("every row has a bell before Watch; Liverpool is watchable, TBC rows are not", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    renderHub(stubCallbacks(), FRIDAY, nextRows([liverpoolEpgFixture()]), tableResult, feedResult)

    const liverpoolSlot = document.querySelector(
      '[data-reminder-slot="fd-535101"]',
    )
    expect(liverpoolSlot).not.toBeNull()
    const liverpoolActions = [...(liverpoolSlot as HTMLElement).children]
    expect(liverpoolActions.map((node) => node.textContent)).toEqual([
      "🔔 Remind me",
      "Watch",
    ])
    expect(bellFor("fd-535101")?.getAttribute("data-couch-key")).toBe(
      "sports:remind:fd-535101",
    )
    // Honest copy on the toggle: reminders only work while the app is open.
    expect(bellFor("fd-535101")?.getAttribute("aria-label")).toContain(
      "while the app is open",
    )
    // Sporting CP is Station TBC: bell, no Watch.
    const sportingSlot = document.querySelector(
      '[data-reminder-slot="fd-535201"]',
    )
    expect([...(sportingSlot as HTMLElement).children].map((node) => node.textContent)).toEqual([
      "🔔 Remind me",
    ])
  })

  it("clicking the bell toggles the store and repaints it set, then cleared", async () => {
    const { tableResult, feedResult } = await feedResults(FRIDAY)
    const callbacks = stubCallbacks()
    const rows = nextRows([liverpoolEpgFixture()])
    // Production toggle behaviour, stubbed: toggle the store, re-render.
    callbacks.onToggleReminder = (feedFixture) => {
      toggleSportsReminder(
        {
          id: feedFixture.id,
          title: "Liverpool v Man Utd",
          startMs: feedFixture.startMs,
        },
        { nowMs: FRIDAY },
      )
      renderHub(callbacks, FRIDAY, rows, tableResult, feedResult)
    }
    renderHub(callbacks, FRIDAY, rows, tableResult, feedResult)

    bellFor("fd-535101")?.click()
    expect(hasSportsReminder("fd-535101", FRIDAY)).toBe(true)
    const setBell = bellFor("fd-535101")
    expect(setBell?.textContent).toBe("🔔 Reminder set · 30 min before")
    expect(setBell?.classList.contains("rs-sports-remind-set")).toBe(true)
    // The Watch button is untouched by the toggle.
    expect(
      document.querySelector('[data-couch-key="sports:next-watch:fd-535101"]'),
    ).not.toBeNull()

    bellFor("fd-535101")?.click()
    expect(hasSportsReminder("fd-535101", FRIDAY)).toBe(false)
    expect(bellFor("fd-535101")?.textContent).toBe("🔔 Remind me")
    expect(bellFor("fd-535101")?.classList.contains("rs-sports-remind-set")).toBe(
      false,
    )
  })
})

describe("X menu — Remind me (plan §7)", () => {
  it("menu order is Watch → Remind me → Open in Guide, state-aware label", () => {
    const callbacks = stubCallbacks()
    const labels = () =>
      fixtureContextActions(
        liverpoolEpgFixture(),
        callbacks,
        FRIDAY,
        LIVERPOOL,
      ).map((action) => action.label)
    expect(labels()).toEqual(["Watch", "Remind me", "Open in Guide"])

    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    expect(labels()).toEqual(["Watch", "Reminder set — turn off", "Open in Guide"])
  })

  it("invoking the Remind action calls onToggleReminder with the feed fixture", () => {
    const callbacks = stubCallbacks()
    const actions = fixtureContextActions(
      liverpoolEpgFixture(),
      callbacks,
      FRIDAY,
      LIVERPOOL,
    )
    actions.find((action) => action.id === "remind")?.action()
    expect(callbacks.reminded).toEqual(["fd-535101"])
  })

  it("no Remind item for a past feed fixture, or when there is no feed fixture", () => {
    const callbacks = stubCallbacks()
    const pastFeed = { ...LIVERPOOL, startMs: FRIDAY - HOUR }
    expect(
      fixtureContextActions(liverpoolEpgFixture(), callbacks, FRIDAY, pastFeed).map(
        (action) => action.id,
      ),
    ).toEqual(["watch", "open-guide"])
    expect(
      fixtureContextActions(liverpoolEpgFixture(), callbacks, FRIDAY, null).map(
        (action) => action.id,
      ),
    ).toEqual(["watch", "open-guide"])
  })
})

describe("T-v2-4 — firing while the app is open", () => {
  it("set Friday; app open Sunday 16:00 → fires once with station + Watch, then never again", () => {
    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    const rows = nextRows([liverpoolEpgFixture()])
    const shown: Array<{ station: string; watchable: boolean }> = []
    const show = (target: ReturnType<typeof resolveDueReminders>[number]) => {
      shown.push({
        station: target.station,
        watchable: target.epgFixture !== null,
      })
    }

    expect(checkSportsReminders(rows, show, SUN_15_59)).toEqual([])
    expect(shown).toEqual([])

    const fired = checkSportsReminders(rows, show, SUN_16_00)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.reminder.fixtureId).toBe("fd-535101")
    expect(fired[0]?.station).toBe(
      "Sky Sports Main Event · Sky Sports Premier League",
    )
    expect(fired[0]?.stationKnown).toBe(true)
    expect(fired[0]?.epgFixture?.channelName).toBe("Sky Sports Main Event")
    expect(shown).toEqual([
      {
        station: "Sky Sports Main Event · Sky Sports Premier League",
        watchable: true,
      },
    ])
    // Firing marks delivered then clears (plan §4.3, default clear).
    expect(getSportsReminder("fd-535101", SUN_16_00)).toBeNull()
    // Delivered-once: the next pass fires nothing.
    expect(checkSportsReminders(rows, show, SUN_16_00)).toEqual([])
    expect(shown).toHaveLength(1)
  })

  it("toggling off before the lead time means nothing fires", () => {
    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    toggleSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    const shown: unknown[] = []
    expect(
      checkSportsReminders(nextRows([liverpoolEpgFixture()]), () => {
        shown.push(true)
      }, SUN_16_00),
    ).toEqual([])
    expect(shown).toEqual([])
  })

  it("a reminder whose station is still TBC fires with no Watch target", () => {
    setSportsReminder(
      { id: "fd-535201", title: "Sporting CP v Man Utd", startMs: MOCK_NEXT_FIXTURES[1]!.startMs },
      { nowMs: FRIDAY },
    )
    const rows = nextRows([])
    const fired = checkSportsReminders(rows, () => {}, MOCK_NEXT_FIXTURES[1]!.startMs - 30 * 60_000)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.station).toBe("Station TBC")
    expect(fired[0]?.stationKnown).toBe(false)
    expect(fired[0]?.epgFixture).toBeNull()
  })

  it("resolveDueReminders is pure: it never writes the store", () => {
    setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    const before = localStorage.getItem(SPORTS_REMINDERS_STORAGE_KEY)
    const targets = resolveDueReminders(
      [getSportsReminder("fd-535101", FRIDAY)!],
      nextRows([liverpoolEpgFixture()]),
      SUN_16_00,
    )
    expect(targets).toHaveLength(1)
    expect(localStorage.getItem(SPORTS_REMINDERS_STORAGE_KEY)).toBe(before)
    expect(hasSportsReminder("fd-535101", SUN_16_00)).toBe(true)
  })
})

describe("no firing while the app is closed (D2-A scope)", () => {
  it("the store alone fires nothing: days pass with no checker, no banner appears", () => {
    vi.useFakeTimers()
    try {
      setSportsReminder(
        { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
        { nowMs: FRIDAY },
      )
      // Three days of clock, no checkSportsReminders call anywhere.
      vi.advanceTimersByTime(3 * 24 * HOUR)
      expect(
        document.querySelector("[data-sports-reminder-banner]"),
      ).toBeNull()
      expect(document.querySelector(".xt-toast")).toBeNull()
      // The reminder is still there, unfired — the checker owns firing.
      expect(hasSportsReminder("fd-535101", SUN_16_00)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("reminder banner", () => {
  function tunableTarget() {
    const rows = nextRows([liverpoolEpgFixture()])
    const reminder = setSportsReminder(
      { id: LIVERPOOL.id, title: "Liverpool v Man Utd", startMs: LIVERPOOL_KICKOFF },
      { nowMs: FRIDAY },
    )
    const [target] = resolveDueReminders([reminder], rows, SUN_16_00)
    if (!target) throw new Error("target missing")
    return target
  }

  it("shows fixture + station + Watch; Watch tunes and dismisses", () => {
    const callbacks = stubCallbacks()
    const banner = showSportsReminderBanner(tunableTarget(), callbacks)
    expect(banner).not.toBeNull()
    const node = document.querySelector("[data-sports-reminder-banner]")
    expect(node?.textContent).toContain(
      "Kick-off in 30 minutes — Liverpool v Man Utd",
    )
    expect(node?.textContent).toContain("Sky Sports Main Event")
    const watch = document.querySelector<HTMLButtonElement>(
      '[data-couch-key="sports:reminder:watch"]',
    )
    expect(watch).not.toBeNull()
    watch?.click()
    expect(callbacks.calls).toEqual([
      { action: "watch", fixture: liverpoolEpgFixture() },
    ])
    expect(document.querySelector("[data-sports-reminder-banner]")).toBeNull()
  })

  it("does not steal focus when it appears", () => {
    const callbacks = stubCallbacks()
    document.body.focus()
    showSportsReminderBanner(tunableTarget(), callbacks)
    expect(document.activeElement).toBe(document.body)
  })

  it("Dismiss button removes it", () => {
    const callbacks = stubCallbacks()
    const banner = showSportsReminderBanner(tunableTarget(), callbacks)
    document
      .querySelector<HTMLButtonElement>(
        '[data-couch-key="sports:reminder:dismiss"]',
      )
      ?.click()
    expect(document.querySelector("[data-sports-reminder-banner]")).toBeNull()
    banner?.dismiss()
  })

  it("B dismisses it via the Back layer", () => {
    const callbacks = stubCallbacks()
    const banner = showSportsReminderBanner(tunableTarget(), callbacks)
    try {
      expect(resolveBack()).toBe(true)
      expect(document.querySelector("[data-sports-reminder-banner]")).toBeNull()
    } finally {
      banner?.dismiss()
    }
  })

  it("auto-dismisses after 60s", () => {
    vi.useFakeTimers()
    try {
      const callbacks = stubCallbacks()
      showSportsReminderBanner(tunableTarget(), callbacks)
      vi.advanceTimersByTime(59_999)
      expect(document.querySelector("[data-sports-reminder-banner]")).not.toBeNull()
      vi.advanceTimersByTime(1)
      expect(document.querySelector("[data-sports-reminder-banner]")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a TBC reminder shows no Watch button, only station TBC", () => {
    const callbacks = stubCallbacks()
    const rows = nextRows([])
    const reminder = setSportsReminder(
      { id: "fd-535201", title: "Sporting CP v Man Utd", startMs: MOCK_NEXT_FIXTURES[1]!.startMs },
      { nowMs: FRIDAY },
    )
    const [target] = resolveDueReminders([reminder], rows, MOCK_NEXT_FIXTURES[1]!.startMs - 30 * 60_000)
    const banner = showSportsReminderBanner(target!, callbacks)
    try {
      const node = document.querySelector("[data-sports-reminder-banner]")
      expect(node?.textContent).toContain("Station TBC")
      expect(
        document.querySelector('[data-couch-key="sports:reminder:watch"]'),
      ).toBeNull()
      expect(
        document.querySelector('[data-couch-key="sports:reminder:dismiss"]'),
      ).not.toBeNull()
    } finally {
      banner?.dismiss()
    }
  })
})

describe("feed station matching for firing (mock sanity)", () => {
  it("the mock EPG listing matches Liverpool and only Liverpool", () => {
    const matched = matchFixtureStations(MOCK_NEXT_FIXTURES, MOCK_EPG_LISTINGS)
    expect(matched[0]?.station).toBe(
      "Sky Sports Main Event · Sky Sports Premier League",
    )
    expect(matched.slice(1).every((row) => row.station === "Station TBC")).toBe(
      true,
    )
  })
})
