// One-off measurement: Discover geometry at 1672x941 and 1920x1080.
// Seeds the fixture playlist, suppresses keys onboarding, walks the
// three steps, and dumps bounding boxes + scroll metrics as JSON.
import { chromium } from "playwright"
import { readFileSync } from "node:fs"

const playlistText = readFileSync("tests/visual/fixtures/playlist.m3u", "utf8")
const epgText = readFileSync("tests/visual/fixtures/epg.xml", "utf8")
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const PLAYLIST_ID = "fixture-playlist-tv"

async function measure(viewport) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
    args: ["--no-sandbox"],
  })
  const page = await browser.newPage({
    viewport,
    colorScheme: "dark",
    reducedMotion: "reduce",
  })
  await page.context().route("https://api.github.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )
  await page.context().route("https://fixtures.invalid/**", (r) => {
    const u = new URL(r.request().url())
    if (u.pathname === "/playlist.m3u")
      return r.fulfill({ status: 200, contentType: "audio/x-mpegurl", body: playlistText })
    if (u.pathname === "/epg.xml")
      return r.fulfill({ status: 200, contentType: "application/xml", body: epgText })
    if (u.pathname.startsWith("/logos/"))
      return r.fulfill({ status: 200, contentType: "image/png", body: LOGO_PNG })
    return r.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
  await page.context().addInitScript(({ playlistId }) => {
    try {
      localStorage.setItem(
        "xt_playlists",
        JSON.stringify({
          entries: [
            {
              _id: playlistId,
              title: "Fixture TV",
              type: "m3u",
              url: "https://fixtures.invalid/playlist.m3u",
              addedAt: 1767225600000,
            },
          ],
          selectedId: playlistId,
        }),
      )
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
      localStorage.setItem("xt_last_seen_version", "99.0.0")
    } catch {}
    try {
      sessionStorage.setItem("xt_splash_done", "1")
      sessionStorage.setItem("rs-keys-onboarding-dismissed-v1", "1")
    } catch {}
  }, { playlistId: PLAYLIST_ID })

  await page.goto("http://127.0.0.1:4325/discover", { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1500)

  const box = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) }
    }, sel)

  const metrics = () =>
    page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      scrollYMax: document.documentElement.scrollHeight - window.innerHeight,
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    }))

  const out = { viewport, ...await metrics() }
  out.canvas = await box(".rs-neural-canvas")
  out.discover = await box(".rs-discover")
  out.nav = await box(".rs-nav")
  out.step1 = {
    title: await box(".rs-flow-step--kind .rs-flow-title"),
    sub: await box(".rs-flow-step--kind .rs-flow-sub"),
    grid: await box(".rs-kind-grid"),
    foot: await box(".rs-flow-step--kind .rs-flow-foot"),
    ...(await metrics()),
  }
  // Step 2: click Movie kind card, then a genre tile is not needed for layout.
  await page.click(".rs-kind-card[data-kind='movie'], .rs-kind-card >> nth=0").catch(() => {})
  await page.waitForTimeout(800)
  out.step2 = {
    title: await box(".rs-flow-step--categories .rs-flow-title"),
    sub: await box(".rs-flow-step--categories .rs-flow-sub"),
    grid: await box(".rs-discover__mood-grid"),
    actions: await box(".rs-flow-step--categories .rs-flow-actions"),
    foot: await box(".rs-flow-step--categories .rs-flow-foot"),
    ...(await metrics()),
  }
  // Step 3: pick a genre then Continue.
  await page.click(".rs-discover__mood-grid [data-nylah-item] >> nth=0").catch(() => {})
  await page.waitForTimeout(400)
  await page.click(".rs-flow-step--categories .rs-flow-primary").catch(() => {})
  await page.waitForTimeout(800)
  const step3 = {
    title: await box(".rs-flow-step--brief .rs-flow-title"),
    sub: await box(".rs-flow-step--brief .rs-flow-sub"),
    choices: await box(".rs-flow-step--brief .rs-flow-choices"),
    label: await box(".rs-flow-brief-label"),
    textarea: await box(".rs-flow-brief-input"),
    hint: await box(".rs-flow-brief-form .rs-flow-hint"),
    actions: await box(".rs-flow-step--brief .rs-flow-actions"),
    panel: await box(".rs-flow-step--brief .rs-ai-panel"),
    modeRow: await box(".rs-flow-step--brief .rs-discover-mode-row"),
    foot: await box(".rs-flow-step--brief .rs-flow-foot"),
    step: await box(".rs-flow-step--brief"),
    ...(await metrics()),
  }
  out.step3 = step3
  // Step 3 with-key simulation: hide the panel.
  await page.evaluate(() => {
    const p = document.querySelector(".rs-flow-step--brief .rs-ai-panel")
    if (p) p.style.display = "none"
  })
  await page.waitForTimeout(200)
  out.step3WithKeySim = await metrics()
  // Step 3 notice state: press Find my next watch with no key.
  await page.evaluate(() => {
    const p = document.querySelector(".rs-flow-step--brief .rs-ai-panel")
    if (p) p.style.display = ""
  })
  await page.click(".rs-flow-step--brief .rs-flow-primary").catch(() => {})
  await page.waitForTimeout(800)
  out.step3Notice = {
    notice: await box(".rs-flow-step--brief .rs-flow-notice"),
    panel: await box(".rs-flow-step--brief .rs-ai-panel"),
    ...(await metrics()),
  }
  await browser.close()
  return out
}

const results = []
for (const vp of [{ width: 1672, height: 941 }, { width: 1920, height: 1080 }]) {
  results.push(await measure(vp))
}
console.log(JSON.stringify(results, null, 2))
