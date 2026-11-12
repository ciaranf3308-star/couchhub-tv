// Integration 0.11.4 render gate: screenshot every new Settings page,
// /controller-status, Home (Nylah lockup) and the Live TV landing at
// 1920x1080 from the built dist/ served statically. No playlist is
// seeded here — these are layout/structure renders; the hero with a
// real EPG fixture is covered by docs/screenshots/render-hero-0114.mjs.
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"

const require = createRequire("/home/hatch/workspace/couchhub-tv-0114-integration/package.json")
const { chromium } = require("playwright")

const ROOT = "/home/hatch/workspace/couchhub-tv-0114-integration"
const DIST = join(ROOT, "dist")
const OUT = join(ROOT, "docs/screenshots/integration-0114")
const CHROME = "/home/hatch/workspace/.chrome-test/chrome-linux/chrome"
const PORT = 4339

mkdirSync(OUT, { recursive: true })

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname)
    if (p.endsWith("/")) p += "index.html"
    const file = join(DIST, p)
    const data = await readFile(file)
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end("not found")
  }
})
await new Promise((r) => server.listen(PORT, "127.0.0.1", r))

const PAGES = [
  ["settings-home", "/settings/"],
  ["settings-playlists", "/settings/playlists/"],
  ["settings-display", "/settings/display/"],
  ["settings-playback", "/settings/playback/"],
  ["settings-live-tv", "/settings/live-tv/"],
  ["settings-followed", "/settings/followed/"],
  ["settings-discover-ai", "/settings/discover-ai/"],
  ["settings-casting", "/settings/casting/"],
  ["settings-data-backup", "/settings/data-backup/"],
  ["settings-app-updates", "/settings/app-updates/"],
  ["settings-help-diagnostics", "/settings/help-diagnostics/"],
  ["settings-danger", "/settings/danger/"],
  ["controller-status", "/controller-status/"],
  ["home", "/"],
  ["livetv-landing", "/livetv/"],
  ["movie-detail", "/movies/detail/"],
]

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-gpu"],
})
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE-ERROR", m.text().slice(0, 200))
})
for (const [name, path] of PAGES) {
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => console.log(name, "NAV-FAIL", String(e).slice(0, 120)))
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/${name}-1920.png` })
  console.log("shot", name)
}
await browser.close()
server.close()
console.log("done", OUT)
