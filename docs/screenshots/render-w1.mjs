// W1 Settings split renders — CouchHub TV 0.11.4 (settings-0114-w1-pages).
// Serves THIS worktree's built dist via python http.server and screenshots
// every Settings page at 1920x1080, top + scrolled, plus sticky/scroll-mt/
// pill-clearance measurements. Fixture data only — nothing here ships.
import { createRequire } from "node:module"
import { writeFileSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"

const require = createRequire("/home/hatch/workspace/couchhub-tv-0114-w1/package.json")
const { chromium } = require("playwright")

const ROOT = "/home/hatch/workspace/couchhub-tv-0114-w1"
const OUT = `${ROOT}/docs/screenshots`
const BASE = "http://127.0.0.1:4401"
const CHROME = "/home/hatch/workspace/.chrome-test/chrome-linux/chrome"

mkdirSync(OUT, { recursive: true })

const server = spawn("python3", ["-m", "http.server", "4401", "--directory", `${ROOT}/dist`, "--bind", "127.0.0.1"], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
})
const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { const res = await fetch(`${BASE}/`); if (res.ok) return true } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("preview server did not come up")
}

const PAGES = [
  ["home", "/settings"],
  ["playlists", "/settings/playlists"],
  ["profile", "/settings/profile"],
  ["display", "/settings/display"],
  ["playback", "/settings/playback"],
  ["live-tv", "/settings/live-tv"],
  ["followed", "/settings/followed"],
  ["discover-ai", "/settings/discover-ai"],
  ["casting", "/settings/casting"],
  ["data-backup", "/settings/data-backup"],
  ["app-updates", "/settings/app-updates"],
  ["help-diagnostics", "/settings/help-diagnostics"],
  ["danger", "/settings/danger"],
]

const results = {}
function note(name, obj) { results[name] = obj; console.log(`--- ${name} ---`, JSON.stringify(obj)) }

try {
  await waitForServer()
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)))
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300)) })
  await page.context().addInitScript(() => {
    try { localStorage.setItem("xt_theme", "dark") } catch {}
  })

  for (const [slug, path] of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" })
    await page.waitForTimeout(700)
    const m = await page.evaluate(() => {
      const topnav = document.querySelector(".rs-topnav")
      const sub = document.querySelector(".settings-subheader")
      const stack = document.querySelector(".settings-stack")
      const pill = document.querySelector("[data-button-hints]")
      const rows = document.querySelectorAll("[data-settings-item]").length
      return {
        url: location.pathname,
        docScrollH: document.documentElement.scrollHeight,
        bodyScrollH: document.body.scrollHeight,
        topnavH: topnav ? Math.round(topnav.getBoundingClientRect().height) : null,
        topnavTop: topnav ? Math.round(topnav.getBoundingClientRect().top) : null,
        subTop: sub ? Math.round(sub.getBoundingClientRect().top) : null,
        subH: sub ? Math.round(sub.getBoundingClientRect().height) : null,
        stackH: stack ? Math.round(stack.getBoundingClientRect().height) : null,
        pillVisible: pill ? !pill.hidden && pill.getBoundingClientRect().height > 0 : false,
        pillBottom: pill ? Math.round(pill.getBoundingClientRect().bottom) : null,
        items: rows,
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
        navCurrent: document.querySelector('.settings-nav-link[aria-current="true"]')?.textContent?.trim() ?? null,
      }
    })
    note(`measure:${slug}`, m)
    await page.screenshot({ path: `${OUT}/w1-${slug}-top.png` })
    // Scroll to bottom: subheader must stay stuck, pill must not cover content.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(500)
    const m2 = await page.evaluate(() => {
      const topnav = document.querySelector(".rs-topnav")
      const sub = document.querySelector(".settings-subheader")
      const pill = document.querySelector("[data-button-hints]")
      const sr = sub?.getBoundingClientRect()
      const pr = pill?.getBoundingClientRect()
      // Lowest visible settings content vs pill top: any overlap?
      const items = Array.from(document.querySelectorAll("[data-settings-item], .settings-home-row"))
      let lowest = 0
      for (const el of items) {
        const r = el.getBoundingClientRect()
        if (r.bottom > 0 && r.top < innerHeight) lowest = Math.max(lowest, r.bottom)
      }
      return {
        scrollY: Math.round(window.scrollY),
        topnavTop: topnav ? Math.round(topnav.getBoundingClientRect().top) : null,
        subTop: sr ? Math.round(sr.top) : null,
        subStuck: sr ? Math.abs(sr.top - (document.querySelector(".rs-topnav")?.getBoundingClientRect().height ?? 0)) < 3 : null,
        pillTop: pr ? Math.round(pr.top) : null,
        lowestContentBottomInView: Math.round(lowest),
        pillCoversContent: pr && lowest > pr.top ? true : false,
      }
    })
    note(`measure-scrolled:${slug}`, m2)
    await page.screenshot({ path: `${OUT}/w1-${slug}-bottom.png` })
    // Anchor jump: a card deep on the page must not land under the header.
    const anchor = await page.evaluate(() => {
      const targets = ["#card-ai-discovery", "#card-tmdb", "#playback-section", "#card-followed", "#update-section", "#card-backup", "#card-categories", "#settings-playlists"]
      for (const sel of targets) {
        const el = document.querySelector(sel)
        if (el) return sel
      }
      return null
    })
    if (anchor) {
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ block: "start" })
      }, anchor)
      await page.waitForTimeout(400)
      const am = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        const topnav = document.querySelector(".rs-topnav")
        const sub = document.querySelector(".settings-subheader")
        const r = el.getBoundingClientRect()
        const headerBottom = Math.max(
          topnav ? topnav.getBoundingClientRect().bottom : 0,
          sub ? sub.getBoundingClientRect().bottom : 0,
        )
        return { anchor: sel, targetTop: Math.round(r.top), headerBottom: Math.round(headerBottom), clipped: r.top < headerBottom - 1 }
      }, anchor)
      note(`anchor:${slug}`, am)
      await page.screenshot({ path: `${OUT}/w1-${slug}-anchor.png` })
    }
    // Search on home + one subpage: filter in place, no scroll yank.
    if (slug === "home" || slug === "playback") {
      const before = await page.evaluate(() => Math.round(window.scrollY))
      await page.fill("#settings-search-input", slug === "home" ? "captions" : "captions")
      await page.waitForTimeout(400)
      const sm = await page.evaluate(() => {
        const input = document.querySelector("#settings-search-input")
        const rows = Array.from(document.querySelectorAll("#settings-home-list [data-search-text], [data-settings-item]"))
        const visible = rows.filter((el) => el.offsetParent !== null || getComputedStyle(el).display !== "none").length
        return {
          scrollYBefore: undefined,
          scrollYAfter: Math.round(window.scrollY),
          visibleRows: visible,
          emptyHidden: document.querySelector("#settings-search-empty")?.hidden ?? null,
          xpageVisible: document.querySelector("#settings-search-xpage") ? !document.querySelector("#settings-search-xpage").hidden : null,
          xpageHits: document.querySelectorAll("#settings-search-xpage .settings-xpage__hit").length,
        }
      })
      sm.scrollYBefore = before
      note(`search:${slug}`, sm)
      await page.screenshot({ path: `${OUT}/w1-${slug}-search.png` })
      await page.fill("#settings-search-input", "")
    }
  }

  // Nylah lockup check on the home page (must be untouched).
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" })
  await page.waitForTimeout(500)
  const lockup = await page.evaluate(() => {
    const brand = document.querySelector(".rs-brand")
    return brand ? { text: brand.textContent?.trim(), hasImg: !!brand.querySelector("img, svg") } : null
  })
  note("lockup", lockup)

  writeFileSync(`${OUT}/w1-render-metrics.json`, JSON.stringify(results, null, 2))
  await browser.close()
  console.log("DONE")
} finally {
  server.kill()
}
