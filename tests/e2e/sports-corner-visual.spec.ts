// Sports Corner visual rebuild (fix-3, workstream 3) — real-browser
// screenshots at 1672x941 and 1920x1080.
//
// Seeds the same fixture playlist + EPG as tests/e2e/flow.spec.ts,
// but with Manchester United programmes on the sports channels, and
// intercepts api.football-data.org with the mock payloads (real
// facts: United 18th / 8 pts / D L L D D, next 5 as of 21 Nov 2026).
// No real key, no network to the feed, no TheSportsDB.
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MOCK_CL_MATCHES_RESPONSE,
  MOCK_PL_MATCHES_RESPONSE,
  MOCK_PL_RESULTS_RESPONSE,
  MOCK_STANDINGS_RESPONSE,
} from "../../src/scripts/lib/football-data-mock.ts"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(
  join(here, "../visual/fixtures/playlist.m3u"),
  "utf8",
)

const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

const HLS_MANIFEST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:10",
  "#EXTINF:10,",
  "https://fixtures.invalid/seg0.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n")

function xmltvTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  )
}

const CHANNELS: Array<{ tvgId: string; name: string }> = [
  { tvgId: "news-one", name: "News One" },
  { tvgId: "news-two", name: "News Two" },
  { tvgId: "sports-prime", name: "Sky Sports Main Event" },
  { tvgId: "sports-extra", name: "Sky Sports Premier League" },
  { tvgId: "sports-plus", name: "MUTV" },
  { tvgId: "drama-central", name: "Drama Central" },
  { tvgId: "comedy-house", name: "Comedy House" },
  { tvgId: "movie-channel", name: "Movie Channel" },
  { tvgId: "kids-zone", name: "Kids Zone" },
]

/** United programmes relative to real now, across the sports channels.
 * Explicit offsets (not hourly blocks): this shape rendered
 * end-to-end in the first screenshot run. Filler blocks cover the
 * non-sports channels so the guide looks real elsewhere. */
function buildSportsEpg(): string {
  const hourMs = 60 * 60 * 1000
  const minuteMs = 60 * 1000
  const now = Date.now()
  const programme = (
    channel: string,
    startOffsetMs: number,
    stopOffsetMs: number,
    title: string,
    desc = "",
  ) =>
    `  <programme start="${xmltvTimestamp(new Date(now + startOffsetMs))}" stop="${xmltvTimestamp(new Date(now + stopOffsetMs))}" channel="${channel}"><title>${title}</title>${desc ? `<desc>${desc}</desc>` : ""}</programme>`

  const channelElements = CHANNELS.map(
    (channel) =>
      `  <channel id="${channel.tvgId}"><display-name>${channel.name}</display-name></channel>`,
  )
  const programmeElements = [
    // Live now: the Liverpool match (on air) + a classic.
    // "Man Utd" is a confirmed alias; bare "United" would
    // classify possible-tier and vanish while on air.
    programme(
      "sports-plus",
      -10 * minuteMs,
      80 * minuteMs,
      "Liverpool v Manchester United",
      "Premier League live from Anfield.",
    ),
    programme(
      "sports-prime",
      -30 * minuteMs,
      60 * minuteMs,
      "Man Utd v Bayern Classic 1999",
      "The 1999 Champions League final, in full.",
    ),
    // Upcoming first team.
    programme(
      "sports-prime",
      2 * hourMs,
      4 * hourMs,
      "Man Utd v Sunderland",
      "Premier League from Old Trafford.",
    ),
    // Possible (bare 'United' + Premier League indicator).
    programme(
      "sports-extra",
      5 * hourMs,
      7 * hourMs,
      "United v Chelsea: Premier League",
    ),
    // Other squads.
    programme(
      "sports-extra",
      3 * hourMs,
      5 * hourMs,
      "Manchester United Women v Arsenal Women",
      "Women's Super League.",
    ),
    // Recent (past).
    programme(
      "sports-prime",
      -3 * hourMs,
      -1 * hourMs,
      "Liverpool v Man Utd",
      "Premier League highlights.",
    ),
    // Filler so the guide looks real elsewhere.
    ...CHANNELS.filter(
      (c) => c.tvgId.startsWith("news") || c.tvgId === "drama-central",
    ).map((channel, index) =>
      programme(
        channel.tvgId,
        -hourMs,
        2 * hourMs,
        `Programme ${index + 1}`,
        "Fixture programme for e2e coverage.",
      ),
    ),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channelElements.join("\n")}\n${programmeElements.join("\n")}\n</tv>\n`
}

async function mockFixtureRoutes(page: Page, epgText: string) {
  await page.context().route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  })
  await page.context().route("https://api.football-data.org/v4/**", async (route) => {
    const url = new URL(route.request().url())
    let payload: unknown = null
    if (url.pathname.includes("/competitions/PL/standings")) {
      payload = MOCK_STANDINGS_RESPONSE
    } else if (url.pathname.includes("/competitions/PL/matches")) {
      const dateFrom = url.searchParams.get("dateFrom") ?? ""
      payload =
        dateFrom !== "" && dateFrom < "2026-11-20"
          ? MOCK_PL_RESULTS_RESPONSE
          : MOCK_PL_MATCHES_RESPONSE
    } else if (url.pathname.includes("/competitions/CL/matches")) {
      payload = MOCK_CL_MATCHES_RESPONSE
    }
    if (payload) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      })
      return
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
  })
  await page.context().route("https://fixtures.invalid/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/playlist.m3u") {
      await route.fulfill({ status: 200, contentType: "audio/x-mpegurl", body: playlistText })
      return
    }
    if (url.pathname === "/epg.xml") {
      await route.fulfill({ status: 200, contentType: "application/xml", body: epgText })
      return
    }
    if (url.pathname.startsWith("/logos/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: LOGO_PNG })
      return
    }
    if (/^\/live\/\d+\.m3u8$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/vnd.apple.mpegurl",
        body: HLS_MANIFEST,
      })
      return
    }
    if (url.pathname === "/seg0.ts") {
      await route.fulfill({ status: 200, contentType: "video/mp2t", body: Buffer.from([0]) })
      return
    }
    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
}

async function seedAppState(page: Page) {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
      localStorage.setItem("xt_last_seen_version", "99.0.0")
      // Followed team (default record shape) + a runtime-only
      // football-data key so the feed client runs, never a real key.
      localStorage.setItem(
        "xt_sports_followed_team",
        JSON.stringify({
          teamId: "manchester-united",
          displayName: "Manchester United",
          followedAt: new Date().toISOString(),
          followed: true,
        }),
      )
      localStorage.setItem("xt_football_data_key", "e2e-screenshot-key")
    } catch {}
    try {
      sessionStorage.setItem("xt_splash_done", "1")
    } catch {}
  })
}

const SHOT_DIR = join(here, "../visual/sports-corner-fix-3")

test("sports corner visual rebuild — screenshots at 1672x941 and 1920x1080", async ({
  page,
}) => {
  // The login + EPG + feed + two full-page shots take ~26s even
  // when healthy, so the 30s default trips on any slowdown.
  test.setTimeout(120_000)
  await mockFixtureRoutes(page, buildSportsEpg())
  await seedAppState(page)

  // Same login flow as tests/e2e/flow.spec.ts.
  await page.goto("/login")
  await page.locator("#tab-m3u").click()
  await page.locator("#m3uUrl").fill("https://fixtures.invalid/playlist.m3u")
  await page.locator("#title").fill("Fixture TV")
  await page.locator("#testBtn").click()
  await expect(page.locator("#status")).toContainText(/9 entries/i)
  await Promise.all([
    page.waitForURL("**/livetv"),
    page.locator("#saveBtn").click(),
  ])
  // Gate: wait until the EPG parse is cached in IndexedDB. The hub
  // reads an in-memory EPG cache, so it must find the parsed guide
  // here — if it mounts first and its own load silently no-ops
  // (no creds yet / load in flight), the hub stays EPG-less with
  // no retry. Live TV triggers the parse on landing.
  await expect
    .poll(
      async () => {
        return await page.evaluate(async () => {
          try {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open("xt_cache")
              req.onsuccess = () => resolve(req.result)
              req.onerror = () => reject(req.error)
            })
            const keys = await new Promise<unknown[]>((resolve, reject) => {
              const tx = db.transaction("entries", "readonly")
              const req = tx.objectStore("entries").getAllKeys()
              req.onsuccess = () => resolve(req.result as unknown[])
              req.onerror = () => reject(req.error)
            })
            db.close()
            return keys.some((key) => String(key).includes("epg_parsed"))
          } catch {
            return false
          }
        })
      },
      { timeout: 60_000 },
    )
    .toBe(true)

  await page.goto("/followed/sports")
  // Feed sections + EPG cards all rendered. The Next row count is
  // time-of-day honest, not pinned: at 16:30+ on matchday the
  // Liverpool fixture has kicked off, so it leaves "Next" (hero +
  // on-TV-now carry it live) and 4 cards remain. Before kick-off
  // it is 5 — the 5-card row is pinned in the jsdom suite.
  await expect(page.locator(".rs-sports-next-row").first()).toBeVisible()
  await expect(page.locator(".rs-sports-table")).toBeVisible()
  await expect(page.locator(".rs-sports-hero")).toBeVisible()
  // Live state: the Liverpool match is on now (on-TV-now card),
  // so the feed hero leads with the next fixture, Sporting CP.
  // EPG-dependent: the guide load is slow in this environment,
  // so these waits get 30s, not the default 5s.
  await expect(
    page.locator('[data-sports-section="on-tv-now"]'),
  ).toContainText("Liverpool", { timeout: 30_000 })
  await expect(page.locator(".rs-sports-row").first()).toBeVisible({
    timeout: 30_000,
  })
  // Let card artwork enrichment settle (or its fallback) before shooting.
  await page.waitForTimeout(2500)

  for (const viewport of [
    { width: 1672, height: 941, tag: "1672" },
    { width: 1920, height: 1080, tag: "1920" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.waitForTimeout(500)
    await page.screenshot({
      path: join(SHOT_DIR, `sports-corner-${viewport.tag}.png`),
      fullPage: true,
    })
  }
})
